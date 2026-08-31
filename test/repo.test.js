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
  assert.match(main, /const pausedTotal = m\.pausedMs/);
  assert.match(main, /m\.startedAt - pausedTotal/);
  assert.ok(appHtml.includes('- mtPausedMs'), '画面の時計が一時停止を引いていない');
});

test('一時停止中は無音警告も区間の切り出しも動かない', () => {
  const c = code(overlayHtml);
  assert.match(c, /function checkSilence\([^)]*\) \{\s*if \(stopping \|\| cancelled \|\| paused/);
  assert.match(c, /function cutSegmentIfOverdue\([^)]*\) \{\s*if \(paused\) return;/);
  assert.match(main, /state === 'meeting' && meeting && !meeting\.paused/);
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
