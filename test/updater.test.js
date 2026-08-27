/*
 * updater.test.js — アプリ内アップデート
 *
 * GitHub API はローカルのスタブサーバで置き換え、配布zipは実物と同じ構成で作る。
 * apply() は url を引数で受けるため src/updater.js を無改変のまま検証できる。
 * check() は API_LATEST が定数なので、URLだけ差し替えたコピーを使う。
 *
 * ここで一番確認したいのは「更新に失敗したときアプリが起動不能にならないこと」。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const updater = require('../src/updater');
const { packerAvailable, packRelease } = require('./helpers/pack');

const CAN_PACK = packerAvailable();
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-upd-'));

// ---------------------------------------------------------------- 単体
test('cmpVersion がバージョンを正しく比較する', () => {
  assert.strictEqual(updater.cmpVersion('0.9.0', '0.8.0'), 1);
  assert.strictEqual(updater.cmpVersion('0.8.0', '0.9.0'), -1);
  assert.strictEqual(updater.cmpVersion('0.8.0', '0.8.0'), 0);
  assert.strictEqual(updater.cmpVersion('v0.8.0', '0.8.0'), 0);
  // 文字列比較なら 0.10.0 < 0.9.0 と誤るところ
  assert.strictEqual(updater.cmpVersion('0.10.0', '0.9.0'), 1);
  assert.strictEqual(updater.cmpVersion('1.0.0', '0.9.9'), 1);
  assert.strictEqual(updater.cmpVersion('0.8.1', '0.8'), 1);
});

test('配布元リポジトリが設定されている', () => {
  assert.match(updater.REPO, /^[\w.-]+\/[\w.-]+$/, 'REPO は <アカウント>/<リポジトリ> 形式');
});

// ---------------------------------------------------------------- check()
test('check() がリリース情報を解釈する', { skip: !CAN_PACK && 'zip コマンドが無い' }, async (t) => {
  const zip = packRelease(REPO_ROOT, work, '0.9.0');
  const bytes = fs.readFileSync(zip);
  let port = 0;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/asset.zip')) { res.writeHead(200); res.end(bytes); return; }
    if (req.url.includes('/no-asset')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v0.9.0', assets: [{ name: 'Listener-0.9.0-setup.exe', browser_download_url: 'x', size: 1 }] }));
      return;
    }
    if (req.url.includes('/missing')) { res.writeHead(404); res.end('{}'); return; }
    if (req.url.includes('/server-error')) { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: 'v0.9.0',
      body: 'リリースノート本文',
      published_at: '2026-10-05T00:00:00Z',
      assets: [
        { name: 'Listener-0.9.0-setup.exe', browser_download_url: `http://127.0.0.1:${port}/exe`, size: 90000000 },
        { name: 'listener-src-0.9.0.zip', browser_download_url: `http://127.0.0.1:${port}/asset.zip`, size: bytes.length },
      ],
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  t.after(() => server.close());

  // API_LATEST だけ差し替えたコピーを読み込む
  const stub = path.join(work, 'updater-stub.js');
  const mkStub = (route) => {
    fs.writeFileSync(stub, fs.readFileSync(path.join(REPO_ROOT, 'src', 'updater.js'), 'utf8')
      .replace(/const API_LATEST = [^\n]+/, `const API_LATEST = 'http://127.0.0.1:${port}${route}';`));
    delete require.cache[require.resolve(stub)];
    return require(stub);
  };

  const up = mkStub('/latest');
  const newer = await up.check('0.8.0', work);
  assert.strictEqual(newer.ok, true, newer.error);
  assert.strictEqual(newer.update, true);
  assert.strictEqual(newer.version, '0.9.0');
  assert.match(newer.url, /asset\.zip$/, 'インストーラーではなく軽量zipを選ぶこと');
  assert.strictEqual(newer.notes, 'リリースノート本文');

  const same = await up.check('0.9.0', work);
  assert.strictEqual(same.update, false, '同一バージョンで更新ありにしない');
  const ahead = await up.check('1.0.0', work);
  assert.strictEqual(ahead.update, false, '現行が新しいときに更新ありにしない');

  const missing = await mkStub('/missing').check('0.8.0', work);
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /リリースが見つかりません/);

  const err = await mkStub('/server-error').check('0.8.0', work);
  assert.strictEqual(err.ok, false);
  assert.match(err.error, /500/);

  const noAsset = await mkStub('/no-asset').check('0.8.0', work);
  assert.strictEqual(noAsset.ok, false);
  assert.match(noAsset.error, /listener-src/,
    'エラー文が実際に探しているファイル名と一致すること');
});

test('check() は繋がらないときオフラインとして静かに諦める', async () => {
  const stub = path.join(work, 'updater-offline.js');
  fs.writeFileSync(stub, fs.readFileSync(path.join(REPO_ROOT, 'src', 'updater.js'), 'utf8')
    .replace(/const API_LATEST = [^\n]+/, "const API_LATEST = 'http://127.0.0.1:1/latest';"));
  const up = require(stub);
  const r = await up.check('0.8.0', work);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.offline, true);
});

// ---------------------------------------------------------------- apply()
test('apply() が src を差し替え、失敗時は元に戻す', { skip: !CAN_PACK && 'zip コマンドが無い' }, async (t) => {
  const zip = packRelease(REPO_ROOT, work, '0.9.0');
  const bytes = fs.readFileSync(zip);

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/broken')) { res.writeHead(200); res.end(Buffer.from('zipではないデータ'.repeat(200))); return; }
    res.writeHead(200); res.end(bytes);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => server.close());

  // --- 正常系 ---
  const appRoot = path.join(work, 'app');
  fs.mkdirSync(path.join(appRoot, 'src', 'renderer'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'src', 'main.js'), '// 旧バージョン');
  fs.writeFileSync(path.join(appRoot, 'src', 'preload.js'), '// 旧');
  fs.writeFileSync(path.join(appRoot, 'src', 'renderer', 'app.html'), '<!-- 旧 -->');
  fs.writeFileSync(path.join(appRoot, 'src', 'REMOVED.js'), '旧版にしか無いファイル');
  fs.writeFileSync(path.join(appRoot, 'package.json'),
    JSON.stringify({ name: 'listener', version: '0.7.0', main: 'src/main.js' }, null, 2), 'utf8');
  fs.mkdirSync(path.join(appRoot, 'src.backup-1'), { recursive: true });

  const progress = [];
  const r = await updater.apply(`http://127.0.0.1:${port}/a.zip`, appRoot, work, (m) => progress.push(m));
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(progress.length >= 3, '進捗が通知されない');

  assert.ok(fs.readFileSync(path.join(appRoot, 'src', 'main.js'), 'utf8').includes("require('./store')"),
    'main.js が新しい内容に置き換わっていない');
  assert.ok(fs.existsSync(path.join(appRoot, 'src', 'renderer', 'app.html')));
  assert.ok(!fs.existsSync(path.join(appRoot, 'src', 'REMOVED.js')),
    '旧版固有のファイルが残っている（上書きではなく差し替えであること）');

  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.version, '0.9.0', 'package.json の version が更新されていない');
  assert.strictEqual(pkg.main, 'src/main.js', '他のキーが失われている');

  const backups = fs.readdirSync(appRoot).filter((d) => d.startsWith('src.backup-'));
  assert.strictEqual(backups.length, 1, 'バックアップは1世代だけ残す');
  assert.ok(fs.existsSync(path.join(appRoot, backups[0], 'REMOVED.js')), 'バックアップが不完全');
  assert.ok(!fs.existsSync(path.join(appRoot, 'src.backup-1')), '古いバックアップが掃除されていない');

  // --- 異常系: 壊れたzip ---
  const appRoot2 = path.join(work, 'app2');
  fs.mkdirSync(path.join(appRoot2, 'src'), { recursive: true });
  fs.writeFileSync(path.join(appRoot2, 'src', 'main.js'), '// 生き残るべき内容');
  const bad = await updater.apply(`http://127.0.0.1:${port}/broken.zip`, appRoot2, work, () => {});
  assert.strictEqual(bad.ok, false, '壊れたzipで成功を返した');
  assert.ok(fs.existsSync(path.join(appRoot2, 'src', 'main.js'))
    && fs.readFileSync(path.join(appRoot2, 'src', 'main.js'), 'utf8').includes('生き残るべき'),
  '更新に失敗したのに既存の src/ が壊れた（アプリが起動しなくなる）');
});

test('apply() は落とせないときも既存の src を壊さない', async () => {
  const appRoot = path.join(work, 'app3');
  fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'src', 'main.js'), '// 無事であること');
  const r = await updater.apply('http://127.0.0.1:1/x.zip', appRoot, work, () => {});
  assert.strictEqual(r.ok, false);
  assert.ok(fs.readFileSync(path.join(appRoot, 'src', 'main.js'), 'utf8').includes('無事であること'));
});
