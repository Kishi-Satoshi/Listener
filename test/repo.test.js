/*
 * repo.test.js — 公開と配布に関わる決まりごとを機械で守る
 *
 *  - 公開リポジトリに個人名・個人パス・社内固有名を出さない
 *  - .ps1 は BOM付きUTF-8 + CRLF（BOMが無いと PS5.1 が Shift-JIS と誤読して壊れる）
 *  - preload / main / renderer の IPC が食い違わない（過去に不整合を出した箇所）
 *
 * 目視の再確認は忘れるが、テストは忘れない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) { return null; }
}

const TEXT_EXT = new Set(['.js', '.html', '.json', '.md', '.ps1', '.bat', '.gitignore', '']);

// ---------------------------------------------------------------- 公開前の確認
test('個人名・個人パス・社内固有名がコードに残っていない', () => {
  const files = trackedFiles();
  if (!files) return; // git が無い環境ではスキップ
  const forbidden = [
    { re: /C:\\Users\\[A-Za-z0-9._-]+/i, what: '個人のWindowsパス' },
    { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, what: 'メールアドレス' },
    // 社内の個人アカウント名。GitHub のアカウント名（updater の REPO）は
    // 公開リポジトリでは元から公開情報なので対象外。
    { re: /\bkishis\b/i, what: '社内アカウント名' },
    { re: /techvan/i, what: '社名' },
  ];
  const hits = [];
  const SELF = 'test/repo.test.js'; // 禁止語そのものを持つので自分自身は対象外
  for (const f of files) {
    if (f === SELF) continue;
    if (!TEXT_EXT.has(path.extname(f))) continue;
    const text = read(f);
    text.split('\n').forEach((line, i) => {
      for (const { re, what } of forbidden) {
        if (re.test(line)) hits.push(`${f}:${i + 1} (${what}) ${line.trim().slice(0, 100)}`);
      }
    });
  }
  assert.deepStrictEqual(hits, [], `公開できない情報が含まれている:\n${hits.join('\n')}`);
});

test('秘匿情報らしき文字列が含まれていない', () => {
  const files = trackedFiles();
  if (!files) return;
  const re = /(gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const hits = [];
  for (const f of files) {
    if (!TEXT_EXT.has(path.extname(f))) continue;
    if (re.test(read(f))) hits.push(f);
  }
  assert.deepStrictEqual(hits, []);
});

test('.gitignore が持ち出してはいけないものを除外している', () => {
  const gi = read('.gitignore');
  for (const p of ['node_modules', 'local-engine', 'release', 'dist', 'src.backup-', '*.log']) {
    assert.ok(gi.includes(p), `.gitignore に ${p} が無い`);
  }
});

test('モデル・音声・ログなどの生成物が追跡されていない', () => {
  const files = trackedFiles();
  if (!files) return;
  const bad = files.filter((f) => /\.(gguf|bin|wav|mp3|log|exe)$/i.test(f)
    || f.startsWith('local-engine/') || f.startsWith('release/') || f.startsWith('node_modules/'));
  assert.deepStrictEqual(bad, []);
});

// ---------------------------------------------------------------- PowerShell
test('.ps1 は BOM付きUTF-8 + CRLF（PS5.1 が Shift-JIS と誤読しないため）', () => {
  const files = (trackedFiles() || fs.readdirSync(ROOT)).filter((f) => f.endsWith('.ps1'));
  assert.ok(files.length > 0, '.ps1 が見つからない');
  for (const f of files) {
    const raw = fs.readFileSync(path.join(ROOT, f));
    assert.ok(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF, `${f}: BOMが無い`);
    const body = raw.subarray(3).toString('binary');
    const lf = (body.match(/\n/g) || []).length;
    const crlf = (body.match(/\r\n/g) || []).length;
    assert.strictEqual(crlf, lf, `${f}: CRLFでない行がある（LF ${lf} 行中 CRLF ${crlf} 行）`);
  }
});

test('.ps1 が PS5.1 で構文エラーになる書き方を使っていない', () => {
  const files = (trackedFiles() || fs.readdirSync(ROOT)).filter((f) => f.endsWith('.ps1'));
  for (const f of files) {
    const text = read(f);
    // コメント行を除いて判定する
    const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.ok(!/\bswitch\s*[({]/.test(code), `${f}: switch は PS5.1 で使わない`);
    assert.ok(!/\[ValidateSet\]/.test(code), `${f}: [ValidateSet] は PS5.1 で使わない`);
    assert.ok(!/utf8BOM/i.test(code), `${f}: -Encoding utf8BOM は PS5.1 に無い`);
  }
});

test('make-release.ps1 が updater の探すファイル名でzipを作る', () => {
  const rel = read('make-release.ps1');
  const upd = read('src/updater.js');
  const pattern = upd.match(/ASSET_PATTERN\s*=\s*\/\^([^/]+)\$\/i/);
  assert.ok(pattern, 'ASSET_PATTERN が読み取れない');
  const m = rel.match(/"(listener-src-)"\s*\+\s*\$Version\s*\+\s*"(\.zip)"/);
  assert.ok(m, 'make-release.ps1 のzip名が読み取れない');
  const produced = `${m[1]}0.8.0${m[2]}`;
  assert.match(produced, new RegExp(`^${pattern[1]}$`, 'i'),
    `make-release.ps1 が作る ${produced} を updater が拾えない`);
  // 添付漏れ時のエラー文が実際のファイル名を案内しているか
  assert.ok(upd.includes('listener-src-*.zip'),
    'updater のエラー文が実際のファイル名と違う（利用者が探せなくなる）');
});

// ---------------------------------------------------------------- IPC の整合
const preload = read('src/preload.js');
const main = read('src/main.js');
const appHtml = read('src/renderer/app.html');
const overlayHtml = read('src/renderer/overlay.html');

const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);

test('preload の invoke に対応する ipcMain.handle が main.js にある', () => {
  const handled = new Set(all(/ipcMain\.handle\('([^']+)'/g, main));
  const missing = all(/ipcRenderer\.invoke\('([^']+)'/g, preload).filter((c) => !handled.has(c));
  assert.deepStrictEqual([...new Set(missing)], [],
    'preload が invoke するのに main.js に handle が無いチャンネル');
});

test('preload の send に対応する ipcMain.on が main.js にある', () => {
  const on = new Set(all(/ipcMain\.on\('([^']+)'/g, main));
  const missing = all(/ipcRenderer\.send\('([^']+)'/g, preload).filter((c) => !on.has(c));
  assert.deepStrictEqual([...new Set(missing)], [],
    'preload が send するのに main.js に受け口が無いチャンネル');
});

test('invoke と send を取り違えていない', () => {
  const handled = new Set(all(/ipcMain\.handle\('([^']+)'/g, main));
  const on = new Set(all(/ipcMain\.on\('([^']+)'/g, main));
  const invoked = new Set(all(/ipcRenderer\.invoke\('([^']+)'/g, preload));
  const sent = new Set(all(/ipcRenderer\.send\('([^']+)'/g, preload));
  for (const c of invoked) assert.ok(!on.has(c) || handled.has(c), `${c}: invoke なのに ipcMain.on で受けている`);
  for (const c of sent) assert.ok(!handled.has(c) || on.has(c), `${c}: send なのに ipcMain.handle で受けている`);
});

test('main.js から送るイベントを preload が購読できる', () => {
  const listened = new Set(all(/ipcRenderer\.on\('([^']+)'/g, preload));
  const sends = [
    ...all(/sendToMainWin\('([^']+)'/g, main),
    ...all(/sendToOverlay\('([^']+)'/g, main),
    ...all(/webContents\.send\('([^']+)'/g, main),
  ].filter((c) => !c.includes('${'));
  const missing = [...new Set(sends)].filter((c) => !listened.has(c));
  assert.deepStrictEqual(missing, [],
    'main.js が送るのに preload が受け口を公開していないイベント');
});

test('画面が呼ぶ API がすべて preload に公開されている', () => {
  const block = (name) => {
    const i = preload.indexOf(`exposeInMainWorld('${name}'`);
    assert.ok(i >= 0, `${name} が preload に無い`);
    const rest = preload.slice(i);
    const end = rest.indexOf('\n});');
    return rest.slice(0, end > 0 ? end : rest.length);
  };
  const names = (src) => new Set(all(/^\s{2}([A-Za-z][\w$]*):/gm, src));

  const koeApp = names(block('koeApp'));
  const koeOverlay = names(block('koeOverlay'));
  assert.ok(koeApp.size > 10 && koeOverlay.size > 5, 'preload の解析に失敗');

  const used = (html, re) => [...new Set(all(re, html))];
  const missingApp = used(appHtml, /window\.koeApp\.(\w+)/g).filter((n) => !koeApp.has(n));
  assert.deepStrictEqual(missingApp, [], 'app.html が使うのに preload に無い koeApp の API');

  const missingOverlay = used(overlayHtml, /koeOverlay\.(\w+)/g).filter((n) => !koeOverlay.has(n));
  assert.deepStrictEqual(missingOverlay, [], 'overlay.html が使うのに preload に無い koeOverlay の API');
});

test('外部URLを開くのは REPO 定数から組み立てたものだけ', () => {
  // 画面から渡された文字列を openExternal に流すと、表示中の内容次第で
  // 任意のページを開けてしまう
  const calls = [...main.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, 'openExternal の呼び出しが見つからない');
  for (const c of calls) {
    assert.match(c, /^`https:\/\/github\.com\/\$\{updater\.REPO\}/,
      `画面から受け取ったURLを開いていないか: ${c}`);
  }
});

test('更新の告知が設定タブの外にも出る', () => {
  // トーストだけだと数秒で消え、見逃すと更新に気づけない
  assert.ok(appHtml.includes('id="updBadge"'), '常駐する告知の要素が無い');
  assert.ok(appHtml.includes('function renderUpdateBadge'), '告知を組み立てる関数が無い');
  const from = appHtml.indexOf('function showUpdate(r)');
  assert.ok(from >= 0, 'showUpdate が無い');
  const body = appHtml.slice(from, appHtml.indexOf('\n  }', from) + 4);
  assert.ok(body.includes('renderUpdateBadge(r)'), '更新を検出したのに告知を出していない');
});

test('公開したのに画面から呼ばれない API がない', () => {
  // 使われないまま残っていると「機能があるはず」と誤解する。
  // 録音中のメモ入力は、API はあるのに画面から呼んでいなかったため
  // 長く使えないままになっていた。
  const block = (name) => {
    const i = preload.indexOf(`exposeInMainWorld('${name}'`);
    const rest = preload.slice(i);
    const end = rest.indexOf('\n});');
    return rest.slice(0, end > 0 ? end : rest.length);
  };
  for (const [ns, html] of [['koeApp', appHtml], ['koeOverlay', overlayHtml]]) {
    const names = all(/^\s{2}([A-Za-z][\w$]*):/gm, block(ns));
    const used = new Set(all(new RegExp(`${ns}\\.(\\w+)`, 'g'), html));
    const dead = names.filter((n) => !used.has(n));
    assert.deepStrictEqual(dead, [], `${ns} に呼ばれていない API がある`);
  }
});

test('preload に公開したまま main.js 側が無い API がない', () => {
  const handled = new Set([
    ...all(/ipcMain\.handle\('([^']+)'/g, main),
    ...all(/ipcMain\.on\('([^']+)'/g, main),
  ]);
  const unreachable = [...new Set([
    ...all(/ipcRenderer\.invoke\('([^']+)'/g, preload),
    ...all(/ipcRenderer\.send\('([^']+)'/g, preload),
  ])].filter((c) => !handled.has(c));
  assert.deepStrictEqual(unreachable, []);
});

// ---------------------------------------------------------------- その他
test('パッケージ版でもアプリ内更新ができる設定になっている', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.build.asar, false,
    'asar 同梱だと src/ が書庫の中に入り、ファイル単位で差し替えられなくなる');
});

test('更新の可否はビルド種別ではなく「差し替えられるか」で判断する', () => {
  assert.ok(main.includes('function updateTarget'), 'updateTarget が無い');
  assert.ok(/\\.asar\$/.test(main), 'asar 同梱を検出していない');
  assert.ok(!/applyable:\s*!app\.isPackaged/.test(main),
    'インストーラー版というだけで更新を拒否している');
});

test('トレイのアイコンが nativeImage の読める形式で置かれている', () => {
  // Electron の nativeImage は PNG / JPEG（Windows は ICO も）だけ。
  // SVG を渡すと空の画像になり、タスクトレイが透明になる。
  for (const f of ['src/assets/tray.ico', 'src/assets/tray-rec.ico',
    'src/assets/tray.png', 'src/assets/tray-rec.png']) {
    const b = fs.readFileSync(path.join(ROOT, f));
    const isPng = b[0] === 0x89 && b.toString('binary', 1, 4) === 'PNG';
    const isIco = b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0;
    assert.ok(isPng || isIco, `${f} が PNG でも ICO でもない`);
  }
  assert.ok(!/image\/svg\+xml/.test(main), 'SVG から nativeImage を作っている（透明になる）');
});

test('トレイのアイコンは src 配下にある（アプリ内更新で一緒に入れ替わるように）', () => {
  const files = trackedFiles();
  if (!files) return;
  for (const f of ['src/assets/tray.ico', 'src/assets/tray-rec.ico']) {
    assert.ok(files.includes(f), `${f} が追跡されていない`);
  }
});

test('設定と履歴の保存が一時ファイル経由で行われる', () => {
  // 直接書くと、書き込み中に落ちたときに壊れたJSONが残り、
  // 次回起動で既定値に戻って設定が消える
  const i = main.indexOf('function saveJson');
  assert.ok(i >= 0, 'saveJson が無い');
  const fn = main.slice(i, main.indexOf('\nconst persist', i));
  assert.ok(fn.includes('renameSync'), 'saveJson が一時ファイル経由になっていない');
});

test('READMEのデータ保存先が実際の保存先と一致する', () => {
  // Electron の app.getName() と同じ解決順（setName は使っていない）
  const pkg = JSON.parse(read('package.json'));
  const name = pkg.productName || pkg.name;
  const readme = read('README.md');
  assert.ok(readme.includes(`%APPDATA%\\${name}`),
    `README が %APPDATA%\\${name} を案内していない`);
  assert.ok(!/%APPDATA%\\koetype/.test(readme),
    '実在しない保存先（koetype）が README に残っている');
});

test('package.json のバージョンが semver 形式', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(pkg.name, 'listener');
});

test('配布物に必要なファイルが build.files に含まれている', () => {
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build.files.join(' ');
  assert.ok(files.includes('src/**/*'), 'src が配布対象に無い');
  assert.ok(files.includes('package.json'), 'package.json が配布対象に無い');
});

test('main.js が require するローカルモジュールが実在する', () => {
  for (const f of ['src/main.js', 'src/minutes.js', 'src/store.js', 'src/cite.js',
    'src/actions.js', 'src/meetingType.js', 'src/updater.js', 'src/preload.js']) {
    for (const rel of all(/require\('(\.[^']+)'\)/g, read(f))) {
      const p = path.join(ROOT, path.dirname(f), rel.endsWith('.js') ? rel : `${rel}.js`);
      assert.ok(fs.existsSync(p), `${f}: ${rel} が見つからない`);
    }
  }
});

test('HTML 内のスクリプトが構文的に正しい', () => {
  for (const [name, html] of [['app.html', appHtml], ['overlay.html', overlayHtml]]) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, `${name}: script が見つからない`);
    for (const s of scripts) {
      assert.doesNotThrow(() => new Function(s), `${name} の script に構文エラー`);
    }
  }
});
