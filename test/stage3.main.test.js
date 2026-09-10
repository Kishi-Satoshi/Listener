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

test('planDataMove: 空でないだけのフォルダは拒み、無い・空・Listener のデータがある場所は通す', () => {
  const t = 'D:/Listener';
  const { exists, listDir } = fsOf({
    'D:/has-data': ['pages', 'index.json'], 'D:/has-data/pages': [], 'D:/has-data/index.json': [],
    'D:/has-pages-only': ['pages'], 'D:/has-pages-only/pages': [],
    'D:/busy': ['report.docx', 'photos'],
    'D:/empty': [],
  });
  // Listener のデータがあるフォルダは通す（写さずに切り替える。元の保存先へ戻る道。R2）
  assert.strictEqual(planDataMove(FROM, 'D:\\has-data', exists, listDir), '', 'Listener のデータがある場所へ戻せない');
  assert.strictEqual(planDataMove(FROM, 'D:\\has-pages-only', exists, listDir), '');
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
  assert.ok(load.includes("const wanted = settings.dataDir || '';") && load.includes("store.init(app.getPath('userData'), wanted)"),
    'store.init に第2引数（dataDir）を渡していない');
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
  assert.ok(fn.includes("if (mode === 'copy') {"), '既にデータがあるフォルダでも写している（R2）');
  assert.ok(fn.includes('fs.mkdirSync(to, { recursive: true })'), '移動先を作っていない');
  assert.ok(fn.includes('fs.cpSync(from, to, { recursive: true'), '再帰で写していない');
  assert.match(m, /const SEGBUF_DIR = 'segbuf';/);
  assert.ok(fn.includes('filter: (src) => src !== skipFrom') && fn.includes('path.join(from, SEGBUF_DIR)'), '一時物の segbuf を写す対象から外していない');
  assert.ok(fn.includes('sameTree(treeSummary(from'), '写した結果を mainlib.sameTree で確かめていない');
  // 確かめてから設定 → store.init のやり直し → 画面へ
  // 確かめる → 新しい場所で開けることを確かめる → 設定を保存 → 画面へ（順を逆にすると、
  // 開けなかったときに設定だけが壊れた場所を指して残る。R3）
  const order = ['sameTree(', "store.init(app.getPath('userData'), to)", 'settings.dataDir = to', 'persistSettings()', "sendToMainWin('pages:updated'", 'return { ok: true, dir: to'];
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
  // app が使わなくなったので、統合で openActions / assigneeList は preload と main から外した
  assert.ok(!preload.includes('openActions:') && !preload.includes('assigneeList:'), '使われない openActions / assigneeList が preload に残っている');
  assert.ok(!m.includes("'pages:openActions'") && !m.includes("'pages:assignees'"), '使われない handle が main に残っている');
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

// ---------------------------------------------------------------- #58 メモリ（判断）
const { idleEnginesToStop } = require('../src/mainlib');
const MIN = 60000;

test('idleEnginesToStop: 手が空いていて、起動していて、idleMin 分使われていないエンジンだけを選ぶ', () => {
  const now = 10_000_000;
  const w = { name: 'w', proc: {}, lastUsed: now - 10 * MIN };
  const s = { name: 's', proc: {}, lastUsed: now - 3 * MIN };
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 10, false), [w]);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 3, false), [w, s], 'ちょうど idleMin 分でも止める');
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 11, false), []);
  // 忙しいときは何も止めない／0 = 止めない
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 10, true), []);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 0, false), []);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, -1, false), []);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 'x', false), []);
});

test('idleEnginesToStop: 起動していない・準備完了を待っている人がいる・使った時刻が無い エンジンは止めない', () => {
  const now = 10_000_000;
  const off = { name: 'off', proc: null, lastUsed: now - 60 * MIN };
  const waiting = { name: 'wait', proc: {}, lastUsed: now - 60 * MIN, readyPromise: Promise.resolve(true) };
  const unknown = { name: 'unk', proc: {} };
  const idle = { name: 'idle', proc: {}, lastUsed: now - 60 * MIN, readyPromise: null };
  assert.deepStrictEqual(idleEnginesToStop([off, waiting, unknown, idle, null], now, 10, false), [idle]);
  assert.deepStrictEqual(idleEnginesToStop(undefined, now, 10, false), []);
});

// ---------------------------------------------------------------- #58 メモリ（結線）
test('#58 記録開始で要約エンジンを先読みしない（要約直前の ensureEngineReady に任せる）', () => {
  const m = code(main);
  const start = fnBody(m, 'function startMeeting()', '\nfunction stopMeeting');
  assert.ok(!start.includes('startEngine(sumEng)'), '記録開始で要約エンジンを起動している（約 3GB が上がったまま降りない）');
  assert.ok(start.includes('ensureEngineReady(whisperEng)'), '文字起こしエンジンの用意まで消している');
  assert.ok(fnBody(m, 'async function generateMinutes', '\nfunction ensurePaster').includes('await ensureEngineReady(sumEng)'), '要約直前に用意していない');
  // 理由はコメントに残す
  assert.ok(/3GB/.test(fnBody(main, 'function startMeeting()', '\nfunction stopMeeting')), '先読みをやめた理由（約 3GB）がコメントに無い');
  // 起動時の whisper 先読みは今まで通り
  assert.ok(fnBody(m, 'app.whenReady().then(', '\n  });').includes('if (engineValid(whisperEng)) startEngine(whisperEng);'));
});

test('#58 lastUsed は起動時と推論のたびに更新し、60 秒ごとに使われないエンジンを止める', () => {
  const m = code(main);
  assert.ok(fnBody(m, 'function makeEngine(name)', '\n}').includes('lastUsed: 0'), 'エンジンに lastUsed が無い');
  assert.match(m, /const touchEngine = \(eng\) => \{ eng\.lastUsed = Date\.now\(\); \};/);
  const start = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(/eng\.proc = p;\s*\n\s*eng\.lastUsed = Date\.now\(\);/.test(start), '起動時に lastUsed を入れていない');
  assert.strictEqual((fnBody(m, 'async function transcribeLocal(', '\n}').match(/touchEngine\(whisperEng\)/g) || []).length, 2, '文字起こしの前後で lastUsed を更新していない');
  assert.strictEqual((fnBody(m, 'async function llmChat(', '\n}').match(/touchEngine\(sumEng\)/g) || []).length, 2, '要約の前後で lastUsed を更新していない');
  // 判断は mainlib.idleEnginesToStop。busy は isBusy()（idle・要約中でない・復旧中でない・待ち 0）
  const rel = fnBody(m, 'function releaseIdleEngines()', '\n}');
  assert.ok(rel.includes('idleEnginesToStop([whisperEng, sumEng], Date.now(), settings.engineIdleMin, isBusy())'), '判断を mainlib.idleEnginesToStop で行っていない');
  assert.ok(rel.includes('stopEngine(eng)'), '止めていない');
  assert.ok(rel.includes('engineLog('), '止めたことをログに残していない');
  assert.match(m, /const ENGINE_IDLE_CHECK_MS = 60000;/);
  assert.ok(fnBody(m, 'app.whenReady().then(', '\n  });').includes('setInterval(releaseIdleEngines, ENGINE_IDLE_CHECK_MS)'), '60 秒ごとに見ていない');
});

test('#58 トレイに「エンジンを停止（メモリを解放）」があり、起動中かつ手が空いているときだけ押せる', () => {
  const m = code(main);
  const tray = fnBody(m, 'function updateTray()', '\nfunction createTray');
  assert.ok(tray.includes("label: 'エンジンを停止（メモリを解放）', enabled: (Boolean(whisperEng.proc) || Boolean(sumEng.proc)) && !isBusy(), click: stopEnginesFromTray"), 'トレイの項目が無いか条件が違う');
  const fn = fnBody(m, 'function stopEnginesFromTray()', '\n}');
  assert.ok(fn.includes('stopEngine(whisperEng)') && fn.includes('stopEngine(sumEng)'), '両方止めていない');
  // 起動・終了・停止のたびにトレイの有効／無効を追随させる（終了中は触らない）
  assert.match(m, /function engineChanged\(\) \{ if \(!quitting\) updateTray\(\); \}/);
  assert.ok(fnBody(m, 'function stopEngine(eng)', '\n}').includes('engineChanged()'), '停止でトレイを更新していない');
  assert.strictEqual((fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine').match(/engineChanged\(\)/g) || []).length, 2, '起動と exit でトレイを更新していない');
});

// ---------------------------------------------------------------- #54 貼り付け先の確認（判断）
const { pasterScript, parsePasterLine } = require('../src/mainlib');

test('pasterScript: fg（前面ウィンドウの HWND）と paste <hwnd>（同じなら貼る）の命令がある。P/Invoke は user32 の 1 つだけ', () => {
  const s = pasterScript();
  assert.ok(s.includes("-eq 'fg'"), 'fg の命令が無い');
  assert.ok(s.includes("StartsWith('paste ')"), 'paste <hwnd> の命令が無い');
  assert.ok(s.includes("-eq 'paste'"), '従来の paste（確認なし）が消えている');
  assert.ok(s.includes("StartsWith('copy ')"), 'copy が消えている');
  // P/Invoke: Add-Type -TypeDefinition で user32 の GetForegroundWindow を 1 つだけ
  assert.strictEqual((s.match(/Add-Type -TypeDefinition/g) || []).length, 1);
  assert.strictEqual((s.match(/DllImport/g) || []).length, 1, 'P/Invoke が 1 つでない');
  assert.ok(s.includes('user32.dll') && s.includes('GetForegroundWindow()'), 'user32 の GetForegroundWindow でない');
  // -Command の引数として渡すので、引用符の扱いで壊れないよう二重引用符は使わず、1 行に収める
  assert.ok(!s.includes('"'), '二重引用符がある（powershell.exe -Command の引数で壊れうる）');
  assert.ok(!s.includes('\n'), '改行がある');
  // HWND は 10 進で標準出力に 1 行。応答は ok / mismatch / fail
  assert.ok(s.includes('[Console]::Out.WriteLine([string][long]'), 'HWND を 10 進の文字列で出していない');
  for (const r of ["'ok'", "'mismatch'", "'fail'"]) assert.ok(s.includes(`[Console]::Out.WriteLine(${r})`), `応答 ${r} を標準出力に出していない`);
  // 前面が違えば何もしない（SendWait しない）。fg が取れなければ 0
  const branch = s.slice(s.indexOf("StartsWith('paste ')"), s.indexOf("StartsWith('copy ')"));
  assert.ok(branch.indexOf('-eq $l.Substring(6)') < branch.indexOf("SendWait('^v')"), '前面を確かめる前に貼っている');
  assert.ok(branch.includes("else { [Console]::Out.WriteLine('mismatch') }"), '違うときに mismatch を返していない');
  assert.ok(s.includes("catch { [Console]::Out.WriteLine('0') }"), 'fg が取れないときに 0 を返していない');
  // PS5.1 で動く書き方（既存の検査と同じ）
  assert.ok(!/\bswitch\b/.test(s) && !/ValidateSet/.test(s));
});

test('parsePasterLine: HWND（10 進）・ok・mismatch・fail を読み、それ以外は null。0 は「控えられなかった」', () => {
  assert.deepStrictEqual(parsePasterLine('1970442'), { kind: 'hwnd', value: '1970442' });
  assert.deepStrictEqual(parsePasterLine('1970442\r'), { kind: 'hwnd', value: '1970442' }, 'CRLF の \\r を落としていない');
  assert.deepStrictEqual(parsePasterLine('0'), { kind: 'hwnd', value: '' }, 'HWND 0（前面なし）を控えている');
  assert.deepStrictEqual(parsePasterLine('ok'), { kind: 'ok' });
  assert.deepStrictEqual(parsePasterLine('mismatch\r'), { kind: 'mismatch' });
  assert.deepStrictEqual(parsePasterLine(' fail '), { kind: 'fail' });
  assert.strictEqual(parsePasterLine(''), null);
  assert.strictEqual(parsePasterLine('Exception calling ...'), null);
  assert.strictEqual(parsePasterLine('12ab'), null);
  assert.strictEqual(parsePasterLine(null), null);
});

// ---------------------------------------------------------------- #54 貼り付け先の確認（結線）
test('#54 常駐 PowerShell の標準出力を行ごとに読み、命令ごとの応答を待てる', () => {
  const m = code(main);
  const ens = fnBody(m, 'function ensurePaster()', '\n}');
  assert.ok(ens.includes("stdio: ['pipe', 'pipe', 'ignore']"), '標準出力を pipe にしていない');
  assert.ok(ens.includes("p.stdout.on('data'"), '標準出力を読んでいない');
  assert.ok(ens.includes('parsePasterLine(line)'), '行の読み方を mainlib.parsePasterLine で行っていない');
  assert.ok(ens.includes('pasterWaiters.shift()'), '応答を待っている順（FIFO）に渡していない');
  assert.ok(ens.includes('w.resolve(null)'), 'PowerShell が居なくなったとき待っている人を解放していない');
  const ask = fnBody(m, 'function askPaster(cmd, timeoutMs)', '\n}');
  assert.ok(ask.includes('pasterWaiters.push(w)') && ask.includes('setTimeout(() => w.resolve(null), timeoutMs)'), '時間切れで null にしていない');
  assert.ok(ask.includes('p.stdin.write(`${cmd}\\n`)'), '命令を 1 行で送っていない');
  assert.match(m, /const FG_REPLY_MS = 300;/);
  assert.match(m, /const PASTE_REPLY_MS = 1500;/);
});

test('#54 録音開始で前面ウィンドウを控え、貼り付けは控えた HWND 付きで送る。違えば貼らずに知らせる', () => {
  const m = code(main);
  const start = fnBody(m, 'function startRecording()', '\n}');
  assert.ok(start.includes("dictationFg = askPaster('fg', FG_REPLY_MS).then((r) => (r && r.kind === 'hwnd' ? r.value : ''))"), '録音開始で fg を送って控えていない');
  const paste = fnBody(m, 'function simulatePaste(hwnd)', '\n}');
  assert.ok(paste.includes("askPaster(hwnd ? `paste ${hwnd}` : 'paste', PASTE_REPLY_MS)"), '控えた HWND があるとき paste <hwnd> で送っていない');
  assert.ok(paste.includes("resolve(r && r.kind !== 'hwnd' ? r.kind : 'unknown')"), "応答を 'ok'|'mismatch'|'fail'|'unknown' に直していない");
  assert.ok(paste.includes("resolve(err ? 'fail' : 'ok')"), '常駐が居ないときの一回きりの貼り付けが結果を返していない');
  assert.strictEqual((paste.match(/resolve\('unknown'\)/g) || []).length, 2, 'Windows 以外は unknown（従来どおり貼れたものとして扱う）');
  const deliver = fnBody(m, 'async function deliverText(', '\n}');
  assert.ok(deliver.includes('const hwnd = await dictationFg;'), '控えた HWND を使っていない');
  assert.ok(deliver.includes('const result = await simulatePaste(hwnd);'));
  assert.ok(deliver.includes("if (result === 'mismatch') { sendToMainWin('app:notice', '貼り付け先が変わったため、クリップボードに残しました（Ctrl+V で貼り付けられます）'); return result; }"), 'mismatch の知らせ方が違う');
  assert.ok(deliver.includes("if (result === 'fail') { sendToMainWin('app:notice', '自動貼り付けに失敗しました。クリップボードに残しています'); return result; }"), 'fail の知らせ方が違う');
  // 貼れなかったときはクリップボードを戻さない（本文が残っていることが救い）
  assert.ok(deliver.indexOf("result === 'fail'") < deliver.indexOf('restoreAfterPaste(prev, text)'), '貼れなかったのに元のクリップボードを戻している');
  // 既存の契約: 書く入口は copyPrivate だけ（repo.test.js #27 が見る）。ここでは deliverText が先に置くことだけ
  assert.ok(deliver.indexOf('await copyPrivate(text)') < deliver.indexOf('simulatePaste(hwnd)'));
});

// ---------------------------------------------------------------- R1 保存先が開けないとき（レビュー）
const { dataDirFallback, dataMoveMode } = require('../src/mainlib');

test('dataDirFallback: 設定した保存先が開けなければ既定に落ちて知らせ、空なら知らせるだけ、正常なら黙る', () => {
  // 既定の場所を使っているとき（設定が空）は何も起きない
  assert.deepStrictEqual(dataDirFallback('', { ok: true, empty: true }), { useDefault: false, notice: '' });
  assert.deepStrictEqual(dataDirFallback('', { ok: false, error: 'x' }), { useDefault: false, notice: '' });
  // 開けた・議事録がある → 黙る
  assert.deepStrictEqual(dataDirFallback('E:\\Listener', { ok: true, empty: false }), { useDefault: false, notice: '' });
  // 開けない（外付けを抜いた・ネットワークが落ちた）→ 既定に落ちて知らせる。設定は書き換えない
  const f = dataDirFallback('E:\\Listener', { ok: false, error: 'ENOENT' });
  assert.strictEqual(f.useDefault, true, '開けない保存先のまま起動しようとしている');
  assert.match(f.notice, /E:\\Listener/); assert.match(f.notice, /ENOENT/);
  assert.match(f.notice, /既定の場所/); assert.match(f.notice, /設定は変えていません/);
  // 結果が無い（呼び出し側の事故）も既定に落とす
  assert.strictEqual(dataDirFallback('E:\\Listener', null).useDefault, true);
  // 開けたが空（ドライブ文字の使い回し）→ 落とさずに知らせる（勝手に既定へ移すと二重管理になる）
  const e = dataDirFallback('E:\\Listener', { ok: true, empty: true });
  assert.strictEqual(e.useDefault, false, '空なだけで既定へ落としている');
  assert.match(e.notice, /議事録がありません/);
  assert.match(e.notice, /データ保存先/);
});

test('#29(R1) 起動時に保存先を開けなくてもアプリは立ち上がり、理由を知らせる', () => {
  const m = code(main);
  const fn = fnBody(m, 'function loadStores()', '\n}');
  assert.ok(/try \{[\s\S]*store\.init\(app\.getPath\('userData'\), wanted\)/.test(fn), '設定した保存先での init を try で囲っていない');
  assert.ok(fn.includes('dataDirFallback(wanted, result)'), '判断を mainlib.dataDirFallback に任せていない');
  assert.ok(fn.includes("store.init(app.getPath('userData'), '')"), '開けなかったときに既定の場所で開き直していない');
  assert.ok(!fn.includes('settings.dataDir = '), '起動時に設定を書き換えている（繋ぎ直しても戻らなくなる）');
  // 知らせは画面が出てから（起動直後は受け手が居ない）
  const win = fnBody(m, 'function createMainWindow()', '\n  mainWin.on(');
  assert.ok(win.includes('dataDirNotice'), '保存先の知らせを画面へ送っていない');
  assert.ok(win.includes("did-finish-load"), '画面の読み込み前に送っている（受け手が居ない）');
});

test('#29(R2) 既に議事録があるフォルダは「写さずに切り替え」、空のフォルダは今まで通り写す', () => {
  // 実機の fs.existsSync は \ と / を区別しない。偽物も同じにする
  const norm = (p) => String(p).replace(/\//g, '\\');
  const exists = (p) => ['D:\\has-data\\index.json', 'D:\\has-pages\\pages'].includes(norm(p));
  assert.strictEqual(dataMoveMode('D:\\has-data', exists), 'switch');
  assert.strictEqual(dataMoveMode('D:\\has-pages', exists), 'switch');
  assert.strictEqual(dataMoveMode('D:\\empty', exists), 'copy');
  assert.strictEqual(dataMoveMode('D:/has-data/', exists), 'switch', '区切りと末尾の / で見落としている');
  // 元の場所へ戻せる（README が案内している経路）
  const FROM2 = 'C:\\U\\AppData\\Roaming\\listener\\data';
  assert.strictEqual(planDataMove('D:\\moved', FROM2, (p) => p.startsWith(FROM2), () => ['index.json']), '',
    '元の保存先へ戻す経路を拒んでいる（README はこれを案内している）');
  const mv = fnBody(code(main), 'async function moveDataDir(dir)', '\n}');
  assert.ok(mv.includes("dataMoveMode(") && mv.includes("mode === 'copy'"), '切り替えと写しを分けていない');
  assert.ok(mv.indexOf('store.init(') < mv.indexOf('persistSettings()'), '保存先を開き直す前に設定を保存している（開けなければ次回起動で詰む）');
});
