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
// ソースを正規表現で検査するテストはコメントに一致して素通りしやすい。
// 「テストが通っているのに実装が無い」を防ぐため、コメントを落としてから見る。
const code = (t) => String(t).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

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

test('外部URLを開くのはコード内で組み立てたものだけ', () => {
  // 画面から渡された文字列を openExternal に流すと、表示中の内容次第で
  // 任意のページを開けてしまう。許すのは次の2つだけ。
  //   - REPO 定数から組み立てたリリースページ
  //   - Windows のサウンド設定（固定のURI）
  const ALLOWED = [
    /^`https:\/\/github\.com\/\$\{updater\.REPO\}/,
    /^'ms-settings:[a-z]+'$/,
  ];
  const calls = [...main.matchAll(/shell\.openExternal\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, 'openExternal の呼び出しが見つからない');
  for (const c of calls) {
    assert.ok(ALLOWED.some((re) => re.test(c)),
      `画面から受け取ったURLを開いていないか: ${c}`);
  }
});

test('録音されるスピーカーは表示だけで、選ばせない', () => {
  // ループバックの取得元は Windows の既定の再生デバイス固定で、
  // アプリから指定する手段が無い。選べる風のUIを出す方が誤解を生む。
  assert.ok(appHtml.includes('id="spkNow"'), 'スピーカーの表示が無い');
  assert.match(appHtml, /id="spkNow"[^>]*readonly/, '編集できてしまう');
  assert.ok(!/<select id="spkSelect"/.test(appHtml), '選択式になっている');
  assert.ok(appHtml.includes('openSoundSettings()'), 'Windows設定への導線が無い');
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
  // 第3段（v0.11.0）で main 側が先に足した API。app 側が同時に実装中で、統合で app.html が
  // 使い始めたらこの一覧を空にする（空にしても通ることを統合時に確かめる）
  const PENDING_APP = new Set(['pagesActionView', 'dataDirGet', 'dataDirMove']);
  for (const [ns, html] of [['koeApp', appHtml], ['koeOverlay', overlayHtml]]) {
    const names = all(/^\s{2}([A-Za-z][\w$]*):/gm, block(ns));
    const used = new Set(all(new RegExp(`${ns}\\.(\\w+)`, 'g'), html));
    const dead = names.filter((n) => !used.has(n) && !PENDING_APP.has(n));
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

// ---------------------------------------------------------------- v0.9.6 の機能の結線
test('会議の所要時間は開始から停止までで計る', () => {
  // 文字起こし待ちを混ぜると、4分の会議が12分と記録される
  assert.match(main, /meeting\.stoppedAt = Date\.now\(\)/);
  assert.match(main, /m\.stoppedAt \|\| Date\.now\(\)/);
  assert.ok(appHtml.includes('(mtStoppedAt || Date.now()) - mtStartedAt'));
});

test('判定材料が無いときの会議タイプは「定例・進捗報告」', () => {
  assert.match(main, /autoType === 'general' \? 'standup' : autoType/);
  assert.ok(appHtml.includes("curPage.meetingType || 'standup'"));
});

test('Markdown保存は IPC ごと撤去済み', () => {
  assert.ok(!appHtml.includes('Markdown保存'));
  assert.ok(!main.includes("'page:export'"));
  assert.ok(!preload.includes('pageExport'));
});

test('閉じるボタンは既定でアプリを終了する（設定でトレイ常駐に戻せる）', () => {
  assert.match(main, /stayInTray:\s*false/);
  assert.match(main, /if \(settings\.stayInTray\) \{ e\.preventDefault\(\); mainWin\.hide\(\); return; \}/);
  assert.ok(appHtml.includes("stayInTray: $('stayInTray').checked"));
});

test('記録を新しく始めたら、開いていた議事録を閉じる', () => {
  assert.ok(appHtml.includes('st.active && !mtWasActive && curId'));
});

test('タイプ変更のアジェンダ挿入は、人が書いたメモを上書きしない', () => {
  // 空か、別タイプの雛形そのままのときだけ差し替える
  assert.match(appHtml, /const isPreset = !cur \|\| mtypes\.some/);
});

test('並べ替えはハンドルからだけ（本文のテキスト選択と衝突させない）', () => {
  assert.match(appHtml, /grip\.onmousedown = \(\) => \{ el\.draggable = true; \}/);
  // 行全体を常時 draggable にしていないこと
  assert.ok(!/el\.draggable = true;\s*$/m.test(appHtml.replace(/grip\.onmousedown.*$/m, '')));
});

// ---------------------------------------------------------------- v0.9.7 の機能の結線
test('文字起こしが切れる問題への3段の対策が入っている', () => {
  // (1) 区切りの見張りは main からの tick（main のタイマーは間引かれない）。
  //     backgroundThrottling: false は Windows で透過ウィンドウの透明を壊すので
  //     使わない（実機でピルの角の外に不透明の矩形が出た）。コメントに語が
  //     残るためコードだけを見る。
  assert.ok(!/backgroundThrottling/.test(code(main)), '透明を壊す設定が残っている');
  assert.match(main, /sendToOverlay\('overlay:tick'/);
  assert.match(main, /function startMeetingTick/);
  assert.ok(preload.includes("onTick: (cb) => ipcRenderer.on('overlay:tick'"));
  assert.ok(overlayHtml.includes('window.koeOverlay.onTick(() => cutSegmentIfOverdue(recorder))'));
  // (2) 時間切れを音声の長さに比例させる（固定240秒で9分の区間が丸ごと消えた）
  assert.match(main, /Math\.max\(240000, Math\.round\(durationMs \|\| 0\) \* 5/);
  assert.match(main, /AbortSignal\.timeout\(waitMs\)/, '計算した待ち時間が使われていない');
  assert.match(main, /transcribeLocal\(buffer, tail, durationMs\)/);
  assert.match(main, /transcribeLocal\(buffer, '', durationMs\)/);
  // (3) 区切りの保険（音声パイプライン由来のイベントで見張る）
  assert.match(overlayHtml,
    /mode === 'meeting' && segDeadline && Date\.now\(\) >= segDeadline/, '区切りの保険が無い');
  // (4) 録音・処理中はOSに眠らせない。updateTray は全ての状態遷移で
  //     呼ばれるので、そこに結線されていることまで見る
  assert.match(main, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
  assert.match(main, /function updateTray\(\) \{\n  updatePowerBlock\(\);/);
});

test('画面の配色の設定が結線されている', () => {
  assert.match(main, /theme:\s*'system'/);
  assert.match(main, /nativeTheme\.themeSource/);
  assert.ok(appHtml.includes("theme: $('themeSel').value"));
  assert.ok(appHtml.includes('@media (prefers-color-scheme: dark)'));
});

test('コピーは開いているタブの中身を写す', () => {
  const cp = appHtml.slice(appHtml.indexOf("mk('コピー'"));
  assert.ok(cp.includes("pane === 'script'"), '文字起こしタブの分岐が無い');
  assert.ok(cp.includes("pane === 'memo'"), 'メモタブの分岐が無い');
});

test('検索は文字起こしだけを対象にする', () => {
  const st = read('src/store.js');
  const fn = st.slice(st.indexOf('function searchFullText'), st.indexOf('function openActions'));
  assert.ok(!fn.includes('inBlocks'), '要約側も検索している');
  assert.ok(fn.includes('getTranscript'));
  assert.ok(appHtml.includes('文字起こし検索'));
  assert.ok(!appHtml.includes('全文検索'));
});

test('一覧に未完了バッジを出さない（高さを一定に保つ）', () => {
  assert.ok(!appHtml.includes('`未完了 ${'), '未完了バッジが残っている');
  assert.match(appHtml, /\.pitem \.t \{[^}]*white-space: nowrap/);
});

test('設定のオン・オフはトグルで表す（議事録のチェックは四角のまま）', () => {
  assert.match(appHtml, /\.check input \{[\s\S]{0,200}?appearance: none/);
  // .blk のチェックボックス（完了の印）には appearance:none を掛けていない
  assert.ok(!/\.blk[^\n]*input[^\n]*\{[\s\S]{0,200}?appearance: none/.test(appHtml));
});

test('画面の名称は「要約タイプ」', () => {
  assert.ok(appHtml.includes('>要約タイプ</span>'));
  assert.ok(!appHtml.includes('>会議タイプ</span>'));
});

test('並べ替えのつまみは6点の1文字', () => {
  assert.ok(appHtml.includes("grip.textContent = '⠿'"));
});

test('要約の文体は報告文書の常体（指示だけでなく例で見せる）', () => {
  assert.ok(main.includes('「です」「ます」は使わない'));
  assert.match(main, /文体は報告文書の常体/);
  // 3Bクラスは指示より例をまねる。実機で指示だけでは効かなかった
  assert.ok(main.includes('良い例:'), '良い例が無い');
  assert.ok(main.includes('悪い例:'), '悪い例が無い');
});

// ---------------------------------------------------------------- レビュー指摘の修正
test('ダーク定義はすべての基底ルールより後ろにある', () => {
  // @media は詳細度に影響しない。前に置くと body / .bg の上書きが
  // カスケード順で負け、地色がライトのまま文字だけ白くなって読めない。
  const mediaAt = appHtml.indexOf('@media (prefers-color-scheme: dark)');
  const bodyAt = appHtml.indexOf('background: #e9edf5');
  const bgAt = appHtml.indexOf('linear-gradient(165deg, #eef2fa');
  assert.ok(mediaAt > 0 && bodyAt > 0 && bgAt > 0);
  assert.ok(mediaAt > bodyAt && mediaAt > bgAt, 'ダーク定義が基底より前にある');
  // ダークで読めなくなる固定色の上書きが入っている
  const dark = appHtml.slice(mediaAt);
  for (const sel of ['button.ghost', '::placeholder', '.atag.who', '.atag.due', '.blob']) {
    assert.ok(dark.includes(sel), `ダーク上書きが無い: ${sel}`);
  }
});

test('ウィンドウの地色がテーマに追従する', () => {
  // ライト固定だとダークで開くたび・リサイズのたびに白くまたたく
  assert.match(main, /backgroundColor: nativeTheme\.shouldUseDarkColors/);
  assert.match(main, /setBackgroundColor\(nativeTheme\.shouldUseDarkColors/);
});

test('区切りの保険は遅延中のタイマーを必ず消してから切る', () => {
  // 消さないと ID を失ったタイマーが生き残り、あとから発火して
  // 「次の」区間を途中で切る。以後ずっとずれが続く
  const guard = overlayHtml.slice(overlayHtml.indexOf("mode === 'meeting' && segDeadline"));
  const upto = guard.slice(0, guard.indexOf('rec.stop()'));
  assert.ok(upto.includes('clearTimeout(autoStopId)'), '旧タイマーを消していない');
});

test('メモのコピーは画面の入力欄の今の文字を写す', () => {
  // 保存は500ms遅れで走る。書いた直後に押すと保存前の古い値が写る
  const cp = appHtml.slice(appHtml.indexOf("mk('コピー'"));
  assert.ok(cp.includes("$('pMemo').querySelector('textarea')"));
});

test('一覧の「要約なし」はタイプ章より左にある（右端で見切れない）', () => {
  const list = appHtml.slice(appHtml.indexOf('function renderList'));
  assert.ok(list.indexOf("textContent = '要約なし'") < list.indexOf('tbadge'),
    '要約なしが右側にあり、狭い幅で見切れる');
});

test('README が現行の機能名と一致している', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('会議タイプ'), '旧名「会議タイプ」が残っている');
  assert.ok(!readme.includes('全文検索'), '旧名「全文検索」が残っている');
  assert.ok(!readme.includes('Markdown書き出し'), '無くなった機能の記述が残っている');
  assert.ok(readme.includes('要約タイプ'));
  assert.ok(readme.includes('文字起こし検索'));
});

// ---------------------------------------------------------------- v0.9.9 の結線
test('エンジンの起動確認は /health を見る', () => {
  // 「/」だと llama-server がモデル読み込み中でも 200 を返し、
  // 準備完了と誤認して直後の推論が 503 になる（実機で発生）
  assert.match(main, /\/health`;/);
  assert.ok(!/`http:\/\/127\.0\.0\.1:\$\{enginePort\(eng\)\}\/`/.test(main), '「/」を見ている');
});

test('要約エンジンの 503 は「準備中」として扱う', () => {
  const fn = main.slice(main.indexOf('async function llmChat'), main.indexOf('async function generateMinutes'));
  assert.match(fn, /res\.status !== 503 \|\| Date\.now\(\) >= deadline/, '待って引き直していない');
  // 待っている間は画面に「準備中」と出す。黙って待つと固まったように見える
  assert.ok(fn.includes('要約エンジンを準備しています'), '待ちの表示が無い');
  // 待ちきれなかったときも「エラー (503)」ではなく準備中だと分かる文で返す
  assert.ok(fn.includes('要約エンジンがまだ準備中です'), '503 が生のエラー文のまま');
  // 3か所の呼び出しすべてが表示付きで呼んでいる
  assert.strictEqual((main.match(/await llmChatP\(/g) || []).length, 3);
});

test('設定は自動保存（保存ボタンは無い）', () => {
  assert.ok(!appHtml.includes('saveBtn'), '保存ボタンが残っている');
  assert.ok(appHtml.includes("$('tabSettings').addEventListener('change'"), '自動保存の結線が無い');
});

test('スレッド数とポートに説明がある', () => {
  assert.ok(appHtml.includes('通常は変更不要です。スレッド数は文字起こしに使うCPUの数'));
  assert.ok(appHtml.includes('2つのエンジンのポートは別の番号にしてください'));
});

// ---------------------------------------------------------------- 検索の本文対応
test('「すべて」の検索が要約の本文とメモに当たる', () => {
  // タイトルと最初の1行しか見ていなかったため、実機で
  // 「検索が全部壊れている」と報告された
  const st = read('src/store.js');
  assert.match(st, /searchText: page\.blocks\.map/);
  const fn = st.slice(st.indexOf('function searchIndex'), st.indexOf('function searchFullText'));
  assert.ok(fn.includes('p.searchText'), '検索が本文を見ていない');
  assert.ok(fn.includes('snippet'), '当たった箇所を見せていない');
  // 古い索引の作り直し（これが無いと既存の議事録は検索に出てこないまま）
  assert.match(st, /typeof index\.pages\[i\]\.searchText === 'string'/);
});

// ---------------------------------------------------------------- 録音バーと設定の並び
test('録音バーは一時停止と停止のボタンを持つ', () => {
  assert.ok(overlayHtml.includes('id="pauseBtn"'), '一時停止ボタンが無い');
  assert.ok(overlayHtml.includes('id="stopBtn"'), '停止ボタンが無い');
  // 停止は赤い四角、一時停止は二本線
  assert.match(overlayHtml, /\.pbtn \.sq \{[\s\S]{0,160}?background: var\(--rec\)/);
  assert.match(overlayHtml, /class="pause-ico"><span class="bar"><\/span><span class="bar">/);
});

test('一時停止は区間を締めてマイクを解放する', () => {
  // 持ったまま止めると再開までの分が同じ区間に混ざり、止めた意味が無くなる。
  // マイクを掴んだままだと、止めたのに録っているように見える。
  const fn = code(overlayHtml).slice(code(overlayHtml).indexOf('function pauseRec'));
  const body = fn.slice(0, fn.indexOf('async function resumeRec'));
  assert.ok(body.includes('recorder.stop()'), '区間を締めていない');
  assert.ok(body.includes('releaseStream()'), 'マイクを解放していない');
  assert.ok(body.includes('reportPause(true)'), 'main へ知らせていない');
});

test('一時停止した時間は会議の長さに含めない', () => {
  // 計算そのものは src/mainlib.js の meetingDurationSec（main.test.js で実行して検査）。
  // ここでは main.js が停止時刻を渡してそれを呼んでいることを見る。
  const lib = read('src/mainlib.js');
  assert.match(lib, /const pausedTotal = .*pausedMs/);
  assert.match(lib, /m\.startedAt - pausedTotal/);
  assert.match(main, /const endAt = m\.stoppedAt \|\| Date\.now\(\);/);
  assert.match(main, /meetingDurationSec\(m, endAt\)/, '所要時間を純関数で計算していない');
  assert.ok(appHtml.includes('- mtPausedMs'), '画面の時計が一時停止を引いていない');
});

test('一時停止中は無音警告も区間の切り出しも動かない', () => {
  const c = code(overlayHtml);
  assert.match(c, /function checkSilence\([^)]*\) \{\s*if \(stopping \|\| cancelled \|\| paused/);
  assert.match(c, /function cutSegmentIfOverdue\([^)]*\) \{\s*if \(paused\) return;/);
  // main 側の「一時停止中は合図を送らない」は mainlib.tickStep の判断（main.test.js で実行）。
  // ここでは interval が tickStep に overlay:tick を送る手を渡していることだけ見る
  assert.match(code(main), /tickStep\(\{ state, meeting \},\s*\(\) => sendToOverlay\('overlay:tick', \{\}\)/);
});

test('議事録の破棄ボタンは録音バーに出さない（誤操作で会議が消える）', () => {
  assert.match(overlayHtml, /\.pill\.meeting \.pbtn\.ng \{ display: none; \}/);
});

test('設定カードの並びは指定通り', () => {
  const heads = [...appHtml.matchAll(/<h2>(.+?)<\/h2>/g)].map((m) => m[1]);
  assert.deepStrictEqual(heads, [
    'アップデート',
    '動作',
    'ユーザー辞書（認識ヒント）',
    '文字起こしエンジン（whisper.cpp・オフライン）',
    '要約エンジン（llama.cpp・オフライン）— 議事録の自動要約に使用',
  ]);
});

test('録音バーは暗色地に合った色で描く', () => {
  // ピルを暗色にしたのに描画色を明るい地のままにすると、
  // 波形もスピナーも見えなくなる（実機で波形が真っ黒になった）
  const c = code(overlayHtml);
  assert.match(c, /ctx2d\.fillStyle = paused \? 'rgba\(255,255,255/, '波形が暗いまま');
  assert.ok(!/rgba\(27,\s*30,\s*37/.test(c), '明るい地向けの墨色が残っている');
});

test('録音バーに外向きの影を付けない', () => {
  // Windows の透過ウィンドウでは影がウィンドウの矩形に落ち、
  // ピルの外側にうっすら灰色の四角が見える（実機で発生）
  // コメントを落としてから見る。説明文の中の語に反応しては意味がない
  const pill = code(overlayHtml.slice(overlayHtml.indexOf('.pill {'), overlayHtml.indexOf('.pill.visible')));
  const shadows = [...pill.matchAll(/box-shadow:([^;]*);/g)].map((m) => m[1]);
  for (const sh of shadows) {
    assert.ok(!/(^|,)\s*0 /.test(sh.replace(/inset[^,]*/g, '')), `外向きの影がある: ${sh.trim()}`);
  }
  assert.ok(!pill.includes('backdrop-filter'), '透過ウィンドウで矩形が出る backdrop-filter が残っている');
  assert.match(main, /hasShadow: false/, 'ウィンドウの影が有効になっている');
});

// ---------------------------------------------------------------- HTMLの入れ子
//
// カードを並べ替えたとき、スクロール枠を閉じる </div> が最後のカードに
// くっついて移動し、残りのカードが枠の外へ出て画面から消えた（実機で発生）。
// 見出しの並びだけを見るテストでは通ってしまうので、入れ子も検査する。
function divDepthMap(html) {
  const out = [];
  let depth = 0;
  for (const line of html.split('\n')) {
    depth += (line.match(/<div\b/g) || []).length - (line.match(/<\/div>/g) || []).length;
    const h = line.match(/<h2>(.+?)<\/h2>/);
    if (h) out.push({ title: h[1], depth });
  }
  return { heads: out, depth };
}

test('設定の各カードが同じ深さにある（枠の外に出ていない）', () => {
  const a = appHtml.indexOf('<section id="tabSettings"');
  const sec = appHtml.slice(a, appHtml.indexOf('    </section>', a));
  const { heads, depth } = divDepthMap(sec);
  assert.strictEqual(depth, 0, '設定セクションの div が閉じ切れていない');
  assert.strictEqual(heads.length, 5);
  for (const h of heads) {
    assert.strictEqual(h.depth, heads[0].depth, `「${h.title}」だけ深さが違う（枠の外に出ている）`);
  }
});

test('画面全体で div の開閉が合っている', () => {
  for (const [name, html] of [['app.html', appHtml], ['overlay.html', overlayHtml]]) {
    const o = (html.match(/<div\b/g) || []).length;
    const c = (html.match(/<\/div>/g) || []).length;
    assert.strictEqual(o, c, `${name} の div が ${o} 対 ${c} で合っていない`);
  }
});

// ---------------------------------------------------------------- 要素の存在
//
// 設定カードを並べ替えた際に、最後のカードより後ろにあった要素
// （データ保存先を開くボタン等）ごと切り落とし、初期化が
// null への代入で止まって設定画面が空になった（実機で発生）。
test('画面が参照する要素がすべてHTMLに存在する', () => {
  // 動的に作る要素だけを除外する。ここに足すときは、
  // 必ず「無ければ作る」側のコードがあることを確かめること。
  const DYNAMIC = new Set(['liveBar']);
  for (const [name, html] of [['app.html', appHtml], ['overlay.html', overlayHtml]]) {
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    for (const u of used) {
      if (DYNAMIC.has(u)) continue;
      assert.ok(ids.has(u), `${name}: 参照している要素 #${u} が無い`);
    }
  }
});

test('設定を読み込む前に保存しない', () => {
  // 自動保存があるので、初期化に失敗して画面が空のまま何かに触れると
  // 空の値でディスク上の設定を上書きしてしまう
  assert.match(appHtml, /if \(!settingsLoaded\) \{/);
  assert.match(appHtml, /fill\(settings\);\s*\n\s*settingsLoaded = true;/);
});

test('更新の導線が画面に依存しない（トレイからも確認できる）', () => {
  // 画面の組み立てが1か所つまずくと設定タブの「更新を確認」ごと死に、
  // アプリ内更新で直すこともできなくなった（実機で発生）。
  // 復旧の手段が、壊れうるものに依存していてはいけない。
  assert.match(main, /label: '更新を確認'[^}]*click: checkUpdateFromTray/);
  assert.match(main, /async function checkUpdateFromTray\(\)/);
  const fn = main.slice(main.indexOf('async function checkUpdateFromTray'), main.indexOf('function updateTray'));
  assert.ok(fn.includes('updater.check('), '確認していない');
  assert.ok(fn.includes('updater.apply('), '適用していない');
  assert.ok(fn.includes('r.url'), 'zipのURLの受け取り方が check() の戻り値と合っていない');
  assert.ok(fn.includes('app.relaunch()'), '再起動していない');
});

// ---------------------------------------------------------------- 監査指摘の修正（main 側）
const fnBody = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${from} が無い`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j > 0 ? j : src.length);
};

test('#46 要約完了時に手元の古い page で書き戻さない（削除した議事録が復活する）', () => {
  // 「store.getPage(pageId) || page」は、要約中に削除されたページを
  // 古いコピーから復活させる。無ければ破棄する（判断は mainlib.saveIfExists）。
  const fn = fnBody(code(main), 'async function doRunSummary', '\nlet hotkeyState');
  assert.ok(!/getPage\(pageId\)\s*\|\|\s*page\b/.test(fn), '「getPage(pageId) || page」のフォールバックが残っている');
  assert.ok(!/store\.savePage\(/.test(fn), '存在確認を挟まずに savePage している');
  assert.ok((fn.match(/saveIfExists\(store, pageId/g) || []).length >= 4,
    '空・未設定・成功・失敗の全経路が saveIfExists を通っていない');
  assert.ok(fn.includes('ページが削除されました'), '削除済みのときの戻り値が無い');
  // 保存できなかった（= 削除済み）ことを全経路が見ている
  assert.ok((fn.match(/if \(!(saved|latest)\) return gone\(\);/g) || []).length >= 4, '削除済みを見ずに進む経路がある');
});

test('#10 同じページの要約は同時に一つだけ走る', () => {
  // 排他の判断は mainlib.makeSummaryRunner（実行して検査するのは main.test.js）。
  // ここは main.js がそれを通しているか（結線）だけを見る。
  assert.match(main, /const runSummary = makeSummaryRunner\(doRunSummary(, \(\) => updateTray\(\))?\)/, '排他を mainlib.makeSummaryRunner で作っていない');
  assert.ok(!/new Map\(\)[^\n]*\n[^\n]*function runSummary/.test(code(main)) && !/const summarizing = new Map\(\)/.test(code(main)),
    '排他を main.js に手書きしている（mainlib を通していない）');
  assert.match(main, /ipcMain\.handle\('page:summarize', \(_e, id\) => runSummary\(id\)\)/);
  assert.match(main, /await runSummary\(page\.id\)/, '議事録終了後の要約が排他を通っていない');
});

test('#12 一時停止しても overlay:tick の見張りを消さない', () => {
  // 送る／飛ばす／消す の判断は mainlib.tickStep（実行して検査するのは main.test.js）。
  // ここは interval の中でそれを通しているか（結線）だけを見る。
  const fn = fnBody(code(main), 'function startMeetingTick', '\nfunction applyTheme');
  assert.ok(fn.includes('tickStep({ state, meeting }'), 'interval の中で mainlib.tickStep を通していない');
  assert.ok(fn.includes("sendToOverlay('overlay:tick', {})"), '合図を送る手を渡していない');
  const clearing = fn.split('\n').filter((l) => l.includes('clearInterval'));
  assert.ok(clearing.length > 0, '見張りを消す手を渡していない');
  for (const l of clearing) assert.ok(!l.includes('paused'), `一時停止で見張りを消している: ${l.trim()}`);
  assert.ok(!/paused/.test(fn), '判断を main.js に手書きしている（mainlib を通していない）');
});

test('#14 一時停止したまま停止したら、停止時刻で一時停止を締める', () => {
  const fn = fnBody(code(main), 'function stopMeeting()', '\nfunction discardMeeting');
  assert.ok(fn.indexOf('meeting.stoppedAt = Date.now()') < fn.indexOf('meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt'));
  assert.ok(fn.includes('meeting.paused = false'));
});

test('#15 次の区間の初期プロンプトは直近の成功区間から取る', () => {
  assert.match(main, /const tail = promptTail\(m\.segments\);/);
  assert.match(main, /transcribeLocal\(buffer, tail, durationMs\)/);
});

test('#26 設定の正規化は起動時と保存時の両方で通す', () => {
  assert.match(main, /require\('\.\/settings'\)/);
  const load = fnBody(code(main), 'function loadStores()', '\n}');
  assert.match(load, /settings = normalizeSettings\(\{ \.\.\.DEFAULT_SETTINGS, \.\.\.loadJson\(settingsPath\(\), \{\}\) \}, DEFAULT_SETTINGS\)/);
  const save = fnBody(code(main), "ipcMain.handle('settings:save'", '\n  });');
  assert.match(save, /const merged = normalizeSettings\(\{ \.\.\.settings, \.\.\.next \}, DEFAULT_SETTINGS\)/);
  assert.ok(!/Math\.max\(1024, Math\.min\(65535/.test(save), '保存時だけの手書きのクランプが残っている');
  // 正規化をすり抜けた不正なポートは、エンジンの起動待ちで TypeError になる。
  // 90秒のタイムアウトまで黙って待たず、設定の問題だと分かる文で返す。
  const ready = fnBody(code(main), 'function ensureEngineReady', '\nfunction restartEnginesIfNeeded');
  assert.ok(ready.includes('e instanceof TypeError'), 'TypeError を起動中と区別していない');
  assert.ok(ready.includes('接続先（ポート設定）が不正です'));
});

test('#35/#49 ホットキーは片方ずつ登録し、失敗を画面とトレイに伝える', () => {
  // 登録は独立（全か無かにしない）
  const apply = fnBody(code(main), 'function applyHotkeys', '\n}');
  assert.ok(apply.includes('registerHotkeys('), '独立登録の純関数を通っていない');
  assert.ok(!apply.includes('unregisterAll(); return { ok: false'), '片方の失敗で両方を解除している');
  // 保存時: 判断は mainlib.saveHotkeys。失敗した側だけ前の値に戻し、他の設定は保存する。
  // 設定として残ったキーを applied で画面に返す（画面はこれを欄に戻す。失敗したキーが
  // 欄に残ると、以後の無関係な保存のたびに再失敗して警告が出続ける）
  const save = fnBody(code(main), "ipcMain.handle('settings:save'", '\n  });');
  assert.ok(!save.includes("return { ok: false, error: `${r.which}"), '全体を失敗として返している');
  assert.ok(save.includes('saveHotkeys(settings, activeHotkeys, merged, applyHotkeys)'), 'mainlib.saveHotkeys を通していない');
  assert.ok(save.includes('merged.hotkey = hk.applied.hotkey') && save.includes('merged.meetingHotkey = hk.applied.meetingHotkey'), '戻した値を設定に反映していない');
  assert.ok(save.includes('activeHotkeys = hk.active') && save.includes('hotkeyState = hk.state') && save.includes('hotkeyNote = hk.note'),
    '実際に登録したキー・状態・トレイの注記を残していない');
  assert.match(save, /const applied = \{ hotkey: settings\.hotkey, meetingHotkey: settings\.meetingHotkey \}/, '設定として残ったキーを applied に組んでいない');
  assert.match(save, /return warning \? \{ ok: true, applied, warning \} : \{ ok: true, applied \}/, '画面が欄に戻す applied を返していない');
  // 起動時: 失敗した側だけ既定に落とす。settings（メモリもディスクも）には書かず、有効なキーは
  // activeHotkeys に持つ。settings に書くと settings:get が既定を返し、次の保存でディスクに漏れる
  assert.match(main, /let hotkeyState = \{ ok: true, failed: \[\], fallback: \{\}, message: '' \}/);
  assert.match(main, /let activeHotkeys = \{ hotkey: /, '実際に登録しているキーを持つ変数が無い');
  const boot = fnBody(code(main), 'resolveStartupHotkeys(', '\n    if (engineValid(whisperEng))');
  assert.ok(!boot.includes('persistSettings'), '起動時のホットキーの失敗で設定をディスクに書いている');
  assert.ok(!/settings\.(hotkey|meetingHotkey)\s*=/.test(boot), '起動時の退避を settings に書いている（settings:get が既定を返し、次の保存でディスクに漏れる）');
  assert.ok(boot.includes('activeHotkeys = r.active'), '実際に登録したキーを activeHotkeys に残していない');
  assert.ok(boot.includes('hotkeyState = r.state'), '起動時の結果を hotkeyState に残していない');
  // 画面から状態を引ける。settings:get は利用者の設定をそのまま返す
  assert.match(main, /ipcMain\.handle\('hotkey:state', \(\) => hotkeyState\)/);
  assert.match(main, /ipcMain\.handle\('settings:get', \(\) => settings\)/);
  assert.ok(preload.includes("  hotkeyState: () => ipcRenderer.invoke('hotkey:state'),"));
  // トレイは実際に登録しているキーを出し、「（…: 既定の … を使用中）」「（… は登録できず）」を添える
  const tray = fnBody(code(main), 'function updateTray()', '\nfunction createTray');
  assert.ok(tray.includes('hotkeyNote'), 'トレイに登録できなかったキーの注記が無い');
  assert.ok(tray.includes('activeHotkeys.hotkey') && tray.includes('activeHotkeys.meetingHotkey'), 'トレイが実際に登録しているキーを出していない');
  assert.ok(!/settings\.(hotkey|meetingHotkey)/.test(tray), 'トレイが設定のキーを出している（退避中は効かないキーが表示される）');
});

test('#18 テンプレートの写しを落とす結線（minutes.dropTemplateEcho が無ければ素通し）', () => {
  assert.match(main, /const dropTemplateEcho = minutes\.dropTemplateEcho \|\| \(\(b\) => b\)/);
  assert.match(main, /dropTemplateEcho\(dropRedundantEmpty\(markdownToBlocks\(md\)\), minutesTemplate\(page\.meetingType\)\)/);
  // プロンプトに入れている書式と同じ文字列を渡す（別々に組み立てるとずれる）
  const gen = fnBody(code(main), 'async function generateMinutes', '\nfunction ensurePaster');
  assert.strictEqual((gen.match(/\$\{minutesTemplate\(type\)\}/g) || []).length, 2, 'プロンプト側がテンプレート関数を使っていない');
});

// ---------------------------------------------------------------- 第2段（D: 小さな直し）
test('#51 議事録の日付はローカルの暦日で作る（UTC の toISOString で日付を作らない）', () => {
  // 計算は src/dates.js の localDateISO（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  assert.ok(!m.includes('toISOString().slice(0, 10)'), 'UTC の日付が残っている');
  assert.match(m, /require\('\.\/dates'\)/, 'dates.js を読み込んでいない');
  assert.strictEqual((m.match(/date: localDateISO\(dt\)/g) || []).length, 2, '復旧と保存の両方で使っていない');
});

test('#56 マイクの代替（要求したマイクが無く既定で録っている）を main が受けて画面へ渡す', () => {
  assert.ok(preload.includes("  reportMic: (info) => ipcRenderer.send('overlay:mic', info),"), 'preload の reportMic が無い');
  const m = code(main);
  assert.match(m, /ipcMain\.on\('overlay:mic'/, 'main に受け口が無い');
  const st = fnBody(m, 'function meetingStatus()', '\n}');
  assert.ok(st.includes('micFallback'), 'meetingStatus に micFallback が無い');
  const on = fnBody(m, "ipcMain.on('overlay:mic'", '\n  });');
  assert.ok(on.includes('meeting.micFallback = !!(info && info.requested && !info.matched)'), '要求したのに合わなかった、を代替としていない');
  assert.ok(on.includes("sendToMainWin('meeting:update', meetingStatus())"), '画面へ知らせていない');
});

test('#27 クリップボードへ書くのは copyPrivate だけ（履歴・クラウド同期から除外する）', () => {
  // 除外書式そのものは mainlib.pasterScript（main.test.js で検査）。ここは
  // 「書く入口が 1 つで、貼り付けもコピーもそこを通る」ことを見る
  const m = code(main);
  assert.strictEqual((m.match(/clipboard\.writeText\(/g) || []).length, 1, 'clipboard.writeText が copyPrivate 以外にもある');
  const fn = fnBody(m, 'async function copyPrivate(', '\n}');
  assert.ok(fn.includes('copyCommand('), '常駐 PowerShell に除外印付きで置かせていない');
  assert.ok(fn.includes('clipboard.writeText('), 'PowerShell が置けなかったとき Electron で書いていない（何も残らない）');
  // 先に Electron で書くと、その最初の書き込みが履歴・クラウド同期に採られる（除外印は後から付けても消えない）
  assert.ok(fn.indexOf('copyCommand(') < fn.indexOf('clipboard.writeText('), 'Electron の書き込みが PowerShell の置き直しより先にある（最初の書き込みが履歴に採られる）');
  assert.ok(fn.includes('if (clipEquals(readClipboardText(), t)) return;'), '置けたことを読み返して確かめていない（確かめずに Electron で書けば元の木阿弥）');
  const deliver = fnBody(m, 'async function deliverText(', '\n}');
  assert.ok(deliver.includes('await copyPrivate(text)'), '自動貼り付けが置き終わるのを待たずに貼っている');
  assert.ok(deliver.includes('clipboard.readText()'), '貼り付け後に戻す元の中身を読んでいない');
  assert.ok(deliver.includes('restoreAfterPaste(prev, text)'), '戻すかの判断を mainlib.restoreAfterPaste で行っていない');
  assert.match(m, /const RESTORE_DELAY_MS = 2000;/, '戻すまでの間が 2 秒でない（読み取りの遅いアプリで古い方が貼られる）');
  assert.match(m, /ipcMain\.handle\('clipboard:copy', async \(_e, t\) => \{ await copyPrivate\(/, '画面のコピーが copyPrivate を（待って）通っていない');
  assert.ok(fnBody(m, 'function ensurePaster()', '\n}').includes('pasterScript()'), '常駐 PowerShell のスクリプトを mainlib から取っていない');
});

// ---------------------------------------------------------------- 第2段（B: エンジン）
test('#28/#31 起動前にポートの空きを見て、塞がっていれば spawn しない', () => {
  const m = code(main);
  assert.match(m, /require\('net'\)/, 'net を使っていない');
  const fn = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(fn.includes('await portInUse('), 'ポートの空きを見ていない');
  assert.ok(fn.indexOf('await portInUse(') < fn.indexOf('spawn('), 'spawn の後でポートを見ている');
  assert.ok(fn.includes('eng.lastError = portInUseError(port)'), '塞がっているときの文を mainlib から取っていない');
  assert.ok(fn.includes('if (quitting) return;'), '終了中に待ち明けで起動してしまう（孤児プロセスになる）');
  // 同時に二度呼ばれても spawn は一度だけ
  assert.ok(fn.includes('if (eng.startPromise) return eng.startPromise;'), '起動中の二重呼び出しを束ねていない');
  const probe = fnBody(m, 'function portInUse(port', '\n}');
  assert.ok(probe.includes("host: '127.0.0.1'") && probe.includes('exclusive: true'), 'listen の条件が違う');
  assert.ok(probe.includes("'EADDRINUSE'"), 'EADDRINUSE 以外を使用中と誤認する');
});

test('#57(1) エンジンのハンドラは自分が起動したプロセスのときだけ状態を触る', () => {
  const fn = fnBody(code(main), 'function startEngine(eng)', '\nfunction stopEngine');
  assert.match(fn, /p = spawn\(engineExe\(eng\)/, 'spawn の戻りをローカルに持っていない');
  assert.ok((fn.match(/if \(eng\.proc !== p\) return;/g) || []).length >= 3, 'exit / error / stderr の全部で自分のプロセスか見ていない');
  // /health の応答が返るまでの間に再起動されていたら、その応答で準備完了にしない
  const ready = fnBody(code(main), 'function ensureEngineReady', '\nfunction restartEnginesIfNeeded');
  assert.ok(ready.includes('await startEngine(eng)'), '非同期になった起動を待っていない');
  const afterFetch = ready.slice(ready.indexOf('await fetch(url'));
  assert.match(afterFetch, /^[^\n]*\n\s*if \(eng\.proc !== p\) continue;/, 'fetch の直後に自分のプロセスか見ていない');
});

test('#32 エンジンの実行ファイルとモデルは存在だけでなく中身の有無と大きさを見る', () => {
  const m = code(main);
  assert.match(m, /const engineValid = \(e\) => !engineCheck\(e\)/, 'engineValid が engineCheck を通っていない');
  const chk = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.strictEqual((chk.match(/engineFileIssue\(/g) || []).length, 2, '実行ファイルとモデルの両方を見ていない');
  assert.ok(chk.includes('engineIssueMessage('), '原因を名指しする文を mainlib から取っていない');
  // 床はモデルだけ（実行ファイルの大きさでは判断しない。上流が薄いランチャにした）
  assert.match(m, /whisper: 50_000_000/); assert.match(m, /gguf: 300_000_000/);
  // 設定画面の「テスト」も原因を名指しする
  assert.ok(!m.includes('またはモデルファイルのパスが正しくありません'), 'テストの失敗が原因を名指ししていない');
});

test('#57(2) 記録中はエンジンに関わる設定を変えず、留めた値を applied で画面へ戻す', () => {
  const save = fnBody(code(main), "ipcMain.handle('settings:save'", '\n  });');
  // 音声入力（recording）の最中も同じ: 文字起こし中に whisper を再起動すると、その発話が失われる
  assert.ok(save.includes("guardEngineSettings(settings, merged, Boolean(meeting) || state === 'recording')"), 'mainlib.guardEngineSettings を（音声入力中も）通していない');
  assert.ok(save.includes('if (!guard.kept.length) restartEnginesIfNeeded();'), '留めたのにエンジンを再起動している');
  assert.ok(save.includes('Object.assign(applied, keptDifferent(next, settings))'), '留めた値を applied に載せていない');
  assert.ok(save.includes('guard.warning'), '警告を画面へ返していない');
});

test('#52 要約中はアプリを「忙しい」として扱う', () => {
  const m = code(main);
  assert.match(m, /const isSummarizing = \(\) => runSummary\.running\(\)\.length > 0/);
  assert.match(m, /const runSummary = makeSummaryRunner\(doRunSummary, \(\) => updateTray\(\)\)/, '件数の増減でトレイ・省電力を更新していない');
  assert.ok(fnBody(m, 'function updatePowerBlock()', '\n}').includes("state !== 'idle' || isSummarizing()"), '省電力の抑止が要約中に外れる');
  const close = fnBody(m, "mainWin.on('close'", '\n  });');
  assert.ok(close.includes('closeConfirm(') && close.includes('isSummarizing()'), '閉じる確認が要約中を見ていない');
  assert.match(m, /label: '更新を確認', enabled: state === 'idle' && !isSummarizing\(\)/, 'トレイの更新が要約中に押せる');
  assert.ok(fnBody(m, "ipcMain.handle('app:restart'", '\n  });').includes('要約を作成中です'), '再起動を拒んでいない');
  assert.ok(fnBody(m, "ipcMain.handle('update:apply'", '\n  });').includes('要約を作成中です'), '更新の適用を拒んでいない');
  assert.ok(fnBody(m, 'async function checkUpdateFromTray()', '\nfunction updateTray').includes('要約を作成中です'), 'トレイからの更新を拒んでいない');
  const bq = fnBody(m, "app.on('before-quit'", '\n  });');
  assert.ok(bq.includes('runSummary.running()') && bq.includes('要約が中断されました。「要約を生成」で作り直せます'), '終了時に中断をページへ書いていない');
  // 終了中に要約の失敗を書き戻すと、上の「中断」の文を上書きする
  assert.match(fnBody(m, 'async function doRunSummary', '\nlet hotkeyState'), /catch \(e\) \{\n\s*if \(quitting\) return/);
});

// ---------------------------------------------------------------- 第2段（C: 要約とプロンプト）
test('#16 分割要約が切れたら半分に割ってやり直し、それでも切れたパートを名指しする', () => {
  // やり直しの判断は mainlib.extractNotes、文は mainlib.truncationMessage（main.test.js で実行）
  const gen = fnBody(code(main), 'async function generateMinutes', '\nfunction ensurePaster');
  assert.ok(gen.includes('await extractNotes('), 'やり直しを mainlib.extractNotes で行っていない');
  assert.ok(gen.includes('truncatedParts.push(i + 1)'), '切れたパート番号を記録していない');
  assert.ok(gen.includes('（※パート${i + 1}の抽出は途中で切れています）'), '要点メモに注記していない');
  assert.match(gen, /return \{ md: one\.text, truncated: one\.truncated, truncatedParts: \[\], finalTruncated: one\.truncated \}/);
  assert.match(gen, /truncatedParts, finalTruncated: final\.truncated \}/);
  const run = fnBody(code(main), 'async function doRunSummary', '\nlet hotkeyState');
  assert.ok(run.includes('saved.summaryError = truncationMessage(truncatedParts, finalTruncated)'), '文を mainlib.truncationMessage から取っていない');
  assert.ok(!code(main).includes('要約が長さの上限で打ち切られた可能性があります'), '文が main.js に手書きのまま残っている');
});

test('#23 初期プロンプトは予算（UTF-8 バイト）に収め、辞書の収まり具合を画面へ返せる', () => {
  // 予算の判断は mainlib.buildPromptParts（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  assert.match(m, /const PROMPT_LIMIT_BYTES = PROMPT_MAX_CHARS \* 3/, '予算が文字数 × 3 バイトになっていない');
  const pp = fnBody(m, 'function promptParts(', '\n}');
  assert.ok(pp.includes('buildPromptParts({'), 'mainlib.buildPromptParts を通していない');
  for (const k of ['ja,', 'sample: PROMPT_SAMPLE', 'dictionary: settings.dictionary', 'useBuiltinTerms: settings.useBuiltinTerms',
    'builtinTerms: BUILTIN_TERMS', 'tail: extraTail', 'limitBytes: PROMPT_LIMIT_BYTES']) {
    assert.ok(pp.includes(k), `${k} を渡していない`);
  }
  assert.match(m, /function buildPrompt\(extraTail\) \{ return promptParts\(extraTail\)\.prompt; \}/);
  const info = fnBody(m, "ipcMain.handle('prompt:info'", '\n  });');
  assert.ok(info.includes("promptParts('')"), '尻尾なしで数えていない');
  assert.ok(info.includes('kept: r.kept') && info.includes('total: r.total') && info.includes('over: r.over'), '{ ok, kept, total, over } の形で返していない');
  assert.ok(preload.includes("  promptInfo: () => ipcRenderer.invoke('prompt:info'),"), 'preload の promptInfo が無い');
});

test('#4 出典は要約の材料にした配列と今の配列の両方から付ける（cite 側が無ければ従来どおり）', () => {
  assert.match(main, /const attachAcross = cite\.attachCitationsAcross \|\| \(\(b, f\) => attachCitations\(b, f\.filter\(\(s\) => !s\.failed\)\)\)/,
    'cite.attachCitationsAcross への切り替え（無ければ素通し）が無い');
  const run = fnBody(code(main), 'async function doRunSummary', '\nlet hotkeyState');
  assert.ok(run.includes('const segmentsAtStart = segments;'), '入口で読んだ配列を取っておいていない');
  assert.ok(run.includes('const stat = attachAcross(blocks, fresh, segmentsAtStart);'), '両方の配列を渡していない');
});

// ---------------------------------------------------------------- 第2段（A: 音声の退避・復旧・背圧・進捗・打ち切り）
test('#8/#42(1) 区間の音声は文字起こしの前にディスクへ退避し、draft に「待ち」として控える', () => {
  const m = code(main);
  assert.match(m, /path\.join\(app\.getPath\('userData'\), 'data', 'segbuf'\)/, '退避先が <userData>/data/segbuf ではない');
  const spool = fnBody(m, 'function spoolSegment(', '\n}');
  assert.ok(spool.includes('mkdirSync') && spool.includes('renameSync'), '一時ファイル経由で書いていない');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok(on.includes('pending: true'), '区間を「待ち」として控えていない');
  assert.ok(on.includes('spoolSegment('), '音声を退避していない');
  assert.ok(on.indexOf('spoolSegment(') < on.indexOf('segChain = segChain.then'), '文字起こしの列に入れる前に退避していない');
  assert.ok(on.indexOf('writeDraft()') < on.indexOf('segChain = segChain.then'), '列に入れる前に draft へ書いていない');
  assert.ok((on.match(/settleSegment\(m, seg/g) || []).length >= 3, '成功・失敗・空 の全部で同じ要素を置き換えていない');
  const settle = fnBody(m, 'function settleSegment(', '\n}');
  assert.ok(settle.includes('unlinkQuiet(seg.wav)') && settle.includes('delete seg.pending') && settle.includes('delete seg.wav'),
    '置き換え時に wav を消し pending/wav を外していない');
  // 画面・保存・要約は「待ち」の区間とパスを見ない
  assert.ok(fnBody(m, 'function meetingStatus()', '\n}').includes('publicSegments(meeting.segments)'), '画面へパスが漏れる');
  assert.ok(fnBody(m, 'async function maybeFinalizeMeeting', '\nconst runSummary').includes('segments: settledSegments(m.segments)'), '保存に待ちの区間が混ざる');
  assert.match(fnBody(m, 'async function doRunSummary', '\nlet hotkeyState'), /const usable = segments\.filter\(\(s\) => !s\.failed && !s\.pending\)/);
  assert.ok(fnBody(m, 'function discardMeeting()', '\n}').includes('cleanupSegbuf(m)'), '破棄で退避した音声を消していない');
  // 復旧: 待ちの区間は draft からページに載せるとき失敗扱いにする（判断は mainlib.recoverSegments）
  assert.ok(fnBody(m, 'function recoverDraftIfAny()', '\n}').includes('recoverSegments(d.segments'), '復旧で待ちの区間を直していない');
});

test('#8/#42(2) 復旧ページの「文字起こし待ち」は起動後に文字起こしして差し替え、古い退避フォルダは消す', () => {
  const m = code(main);
  // エンジンの用意待ち（transcribeRecovered）と区間ごとの処理（transcribeRecoveredItems）に分かれている
  const fn = fnBody(m, 'async function transcribeRecovered()', '\n}') + fnBody(m, 'async function transcribeRecoveredItems(', '\n}');
  assert.ok(fn.includes('await ensureEngineReady(whisperEng)'), 'エンジンの用意を待っていない');
  assert.ok(fn.includes('store.updateSegment(q.pageId, item.id, { text })'), '成功した区間を store.updateSegment で差し替えていない（failed が残る）');
  assert.ok(fn.includes('unlinkQuiet(item.wav)'), '文字起こした wav を消していない');
  assert.ok(fn.includes('（この区間の認識に失敗: '), '失敗した区間に失敗の文を残していない');
  assert.ok(fn.includes('removeDirIfEmpty(q.dir)'), '空になった退避フォルダを消していない');
  assert.ok(fn.includes("sendToMainWin('page:updated'"), '開いている復旧ページの文字起こしを描き直していない');
  const boot = fnBody(m, 'app.whenReady().then(', '\n  });');
  assert.ok(boot.includes('transcribeRecovered()'), '起動時に復旧の文字起こしを始めていない');
  assert.ok(boot.includes('cleanOrphanSegbuf('), '起動時に古い退避フォルダを掃除していない');
  assert.ok(boot.indexOf('recoverDraftIfAny()') < boot.indexOf('cleanOrphanSegbuf('), '復旧より先に掃除している（復旧中のフォルダを消しうる）');
  const clean = fnBody(m, 'function cleanOrphanSegbuf(', '\n}');
  assert.ok(clean.includes('staleSegbufDirs('), '7 日の判断を mainlib.staleSegbufDirs で行っていない');
  assert.ok(clean.includes('if (dir === keepDir) continue;'), '復旧中のフォルダを消しうる');
});

test('#42(3) 文字起こしが追いつかないときは区間を伸ばして送る回数を減らし、追いついたら戻す', () => {
  // 判断は mainlib.nextSegmentMs（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  const bp = fnBody(m, 'function applyBackpressure(', '\n}');
  assert.ok(bp.includes('nextSegmentMs(pendingSegs, '), '判断を mainlib.nextSegmentMs で行っていない');
  assert.ok(bp.includes("sendToOverlay('overlay:segment-ms', next)"), 'オーバーレイへ区間の長さを送っていない');
  assert.ok(bp.includes('if (next === m.segmentMs) return;'), '変わっていないのに送っている');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok(on.includes('pendingSegs++;\n  applyBackpressure(m, 1);'), '増えたときに見ていない');
  assert.ok(on.includes('pendingSegs = Math.max(0, pendingSegs - 1); applyBackpressure(m, -1);'), '減ったときに見ていない');
  assert.ok(fnBody(m, 'function startMeeting()', '\nfunction stopMeeting').includes('segmentMs: (settings.segmentSec || 75) * 1000'), '開始時の長さを持っていない');
  assert.ok(preload.includes("  onSegmentMs: (cb) => ipcRenderer.on('overlay:segment-ms', (_e, ms) => cb(ms)),"), 'preload の onSegmentMs が無い');
});

test('#42(4) 残り時間の見積もり（etaSec）と打ち切った数（skipped）を meetingStatus で返す', () => {
  // 見積もりの計算は mainlib.EtaTracker（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  assert.match(m, /const eta = new EtaTracker\(\)/, '見積もりを mainlib.EtaTracker で行っていない');
  const st = fnBody(m, 'function meetingStatus()', '\n}');
  assert.ok(st.includes('etaSec:') && st.includes('skipped:'), 'etaSec / skipped が無い');
  const etaFn = fnBody(m, 'function etaSecOf(m)', '\n}');
  assert.ok(etaFn.includes('pendingDurationMs(m.segments)'), '残りの待ちを区間の長さから数えていない');
  assert.ok(etaFn.includes('m.inFlightSince'), '進行中の区間で経過した分を引いていない');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok(on.includes('eta.record(Date.now() - t0, durationMs)'), '成功した区間で学習していない');
  assert.ok(on.indexOf('eta.record(') > on.indexOf('} catch (e) {'), '失敗した区間まで学習している');
  assert.ok(on.includes('m.inFlightSince = t0') && on.includes('m.inFlightSince = 0'), '進行中の区間の開始時刻を持って・戻していない');
});

test('#42(5) 終了後の文字起こし待ちは打ち切れる（meeting:skipPending）', () => {
  // 区間の書き換えは mainlib.skipPendingSegments（main.test.js で実行）。ここは結線だけ見る
  const m = code(main);
  const h = fnBody(m, "ipcMain.handle('meeting:skipPending'", '\n  });');
  assert.ok(h.includes('if (!meeting || !meeting.stopping) return { ok: false'), '記録中（終了前）に打ち切れてしまう');
  assert.ok(h.includes('m.gen++'), '進行中の結果を無効にしていない');
  assert.ok(h.includes('skipPendingSegments(m.segments)'), '区間の書き換えを mainlib.skipPendingSegments で行っていない');
  assert.ok(h.includes('unlinkQuiet('), 'wav を消していない');
  assert.ok(h.includes('pendingSegs = 0;'), '待ち件数を 0 にしていない');
  assert.ok(h.includes('m.skipped += '), '打ち切った数を数えていない');
  assert.ok(h.includes('maybeFinalizeMeeting()'), '打ち切ったのに締めていない');
  assert.ok(h.includes('return { ok: true, skipped:'), '{ ok, skipped } の形で返していない');
  const on = fnBody(m, 'function onMeetingSegment(', '\nasync function maybeFinalizeMeeting');
  assert.ok((on.match(/m\.gen !== gen/g) || []).length >= 3, '列の中で世代を見ていない（打ち切った区間の結果が後から混ざる）');
  assert.ok(preload.includes("  meetingSkipPending: () => ipcRenderer.invoke('meeting:skipPending'),"), 'preload の meetingSkipPending が無い');
});

// ---------------------------------------------------------------- 第2段の統合レビューで見つかった取りこぼし
test('meetingStatus は stopping を返す（画面の残り区間・打ち切りの導線がこれを見る）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const body = main.slice(main.indexOf('function meetingStatus()'), main.indexOf('function meetingStatus()') + 1500);
  assert.ok(/stopping:\s*Boolean\(meeting && meeting\.stopping\)/.test(body), 'meetingStatus に stopping が無い（画面の打ち切りボタンが一度も出ない）');
});

test('打ち切りの後に届く最後の区間を捨てない（届くまで締めず、届いた区間は打ち切りとして数える）', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(main.includes('if (isFinal) m.finalSeen = true;'), '最後の区間の到着を記録していない');
  assert.ok(main.includes('if (meeting.skipAll && !meeting.finalSeen) return;'), '打ち切り後、最後の区間が届く前に締めている');
  assert.ok(main.includes("text: '（文字起こしを打ち切り）', failed: true });\n      m.skipped++;"), '打ち切り後に届いた区間を数えていない');
});

test('復旧の文字起こしは、エンジンが用意できないときに wav を消さず待ち行列を残す', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const body = main.slice(main.indexOf('async function transcribeRecovered()'), main.indexOf('async function transcribeRecoveredItems('));
  assert.ok(/if \(!ready\) \{[\s\S]*?return;/.test(body), 'エンジン未準備で return していない');
  assert.ok(!/unlink/.test(body), 'エンジン未準備の経路で wav を消している');
  assert.ok(main.includes('saveRecoveryQueue(recoveryQueue)'), '待ち行列を recovery.json に残していない');
  assert.ok(main.includes('recoveryQueue = loadSavedRecoveryQueue()'), '起動時に残した待ち行列を拾っていない');
  assert.ok(/if \(recoveryQueue\) transcribeRecovered\(\)/.test(main), '設定を直したときに復旧を再開していない');
});

test("overlay:mic は議事録が無いとき meeting:update を送らない（要約中の進捗表示を消さない）", () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const i = main.indexOf("ipcMain.on('overlay:mic'");
  const body = main.slice(i, i + 500);
  assert.ok(/if \(!meeting\) return;/.test(body), 'overlay:mic に議事録なしのガードが無い');
});

// ---------------------------------------------------------------- 第2段 レビュー2（忠実さ・実機リスク）
test('トレイの「終了」も、閉じるボタンと同じく記録中・要約中は確かめる', () => {
  const m = code(main);
  assert.ok(m.includes("items.push({ label: '終了', click: quitFromTray });"), 'トレイの終了が quitFromTray を通っていない');
  const fn = fnBody(m, 'function quitFromTray()', '\n}');
  assert.ok(fn.includes("closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing())"), '終了確認の文を mainlib.closeConfirm で組んでいない');
  assert.ok(fn.includes('dialog.showMessageBoxSync('), '確認を出していない');
  assert.ok(/if \(r !== 0\) return;/.test(fn), 'キャンセルで終了を止めていない');
  assert.ok(fn.indexOf('showMessageBoxSync(') < fn.indexOf('quitting = true'), '確認より先に終了している');
});

test('認識に失敗した区間の wav は残し、議事録を締めたあと（要約の後）にもう一度文字起こしする', () => {
  const m = code(main);
  const settle = fnBody(m, 'function settleSegment(', '\n}');
  assert.ok(settle.includes('const keepWav = Boolean(patch && patch.failed && seg.wav);'), '失敗した区間の wav を残す判断が無い');
  assert.ok(settle.includes('if (!keepWav) unlinkQuiet(seg.wav);'), '失敗した区間の wav も消している');
  assert.ok(settle.includes('if (keepWav) seg.wav = wav;'), '残した wav のパスを区間に戻していない（締めのときに見つからない）');
  const fin = fnBody(m, 'async function maybeFinalizeMeeting', '\nconst runSummary');
  assert.ok(fin.includes('m.segments.filter((s) => s.failed && s.wav && fs.existsSync(s.wav))'), '失敗した区間を待ち行列に集めていない');
  assert.ok(fin.includes('saveRecoveryQueue(q)'), '待ち行列を recovery.json に残していない（途中で落ちると消える）');
  assert.ok(fin.includes('if (!recoveryQueue) recoveryQueue = q;'), '別の復旧が待っているときに上書きしている');
  assert.ok(fin.indexOf('await runSummary(page.id)') < fin.indexOf('transcribeRecovered()'), '要約より先にやり直している（要約が待たされる）');
  const rec = fnBody(m, 'async function transcribeRecovered()', '\n}');
  assert.ok(rec.includes('while (q && !seen.has(q.dir)) {') && rec.includes('q = recoveryQueue = loadSavedRecoveryQueue();'), '残りの待ち行列を順に拾っていない／同じ行列を二度拾いうる');
  assert.ok(fnBody(m, 'function cleanupSegbuf(', '\n}').includes('for (const s of m.segments) unlinkQuiet(s.wav);'), '破棄で失敗区間の wav が残る');
  const items = fnBody(m, 'async function transcribeRecoveredItems(', '\n}');
  assert.ok(items.includes('q.retry') && items.includes('やり直しました'), 'やり直しの通知文が復旧の文のまま');
  // 記録中に落ちて draft に残った失敗区間も、wav があればやり直す（mainlib.recoverSegments）
  assert.ok(m.includes("JSON.stringify({ pageId: q.pageId, items: q.items, retry: Boolean(q.retry) })"), 'recovery.json に retry の印を残していない');
});

test('退避フォルダの掃除は、待ち行列（recovery.json）が残っているフォルダを消さない', () => {
  const clean = fnBody(code(main), 'function cleanOrphanSegbuf(', '\n}');
  assert.ok(clean.includes('if (fs.existsSync(path.join(dir, RECOVERY_FILE))) continue;'), 'recovery.json 付きのフォルダを 7 日で消してしまう');
  const load = fnBody(code(main), 'function loadSavedRecoveryQueue()', '\n}');
  assert.ok(/catch \(_\) \{\s*try \{ fs\.unlinkSync\(f\); \}/.test(load), '壊れた recovery.json を消していない（掃除が永久に避け続ける）');
});

test('録音側のエラーで議事録を締めるときは、会議の長さをそこで止め、利用者に伝える', () => {
  const m = code(main);
  const i = m.indexOf("ipcMain.on('audio:error'");
  const body = m.slice(i, m.indexOf("ipcMain.on('overlay:hidden-request'", i));
  assert.ok(body.includes('meeting.stoppedAt = Date.now();'), '会議の長さに文字起こし待ちが混ざる');
  assert.ok(body.includes('meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt;'), '一時停止したまま切れたとき一時停止を締めていない');
  assert.ok(body.includes("sendToMainWin('app:notice'"), '利用者に伝えていない');
  assert.ok(body.indexOf('meeting.stoppedAt = Date.now();') < body.indexOf('maybeFinalizeMeeting()'), '締めた後に時刻を書いている');
});

test('区間の onstop は、次の区間の開始（rollSegment）を try の中で呼ぶ（投げても番号を埋める）', () => {
  // 外で投げると finally が走らず、この区間の番号が待ち行列で埋まらない。以後の区間も
  // 空の最後も永久に届かず、main は終了しても議事録を締められない
  const onstop = overlayHtml.slice(overlayHtml.indexOf('rec.onstop = async () => {'), overlayHtml.indexOf('autoStopId = setTimeout(() => rollSegment(rec), thisSegMs);'));
  const tryAt = onstop.indexOf('try {');
  const roll = onstop.indexOf('rollSegment(rec);');
  assert.ok(tryAt >= 0 && roll > tryAt, 'rollSegment(rec) が try の外にある');
  assert.ok(onstop.indexOf('finally {') > roll && onstop.includes('settle(null);'), 'finally で番号を埋めていない');
  // 次の区間の start() が投げても（マイクの切断）、番号を空の最後で埋めて録音を畳む
  const seg = overlayHtml.slice(overlayHtml.indexOf('function startMeetingSegment()'), overlayHtml.indexOf('function newClosing()'));
  assert.ok(/try \{\s*rec\.start\(250\);\s*\} catch \(e\) \{/.test(seg), 'rec.start(250) を try で包んでいない');
  assert.ok(seg.includes('settleSeg(seq, { wav: new Uint8Array(0), durationMs: 0, isFinal: true });'), '投げたときに番号を空の最後で埋めていない');
  assert.ok(seg.includes("errorAfterFinal = 'マイクが切断されました';"), 'エラーを最後の区間の後に回していない');
});

// ---------------------------------------------------------------- エンジンの壊れ方（実機の報告）
test('エンジンの不具合は、どのファイルかを名指しして伝える', () => {
  const m = code(main);
  const fn = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.ok(fn.includes("engineIssueMessage(exe, 'exe', fileSize(engineExe(eng)), engineExe(eng), ps)"), '実行ファイルのパスを文に渡していない');
  assert.ok(fn.includes("engineIssueMessage(model, 'model', fileSize(engineModel(eng)), engineModel(eng), ps)"), 'モデルのパスを文に渡していない');
  // エンジンごとに実行し直すスクリプトを名指しする（setup-*.ps1 では利用者がどれか分からない）
  assert.ok(fn.includes("eng === whisperEng ? 'setup-local-engine.ps1' : 'setup-summarizer.ps1'"), 'スクリプトを名指ししていない');
});

test('起動テストは、エンジンがアプリのインストール先にあれば移動を促す（更新のたびに消える）', () => {
  const m = code(main);
  assert.ok(m.includes('const appInstallDir = () => path.dirname(process.execPath);'), 'インストール先を求めていない');
  assert.ok(m.includes('engineDirWarning([engineExe(eng), engineModel(eng)], appInstallDir())'), '判断を mainlib.engineDirWarning に任せていない');
  for (const [ch, eng] of [["app:test'", 'whisperEng'], ["app:test-sum'", 'sumEng']]) {
    const i = m.indexOf(`ipcMain.handle('${ch}`);
    assert.ok(i > 0, `${ch} が無い`);
    const body = m.slice(i, m.indexOf('  });', i));
    assert.ok(body.includes(`const warning = engineDirNote(${eng});`), `${ch} が置き場所を見ていない`);
    // 成功でも失敗でも添える（動いていても次の更新で壊れる）。返す物を1つずつ、文の終わりまで見る
    const at = [...body.matchAll(/\bok: (?:true|false)\b/g)].map((x) => x.index);
    assert.ok(at.length >= 3, `${ch} の戻り値を数えられない（検査が空振り）`);
    for (const i of at) {
      const end = body.indexOf('};', i);
      const stmt = body.slice(i, end > 0 ? end : i + 200);
      assert.ok(/\bwarning\b/.test(stmt), `${ch} の経路「${stmt.slice(0, 50)}…」が注意を伝えていない`);
    }
  }
  // 画面は成否にかかわらず同じ行に出す
  const run = appHtml.slice(appHtml.indexOf('async function runTest('), appHtml.indexOf("$('testBtn').onclick"));
  assert.ok(run.includes('r.warning'), '画面が注意を出していない');
});

test('セットアップは、展開が不完全でないかを確かめてから zip を消す', () => {
  for (const name of ['setup-summarizer.ps1', 'setup-local-engine.ps1']) {
    const s = read(name);
    const i = s.indexOf('Expand-Archive');
    assert.ok(i > 0, `${name}: 展開していない`);
    const after = s.slice(i);
    const check = after.indexOf('-lt 5MB');
    assert.ok(check > 0, `${name}: 展開物の合計を見ていない（0 バイトでも「完了」と言ってしまう）`);
    const rm = after.indexOf('Remove-Item $binZip');
    assert.ok(rm > 0 && check < rm, `${name}: 確かめる前に zip を消している（再実行で取り直せない）`);
    assert.match(after.slice(check, check + 400), /ウイルス対策|除外/, `${name}: 直し方（除外設定）を案内していない`);
  }
});

test('アプリのインストール先にエンジンを置かないことが文書に書いてある', () => {
  for (const name of ['README.md', 'INSTALL.md']) {
    const s = read(name);
    const i = s.indexOf('Programs\\Listener');
    assert.ok(i > 0, `${name}: インストール先に触れていない`);
    assert.match(s, /インストール先[^\n]*(置かない|置かないで)|エンジン[^\n]*インストール先[^\n]*消え/,
      `${name}: インストール先にエンジンを置かない注意が無い`);
  }
});

test('エンジンの実行ファイルは大きさの床で弾かない（上流が薄いランチャにした）', () => {
  const m = code(main);
  // 床はモデルだけ。exe に床を置くと、9KB の llama-server.exe（正常）を「壊れている」と言ってしまう
  assert.match(m, /const ENGINE_MIN_BYTES = \{ whisper: 50_000_000, gguf: 300_000_000 \};/, 'exe の床が残っている');
  const fn = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.ok(fn.includes('engineFileIssue(engineExe(eng), 0, stat)'), 'exe に床を渡している');
  assert.ok(!/ENGINE_MIN_BYTES\.exe/.test(m), 'ENGINE_MIN_BYTES.exe をまだ参照している');
});

test('セットアップは展開物ぜんたいの大きさで確かめる（exe の大きさでは判定しない）', () => {
  for (const name of ['setup-summarizer.ps1', 'setup-local-engine.ps1']) {
    const s = read(name);
    assert.ok(!/\$server\.Length -lt 1MB/.test(s), `${name}: exe の大きさで判定している（薄いランチャを弾く）`);
    assert.match(s, /Measure-Object[^\n]*Length[^\n]*-Sum/, `${name}: 展開物の合計を数えていない`);
    assert.match(s, /-lt 5MB/, `${name}: 合計の下限を見ていない`);
    const i = s.indexOf('Measure-Object');
    assert.ok(s.indexOf('Remove-Item $binZip') > i, `${name}: 確かめる前に zip を消している`);
  }
});

test('whisper のバイナリはリリース一覧から探す（固定URLは 404 になった）', () => {
  const s = read('setup-local-engine.ps1');
  assert.ok(!/releases\/latest\/download\/whisper-bin-x64\.zip/.test(s), '固定URLの直打ちが残っている（latest では 404）');
  assert.match(s, /api\.github\.com\/repos\/ggml-org\/whisper\.cpp\/releases/, 'リリース一覧を見ていない');
  assert.match(s, /Find-WinAsset|Find-WhisperAsset/, '資産を探す関数が無い');
  assert.match(s, /v1\.8\.0/, '見つからないときの既知の版に落ちていない');
});
