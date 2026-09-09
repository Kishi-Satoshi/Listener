/*
 * stage3.main.test.js — 第3段（v0.11.0）の main 側の判断と結線
 *
 * 判断は src/mainlib.js / src/settings.js の純関数として切り出し、ここで実行して固定する。
 * main.js は Electron を require するので直接は読み込めない。結線（main.js がそれらを
 * 本当に呼んでいるか）は repo.test.js と同じ流儀で、ソースの文字列を見て固定する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  planDataMove, sameTree,
} = require('../src/mainlib');
const { normalizeSettings } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const main = read('src/main.js');
const preload = read('src/preload.js');
// コメントに一致して素通りしないよう、コメントを落としてから見る（repo.test.js と同じ）
const code = (t) => String(t).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fnBody = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${from} が無い`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j > 0 ? j : src.length);
};

// ---------------------------------------------------------------- 設定キー（第3段で足した 3 つ）
const DEF = { localPort: 8990, sumPort: 8991, localThreads: 8, sumThreads: 8, segmentSec: 75, sumCtx: 32768, engineIdleMin: 10, dataDir: '' };

test('normalizeSettings: sumCtx は 4096〜131072 に丸め、壊れた値は既定 32768', () => {
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: 1000 }, DEF).sumCtx, 4096);
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: 999999 }, DEF).sumCtx, 131072);
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: 'abc' }, DEF).sumCtx, 32768);
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: '16384' }, DEF).sumCtx, 16384, '文字列の数字を数に直していない');
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: undefined }, DEF).sumCtx, 32768, '未設定（古い settings.json）で既定にならない');
});

test('normalizeSettings: engineIdleMin は 0〜120 に丸め、0（止めない）は 0 のまま', () => {
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 0 }, DEF).engineIdleMin, 0, '0 = 止めない を既定に戻している');
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: '0' }, DEF).engineIdleMin, 0);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: -5 }, DEF).engineIdleMin, 0);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 500 }, DEF).engineIdleMin, 120);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 'x' }, DEF).engineIdleMin, 10);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: undefined }, DEF).engineIdleMin, 10);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 7.9 }, DEF).engineIdleMin, 7, '整数に切っていない');
});

test('normalizeSettings: dataDir は文字列（前後の空白を落とす）。文字列でなければ既定の \'\'', () => {
  assert.strictEqual(normalizeSettings({ ...DEF, dataDir: '  D:\\Listener\\data  ' }, DEF).dataDir, 'D:\\Listener\\data');
  assert.strictEqual(normalizeSettings({ ...DEF, dataDir: 42 }, DEF).dataDir, '');
  assert.strictEqual(normalizeSettings({ ...DEF, dataDir: null }, DEF).dataDir, '');
  assert.strictEqual(normalizeSettings({ ...DEF }, DEF).dataDir, '');
});

test('DEFAULT_SETTINGS に sumCtx / engineIdleMin / dataDir がある', () => {
  const defs = fnBody(code(main), 'const DEFAULT_SETTINGS = {', '\n};');
  assert.match(defs, /\n  sumCtx: 32768,/);
  assert.match(defs, /\n  engineIdleMin: 10,/);
  assert.match(defs, /\n  dataDir: '',/);
});

// ---------------------------------------------------------------- #29 データ保存先の移動（判断）
// exists(p) は fs.existsSync 相当、listDir(p) は readdirSync 相当（無ければ []）
const fsOf = (table) => ({
  exists: (p) => Object.prototype.hasOwnProperty.call(table, p.replace(/\\/g, '/')),
  listDir: (p) => table[p.replace(/\\/g, '/')] || [],
});
const FROM = 'C:\\U\\AppData\\Roaming\\Listener\\data';

test('planDataMove: 空・相対パス・同じ場所・今の data の内側・data を含む親 を拒む', () => {
  const { exists, listDir } = fsOf({});
  assert.match(planDataMove(FROM, '', exists, listDir), /指定されていません/);
  assert.match(planDataMove(FROM, '   ', exists, listDir), /指定されていません/);
  assert.match(planDataMove(FROM, 'data2', exists, listDir), /絶対パス/);
  assert.match(planDataMove(FROM, FROM, exists, listDir), /同じ場所/);
  // Windows は大文字小文字と区切り文字の違いで別の場所にならない
  assert.match(planDataMove(FROM, FROM.toUpperCase() + '\\', exists, listDir), /同じ場所/);
  assert.match(planDataMove(FROM, FROM.replace(/\\/g, '/'), exists, listDir), /同じ場所/);
  assert.match(planDataMove(FROM, `${FROM}\\inner`, exists, listDir), /中には移せません/);
  assert.match(planDataMove(FROM, `${FROM}\\segbuf\\x`, exists, listDir), /中には移せません/);
  assert.match(planDataMove(FROM, 'C:\\U\\AppData\\Roaming\\Listener', exists, listDir), /親フォルダ/);
  assert.match(planDataMove(FROM, 'C:\\', exists, listDir), /親フォルダ/);
  // 名前が前方一致するだけの別フォルダは「内側」ではない
  assert.strictEqual(planDataMove(FROM, `${FROM}2`, exists, listDir), '');
});

test('planDataMove: 移動先に既に Listener のデータがある／空でない フォルダを拒み、無い・空なら通す', () => {
  const t = 'D:/Listener';
  const { exists, listDir } = fsOf({
    'D:/has-data': ['pages', 'index.json'], 'D:/has-data/pages': [], 'D:/has-data/index.json': [],
    'D:/has-pages-only': ['pages'], 'D:/has-pages-only/pages': [],
    'D:/busy': ['report.docx', 'photos'],
    'D:/empty': [],
  });
  assert.match(planDataMove(FROM, 'D:\\has-data', exists, listDir), /既に Listener のデータ/);
  assert.match(planDataMove(FROM, 'D:\\has-pages-only', exists, listDir), /既に Listener のデータ/);
  assert.match(planDataMove(FROM, 'D:\\busy', exists, listDir), /空のフォルダ/);
  assert.strictEqual(planDataMove(FROM, 'D:\\empty', exists, listDir), '', '空のフォルダを拒んでいる');
  assert.strictEqual(planDataMove(FROM, t, exists, listDir), '', '無いフォルダ（これから作る）を拒んでいる');
  assert.strictEqual(planDataMove(FROM, '\\\\nas\\share\\listener', exists, listDir), '', 'UNC パスを絶対パスと見ていない');
  // 今の場所が既定でない（D:\a）ときも同じ規則
  assert.match(planDataMove('D:\\a', 'D:\\a\\b', exists, listDir), /中には移せません/);
  assert.match(planDataMove('D:\\a\\b', 'D:\\a', exists, listDir), /親フォルダ/);
});

test('sameTree: ファイル数と合計バイト数が一致するときだけ同じ木とみなす', () => {
  assert.strictEqual(sameTree({ files: 12, bytes: 34567 }, { files: 12, bytes: 34567 }), true);
  assert.strictEqual(sameTree({ files: 0, bytes: 0 }, { files: 0, bytes: 0 }), true, '空のデータでも移せる');
  assert.strictEqual(sameTree({ files: 12, bytes: 34567 }, { files: 11, bytes: 34567 }), false);
  assert.strictEqual(sameTree({ files: 12, bytes: 34567 }, { files: 12, bytes: 34566 }), false);
  assert.strictEqual(sameTree(null, { files: 0, bytes: 0 }), false);
  assert.strictEqual(sameTree({ files: NaN, bytes: 0 }, { files: NaN, bytes: 0 }), false, '数えられなかったのに一致としている');
});

// ---------------------------------------------------------------- #29 データ保存先の移動（結線）
test('#29 store.init に dataDir を渡し、data:dir は { dir, isDefault } を返す', () => {
  const m = code(main);
  const load = fnBody(m, 'function loadStores()', '\n}');
  assert.ok(load.includes("store.init(app.getPath('userData'), settings.dataDir || '')"), 'store.init に第2引数（dataDir）を渡していない');
  // store.root が無い版（統合前）でも動くよう typeof で守り、無ければ既定の場所
  const root = fnBody(m, 'const dataRoot = ', '\n');
  assert.ok(root.includes("typeof store.root === 'function'"), 'store.root の有無を見ていない');
  assert.ok(root.includes("path.join(app.getPath('userData'), 'data')"), '無いときの既定の場所が違う');
  assert.match(m, /ipcMain\.handle\('data:dir', \(\) => \(\{ dir: dataRoot\(\), isDefault: !settings\.dataDir \}\)\)/);
  assert.match(m, /ipcMain\.handle\('data:move', /);
  assert.ok(preload.includes("  dataDirGet: () => ipcRenderer.invoke('data:dir'),"), 'preload の dataDirGet が無い（書式込み）');
  assert.ok(preload.includes("  dataDirMove: (dir) => ipcRenderer.invoke('data:move', dir),"), 'preload の dataDirMove が無い（書式込み）');
  // 「データ保存先を開く」は今のデータフォルダ（移動後はそこ）
  assert.match(m, /ipcMain\.handle\('app:open-data-dir', \(\) => \{ shell\.openPath\(dataRoot\(\)\); return true; \}\)/);
});

test('#29 data:move は idle かつ要約中・復旧中でないときだけ受け、写して確かめてから切り替え、元は消さない', () => {
  const m = code(main);
  const fn = fnBody(m, 'async function moveDataDir(', '\n}');
  assert.ok(fn.includes("if (isBusy()) return { ok: false, error: '記録中・要約中は移動できません' };"), '忙しいときの拒み方が違う');
  const busy = fnBody(m, 'const isBusy = () => ', '\n');
  for (const k of ["state !== 'idle'", 'isSummarizing()', 'recoveryRunning', 'pendingSegs > 0']) assert.ok(busy.includes(k), `isBusy が ${k} を見ていない`);
  // 判断は mainlib.planDataMove（'' なら通す）
  assert.ok(fn.includes('planDataMove(from, raw, '), '拒む理由を mainlib.planDataMove で判断していない');
  assert.ok(fn.indexOf('planDataMove(from, raw, ') < fn.indexOf('fs.mkdirSync('), '判断より先にフォルダを作っている');
  assert.ok(fn.includes('fs.mkdirSync(to, { recursive: true })'), '移動先を作っていない');
  assert.ok(fn.includes('fs.cpSync(from, to, { recursive: true'), '再帰で写していない');
  assert.match(m, /const SEGBUF_DIR = 'segbuf';/);
  assert.ok(fn.includes('filter: (src) => src !== skipFrom') && fn.includes('path.join(from, SEGBUF_DIR)'), '一時物の segbuf を写す対象から外していない');
  assert.ok(fn.includes('sameTree(treeSummary(from'), '写した結果を mainlib.sameTree で確かめていない');
  // 確かめてから設定 → store.init のやり直し → 画面へ
  const order = ['sameTree(', 'settings.dataDir = to', 'persistSettings()', "store.init(app.getPath('userData'), settings.dataDir)", "sendToMainWin('pages:updated'", 'return { ok: true, dir: to }'];
  let at = -1;
  for (const k of order) { const i = fn.indexOf(k); assert.ok(i > at, `${k} の順番が違う（か無い）`); at = i; }
  assert.ok(fn.includes('元の場所のデータは残しています'), '元を消さないことを伝えていない');
  assert.ok(!/rmSync\(from|rmdirSync\(from|unlinkSync\(from/.test(fn), '元のフォルダを消している');
  assert.match(m, /ipcMain\.handle\('data:move', \(_e, dir\) => moveDataDir\(dir\)\)/);
  // 退避フォルダ segbuf は今まで通り <userData>/data/segbuf（一時物なので移さない）
  assert.match(m, /const segbufRoot = \(\) => path\.join\(app\.getPath\('userData'\), 'data', 'segbuf'\)/);
});

test('#29 フォルダ選択（pickFile(\'folder\)）と pages:actionView の結線', () => {
  const m = code(main);
  const pick = fnBody(m, "ipcMain.handle('dialog:pick'", '\n  });');
  assert.ok(pick.includes("kind === 'folder'"), 'フォルダ選択の分岐が無い');
  assert.ok(pick.includes("properties: ['openDirectory']"), 'フォルダを選ぶ指定が無い');
  assert.match(pick, /return res\.canceled \? '' : \(res\.filePaths\[0\] \|\| ''\);/, 'フォルダ選択の戻り値がパスか \'\' になっていない');
  assert.match(m, /ipcMain\.handle\('pages:actionView', \(_e, \{ q, assignee \} = \{\}\) => store\.actionView\(\{ q, assignee \}\)\)/);
  assert.ok(preload.includes("  pagesActionView: ({ q, assignee }) => ipcRenderer.invoke('pages:actionView', { q, assignee }),"), 'preload の pagesActionView が無い（書式込み）');
  // 既存の openActions / assigneeList は残す（app が使わなくなったら統合時に外す）
  assert.ok(preload.includes("  openActions: () => ipcRenderer.invoke('pages:openActions'),"));
  assert.ok(preload.includes("  assigneeList: () => ipcRenderer.invoke('pages:assignees'),"));
  assert.match(m, /ipcMain\.handle\('pages:searchFull', \(_e, q\) => store\.searchFullText\(q \|\| '', 60\)\)/, 'pages:searchFull は store の戻り値をそのまま返す');
});

// ---------------------------------------------------------------- #41 要約の文脈長（判断）
const { estimateTokens, foldNotes, ENGINE_SETTING_KEYS, guardEngineSettings } = require('../src/mainlib');

test('estimateTokens: UTF-8 のバイト数 ÷ 2.5 の切り上げ（多めに見積もって溢れる側に外さない）', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens(null), 0);
  assert.strictEqual(estimateTokens('abcde'), 2);          // 5 バイト → 2
  assert.strictEqual(estimateTokens('あ'), 2);              // 3 バイト → 1.2 → 2
  assert.strictEqual(estimateTokens('あいうえお'), 6);      // 15 バイト → 6
  assert.strictEqual(estimateTokens('a'.repeat(250)), 100);
});

test('foldNotes: 前から順に「合計が予算に収まる束」に分ける（1 件で超える要点メモは単独の束）', () => {
  const len = (t) => t.length;
  assert.deepStrictEqual(foldNotes(['a', 'bb', 'ccc', 'd'], 3, len), [['a', 'bb'], ['ccc'], ['d']]);
  assert.deepStrictEqual(foldNotes(['aaaaa', 'b', 'c'], 3, len), [['aaaaa'], ['b', 'c']], '予算を超える 1 件を単独の束にしていない');
  assert.deepStrictEqual(foldNotes(['a', 'b'], 100, len), [['a', 'b']], '収まるなら 1 束');
  assert.deepStrictEqual(foldNotes([], 3, len), []);
  // 順序を入れ替えない（時系列のまま）。入力は書き換えない
  const notes = ['x', 'yy', 'z'];
  const r = foldNotes(notes, 2, len);
  assert.deepStrictEqual(r.flat(), notes);
  assert.deepStrictEqual(notes, ['x', 'yy', 'z']);
  // 予算が壊れていても止まらない（0 以下・NaN は 1 とみなす → 全部単独の束）
  assert.deepStrictEqual(foldNotes(['a', 'b'], 0, len), [['a'], ['b']]);
  assert.deepStrictEqual(foldNotes(['a', 'b'], NaN, len), [['a'], ['b']]);
  // 推定関数を省けば estimateTokens で数える
  assert.deepStrictEqual(foldNotes(['あいうえお', 'かきくけこ'], 6), [['あいうえお'], ['かきくけこ']]);
});

test('#41 sumCtx は記録中に変えられないエンジン設定で、名前は「要約の文脈長」', () => {
  assert.ok(ENGINE_SETTING_KEYS.includes('sumCtx'));
  const prev = { sumCtx: 32768, theme: 'dark' };
  const r = guardEngineSettings(prev, { sumCtx: 8192, theme: 'light' }, true);
  assert.strictEqual(r.settings.sumCtx, 32768);
  assert.deepStrictEqual(r.kept, ['sumCtx']);
  assert.ok(r.warning.includes('要約の文脈長'), '警告で名指ししていない');
});

// ---------------------------------------------------------------- #41 要約の文脈長（結線）
test('#41 llama-server の -c は settings.sumCtx で、署名（再起動の判断）にも入る', () => {
  const m = code(main);
  const args = fnBody(m, 'function engineSpawnArgs(eng)', '\n}');
  assert.ok(args.includes("'-c', String(settings.sumCtx),"), '-c が settings.sumCtx でない');
  assert.ok(!args.includes("'16384'"), '固定の 16384 が残っている');
  const sig = fnBody(m, 'function engineSignature(eng)', '\n}');
  assert.ok(sig.includes("eng === whisperEng ? '' : settings.sumCtx"), '要約エンジンの署名に sumCtx が入っていない（変えても再起動されない）');
});

test('#41 統合プロンプトが文脈長に収まらないときは要点メモを 2 段で畳み、engineLog にだけ残す', () => {
  const m = code(main);
  assert.match(m, /const SUM_CTX_MARGIN = 256;/);
  assert.match(m, /const sumCtxBudget = \(\) => settings\.sumCtx - SUM_MAX_TOKENS - SUM_CTX_MARGIN;/);
  const gen = fnBody(m, 'async function generateMinutes', '\nfunction ensurePaster');
  assert.ok(gen.includes('const budget = sumCtxBudget();'), '予算を sumCtxBudget から取っていない');
  assert.ok(gen.includes('const fixed = estimateTokens(sys + memoBlock + minutesTemplate(type));'), '固定分（役割・メモ・書式）を推定していない');
  // 1 回で収まるかの判断は、文字数だけでなく推定トークンでも見る（文脈長を小さくしたとき溢れない）
  assert.ok(gen.includes('&& estimateTokens(plain) + fixed <= budget) {'), '1 回で収まるかの判断が推定トークンを見ていない');
  // 畳む: 束の分け方は mainlib.foldNotes、各束は分割要約と同じ経路（extractNotes・NOTE_MAX_TOKENS）
  const fold = fnBody(gen, 'if (need > budget) {', "if (onProgress) onProgress('議事録をまとめています…');");
  assert.ok(gen.includes("const need = estimateTokens(notes.join('\\n\\n')) + fixed;"), '統合プロンプトの推定が無い');
  assert.ok(fold.includes('foldNotes(notes, Math.max(1, budget - fixed), estimateTokens)'), '束の分け方を mainlib.foldNotes で決めていない');
  assert.ok(fold.includes("extractNotes((t) => extract(t, k, bundles.length, '要点メモ'), bundles[k].join('\\n\\n'))"), '束を分割要約と同じ経路で要約していない');
  assert.ok(gen.includes("extractNotes((t) => extract(t, i, chunks.length, '文字起こし'), chunks[i])"), '既存の分割要約が同じ extract を通っていない');
  assert.ok(fold.includes('束に畳んだ'), 'engineLog に「n パートを m 束に畳んだ」を残していない');
  assert.ok(fold.includes('engineLog('), 'engineLog に残していない');
  assert.ok(!fold.includes('summaryError') && !fold.includes('page.notes') && !fold.includes('truncatedParts'), 'summaryError / page.notes / 切れたパートの一覧に畳んだことを書いている');
  // 統合には畳んだ後の材料を渡す
  assert.ok(gen.includes("【会議の要点メモ（時系列）】\\n${material.join('\\n\\n')}"), '統合に畳んだ材料を渡していない');
  // llmChatP の呼び出しは 3 か所のまま（repo.test.js が数える）。畳みは extract を通る
  assert.strictEqual((gen.match(/await llmChatP\(/g) || []).length, 3);
});
