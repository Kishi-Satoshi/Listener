/*
 * Listener v0.5 — 完全オフラインの音声入力・議事録ツール
 *
 * 文字起こし(whisper.cpp) も要約(llama.cpp) もすべてローカルで完結する。
 * 議事録は Notion 風のページ／ブロック構造で保存し、
 * 要約の各要点には根拠となった発言へのリンク（出典）を機械的に付与する。
 */
'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, clipboard, nativeImage, screen, dialog, shell, session,
  nativeTheme, powerSaveBlocker,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const net = require('net');

const store = require('./store');
const cite = require('./cite');
const { attachCitations, refreshCitations } = cite;
// 要約中に文字起こしが編集されていても、出典は「要約の材料にした配列」と「いまの配列」の
// 両方を見て付ける（cite.attachCitationsAcross。#4）。まだ無い版では従来どおり今の配列だけ。
const attachAcross = cite.attachCitationsAcross || ((b, f) => attachCitations(b, f.filter((s) => !s.failed)));
const mtype = require('./meetingType');
const { enrichActionBlocks } = require('./actions');
const updater = require('./updater');
const { chooseDisplayMedia } = require('./loopback');
const minutes = require('./minutes');
const { markdownToBlocks, dropRedundantEmpty } = minutes;
// テンプレートの写し（見出しだけ・雛形そのまま）を落とす。minutes.js 側に
// まだ無い版でも動くよう、無ければ素通しにする。
const dropTemplateEcho = minutes.dropTemplateEcho || ((b) => b);
const { normalizeSettings } = require('./settings');
const { localDateISO } = require('./dates');
const {
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, resolveStartupHotkeys, saveHotkeys, makeSummaryRunner, tickStep,
  pasterScript, copyCommand, parsePasterLine,
  engineFileIssue, engineIssueMessage, portInUseError, guardEngineSettings, keptDifferent, closeConfirm,
  extractNotes, truncationMessage, buildPromptParts,
  publicSegments, settledSegments, pendingDurationMs, recoverSegments, staleSegbufDirs, nextSegmentMs, EtaTracker,
  skipPendingSegments, restoreAfterPaste,
  planDataMove, sameTree, estimateTokens, foldNotes, idleEnginesToStop,
} = require('./mainlib');

const CPU_OLD_DEFAULT_THREADS = Math.max(4, Math.floor(os.cpus().length / 2));
const CPU_DEFAULT_THREADS = Math.max(4, os.cpus().length - 2);
const MIN_RECORD_MS = 400;
// メモはプロンプトにそのまま前置きされるので、文脈を食い潰さない範囲に収める
const MEMO_MAX = 1500;
const SUM_MAX_TOKENS = 3000;   // 最終的な議事録
const NOTE_MAX_TOKENS = 900;   // 分割要約の各パート
// 文脈長（settings.sumCtx）のうち、指示文・役割名・書式の余白として取っておく分（#41）
const SUM_CTX_MARGIN = 256;
const ENGINE_READY_TIMEOUT_MS = 90000;

const DEFAULT_SETTINGS = {
  localServerExe: '',
  localModelPath: '',
  localPort: 8990,
  localThreads: CPU_DEFAULT_THREADS,
  vadModelPath: '',
  useVad: true,
  suppressNst: true,
  sumServerExe: '',
  sumModelPath: '',
  sumPort: 8991,
  sumThreads: CPU_DEFAULT_THREADS,
  language: 'ja',
  hotkey: 'Control+Shift+Space',
  meetingHotkey: 'Alt+M',
  micId: '',
  pillPos: 'bottom',
  pillCustom: null,
  autoPaste: true,
  removeFillers: true,
  soundFeedback: true,
  autoLaunch: false,
  // 画面の配色。system は Windows の設定に追従する
  theme: 'system',
  // ウィンドウを閉じたときにタスクトレイへ残すか。既定は残さない＝そのまま終了。
  stayInTray: false,
  dictionary: [],
  // 業務日本語の既定語彙をエンジンへ渡すか。dictionary の既定を非空にすると、
  // 既に [] を保存済みの環境には既定値が届かないので、別のキーで持つ。
  useBuiltinTerms: true,
  // 議事録のときだけ、パソコンから出ている音（Web会議の相手の声）も録る。
  // 既定は false。同席者の声を残すかどうかは、その場で人が決めること。
  useSystemAudio: false,
  maxHistory: 500,
  segmentSec: 75,
  // 要約エンジン（llama-server）の文脈長（-c）。統合プロンプトがこれに収まらないときは
  // 要点メモを 2 段で畳む（#41。generateMinutes）
  sumCtx: 32768,
  // 使われないエンジンを止めるまでの分。0 = 止めない（#58。releaseIdleEngines）
  engineIdleMin: 10,
  // データ保存先。'' = 既定の場所 <userData>/data（#29。store.init の第2引数）
  dataDir: '',
};

// ---------------------------------------------------------------- 状態
let settings = { ...DEFAULT_SETTINGS };
let history = [];
let state = 'idle'; // idle | recording | processing | meeting | meeting-finalizing
let tray = null;
let trayIconIdle = null;
let trayIconRec = null;
let overlayWin = null;
let mainWin = null;
let quitting = false;
// 録音・文字起こし中は OS にアプリを眠らせない。省電力でプロセスが
// 絞られると、録音の区切りも文字起こしも静かに止まる。
let powerBlockId = null;
// 録音の区切りの見張り。レンダラーの setTimeout は画面が隠れると間引かれる
// （実機で1区間が9分になり、文字起こしが時間切れで失われた）。
// main のタイマーは間引かれないので、ここから5秒ごとに合図を送り、
// 録音側は期限を過ぎていたら区間を切る。
let meetingTickId = null;
function startMeetingTick() {
  if (meetingTickId) return;
  meetingTickId = setInterval(() => {
    // 送る／飛ばす／消す の判断は mainlib.tickStep（main.test.js で実行して固定）。
    // 見張りを消すのは議事録が無くなったときだけで、一時停止は送信を飛ばすだけにする。
    // 一時停止で消すと、再開しても誰も起こし直さず、以後の区切りが画面の
    // 間引かれるタイマー任せに戻る（1区間が9分になる元の不具合が再発する）。
    tickStep({ state, meeting },
      () => sendToOverlay('overlay:tick', {}),
      () => { clearInterval(meetingTickId); meetingTickId = null; });
  }, 5000);
}
function applyTheme() {
  // themeSource を切り替えると、レンダラー側の prefers-color-scheme が
  // 変わり、CSSのダーク定義がそのまま効く。画面側のJSは不要。
  try {
    nativeTheme.themeSource = settings.theme === 'light' || settings.theme === 'dark'
      ? settings.theme : 'system';
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#171a21' : '#E9EDF5');
    }
  } catch (_) { /* noop */ }
}

function updatePowerBlock() {
  // 要約中も忙しい（#52）。省電力で絞られると、数分かかる要約が静かに止まる
  const busy = state !== 'idle' || isSummarizing();
  if (busy && powerBlockId === null) {
    try { powerBlockId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) { powerBlockId = null; }
  } else if (!busy && powerBlockId !== null) {
    try { powerSaveBlocker.stop(powerBlockId); } catch (_) { /* noop */ }
    powerBlockId = null;
  }
}
let pasterProc = null;
// 常駐 PowerShell の応答を待っている人（送った順に受け取る。mainlib.parsePasterLine）
const pasterWaiters = [];
// 音声入力を始めたときの前面ウィンドウ（HWND）。貼り付け先が変わっていれば貼らない（#54）
let dictationFg = Promise.resolve('');
const FG_REPLY_MS = 300;      // fg の応答待ち。常駐が起動中なら間に合わず ''（従来どおり確認なしで貼る）
const PASTE_REPLY_MS = 1500;  // paste の応答待ち。無応答なら貼れたものとして扱う（unknown）
let programmaticMove = false;
let recoveredPageId = null;

let meeting = null;
let segChain = Promise.resolve();
let pendingSegs = 0;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const historyPath = () => path.join(app.getPath('userData'), 'history.json');

// ---------------------------------------------------------------- 永続化
function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // 壊れていたら退避してから既定値に戻す。
    // そのまま既定値で動くと、次の保存で上書きされて設定が復旧できなくなる。
    console.error('loadJson', file, e.message);
    try {
      const broken = `${file}.broken-${Date.now()}`;
      fs.renameSync(file, broken);
      console.error('壊れた設定を退避しました:', broken);
    } catch (_) { /* noop */ }
  }
  return fallback;
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 一時ファイルに書いてから置き換える。直接書くと、書き込み中に落ちたときに
    // 壊れたJSONが残り、次回起動で既定値に戻って設定が消える。
    // （store.js の writeJson と同じ扱いにする）
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { console.error('saveJson', file, e.message); }
}
const persistSettings = () => saveJson(settingsPath(), settings);
const persistHistory = () => saveJson(historyPath(), history);

function loadStores() {
  // 保存時と同じ正規化を通す。手で編集された settings.json のポートが文字列や
  // 範囲外だと、起動直後だけ正規化をすり抜けてエンジンの起動待ちが静かに失敗する。
  settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...loadJson(settingsPath(), {}) }, DEFAULT_SETTINGS);
  if (CPU_DEFAULT_THREADS > CPU_OLD_DEFAULT_THREADS) {
    if (settings.localThreads === CPU_OLD_DEFAULT_THREADS) settings.localThreads = CPU_DEFAULT_THREADS;
    if (settings.sumThreads === CPU_OLD_DEFAULT_THREADS) settings.sumThreads = CPU_DEFAULT_THREADS;
  }
  history = loadJson(historyPath(), []);
  if (!Array.isArray(history)) history = [];
  // 第2引数が空でなければそこをデータフォルダにする（#29）。設定した場所が無くなっていても
  // （外付けディスクを抜いた等）store 側が作り直すので、起動は止まらない
  store.init(app.getPath('userData'), settings.dataDir || '');
}
// いまのデータフォルダの絶対パス。store.root が無い版でも動くよう守り、無ければ既定の場所
const dataRoot = () => (typeof store.root === 'function' ? store.root() : path.join(app.getPath('userData'), 'data'));

// ---------------------------------------------------------------- データ保存先の移動（#29）
// 写す → 確かめる → 設定を切り替える → store を開き直す。元のフォルダは消さない（消すのは
// 利用者。移せていなかったときに戻れる）。受けるかの判断は mainlib.planDataMove、写した結果の
// 検証は mainlib.sameTree（ファイル数と合計バイト数の一致）。
// 退避フォルダ segbuf（<userData>/data/segbuf）は一時物なので写さない（segbufRoot はデータ
// フォルダを移しても変わらない）。
const SEGBUF_DIR = 'segbuf';
// dir 以下のファイル数と合計バイト数。skip（絶対パス）以下は数えない
function treeSummary(dir, skip) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === skip) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files++; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}
async function moveDataDir(dir) {
  if (isBusy()) return { ok: false, error: '記録中・要約中は移動できません' };
  const from = dataRoot();
  const raw = String(dir || '').trim();
  const listDir = (p) => { try { return fs.readdirSync(p); } catch (_) { return []; } };
  const why = planDataMove(from, raw, (p) => fs.existsSync(p), listDir);
  if (why) return { ok: false, error: why };
  const to = path.normalize(raw);
  try {
    fs.mkdirSync(to, { recursive: true });
    const skipFrom = path.join(from, SEGBUF_DIR);
    fs.cpSync(from, to, { recursive: true, filter: (src) => src !== skipFrom });
    if (!sameTree(treeSummary(from, skipFrom), treeSummary(to, path.join(to, SEGBUF_DIR)))) {
      return { ok: false, error: '写した内容が元と一致しないため、保存先を切り替えませんでした。元の場所のデータはそのままです' };
    }
  } catch (e) {
    return { ok: false, error: `移動に失敗しました: ${e.message}。元の場所のデータはそのままです` };
  }
  settings.dataDir = to;
  persistSettings();
  store.init(app.getPath('userData'), settings.dataDir);
  engineLog(`データ保存先を移動: ${from} → ${to}`);
  sendToMainWin('pages:updated', store.listPages());
  sendToMainWin('app:notice', `データの保存先を ${to} に変えました。元の場所のデータは残しています（不要なら手で削除してください）`);
  return { ok: true, dir: to };
}

// ---------------------------------------------------------------- テキスト整形
function removeFillersRule(text) {
  let t = text;
  const patterns = [
    /(?:えー+っ?と+|えっ?と+|ええと+|ええっと+)[、,。.\s]*/g,
    /(?:えー+|えぇ+ー*)[、,\s]*/g,
    /(?:あのー+|あのう+|そのー+|そのう+)[、,\s]*/g,
    /(?:うー+ん(?:と+)?|んー+と?)[、,\s]*/g,
    /\b(?:u+m+|u+h+|erm+|hm+)\b[,\s]*/gi,
  ];
  for (const p of patterns) t = t.replace(p, '');
  return t.replace(/、{2,}/g, '、').replace(/。{2,}/g, '。')
    .replace(/(^|。)、+/g, '$1').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 業務日本語でよく化ける語。固有名詞ではないのでユーザーに登録させる筋ではなく、
// 既定で渡す。実機で「不具合→風買い」「改修→回収」「今週→本週」が出たことによる。
// 数詞の聞き違い（12件→22件）には効かない。効くのはマイクとモデルの大きさ。
const BUILTIN_TERMS = [
  '不具合', '改修', '受注', '発注', '仕様', '要件', '結合テスト', '単体テスト', '検収', 'リリース',
  '課題', '懸案', '進捗', '稼働', '納期', '見積', '工数', '案件', '所感',
  '今週', '来週', '今月', '来月', '月末', '期末',
  '定例', '共有', '対応', '確認', '検討', '展開', '棚卸し',
];

// whisper.cpp の初期プロンプトは n_text_ctx/2（既定 224 トークン）で切られる。
// どちら側から切られるかはビルドで変わりうるので、そもそも溢れさせない。
// 日本語は最悪 1文字 1トークンとみて 200 文字。予算の単位は UTF-8 のバイト数でその 3 倍
// （日本語 1 文字 = 3 バイト。英数字の語を文字数で数えると実際の 3 倍に見積もられ、辞書が
// 不当に切られる。詳しくは mainlib.buildPromptParts）。
const PROMPT_MAX_CHARS = 200;
const PROMPT_LIMIT_BYTES = PROMPT_MAX_CHARS * 3;
// 文例。指示文ではなく「この後に続く文章の文例」。モデルは指示に従うのでは
// なく真似るだけで、実機では文例中の語がそのまま本文へ漏れた
// （「不具合の報告」が「句読報告」になった）。丸めの誘導は文例自体の
// 「、」「。」で行い、漏れても会議の発言として無害な語だけで書く。
// 語の接頭辞も付けない。「用語:」のような不自然な語も文例として漏れうる。
const PROMPT_SAMPLE = 'お疲れさまです。よろしくお願いします。';

// 優先順は 文例 → 辞書（先頭行から）→ 既定語彙 → 直前の発言の尻尾。予算を超えたら
// 後ろから落とす（判断は mainlib.buildPromptParts）。既定語彙は日本語のときだけ
// （英語や自動判定で日本語の語を渡すと、その語が出力に漏れ、言語の推定も日本語へ引っぱられる）。
// 戻り値の kept/total は prompt:info で画面へ返す（辞書が予算を超えていると伝えるため。#23）。
function promptParts(extraTail) {
  const ja = settings.language === 'ja';
  return buildPromptParts({
    ja, sample: PROMPT_SAMPLE,
    dictionary: settings.dictionary,
    useBuiltinTerms: settings.useBuiltinTerms, builtinTerms: BUILTIN_TERMS,
    tail: extraTail, limitBytes: PROMPT_LIMIT_BYTES,
  });
}
function buildPrompt(extraTail) { return promptParts(extraTail).prompt; }

// ---------------------------------------------------------------- エンジン管理
function makeEngine(name) {
  // lastUsed: 起動時と推論のたびの時刻。使われないまま engineIdleMin 分たったら止める（#58）
  return { name, proc: null, ready: false, lastError: '', readyPromise: null, startPromise: null, sig: '', stderrTail: '', stopping: false, lastUsed: 0 };
}
const whisperEng = makeEngine('文字起こしエンジン');
const sumEng = makeEngine('要約エンジン');
const touchEngine = (eng) => { eng.lastUsed = Date.now(); };
// 起動・終了・停止のたびにトレイ（「エンジンを停止」の有効／無効）を追随させる。終了中は触らない
function engineChanged() { if (!quitting) updateTray(); }

function engineLog(line) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'engine.log'),
      `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (_) { /* noop */ }
}

function resolveVadModel() {
  if (settings.vadModelPath && fs.existsSync(settings.vadModelPath)) return settings.vadModelPath;
  try {
    const dir = path.dirname(settings.localModelPath || '');
    if (!dir || !fs.existsSync(dir)) return '';
    const hits = fs.readdirSync(dir).filter((f) => /^ggml-silero-.*\.bin$/i.test(f)).sort().reverse();
    return hits.length ? path.join(dir, hits[0]) : '';
  } catch (_) { return ''; }
}

function engineSpawnArgs(eng) {
  if (eng === whisperEng) {
    const args = [
      '-m', settings.localModelPath,
      '--host', '127.0.0.1',
      '--port', String(settings.localPort),
      '-t', String(settings.localThreads),
      '-l', settings.language === 'auto' ? 'auto' : settings.language,
    ];
    if (settings.suppressNst) args.push('-sns');
    const vad = settings.useVad ? resolveVadModel() : '';
    if (vad) args.push('--vad', '--vad-model', vad);
    return args;
  }
  return [
    '-m', settings.sumModelPath,
    '--host', '127.0.0.1',
    '--port', String(settings.sumPort),
    '-t', String(settings.sumThreads),
    '-c', String(settings.sumCtx),   // 文脈長（#41）。統合プロンプトが収まらなければ要点メモを畳む
  ];
}
const engineExe = (e) => (e === whisperEng ? settings.localServerExe : settings.sumServerExe);
const engineModel = (e) => (e === whisperEng ? settings.localModelPath : settings.sumModelPath);
const enginePort = (e) => (e === whisperEng ? settings.localPort : settings.sumPort);
const engineConfigured = (e) => Boolean(engineExe(e) && engineModel(e));
// 実行ファイルとモデルは「あるか」だけでなく中身まで見る（#32。判断は mainlib.engineFileIssue）。
// 存在だけを見ると、OneDrive のプレースホルダ（大きさはあるが実体がこの PC に無い）や
// 途中で切れたダウンロードを「ある」と誤認し、起動して落ちるまで原因が分からない。
// 下限はどの配布物でも下回らない大きさ（exe は数 MB、whisper は tiny でも 75MB、
// 要約の gguf は最小のものでも数百 MB）。
const ENGINE_MIN_BYTES = { exe: 100_000, whisper: 50_000_000, gguf: 300_000_000 };
const fileSize = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
// 問題があれば利用者向けの一文、無ければ ''
function engineCheck(eng) {
  if (!engineConfigured(eng)) return `${eng.name}の実行ファイルまたはモデルが見つかりません`;
  const stat = (f) => fs.statSync(f);
  const exe = engineFileIssue(engineExe(eng), ENGINE_MIN_BYTES.exe, stat);
  if (exe !== 'ok') return `${eng.name}の${engineIssueMessage(exe, 'exe', fileSize(engineExe(eng)))}`;
  const model = engineFileIssue(engineModel(eng), eng === whisperEng ? ENGINE_MIN_BYTES.whisper : ENGINE_MIN_BYTES.gguf, stat);
  if (model !== 'ok') return `${eng.name}の${engineIssueMessage(model, 'model', fileSize(engineModel(eng)))}`;
  return '';
}
const engineValid = (e) => !engineCheck(e);
// 未設定なのか、設定はあるが中身に問題があるのかを分けて伝える
function whisperProblem() {
  if (!engineConfigured(whisperEng)) return '文字起こしエンジンが未設定です。設定タブでパスを指定してください。';
  return engineCheck(whisperEng);
}

function engineSignature(eng) {
  return [engineExe(eng), engineModel(eng), enginePort(eng),
    eng === whisperEng ? settings.localThreads : settings.sumThreads,
    eng === whisperEng ? settings.language : '',
    eng === whisperEng ? `${settings.useVad ? resolveVadModel() : ''}|${settings.suppressNst}` : '',
    eng === whisperEng ? '' : settings.sumCtx].join('|');   // 文脈長を変えたら要約エンジンを起動し直す（#41）
}

// 127.0.0.1:port を一瞬だけ listen して空きを見る（#28/#31）。EADDRINUSE だけを「使用中」
// とし、それ以外（権限など）はエンジン自身の起動に任せる。直前に止めた自分のエンジンが
// まだ手放していないことがあるので、短い間隔で数回まで見直してから「使用中」と決める。
function portInUse(port, tries = 5) {
  const probe = () => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(Boolean(e && e.code === 'EADDRINUSE')));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(false)));
  });
  return (async () => {
    for (let i = 0; i < tries; i++) {
      if (!(await probe())) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  })();
}

// 起動は非同期（ポートの空きを見てから spawn する）。戻り値の Promise は spawn まで
// （準備完了までではない。それは ensureEngineReady）。同時に二度呼ばれても spawn は
// 一度だけ（startPromise で束ねる）。
function startEngine(eng) {
  if (eng.proc) return Promise.resolve();
  if (eng.startPromise) return eng.startPromise;
  eng.startPromise = (async () => {
    const issue = engineCheck(eng);
    if (issue) { eng.lastError = issue; return; }
    eng.lastError = ''; eng.ready = false; eng.stopping = false; eng.stderrTail = '';
    // 塞がっているポートで spawn すると、エンジンはモデルを読み終えてから bind に失敗して
    // 落ちる。それまで「起動中」に見え、/health は塞いでいる別のプロセスに当たって
    // 「準備完了」と誤認することさえある。先に見て、塞がっていれば起動しない。
    const port = enginePort(eng);
    if (await portInUse(port)) {
      eng.lastError = portInUseError(port); engineLog(`${eng.name}: ${eng.lastError}`); return;
    }
    // 待っている間に終了が始まっていたら起動しない（孤児プロセスになる）
    if (quitting) return;
    if (eng.proc) return;
    eng.sig = engineSignature(eng);
    engineLog(`${eng.name} 起動: ${engineExe(eng)} ${engineSpawnArgs(eng).join(' ')}`);
    let p;
    try {
      p = spawn(engineExe(eng), engineSpawnArgs(eng), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      eng.lastError = `${eng.name}を起動できません: ${e.message}`; engineLog(eng.lastError); return;
    }
    eng.proc = p;
    eng.lastUsed = Date.now();
    engineChanged();
    // 以下のハンドラは「自分が起動したプロセス」のときだけ状態を触る（#57）。
    // 再起動のあとに古いプロセスの exit が届き、新しいプロセスを null にしていた。
    p.stderr.on('data', (d) => {
      if (eng.proc !== p) return;
      eng.stderrTail = (eng.stderrTail + d.toString()).slice(-1500);
    });
    p.on('error', (e) => {
      if (eng.proc !== p) return;
      eng.lastError = `${eng.name}を起動できません: ${e.message}`; engineLog(eng.lastError);
      eng.proc = null; eng.ready = false;
    });
    p.on('exit', (code) => {
      if (eng.proc !== p) return;
      if (!quitting && !eng.stopping) {
        const tail = eng.stderrTail.split('\n').filter(Boolean).slice(-3).join(' / ');
        eng.lastError = `${eng.name}が終了しました (code ${code})${tail ? `: ${tail}` : ''}`.trim();
        engineLog(eng.lastError);
      }
      eng.proc = null; eng.ready = false; eng.readyPromise = null;
      engineChanged();
    });
  })().finally(() => { eng.startPromise = null; });
  return eng.startPromise;
}

function stopEngine(eng) {
  if (eng.proc) { eng.stopping = true; try { eng.proc.kill(); } catch (_) { /* noop */ } eng.proc = null; }
  eng.ready = false; eng.readyPromise = null;
  engineChanged();
}

// 使われないエンジンを止める（#58）。60 秒ごとに呼ぶ。判断は mainlib.idleEnginesToStop
// （手が空いていて、起動していて、engineIdleMin 分使われていない。0 = 止めない）。
// 次に使うときは ensureEngineReady が起動し直す
const ENGINE_IDLE_CHECK_MS = 60000;
function releaseIdleEngines() {
  for (const eng of idleEnginesToStop([whisperEng, sumEng], Date.now(), settings.engineIdleMin, isBusy())) {
    engineLog(`${eng.name}: ${settings.engineIdleMin} 分使われていないため停止（メモリを解放）`);
    stopEngine(eng);
  }
}
// トレイの「エンジンを停止（メモリを解放）」。次に使うときは起動し直す
function stopEnginesFromTray() {
  if (isBusy()) return;
  engineLog('トレイからエンジンを停止（メモリを解放）');
  stopEngine(whisperEng); stopEngine(sumEng);
}

function ensureEngineReady(eng) {
  if (eng.ready && eng.proc) return Promise.resolve(true);
  if (eng.readyPromise) return eng.readyPromise;
  const self = (async () => {
    if (!eng.proc) await startEngine(eng);
    let p = eng.proc;
    if (!p) return false;
    // 「/」は見ない。llama-server はモデル読み込み中でも「/」に 200 を
    // 返すため、準備完了と誤認して直後の推論が 503 になる（実機で発生）。
    // /health は読み込み中 503・完了で 200 を返す。エンドポイントを持たない
    // 古いビルドは 404 を返すので、その場合だけ「応答した」ことで良しとする。
    const url = `http://127.0.0.1:${enginePort(eng)}/health`;
    const deadline = Date.now() + ENGINE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // 待っている間に再起動されていたら、新しいプロセスを待ち直す（#57）
      if (eng.proc !== p) { if (!eng.proc) return false; p = eng.proc; }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        // 応答を待つ間に再起動されていたら、その応答は古い（または他の）プロセスのもの
        if (eng.proc !== p) continue;
        if (res.ok || res.status === 404) { eng.ready = true; return true; }
      } catch (e) {
        // 接続先の URL 自体が組み立てられない（ポートが不正）なら、90秒待っても
        // 直らない。「起動中」と区別して設定の問題だと分かる文で返す。
        // 接続拒否も TypeError（fetch failed）で来るので、URL の解析失敗だけを見る。
        if (e instanceof TypeError && /URL/i.test(e.message)) {
          eng.lastError = `${eng.name}の接続先（ポート設定）が不正です`;
          engineLog(`${eng.lastError}: ${url}`);
          return false;
        }
        /* 起動中 */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!eng.lastError) {
      const tail = eng.stderrTail.split('\n').filter(Boolean).slice(-3).join(' / ');
      eng.lastError = `${eng.name}の起動がタイムアウトしました${tail ? `: ${tail}` : '（モデル読み込み中の可能性）'}`;
    }
    return false;
  })().finally(() => { if (eng.readyPromise === self) eng.readyPromise = null; });   // 再起動後の新しい待ちを消さない
  eng.readyPromise = self;
  return self;
}

function restartEnginesIfNeeded() {
  for (const eng of [whisperEng, sumEng]) {
    if (eng.proc && eng.sig !== engineSignature(eng)) stopEngine(eng);
  }
  if (!whisperEng.proc && engineValid(whisperEng)) startEngine(whisperEng);
}

// ---------------------------------------------------------------- 文字起こし
async function transcribeLocal(wavBuffer, extraPromptTail, durationMs) {
  const ok = await ensureEngineReady(whisperEng);
  if (!ok) throw new Error(whisperEng.lastError || '文字起こしエンジンが起動していません');
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  if (settings.language && settings.language !== 'auto') form.append('language', settings.language);
  const prompt = buildPrompt(extraPromptTail);
  if (prompt) {
    form.append('prompt', prompt);
    // これが無いと語彙のヒントが各リクエストの最初の30秒にしか効かない。
    // 1区間は75秒あるので、2/3が素の状態で書き起こされていた。
    // 古いビルドでは黙って無視されるだけで害は無い。
    form.append('carry_initial_prompt', 'true');
  }

  // 処理時間は音声の長さにほぼ比例する。固定240秒だと、長くなった区間や
  // 長い音声入力が時間切れで丸ごと失われる（実機で9分の区間が消えた）。
  // 音声の5倍+60秒まで、上限30分で待つ。短い区間は今まで通り。
  // トレードオフ: エンジンが応答しないままハングした場合、この時間まで
  // 待ち続ける（議事録は「破棄」で抜けられる）。喪失よりは待ちを選ぶ。
  const waitMs = Math.min(1800000, Math.max(240000, Math.round(durationMs || 0) * 5 + 60000));
  touchEngine(whisperEng);
  const res = await fetch(`http://127.0.0.1:${settings.localPort}/inference`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(waitMs) });
  touchEngine(whisperEng);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch (_) { /* noop */ }
    throw new Error(`文字起こしエンジンエラー (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  return (data?.text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, (m) => (/BLANK|MUSIC|音楽|拍手/i.test(m) ? '' : m))
    .replace(/\n+/g, '').trim();
}

// ---------------------------------------------------------------- 要約
async function llmChat(messages, maxTokens, onWait) {
  // 503 は「壊れた」ではなく「まだ準備中・手が塞がっている」。
  // すぐ諦めるとモデル読み込みの数十秒を待てずにエラーで返してしまう。
  // 待っていることは画面に出す。黙って待つと固まったように見え、
  // エラーで返すと壊れたように見える。どちらも実態と違う。
  let res;
  let waited = false;
  const deadline = Date.now() + 120000;
  touchEngine(sumEng);
  for (;;) {
    res = await fetch(`http://127.0.0.1:${settings.sumPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0.2, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(900000),
    });
    touchEngine(sumEng);
    if (res.status !== 503 || Date.now() >= deadline) break;
    if (!waited && onWait) {
      waited = true;
      onWait('要約エンジンを準備しています（モデルの読み込み中）。そのままお待ちください…');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (res.status === 503) {
    throw new Error('要約エンジンがまだ準備中です。モデルの読み込みに時間がかかっています。'
      + '1〜2分おいてから、もう一度「要約を生成」を押してください。');
  }
  if (!res.ok) throw new Error(`要約エンジンエラー (${res.status})`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('要約エンジンの応答が空でした');
  // 長さ上限で打ち切られると末尾の議題が黙って欠ける。
  // 黙って欠けるより、欠けたと分かる方がよい。
  const truncated = data?.choices?.[0]?.finish_reason === 'length';
  return { text, truncated };
}

// 節ごとに「なければ特になし」と書くと、小型モデルが条件を守り切れず
// 実項目と「特になし」を両方並べてくる。ルールは全体で1回だけ言う。
// （それでも混ざるので minutes.js の dropRedundantEmpty で後始末する）
// 装飾を禁じるのは見た目のためではない。「**」が残ると出典の一致が
// 薄まり、短い要点でリンクが消えるため。
const OUTPUT_RULE = '書き方のきまり:\n'
  + '- 該当する内容が本当に一つも無い見出しにだけ「特になし」と書く。'
  + '一つでも書くことがあれば「特になし」は書かない。\n'
  + '- 太字（**）や斜体などの装飾は使わない。素の文章で書く。\n'
  + '- 文体は報告文書として使える常体で書く。「です」「ます」は使わない。\n'
  // 3Bクラスは指示より例をまねる。会話体の文字起こしに引きずられて
  // 「です・ます」で書いてくるので、良い例と悪い例を1組だけ見せる。
  + '  良い例: 「結合テストは今週で完了。不具合22件のうち20件は修正済み。残り2件は来週対応。」\n'
  + '  悪い例: 「完了しました」「修正されました」「お願いします」「持ち越します」';

// プロンプトに入れる議事録の書式（見出しの雛形 + 書き方のきまり）。
// 要約後にテンプレートの写しを落とす（dropTemplateEcho）ときも同じ文字列を
// 渡す。別々に組み立てると、片方を直したときにずれて落とし損ねる。
function minutesTemplate(type) {
  return `${mtype.getFormat(type)}\n\n${OUTPUT_RULE}`;
}

// 文脈長のうち入力（プロンプト）に使える推定トークン（#41）: 文脈長 − 出力の上限 − 余白。
// 推定は mainlib.estimateTokens（UTF-8 バイト ÷ 2.5。多めに見積もる）
const sumCtxBudget = () => settings.sumCtx - SUM_MAX_TOKENS - SUM_CTX_MARGIN;

async function generateMinutes(plain, memo, onProgress, type) {
  const ok = await ensureEngineReady(sumEng);
  if (!ok) throw new Error(sumEng.lastError || '要約エンジンが起動していません');
  const llmChatP = (messages, maxTokens) => llmChat(messages, maxTokens, onProgress);
  const sys = 'あなたは議事録作成の専門家です。会議の文字起こしを分析し、正確で実用的な議事録を日本語のMarkdownで作成します。'
    + '文体は報告文書の常体（だ・である調、体言止め）で、「です・ます」は使いません。'
    + '文字起こしに無い情報を創作せず、雑談は省いてください。';
  // メモはユーザーが好きなだけ書けるうえ、そのままプロンプトに前置きされる。
  // 長すぎると文脈を食い潰して文字起こし側が押し出されるので上限を設ける。
  const memoText = String(memo || '').trim().slice(0, MEMO_MAX);
  const memoBlock = memoText ? `【会議メモ・アジェンダ（要約のヒント）】\n${memoText}\n\n` : '';

  const CHUNK = 5500;
  // 文脈長の予算（#41）。固定分（役割・メモ・書式）は先に引いておく
  const budget = sumCtxBudget();
  const fixed = estimateTokens(sys + memoBlock + minutesTemplate(type));
  // メモの分も含めて1回で収まるかを判断する。文字数のほか推定トークンでも見る
  // （文脈長を小さくした設定で、1 回分のプロンプトが溢れないように）
  if (plain.length + memoBlock.length <= CHUNK + 1500 && estimateTokens(plain) + fixed <= budget) {
    const one = await llmChatP([
      { role: 'system', content: sys },
      { role: 'user', content: `${memoBlock}【会議の文字起こし】\n${plain}\n\n上記から、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${minutesTemplate(type)}` },
    ], SUM_MAX_TOKENS);
    return { md: one.text, truncated: one.truncated, truncatedParts: [], finalTruncated: one.truncated };
  }

  const chunks = [];
  for (let i = 0; i < plain.length; i += CHUNK) {
    // 残りが重なり幅以下なら、直前のチャンクに完全に含まれるので作らない
    if (i > 0 && plain.length - i <= 200) break;
    chunks.push(plain.slice(i, i + CHUNK + 200));
  }
  const notes = [];
  const truncatedParts = [];   // 半分にしても上限で切れたパート番号（1 始まり）
  // 要点の抽出。kind は材料の呼び名（'文字起こし' | '要点メモ'）。文字起こしの分割要約と、
  // 文脈長に収まらないときの要点メモの畳み（下）が同じ経路を通る
  const extract = async (text, i, n, kind) => {
    const r = await llmChatP([
      { role: 'system', content: sys },
      { role: 'user', content: `以下は長い会議の${kind}の一部（${i + 1}/${n}）です。重要な発言・決定・依頼・課題・数字を漏らさず、簡潔な箇条書きで抽出してください。文体は常体（だ・である調、体言止め）。\n\n${text}` },
    ], NOTE_MAX_TOKENS);
    return r;
  };
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(`要約中… (${i + 1}/${chunks.length})`);
    // 上限で切れたら半分に割って両方をやり直す（一度だけ。mainlib.extractNotes）。
    // 切れたままだと中盤の議題が黙って欠ける（#16）。それでも切れたら本文は残し、
    // 要点メモに注記を添え、パート番号を控える（summaryError で名指しする）。
    const part = await extractNotes((t) => extract(t, i, chunks.length, '文字起こし'), chunks[i]);
    let text = part.text;
    if (part.truncated) {
      truncatedParts.push(i + 1);
      text += `\n（※パート${i + 1}の抽出は途中で切れています）`;
    }
    notes.push(`--- パート${i + 1} ---\n${text}`);
  }
  // 統合プロンプトが文脈長に収まらないなら、要点メモを 2 段で畳む（#41）。前から順に予算に
  // 収まる束に分け（mainlib.foldNotes）、各束を分割要約と同じ経路（extractNotes・NOTE_MAX_TOKENS）
  // でもう一段要約してから統合する。畳んだことは engineLog にだけ残す（page.notes や
  // summaryError には書かない。要約の中身の問題ではなく容量の話で、利用者が直すものではない）。
  // 束の予算は統合と同じ budget − fixed（束の要約は出力が短く指示文も短いので、余裕がある側）
  let material = notes;
  const need = estimateTokens(notes.join('\n\n')) + fixed;
  if (need > budget) {
    const bundles = foldNotes(notes, Math.max(1, budget - fixed), estimateTokens);
    engineLog(`要約: 要点メモ ${notes.length} パート（推定 ${need} トークン）が文脈長 ${settings.sumCtx} の予算 ${budget} を超えるため、${bundles.length} 束に畳んだ`);
    material = [];
    let first = 1;
    for (let k = 0; k < bundles.length; k++) {
      const last = first + bundles[k].length - 1;
      if (onProgress) onProgress(`要点メモをまとめ直しています… (${k + 1}/${bundles.length})`);
      const part = await extractNotes((t) => extract(t, k, bundles.length, '要点メモ'), bundles[k].join('\n\n'));
      let text = part.text;
      if (part.truncated) {
        engineLog(`要約: 束 ${k + 1}（パート${first}〜${last}）のまとめ直しが長さの上限で切れた`);
        text += `\n（※パート${first}〜${last}のまとめは途中で切れています）`;
      }
      material.push(`--- パート${first}〜${last}（まとめ） ---\n${text}`);
      first = last + 1;
    }
    const after = estimateTokens(material.join('\n\n')) + fixed;
    if (after > budget) engineLog(`要約: 畳んでも推定 ${after} トークンで予算 ${budget} を超える（2 段まで。続行する）`);
  }
  if (onProgress) onProgress('議事録をまとめています…');
  const final = await llmChatP([
    { role: 'system', content: sys },
    { role: 'user', content: `${memoBlock}【会議の要点メモ（時系列）】\n${material.join('\n\n')}\n\n上記の要点メモを統合し、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${minutesTemplate(type)}` },
  ], SUM_MAX_TOKENS);
  return { md: final.text, truncated: truncatedParts.length > 0 || final.truncated, truncatedParts, finalTruncated: final.truncated };
}

// ---------------------------------------------------------------- 貼り付け
function ensurePaster() {
  if (process.platform !== 'win32') return null;
  if (pasterProc && pasterProc.stdin && pasterProc.stdin.writable) return pasterProc;
  // 貼り付け（paste / paste <hwnd>）、前面の問い合わせ（fg）、除外書式付きの置き直し（copy）を
  // 受ける（mainlib.pasterScript）。応答は標準出力に 1 行ずつ、命令を送った順に返る
  const script = pasterScript();
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    pasterProc = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const r = parsePasterLine(line);
        if (!r) continue;   // エラー文などは応答ではない
        const w = pasterWaiters.shift();
        if (w) w.resolve(r);
      }
    });
    const gone = () => {
      if (pasterProc === p) pasterProc = null;
      while (pasterWaiters.length) { const w = pasterWaiters.shift(); w.resolve(null); }
    };
    p.on('exit', gone);
    p.on('error', gone);
  } catch (_) { pasterProc = null; }
  return pasterProc;
}
// 常駐 PowerShell に命令を 1 行送り、応答（parsePasterLine の結果）を待つ。常駐が居ない・
// 時間切れ・居なくなった、は null
function askPaster(cmd, timeoutMs) {
  const p = ensurePaster();
  if (!p || !p.stdin || !p.stdin.writable) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const w = { resolve: (r) => { if (done) return; done = true; const i = pasterWaiters.indexOf(w); if (i >= 0) pasterWaiters.splice(i, 1); resolve(r); } };
    pasterWaiters.push(w);
    setTimeout(() => w.resolve(null), timeoutMs);
    try { p.stdin.write(`${cmd}\n`); } catch (_) { w.resolve(null); }
  });
}
// トレイの「終了」も、閉じるボタンと同じく記録中・要約中は確かめる（mainlib.closeConfirm）。
// トレイからは会議の状態が見えないので、閉じるボタンより間違えやすい
function quitFromTray() {
  const confirm = closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing());
  if (confirm) {
    const r = dialog.showMessageBoxSync({
      type: 'warning', buttons: ['終了する', 'キャンセル'], defaultId: 1, cancelId: 1,
      message: confirm.message, detail: confirm.detail,
    });
    if (r !== 0) return;
  }
  quitting = true;
  app.quit();
}
function stopPaster() {
  if (pasterProc) { try { pasterProc.stdin.end(); pasterProc.kill(); } catch (_) { /* noop */ } pasterProc = null; }
}
// Ctrl+V を送る。戻り値は 'ok' | 'mismatch'（前面が hwnd と違うので貼らなかった）| 'fail' |
// 'unknown'（確かめる手段が無い。従来どおり貼れたものとして扱う）
function simulatePaste(hwnd) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const p = ensurePaster();
      if (p && p.stdin.writable) {
        askPaster(hwnd ? `paste ${hwnd}` : 'paste', PASTE_REPLY_MS).then((r) => resolve(r && r.kind !== 'hwnd' ? r.kind : 'unknown'));
        return;
      }
      execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"],
      { windowsHide: true }, (err) => resolve(err ? 'fail' : 'ok'));
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], () => resolve('unknown'));
    } else {
      execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], () => resolve('unknown'));
    }
  });
}
// クリップボードへ書く唯一の入口（#27）。Windows では常駐 PowerShell に頼んで、クリップボード
// 履歴（Win+V）とクラウド同期から除外する書式を付けて置く（書式は mainlib.pasterScript）。
// 置けたことをクリップボードを読み返して確かめ、置けていなければ（PowerShell が居ない・
// まだ起動中・失敗）Electron の clipboard で書く（履歴には入るが、何も残らないよりはよい）。
// 先に Electron で書くと、その最初の書き込みが履歴とクラウド同期に採られる。除外の印は
// 後から置き直しても、採られた分は消えない。'paste' と同じ標準入力に順に流すので、
// 置き直しが貼り付けより後になることはない。
const COPY_SETTLE_MS = 150;
async function copyPrivate(text) {
  const t = String(text ?? '');
  const p = process.platform === 'win32' ? ensurePaster() : null;
  if (p && p.stdin && p.stdin.writable) {
    try {
      p.stdin.write(`${copyCommand(t)}\n`);
      await new Promise((r) => setTimeout(r, COPY_SETTLE_MS));
      if (clipEquals(readClipboardText(), t)) return;
    } catch (_) { /* 下で Electron が書く */ }
  }
  clipboard.writeText(t);
}
function readClipboardText() {
  try { return clipboard.readText(); } catch (_) { return null; }
}
// 改行の形（CRLF / LF）の違いは置けた・置けていないの判断に使わない
function clipEquals(a, b) {
  return typeof a === 'string' && a.replace(/\r\n/g, '\n') === String(b).replace(/\r\n/g, '\n');
}
// 貼り付け先がクリップボードを読む前に戻すと古い方が貼られる。SendWait は処理完了まで
// 待つが、読み取りが遅いアプリ（ブラウザの入力欄・Teams）は 500ms では間に合わなかった
const RESTORE_DELAY_MS = 2000;
async function deliverText(text) {
  // 自動貼り付けのあとは元のクリップボードを戻す（短い文字列だったときだけ・できる範囲で。
  // 判断は mainlib.restoreAfterPaste）。音声入力は「いま書いている場所へ入れる」道具なので、
  // 貼り付けた本文がクリップボードに残り続けると、直前にコピーしていたものが失われる。
  let prev = '';
  if (settings.autoPaste) { try { prev = clipboard.readText(); } catch (_) { prev = ''; } }
  await copyPrivate(text);
  if (!settings.autoPaste) return;
  await new Promise((r) => setTimeout(r, 50));
  // 貼り付け先は録音を始めたときの前面ウィンドウ（#54）。文字起こしの間に通知や Teams が
  // 前へ出ていると、そこへ口述が流れ込む。違えば貼らずクリップボードに残す
  const hwnd = await dictationFg;
  const result = await simulatePaste(hwnd);
  if (result === 'mismatch') { sendToMainWin('app:notice', '貼り付け先が変わったため、クリップボードに残しました（Ctrl+V で貼り付けられます）'); return result; }
  if (result === 'fail') { sendToMainWin('app:notice', '自動貼り付けに失敗しました。クリップボードに残しています'); return result; }
  if (restoreAfterPaste(prev, text)) setTimeout(() => { copyPrivate(prev).catch(() => {}); }, RESTORE_DELAY_MS);
  return result;
}

// ---------------------------------------------------------------- ウィンドウ
function sendToMainWin(ch, p) { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, p); }
function sendToOverlay(ch, p) { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(ch, p); }

function createOverlay() {
  overlayWin = new BrowserWindow({
    width: 316, height: 72,
    frame: false, transparent: true, resizable: false, movable: true,
    minimizable: false, maximizable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    // backgroundThrottling: false をここに入れてはいけない。Windows では
    // 透過ウィンドウの透明が壊れ、ピルの角の外に不透明の矩形が出る（実機で発生）。
    // タイマーの間引き対策は、間引かれない main 側からの overlay:tick で行う。
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  let moveT = null;
  overlayWin.on('move', () => {
    if (programmaticMove || !overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
    clearTimeout(moveT);
    moveT = setTimeout(() => {
      if (programmaticMove || !overlayWin || overlayWin.isDestroyed()) return;
      const [x, y] = overlayWin.getPosition();
      settings.pillCustom = { x, y };
      persistSettings();
    }, 350);
  });
}

function positionOverlay() {
  if (!overlayWin) return;
  const [w, h] = overlayWin.getSize();
  let px; let py;
  const c = settings.pillCustom;
  if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) {
    const d = screen.getDisplayNearestPoint({ x: c.x, y: c.y }).workArea;
    px = Math.min(Math.max(c.x, d.x), d.x + d.width - w);
    py = Math.min(Math.max(c.y, d.y), d.y + d.height - h);
  } else {
    const { x, y, width, height } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const mgn = 12;
    const pos = settings.pillPos || 'bottom';
    px = pos.includes('left') ? x + mgn : pos.includes('right') ? x + width - w - mgn : x + (width - w) / 2;
    py = pos.includes('top') ? y + mgn : pos.includes('bottom') ? y + height - h - mgn : y + (height - h) / 2;
  }
  programmaticMove = true;
  overlayWin.setPosition(Math.round(px), Math.round(py));
  setTimeout(() => { programmaticMove = false; }, 80);
}

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  mainWin = new BrowserWindow({
    width: 1120, height: 780, minWidth: 820, minHeight: 560,
    title: 'Listener',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // 地色は CSS が効く前の一瞬に見える色。ライト固定だとダークで
    // 開くたび・リサイズのたびに白くまたたく。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171a21' : '#E9EDF5',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'app.html'));
  if (recoveredPageId) {
    const id = recoveredPageId;
    recoveredPageId = null;
    mainWin.webContents.once('did-finish-load', () => {
      sendToMainWin('app:notice', '前回中断された議事録の文字起こしを復旧しました。「要約を生成」から議事録を作成できます。');
      sendToMainWin('page:open', id);
    });
  }
  // 閉じるボタンの挙動。既定はそのまま終了。設定でトレイ常駐に切り替えられる。
  mainWin.on('close', (e) => {
    if (quitting) return;
    if (settings.stayInTray) { e.preventDefault(); mainWin.hide(); return; }
    // 記録中・要約中の閉じ間違いで会議や要約を失わせない（文は mainlib.closeConfirm）。
    // draft からの復旧はあるが要約前の状態に戻るので、一度は確認を挟む。
    const confirm = closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing());
    if (confirm) {
      const r = dialog.showMessageBoxSync(mainWin, {
        type: 'warning', buttons: ['終了する', 'キャンセル'], defaultId: 1, cancelId: 1,
        message: confirm.message, detail: confirm.detail,
      });
      if (r !== 0) { e.preventDefault(); return; }
    }
    quitting = true;
    app.quit();
  });
}

// ---------------------------------------------------------------- 音声入力
function startRecording() {
  if (state !== 'idle') return;
  const problem = whisperProblem();
  if (problem) {
    createMainWindow();
    sendToMainWin('app:notice', problem);
    return;
  }
  ensureEngineReady(whisperEng);
  state = 'recording';
  // いま前にある窓が貼り付け先。オーバーレイを出す前に控える（#54）
  dictationFg = askPaster('fg', FG_REPLY_MS).then((r) => (r && r.kind === 'hwnd' ? r.value : ''));
  positionOverlay();
  overlayWin.showInactive();
  sendToOverlay('overlay:start', { mode: 'dictation', micId: settings.micId || '', sound: Boolean(settings.soundFeedback) });
  globalShortcut.register('Escape', cancelRecording);
  updateTray();
}
function stopRecording() {
  if (state !== 'recording') return;
  state = 'processing';
  globalShortcut.unregister('Escape');
  sendToOverlay('overlay:stop', {});
  updateTray();
}
function cancelRecording() {
  if (state !== 'recording') return;
  state = 'idle';
  globalShortcut.unregister('Escape');
  sendToOverlay('overlay:cancel', {});
  updateTray();
}
function toggleRecording() {
  if (state === 'idle') startRecording();
  else if (state === 'recording') stopRecording();
}

async function handleDictationAudio(buffer, durationMs) {
  // 取り消し後に届いた録音を処理しない。
  // Escape で取り消しても、録音側の停止処理が終わってから音声が届くことがあり、
  // そのまま進むと取り消したはずの文章が貼り付けられる。
  if (state !== 'recording' && state !== 'processing') return;
  if (state === 'recording') globalShortcut.unregister('Escape');
  state = 'processing'; updateTray();
  if (durationMs < MIN_RECORD_MS || buffer.byteLength < 1000) { finishWithError('録音が短すぎます'); return; }
  sendToOverlay('overlay:phase', { phase: 'processing', message: '文字起こし中…' });
  try {
    const t0 = Date.now();
    const raw = await transcribeLocal(buffer, '', durationMs);
    if (!raw) throw new Error('音声を認識できませんでした');
    let text = settings.removeFillers ? removeFillersRule(raw) : raw;
    if (!text) text = raw;
    const procMs = Date.now() - t0;
    history.unshift({
      id: store.newId('h'), text, raw,
      createdAt: new Date().toISOString(),
      durationSec: Math.round(durationMs / 1000), procMs, chars: text.length,
    });
    if (history.length > settings.maxHistory) history.length = settings.maxHistory;
    persistHistory();
    sendToMainWin('history:updated', history);
    await deliverText(text);
    const preview = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    sendToOverlay('overlay:phase', { phase: 'done', message: preview, procSec: (procMs / 1000).toFixed(1) });
    setTimeout(hideOverlayIfIdle, 1500);
    state = 'idle'; updateTray();
  } catch (e) { finishWithError(e.message || '不明なエラー'); }
}

function finishWithError(message) {
  // 録音中に確保した Escape を必ず手放す。ここを抜かすと、以後アプリ以外の
  // 場所でも Escape が効かなくなる（録音中だけの横取りのはずが残り続ける）。
  if (state === 'recording') globalShortcut.unregister('Escape');
  state = 'idle'; updateTray();
  sendToOverlay('overlay:phase', { phase: 'error', message });
  setTimeout(hideOverlayIfIdle, 3000);
}
function hideOverlayIfIdle() {
  if (state === 'idle' && overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

// ---------------------------------------------------------------- 区間の音声の退避（#8/#42）
// 区間は音声が届いた時点で { id, atMs, durationMs, pending: true, wav, text: '' } として
// meeting.segments と draft.json に控え、音声そのものを <userData>/data/segbuf/<開始時刻>/<seq>.wav
// へ退避する。文字起こしが終わったら同じ要素を結果で置き換え、wav を消す。
// 以前は文字起こしが終わるまで draft に載らず、その間にアプリが落ちると音声ごと消えていた。
// 残った wav は次回起動時に文字起こしして復旧ページへ差し替える（recoverDraftIfAny）。
const segbufRoot = () => path.join(app.getPath('userData'), 'data', 'segbuf');
const segbufDir = (startedAt) => path.join(segbufRoot(), String(startedAt));
function spoolSegment(dir, seq, buffer) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${seq}.wav`);
    // 一時ファイルに書いてから置き換える（書き込み中に落ちても半端な wav を復旧しない）
    fs.writeFileSync(`${file}.tmp`, buffer);
    fs.renameSync(`${file}.tmp`, file);
    return file;
  } catch (e) {
    engineLog(`音声の退避に失敗: ${e.message}`);   // 退避できなくても文字起こしは続ける
    return '';
  }
}
function unlinkQuiet(file) { if (file) { try { fs.unlinkSync(file); } catch (_) { /* noop */ } } }
// 空のときだけ消す（rmdir は中身があれば失敗する）。中身が残っているなら復旧の材料
function removeDirIfEmpty(dir) { try { fs.rmdirSync(dir); } catch (_) { /* noop */ } }
// 破棄: 退避した音声は復旧の材料にしない（破棄は利用者の意思）
function cleanupSegbuf(m) {
  for (const s of m.segments) unlinkQuiet(s.wav);   // 待ちの区間も、失敗して残した区間も
  removeDirIfEmpty(segbufDir(m.startedAt));
}
// 文字起こし待ちの区間を結果で置き換える（id/atMs はそのまま。pending/wav を外し、wav を消す）。
// patch が null なら区間ごと消す（空・直前の繰り返し。以前は push しなかったのと同じ）。
// 認識に失敗した区間（時間切れ・エンジンの落ち）は wav を残す: 議事録を締めるときに
// 復旧と同じ待ち行列に載せ、要約のあとでもう一度文字起こしする（maybeFinalizeMeeting）。
// 消してしまうと、その 75 秒は二度と戻らない
function settleSegment(m, seg, patch) {
  const keepWav = Boolean(patch && patch.failed && seg.wav);
  if (!keepWav) unlinkQuiet(seg.wav);
  if (patch) {
    const wav = seg.wav;
    delete seg.pending; delete seg.wav;
    Object.assign(seg, patch);
    if (keepWav) seg.wav = wav;
  } else {
    const i = m.segments.indexOf(seg);
    if (i >= 0) m.segments.splice(i, 1);
  }
  writeDraft();
  sendToMainWin('meeting:update', meetingStatus());
}

// 文字起こしが追いつかないとき（待ちが 3 区間を超える）は区間を倍に伸ばして送る回数を
// 減らし、追いついたら（待ち 1 以下）設定の長さに戻す（判断は mainlib.nextSegmentMs。#42）。
// 変わったときだけオーバーレイへ送る（次の区切りから効く）
function applyBackpressure(m, delta) {
  const base = (settings.segmentSec || 75) * 1000;
  const next = nextSegmentMs(pendingSegs, m.segmentMs || base, base, delta);
  if (next === m.segmentMs) return;
  m.segmentMs = next;
  sendToOverlay('overlay:segment-ms', next);
}

// 残りの待ち時間（秒）。待ちの区間の長さの合計に、区間ごとの処理時間の比（EMA。
// mainlib.EtaTracker）を掛ける。進行中の区間で既に経過した分は引く。待ちが無ければ null。
// 比はアプリの起動中は持ち越す（次の会議の最初の区間から見積もれる）
const eta = new EtaTracker();
function etaSecOf(m) {
  const remain = pendingDurationMs(m.segments);
  if (remain <= 0) return null;
  return eta.etaSec(remain, m.inFlightSince ? Date.now() - m.inFlightSince : 0);
}

// ---------------------------------------------------------------- 議事録
function meetingStatus() {
  return {
    active: state === 'meeting' || state === 'meeting-finalizing',
    finalizing: state === 'meeting-finalizing',
    startedAt: meeting ? meeting.startedAt : null,
    memo: meeting ? meeting.memo : '',
    segments: meeting ? publicSegments(meeting.segments) : [],   // wav（パス）は外す。待ちは pending: true
    pending: pendingSegs,
    stoppedAt: meeting && meeting.stoppedAt ? meeting.stoppedAt : null,
    // 終了を押した後（文字起こし待ち）。画面はこれを見て残り区間と打ち切りの導線を出す
    stopping: Boolean(meeting && meeting.stopping),
    paused: Boolean(meeting && meeting.paused),
    pausedMs: meeting ? meeting.pausedMs + (meeting.paused ? Date.now() - meeting.pausedAt : 0) : 0,
    systemAudio: Boolean(meeting && meeting.systemAudio),
    // 選んだマイクが見つからず既定のマイクで録っている（overlay:mic）。黙って
    // 別のマイクで録ると、会議が終わってから片側しか入っていないことに気づく
    micFallback: Boolean(meeting && meeting.micFallback),
    // 残りの待ち時間の見積もり（秒。材料が無い・待ちが無いときは null）と、打ち切った区間の数
    etaSec: meeting ? etaSecOf(meeting) : null,
    skipped: meeting ? meeting.skipped : 0,
  };
}

function writeDraft() {
  if (!meeting) return;
  store.writeDraft({
    startedAt: meeting.startedAt, memo: meeting.memo,
    segments: meeting.segments, offsetMs: meeting.offsetMs, savedAt: Date.now(),
  });
}

// 復旧ページで文字起こし待ちのまま残った音声 { pageId, items: [{ id, wav, durationMs }], dir }。
// 起動が済んでエンジンが用意できてから順に文字起こしする
let recoveryQueue = null;
const RECOVERY_FILE = 'recovery.json';
// 復旧の待ち行列をフォルダに書いておく。エンジンが用意できずに終えられなかったとき、
// 次の起動や設定の直しで続きから文字起こしできる（wav は消さない）
function saveRecoveryQueue(q) {
  try { fs.writeFileSync(path.join(q.dir, RECOVERY_FILE), JSON.stringify({ pageId: q.pageId, items: q.items, retry: Boolean(q.retry) }), 'utf8'); } catch (_) { /* noop */ }
}
function loadSavedRecoveryQueue() {
  let names = [];
  try { names = fs.readdirSync(segbufRoot()); } catch (_) { return null; }
  for (const name of names) {
    const dir = path.join(segbufRoot(), name);
    const f = path.join(dir, RECOVERY_FILE);
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const items = (j.items || []).filter((it) => it && it.wav && fs.existsSync(it.wav));
      if (j.pageId && items.length && store.getPage(j.pageId)) return { pageId: j.pageId, items, dir, retry: Boolean(j.retry) };
      try { fs.unlinkSync(f); } catch (_) { /* noop */ }
      removeDirIfEmpty(dir);
    } catch (_) {
      try { fs.unlinkSync(f); } catch (_2) { /* noop */ }   // 壊れた待ち行列。残すと掃除（cleanOrphanSegbuf）が避け続ける
    }
  }
  return null;
}
function recoverDraftIfAny() {
  const d = store.readDraft();
  if (!d || !Array.isArray(d.segments) || d.segments.length === 0) { store.clearDraft(); return; }
  const dt = new Date(d.startedAt || Date.now());
  // 文字起こしが終わっていなかった区間（pending）は失敗扱いでページに載せ、wav が残っていれば
  // あとで文字起こしして差し替える（mainlib.recoverSegments）。先にページを作るのは、
  // エンジンの起動を待たずに復旧した本文を開けるようにするため
  const rec = recoverSegments(d.segments, (f) => fs.existsSync(f));
  const page = store.createPage({
    title: `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} の議事録（復旧）`,
    // 日付はローカルの暦日（#51。UTC で作ると日本の朝の会議が前日になる）
    date: localDateISO(dt),
    durationSec: Math.round((d.offsetMs || 0) / 1000),
    memo: d.memo || '',
    blocks: [],
    segments: rec.segments,
    createdAt: new Date(d.startedAt || Date.now()).toISOString(),
    recovered: true,
  });
  page.summaryError = rec.todo.length
    ? '録音が中断されたため要約は未生成です。残っていた音声の文字起こしを続けています。終わったら「要約を生成」で作成できます。'
    : '録音が中断されたため要約は未生成です。「要約を生成」で作成できます。';
  store.savePage(page);
  store.clearDraft();
  recoveredPageId = page.id;
  if (rec.todo.length) {
    recoveryQueue = { pageId: page.id, items: rec.todo, dir: segbufDir(d.startedAt) };
    saveRecoveryQueue(recoveryQueue);
  } else removeDirIfEmpty(segbufDir(d.startedAt));
}

// 復旧ページの「文字起こし待ち」を、起動が済んでエンジンが用意できてから順に文字起こしし、
// store.updateSegment で本文を差し替える（failed が外れて要約の材料に戻る）。
// 失敗した区間は失敗の文を残す。ページが消されていたら残りの wav を捨てて止める。
// 済んだ wav は消し、空になった退避フォルダも消す。
let recoveryRunning = false;
async function transcribeRecovered() {
  if (recoveryRunning) return;
  let q = recoveryQueue;
  if (!q) return;
  recoveryRunning = true;
  updateTray();   // 復旧中は「手が塞がっている」（isBusy）。トレイの有効／無効を追随させる
  try {
    const seen = new Set();   // 同じ待ち行列を二度拾わない（recovery.json を消せなかったとき）
    while (q && !seen.has(q.dir)) {
      seen.add(q.dir);
      const ready = await ensureEngineReady(whisperEng);
      if (!ready) {
        // エンジンが未設定・未起動のときは何も消さない。wav と待ち行列（recovery.json）を残し、
        // 設定を直したとき（settings:save）や次の起動でもう一度ここへ来る
        engineLog(`復旧の文字起こしを保留: ${whisperEng.lastError || 'エンジンが起動していません'}`);
        return;
      }
      recoveryQueue = null;
      await transcribeRecoveredItems(q);
      // 別の会議の分（議事録を締めたとき既に待ち行列があった失敗区間）が残っていれば続ける
      q = recoveryQueue = loadSavedRecoveryQueue();
    }
  } finally {
    recoveryRunning = false;
    updateTray();
  }
}
async function transcribeRecoveredItems(q) {
  let done = 0;
  for (const item of q.items) {
    if (!store.getPage(q.pageId)) { unlinkQuiet(item.wav); continue; }   // ページが消された
    let text = null;
    let err = '';
    if (!err) {
      try {
        text = await transcribeLocal(fs.readFileSync(item.wav), '', item.durationMs);
        if (settings.removeFillers) text = removeFillersRule(text);
      } catch (e) { err = e.message; }
    }
    if (err) {
      // 失敗の文を残す（updateSegment は failed を外してしまうので直接書く）
      const segs = store.getTranscript(q.pageId);
      const s = segs.find((x) => x.id === item.id);
      if (s) { s.text = `（この区間の認識に失敗: ${err}）`; s.failed = true; store.saveTranscript(q.pageId, segs); }
    } else if (text) {
      store.updateSegment(q.pageId, item.id, { text });
      done++;
    } else {
      removeTranscriptSegment(q.pageId, item.id);   // 無音: 区間ごと消す（記録中と同じ扱い）
      done++;
    }
    // 推論まで到達した wav は成否にかかわらず消す（同じ音声を何度も失敗させても意味が無い）
    unlinkQuiet(item.wav);
  }
  try { fs.unlinkSync(path.join(q.dir, RECOVERY_FILE)); } catch (_) { /* noop */ }
  removeDirIfEmpty(q.dir);
  const page = store.getPage(q.pageId);
  if (!page) return;
  // 「続けています」の文を通常の復旧の文に戻す（別の要約が書いていれば触らない）
  const latest = saveIfExists(store, q.pageId, (p) => {
    if (String(p.summaryError || '').includes('文字起こしを続けています')) {
      p.summaryError = '録音が中断されたため要約は未生成です。「要約を生成」で作成できます。';
    }
  });
  sendToMainWin('pages:updated', store.listPages());
  sendToMainWin('page:updated', { page: latest || page, segments: store.getTranscript(q.pageId) });
  sendToMainWin('app:notice', q.retry
    ? `認識に失敗していた区間の文字起こしをやり直しました（${done}/${q.items.length} 区間）。「要約を生成」で議事録を作り直せます。`
    : `中断されていた文字起こしの復旧が終わりました（${done}/${q.items.length} 区間）。「要約を生成」で議事録を作成できます。`);
}
function removeTranscriptSegment(pageId, segId) {
  store.saveTranscript(pageId, store.getTranscript(pageId).filter((s) => s.id !== segId));
}

// 7 日より古い退避フォルダを消す（復旧されずに残った孤児。判断は mainlib.staleSegbufDirs）。
// 今回復旧中のフォルダ（keepDir）は残す
function cleanOrphanSegbuf(keepDir) {
  let names = [];
  try { names = fs.readdirSync(segbufRoot()); } catch (_) { return; }
  const entries = names.map((name) => {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(path.join(segbufRoot(), name)).mtimeMs; } catch (_) { /* noop */ }
    return { name, mtimeMs };
  });
  for (const name of staleSegbufDirs(entries, Date.now())) {
    const dir = path.join(segbufRoot(), name);
    if (dir === keepDir) continue;
    // 待ち行列が残っている（エンジンが用意できず 7 日以上そのまま等）フォルダは復旧の材料。
    // 今回の復旧が終わったあと transcribeRecovered が順に拾う
    if (fs.existsSync(path.join(dir, RECOVERY_FILE))) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

function startMeeting() {
  if (state !== 'idle') return { ok: false, error: '他の処理を実行中です' };
  const problem = whisperProblem();
  if (problem) return { ok: false, error: problem };
  meeting = { startedAt: Date.now(), memo: '', segments: [], offsetMs: 0, stopping: false, seq: 0,
    systemAudio: false, paused: false, pausedMs: 0, pausedAt: 0,
    // gen: 打ち切り（meeting:skipPending）で進める世代。進行中の結果を捨てる判断に使う
    // segmentMs: いま録音側に頼んでいる区間の長さ（背圧で伸縮する）
    // inFlightSince: 文字起こし中の区間の開始時刻（残り時間の見積もりで経過分を引く）
    // finalSeen: 録音側の最後の区間が届いたか。skipAll: 打ち切り後に届く区間も文字起こしせず数だけ残す
    gen: 0, skipped: 0, micFallback: false, segmentMs: (settings.segmentSec || 75) * 1000, inFlightSince: 0,
    finalSeen: false, skipAll: false };
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'meeting';
  writeDraft();
  ensureEngineReady(whisperEng);
  // 要約エンジンはここで先読みしない（#58）。記録開始で起動すると約 3GB が上がり、破棄しても
  // 降りない（記録だけして要約しない会議でも掴んだまま）。要約直前の ensureEngineReady(sumEng)
  // （generateMinutes）に任せる。その分、最初の要約はモデル読み込みの待ちを含む
  positionOverlay();
  overlayWin.showInactive();
  // 音声入力の開始（上の 'dictation'）には systemAudio を渡さない。
  // あちらは常にマイクだけで、今回の変更で挙動が変わってはいけない。
  const payload = {
    mode: 'meeting', segmentSec: settings.segmentSec || 75,
    micId: settings.micId || '', sound: Boolean(settings.soundFeedback),
    systemAudio: Boolean(settings.useSystemAudio),
  };
  if (payload.systemAudio && overlayWin && !overlayWin.isDestroyed()) {
    // 相手の声の取り込みは「ユーザー操作の直後」でないと拒まれることがある。
    // オーバーレイはホットキーで出る焦点の当たらない小窓なので、
    // executeJavaScript の第2引数でその扱いにして呼ぶ。
    // 失敗したら従来の IPC 経路へ落とす（マイクだけにはなるが録音は始まる）。
    overlayWin.webContents
      .executeJavaScript(`window.__koeStart(${JSON.stringify(payload)})`, true)
      .catch(() => sendToOverlay('overlay:start', payload));
  } else {
    sendToOverlay('overlay:start', payload);
  }
  startMeetingTick();
  updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}

function stopMeeting() {
  if (state !== 'meeting') return { ok: false };
  state = 'meeting-finalizing';
  meeting.stopping = true;
  // 会議の長さはここまで。以降の文字起こし待ちを所要時間に混ぜると、
  // 実際の会議時間が分からなくなる（4分の会議が12分と記録されていた）。
  meeting.stoppedAt = Date.now();
  // 一時停止したまま停止したら、停止時刻で一時停止を締める。開けたままだと
  // 所要時間の計算が「今」まで一時停止として引き、文字起こし待ちの分だけ
  // 短くなる（待ちが長いと負になる）。
  if (meeting.paused) {
    meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt;
    meeting.paused = false;
    meeting.pausedAt = 0;
  }
  sendToOverlay('overlay:stop', {});
  sendToOverlay('overlay:phase', { phase: 'processing', message: '議事録を作成中…' });
  sendToMainWin('meeting:progress', { message: '録音を終了し、残りの文字起こしを処理しています…' });
  updateTray();
  // 開始・破棄と同じく状態を送る。これが無いと、ホットキーやトレイから
  // 終了したときにボタンが「■ 終了して作成」のまま残る。
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}

function discardMeeting() {
  if (state !== 'meeting' && state !== 'meeting-finalizing') return { ok: false };
  sendToOverlay('overlay:cancel', {});
  const m = meeting;
  cleanupSegbuf(m);
  meeting = null; store.clearDraft();
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'idle'; updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}

function toggleMeetingByHotkey() {
  if (state === 'idle') {
    const r = startMeeting();
    createMainWindow();
    if (!r.ok) sendToMainWin('app:notice', r.error || '議事録を開始できません');
  } else if (state === 'meeting') stopMeeting();
}

function onMeetingSegment(buffer, durationMs, isFinal) {
  if (!meeting) return;
  // 文字起こしは録音より遅れて終わる。その間に議事録が破棄されて次の記録が
  // 始まっていることがあるので、この区間が属する議事録を捕まえておき、
  // 「今も同じ議事録か」で判断する。単なる null 判定だと、破棄した議事録の
  // 発言が次の議事録に紛れ込む。
  const m = meeting;
  const segOffset = m.offsetMs;
  m.offsetMs += durationMs;
  if (isFinal) m.finalSeen = true;
  // 打ち切り（meeting:skipPending）の後に届いた区間（録音側で変換中だった最後の区間）は
  // 文字起こしせず「打ち切り」として残す。黙って捨てると残り件数にも出ず、痕跡が無くなる
  if (m.skipAll) {
    if (buffer.byteLength >= 4000) {
      m.segments.push({ id: `s${++m.seq}`, atMs: segOffset, durationMs, text: '（文字起こしを打ち切り）', failed: true });
      m.skipped++;
      writeDraft();
    }
    sendToMainWin('meeting:update', meetingStatus());
    if (isFinal) maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    return;
  }
  // 短すぎる端切れ（無音の切れ端）は区間にしない。件数には数え、最後の区間なら締めの引き金にする
  let seg = null;
  if (buffer.byteLength >= 4000) {
    // 音声を先にディスクへ退避し、区間を「文字起こし待ち」として draft に控える（#8/#42）。
    // 文字起こしは録音より遅れて終わる。その間にアプリが落ちても、wav が残っていれば
    // 次回起動時に文字起こしして復旧できる
    seg = { id: `s${++m.seq}`, atMs: segOffset, durationMs, pending: true, wav: '', text: '' };
    seg.wav = spoolSegment(segbufDir(m.startedAt), m.seq, buffer);
    m.segments.push(seg);
    writeDraft();
  }
  // 打ち切り（meeting:skipPending）で世代が進んだら、進行中・待ち行列の結果は捨てる
  const gen = m.gen;
  pendingSegs++;
  applyBackpressure(m, 1);
  sendToMainWin('meeting:update', meetingStatus());
  segChain = segChain.then(async () => {
    if (meeting !== m || m.gen !== gen || !seg) return;
    // 直近の「成功した」区間の末尾。失敗区間のエラー文を渡すと、次の区間が
    // それを文例として真似る（mainlib.promptTail。待ちの区間は飛ばす）。
    const tail = promptTail(m.segments);
    const t0 = Date.now();
    m.inFlightSince = t0;
    let text = '';
    try {
      text = await transcribeLocal(buffer, tail, durationMs);
    } catch (e) {
      if (meeting !== m || m.gen !== gen) return;
      m.inFlightSince = 0;
      settleSegment(m, seg, { text: `（この区間の認識に失敗: ${e.message}）`, failed: true });
      return;
    }
    if (meeting !== m || m.gen !== gen) return;
    m.inFlightSince = 0;
    eta.record(Date.now() - t0, durationMs);   // 成功した区間だけで学習（失敗は時間の目安にならない）
    if (settings.removeFillers) text = removeFillersRule(text);
    // 空・直前と同じ（繰り返しハルシネーション）は区間ごと消す
    const done = m.segments.filter((s) => !s.pending);
    const prev = done.length ? done[done.length - 1].text : '';
    if (!text || (prev && text.length > 6 && prev === text)) { settleSegment(m, seg, null); return; }
    settleSegment(m, seg, { text });
  }).catch(() => {}).finally(() => {
    // 破棄済みの議事録の区間は、破棄時に数え直した件数を減らさない
    if (meeting === m) { pendingSegs = Math.max(0, pendingSegs - 1); applyBackpressure(m, -1); }
    sendToMainWin('meeting:update', meetingStatus());
    if (meeting === m && (isFinal || (m.stopping && pendingSegs === 0))) {
      maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    }
  });
}

async function maybeFinalizeMeeting() {
  if (!meeting || !meeting.stopping || pendingSegs > 0) return;
  if (state !== 'meeting-finalizing') return;
  // 打ち切りで待ち件数を 0 にしても、録音側が変換中の最後の区間はこれから届く。
  // 先に締めると、その区間は議事録の無いところへ届いて消える（打ち切りの数にも入らない）
  if (meeting.skipAll && !meeting.finalSeen) return;
  const m = meeting;
  meeting = null;

  // 一時停止していた時間は会議の長さに含めない。基準は停止時刻であって
  // 「今」ではない（今で計ると文字起こし待ちが混ざる。mainlib.meetingDurationSec）。
  const endAt = m.stoppedAt || Date.now();
  const durationSec = meetingDurationSec(m, endAt);
  const dt = new Date(m.startedAt);
  const fallbackTitle = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} の議事録`;

  let page = null;
  try {
    page = store.createPage({
      title: fallbackTitle,
      date: localDateISO(dt),   // ローカルの暦日（#51）
      durationSec, memo: m.memo, blocks: [],
      segments: settledSegments(m.segments),   // 待ちの区間（本文なし）と wav のパスは載せない
      createdAt: dt.toISOString(),
    });
    store.clearDraft();
    // 認識に失敗した区間の wav は残してある（settleSegment）。復旧と同じ待ち行列に載せ、
    // 要約のあとでもう一度文字起こしする。途中で落ちても recovery.json から次の起動で続く
    const retry = m.segments.filter((s) => s.failed && s.wav && fs.existsSync(s.wav))
      .map((s) => ({ id: s.id, wav: s.wav, durationMs: Number(s.durationMs) || 0 }));
    if (retry.length) {
      const q = { pageId: page.id, items: retry, dir: segbufDir(m.startedAt), retry: true };
      saveRecoveryQueue(q);
      if (!recoveryQueue) recoveryQueue = q;   // 別の復旧が待っていれば、その後に拾う（transcribeRecovered）
    }
    removeDirIfEmpty(segbufDir(m.startedAt));   // 全区間が片付いていれば空
  } catch (e) {
    // 保存に失敗しても draft.json は消さない（次回起動時に復旧できる）
    engineLog(`議事録の保存に失敗: ${e.message}`);
    sendToOverlay('overlay:phase', { phase: 'error', message: '議事録を保存できませんでした' });
    sendToMainWin('app:notice', `議事録を保存できませんでした: ${e.message}\n次回起動時に復旧を試みます。`);
  } finally {
    // 何があっても録音状態は解除する。ここを抜けると画面が「作成中…」で止まる。
    state = 'idle'; updateTray();
    setTimeout(hideOverlayIfIdle, 2000);
    sendToMainWin('meeting:update', meetingStatus());
  }
  if (!page) return;

  sendToOverlay('overlay:phase', { phase: 'done', message: '議事録を保存しました' });
  sendToMainWin('pages:updated', store.listPages());
  sendToMainWin('page:open', page.id);

  await runSummary(page.id);
  if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`retry failed: ${e.message}`));
}

// 同じページの要約は同時に一つだけ（mainlib.makeSummaryRunner。main.test.js で
// 実行して固定）。走行中に「要約を生成」を連打されると、同じ文字起こしに対して
// 要約が二重に走り、後から終わった方が前の結果（とその間の編集）を上書きしていた。
// 走行中なら同じ Promise を返す。
const runSummary = makeSummaryRunner(doRunSummary, () => updateTray());
// 要約が走っている間はアプリを「忙しい」として扱う（#52）: 省電力を止めない・終了前に
// 確かめる・更新と再起動を拒む。件数は mainlib.makeSummaryRunner が持つ。
const isSummarizing = () => runSummary.running().length > 0;
// 「手が塞がっている」: 記録・文字起こし・要約・復旧の文字起こしのどれかが動いている。
// データ保存先の移動（#29）と、使われないエンジンの停止（#58）はこれが false のときだけ
const isBusy = () => state !== 'idle' || isSummarizing() || recoveryRunning || pendingSegs > 0;

// 要約の生成 → ブロック化 → 出典付与 → 保存
async function doRunSummary(pageId) {
  // どの経路で抜けても進捗表示と録音状態を必ず解除する
  const clearUi = () => {
    sendToMainWin('meeting:progress', { message: '' });
    sendToMainWin('meeting:update', meetingStatus());
  };
  // 保存は必ず「いまディスクにあるページ」に対して行う。入口で読んだ page を
  // 書き戻すと、要約中に削除された議事録が復活する（mainlib.saveIfExists）。
  const gone = () => {
    engineLog('要約完了時にページが無い（削除済み）ため破棄');
    clearUi();
    return { ok: false, error: 'ページが削除されました' };
  };
  const page = store.getPage(pageId);
  if (!page) { clearUi(); return { ok: false, error: 'ページが見つかりません' }; }
  let segments = store.getTranscript(pageId);   // 出典付与の直前に読み直して差し替える（下記）
  const segmentsAtStart = segments;   // 要約の材料にした配列。出典付けで今の配列と突き合わせる（#4）
  const usable = segments.filter((s) => !s.failed && !s.pending);
  const plain = usable.map((s) => s.text).join('\n');

  if (!plain.trim()) {
    const err = '文字起こしが空のため要約できません';
    const saved = saveIfExists(store, pageId, (p) => { p.summaryError = err; });
    if (!saved) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: saved, segments });
    return { ok: false, error: err };
  }
  if (!engineValid(sumEng)) {
    const err = '要約エンジンが未設定のため、文字起こしのみ保存しました。'
      + 'setup-summarizer.ps1 を実行し、設定タブでパスを指定すると「要約を生成」で作成できます。';
    const saved = saveIfExists(store, pageId, (p) => { p.summaryError = err; });
    if (!saved) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: saved, segments });
    sendToMainWin('app:notice', err);
    return { ok: false, error: err };
  }

  // 会議タイプ: 手動指定があればそれを尊重し、無ければタイトルと冒頭から推定。
  // 自動判定は手動指定があっても必ず走らせ、結果を別に残す。こうしないと
  // 「自動判定が当たっていたか」を後から誰も確かめられない
  // （手で選んだ議事録では detectType が一度も呼ばれていなかった）。
  const autoType = mtype.detectType(page.title, plain.slice(0, 1200));
  page.autoType = autoType;
  if (!page.meetingType || page.typeAuto !== false) {
    // 判定材料が無いときの既定は「定例・進捗報告」。タイトルを付けない
    // 運用では自動判定はほぼ働かず（本文だけで5語必要）、一般テンプレート
    // より定例の見出しの方が実務に合う。
    page.meetingType = autoType === 'general' ? 'standup' : autoType;
    page.typeAuto = true;
  }
  // タイトルは書かない。1on1・面談の議事録は機微で、engine.log は
  // 不具合報告に添付されうる。
  engineLog(`会議タイプ: 採用=${page.meetingType} 自動判定=${autoType}`
    + ` 手動=${page.typeAuto === false} 区間数=${usable.length}`);

  sendToMainWin('meeting:progress', {
    message: `要約エンジンで議事録を作成中…（${mtype.getLabel(page.meetingType)}として要約します）`,
  });
  try {
    const { md, truncatedParts, finalTruncated } = await generateMinutes(
      plain, page.memo,
      (msg) => sendToMainWin('meeting:progress', { message: msg }),
      page.meetingType,
    );
    // 「特になし」の混入を先に落とす。ここで落とさないと
    // 「- [ ] 特になし」がアクション1件として数えられてしまう。
    // 続けて、テンプレートの見出し・雛形をそのまま写した行も落とす。
    const blocks = dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(md)), minutesTemplate(page.meetingType));
    // 担当・期限を先に抜く。出典の突き合わせは
    // 「（担当: ○○ / 期限: ○○）」を落とした本文に対して行いたい。
    // 書式が残ったままだと、その語がクエリに混ざって一致がぶれる。
    const actStat = enrichActionBlocks(blocks, new Date(page.createdAt));
    // 要約は数分かかる。その間に文字起こしが編集されているかもしれないので、
    // 出典は読み込み時の配列ではなく、いまディスクにある文字起こしに対して付ける。
    // 画面へ返す segments も同じもの（古い配列を返すと、編集した行が画面上で戻る）。
    const fresh = store.getTranscript(pageId);
    // 要約の材料にした配列（入口）と今の配列の両方を渡す（#4。cite.attachCitationsAcross）
    const stat = attachAcross(blocks, fresh, segmentsAtStart);
    segments = fresh;

    // 同じ理由で、タイトルやメモも読み込み時のページを丸ごと書き戻さず、
    // 生成物だけを最新のページに載せる。ページが消えていれば生成物は捨てる。
    const latest = saveIfExists(store, pageId, (saved) => {
      saved.blocks = blocks;
      saved.meetingType = page.meetingType;
      saved.typeAuto = page.typeAuto;
      saved.autoType = page.autoType;
      saved.citeStat = stat;
      saved.actionStat = actStat;
      // 切れたパートと最終統合の打ち切りを名指しする（mainlib.truncationMessage。無ければ ''）
      saved.summaryError = truncationMessage(truncatedParts, finalTruncated);
    });
    if (!latest) return gone();
    clearUi();
    sendToMainWin('pages:updated', store.listPages());
    sendToMainWin('page:updated', { page: latest, segments });
    return { ok: true, page: latest, stat };
  } catch (e) {
    if (quitting) return { ok: false, error: e.message };   // 終了中: before-quit が書いた「中断」の文を上書きしない
    const latest = saveIfExists(store, pageId, (saved) => { saved.summaryError = e.message; });
    if (!latest) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: latest, segments });
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------- ホットキー / トレイ
// 登録できていないホットキーの状態。画面（hotkey:state）とトレイに出す。
// 形は mainlib.hotkeyStatus の state: { ok, failed, fallback, message }。
// 以前は片方が他アプリと衝突すると両方を黙って既定に戻し、ディスクにも
// 書いていたので、利用者は「設定したキーが勝手に変わる」としか見えなかった。
let hotkeyState = { ok: true, failed: [], fallback: {}, message: '' };
let hotkeyNote = '';   // トレイに添える「（音声入力: 既定の … を使用中）」「（Alt+M は登録できず）」
// 実際に登録しているキー。settings は常に利用者が選んだキーを持ち、起動時に既定へ
// 退避してもここにだけ入れる。settings に書くと settings:get が既定を返して設定画面に
// 既定が出、次の無関係な保存（自動起動の切り替えなど）でディスクにも漏れて、
// 利用者のキーが黙って消える。トレイと保存時の登録し直しはこちらを使う。
let activeHotkeys = { hotkey: '', meetingHotkey: '' };

// 片方ずつ独立に登録する。片方が失敗しても成功した側は解除しない
// （mainlib.registerHotkeys）。戻り値 { ok, failed: ['音声入力'|'議事録'…] }
function applyHotkeys(hk, mhk) {
  globalShortcut.unregisterAll();
  return registerHotkeys([
    { label: '音声入力', accel: hk, handler: toggleRecording },
    { label: '議事録', accel: mhk, handler: toggleMeetingByHotkey },
  ], (accel, handler) => globalShortcut.register(accel, handler));
}

/*
 * トレイのアイコン。
 *
 * nativeImage が読めるのは PNG / JPEG（Windows なら ICO も）だけで、
 * SVG は読めない。以前は SVG のデータURLから作っていたため常に空の画像になり、
 * タスクトレイのアイコンが透明になっていた。
 *
 * 図柄は src/assets に置く。src/ 配下ならアプリ内更新で一緒に入れ替わる
 * （更新は src/ をまるごと差し替える方式のため）。
 * ICO は 16/20/24/32/48/64 を含むので、Windows が画面のDPIに合うものを選ぶ。
 */
function makeTrayIcon(recording) {
  const base = path.join(__dirname, 'assets', recording ? 'tray-rec' : 'tray');
  const candidates = process.platform === 'win32'
    ? [`${base}.ico`, `${base}.png`]
    : [`${base}.png`];
  for (const file of candidates) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  // 見つからなければアプリのアイコンで代用する（透明なトレイよりはよい）
  const fallback = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  return fallback.isEmpty() ? fallback : fallback.resize({ width: 16, height: 16 });
}

// トレイからの更新確認。画面を経由しないので、レンダラーが壊れていても動く。
async function checkUpdateFromTray() {
  const target = updateTarget();
  const r = await updater.check(app.getVersion(), app.getPath('userData'));
  if (!r.ok) {
    dialog.showMessageBox({ type: 'error', message: '更新を確認できませんでした', detail: r.error || '' });
    return;
  }
  if (!r.update) {
    dialog.showMessageBox({ type: 'info', message: `最新です（${app.getVersion()}）` });
    return;
  }
  if (!target.ok) {
    const pick = dialog.showMessageBoxSync({
      type: 'info', buttons: ['配布ページを開く', '閉じる'], defaultId: 0, cancelId: 1,
      message: `新しいバージョン ${r.version} があります`, detail: target.error || '',
    });
    if (pick === 0) shell.openExternal(`https://github.com/${updater.REPO}/releases/latest`);
    return;
  }
  const pick = dialog.showMessageBoxSync({
    type: 'question', buttons: ['更新して再起動', 'あとで'], defaultId: 0, cancelId: 1,
    message: `新しいバージョン ${r.version} があります`,
    detail: String(r.notes || '').slice(0, 800),
  });
  if (pick !== 0) return;
  if (isSummarizing()) {   // 確認の間に要約が始まっていることがある（#52）
    dialog.showMessageBox({ type: 'info', message: '要約を作成中です', detail: '終わってから更新してください' });
    return;
  }
  const res = await updater.apply(r.url, target.root, app.getPath('userData'), () => {});
  if (!res.ok) {
    dialog.showMessageBox({ type: 'error', message: '更新に失敗しました', detail: res.error || '' });
    return;
  }
  quitting = true;
  stopEngine(whisperEng); stopEngine(sumEng); stopPaster();
  app.relaunch();
  app.exit(0);
}

function updateTray() {
  updatePowerBlock();
  if (!tray) return;
  const recording = state === 'recording' || state === 'meeting';
  tray.setImage(recording ? trayIconRec : trayIconIdle);
  const items = [];
  if (state === 'meeting') {
    items.push({ label: '■ 議事録を終了して作成', click: stopMeeting });
    items.push({ label: '議事録を破棄', click: discardMeeting });
  } else if (state === 'meeting-finalizing') {
    items.push({ label: '議事録を作成中…', enabled: false });
  } else {
    items.push({
      label: state === 'recording' ? '■ 停止して文字起こし' : state === 'processing' ? '文字起こし中…' : '● 音声入力を開始',
      enabled: state !== 'processing', click: toggleRecording,
    });
    items.push({ label: '議事録の記録を開始', enabled: state === 'idle', click: () => { startMeeting(); createMainWindow(); } });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'ノートを開く', click: createMainWindow });
  // 更新はトレイからも行えるようにする。画面側の組み立てが1か所でも
  // つまずくと、設定タブの「更新を確認」ボタンごと動かなくなり、
  // アプリ内更新で直すこともできなくなる（実機で起きた）。
  // 復旧の手段が、壊れうるものに依存していてはいけない。
  items.push({ label: '更新を確認', enabled: state === 'idle' && !isSummarizing(), click: checkUpdateFromTray });
  // エンジンを手で止めてメモリを解放する（#58）。どちらかが起動していて、手が空いているときだけ
  items.push({ label: 'エンジンを停止（メモリを解放）', enabled: (Boolean(whisperEng.proc) || Boolean(sumEng.proc)) && !isBusy(), click: stopEnginesFromTray });
  items.push({ type: 'separator' });
  items.push({ label: '終了', click: quitFromTray });
  // 既定で代替している／登録できていないキーがあれば、その旨を添える
  // （画面を開かなくても気づけるように）
  if (hotkeyNote) items.push({ label: `ホットキー ${hotkeyNote}`, enabled: false });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  // 出すのは設定のキーではなく実際に登録しているキー（退避中は設定のキーは効かない）
  tray.setToolTip(
    state === 'meeting' ? 'Listener — 議事録を記録中'
      : state === 'recording' ? 'Listener — 録音中'
        : state === 'processing' || state === 'meeting-finalizing' ? 'Listener — 処理中'
          : `Listener — ${activeHotkeys.hotkey}: 音声入力 / ${activeHotkeys.meetingHotkey || '未設定'}: 議事録${hotkeyNote}`,
  );
}

function createTray() {
  trayIconIdle = makeTrayIcon(false);
  trayIconRec = makeTrayIcon(true);
  tray = new Tray(trayIconIdle);
  tray.on('double-click', createMainWindow);
  updateTray();
}

// ---------------------------------------------------------------- 更新の適用先
/*
 * 更新は src/ をファイル単位で差し替える方式なので、
 * 「package.json と src/ が素のファイルとして置かれているか」が条件になる。
 *
 * app.getAppPath() は、開発時はプロジェクトフォルダ、
 * インストーラー版（asar 無効）は <インストール先>\resources\app を返すので、
 * どちらもそのまま適用先になる。asar 同梱でビルドすると書庫の中に入り、
 * ファイル単位では差し替えられない（package.json の build.asar を参照）。
 *
 * 「インストーラー版かどうか」ではなく「実際に差し替えられるか」で判断する。
 */
let updateTargetCache = null;
function updateTarget() {
  if (updateTargetCache) return updateTargetCache;
  const root = app.getAppPath();
  let result;
  if (/\.asar$/i.test(root)) {
    result = { ok: false, error: 'このビルドは asar 同梱のため、この方法では更新できません。新しいインストーラーを実行してください。' };
  } else {
    // Windows の access() は ACL を見ないので、実際に書いて確かめる
    try {
      const probe = path.join(root, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      result = { ok: true, root };
    } catch (_) {
      result = { ok: false, error: `インストール先に書き込めないため更新できません（${root}）。新しいインストーラーを実行してください。` };
    }
  }
  updateTargetCache = result;
  return result;
}

// ---------------------------------------------------------------- IPC
function setupIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', (_e, next) => {
    const prevAutoLaunch = settings.autoLaunch;
    const prevPillPos = settings.pillPos;
    const merged = normalizeSettings({ ...settings, ...next }, DEFAULT_SETTINGS);
    // 記録中はエンジンに関わる設定を前の値に留める（#57。判断は mainlib.guardEngineSettings）。
    // 保存のたびにエンジンが再起動すると、文字起こし中の区間が失われる。留めた値は
    // applied で画面へ戻し、warning で伝える。
    // 音声入力（recording）の最中も同じ。文字起こし中に whisper を再起動すると、その発話が失われる
    const guard = guardEngineSettings(settings, merged, Boolean(meeting) || state === 'recording');
    Object.assign(merged, guard.settings);

    // ホットキーは変えた側だけ登録し直し、失敗した側だけ前の値に戻して、他の設定は
    // 保存する（判断は mainlib.saveHotkeys。main.test.js で実行して固定）。
    // 以前は片方の衝突で保存全体を失敗にしていたので、同時に変えた他の項目まで
    // 黙って捨てられていた。失敗は warning で画面に返す。
    // 設定として残ったキーは applied で返す。画面はこれを欄に戻す（失敗したキーが
    // 欄に残ると、以後の無関係な保存のたびに再失敗して警告が出続ける）。
    // 両方とも変えていなければ hk は null で、登録も状態も触らない。
    let warning = '';
    const hk = saveHotkeys(settings, activeHotkeys, merged, applyHotkeys);
    if (hk) {
      merged.hotkey = hk.applied.hotkey;
      merged.meetingHotkey = hk.applied.meetingHotkey;
      activeHotkeys = hk.active;
      hotkeyState = hk.state;
      hotkeyNote = hk.note;
      warning = hk.warning;
    }
    if (guard.warning) warning = warning ? `${warning}。${guard.warning}` : guard.warning;
    if (merged.pillPos !== prevPillPos) merged.pillCustom = null;
    settings = merged;
    persistSettings();
    applyTheme();
    if (!guard.kept.length) restartEnginesIfNeeded();
    // 保留していた復旧（エンジン未設定で止めていた分）を、設定が直った機会にもう一度試す
    if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${e.message}`));
    if (settings.autoLaunch !== prevAutoLaunch) {
      try { app.setLoginItemSettings({ openAtLogin: settings.autoLaunch }); } catch (_) { /* noop */ }
    }
    updateTray();
    const applied = { hotkey: settings.hotkey, meetingHotkey: settings.meetingHotkey };
    // 画面が送った値と違う値で残ったキーは全部載せる（記録中に留めたエンジン設定・
    // 正規化で丸めた値も）。画面はこれを欄に戻す（mainlib.keptDifferent）
    Object.assign(applied, keptDifferent(next, settings));
    return warning ? { ok: true, applied, warning } : { ok: true, applied };
  });
  ipcMain.handle('hotkey:state', () => hotkeyState);

  ipcMain.handle('history:get', () => history);
  ipcMain.handle('history:delete', (_e, id) => { history = history.filter((h) => h.id !== id); persistHistory(); return history; });
  ipcMain.handle('history:clear', () => { history = []; persistHistory(); return history; });
  ipcMain.handle('app:toggle-recording', () => { toggleRecording(); return state; });

  ipcMain.handle('pages:search', (_e, q) => store.searchIndex(q || ''));
  ipcMain.handle('pages:searchFull', (_e, q) => store.searchFullText(q || '', 60));
  // アクション一覧（絞り込み込み）。store.actionView の戻り値 { actions, people, total } をそのまま返す
  ipcMain.handle('pages:actionView', (_e, { q, assignee } = {}) => store.actionView({ q, assignee }));
  // データ保存先（#29）。isDefault は「既定の場所 <userData>/data のまま」
  ipcMain.handle('data:dir', () => ({ dir: dataRoot(), isDefault: !settings.dataDir }));
  ipcMain.handle('data:move', (_e, dir) => moveDataDir(dir));
  ipcMain.handle('page:get', (_e, id) => {
    const page = store.getPage(id);
    if (!page) return null;
    return { page, segments: store.getTranscript(id) };
  });
  ipcMain.handle('page:delete', (_e, id) => store.deletePage(id));
  ipcMain.handle('page:setTitle', (_e, { id, title }) => store.setTitle(id, title));
  ipcMain.handle('page:setMemo', (_e, { id, memo }) => {
    const p = store.getPage(id); if (!p) return null;
    p.memo = String(memo || ''); return store.savePage(p);
  });
  ipcMain.handle('block:update', (_e, { pageId, blockId, patch }) => store.updateBlock(pageId, blockId, patch));
  ipcMain.handle('block:insert', (_e, { pageId, afterBlockId, type }) => store.insertBlock(pageId, afterBlockId, type));
  ipcMain.handle('block:remove', (_e, { pageId, blockId }) => store.removeBlock(pageId, blockId));
  ipcMain.handle('block:move', (_e, { pageId, blockId, toIndex }) => store.moveBlock(pageId, blockId, toIndex));
  // 文字起こしの1区間を直す。その区間を根拠にしていた要点と根拠なしの要点だけ出典を引き直す。
  // page:updated は送らない。送ると画面が文字起こし面を全部描き直し、次の行の編集を壊す。
  // 戻り値（page:get と同じ形）で画面側が要約タブの出典チップだけを描き直す。
  ipcMain.handle('segment:update', (_e, { pageId, segId, patch }) => {
    const segments = store.updateSegment(pageId, segId, patch || {});
    if (!segments) return null;
    const page = store.getPage(pageId);
    if (!page) return null;
    if (page.blocks.length) page.citeStat = refreshCitations(page.blocks, segments.filter((s) => !s.failed), segId);
    store.savePage(page);
    return { page, segments };
  });
  ipcMain.handle('block:setAction', (_e, { pageId, blockId, assignee, dueRaw }) => {
    const p = store.getPage(pageId); if (!p) return null;
    const b = p.blocks.find((x) => x.id === blockId); if (!b) return null;
    if (typeof assignee === 'string') b.assignee = assignee.trim();
    if (typeof dueRaw === 'string') {
      b.dueRaw = dueRaw.trim();
      const { parseDue } = require('./actions');
      const r = parseDue(b.dueRaw, new Date(p.createdAt));
      b.due = r.date; b.dueApprox = r.approx;
    }
    return store.savePage(p);
  });
  ipcMain.handle('page:summarize', (_e, id) => runSummary(id));
  ipcMain.handle('page:setType', (_e, { id, type }) => {
    const p = store.getPage(id); if (!p) return null;
    p.meetingType = type; p.typeAuto = false;   // 手動指定は以後の自動推定より優先
    return store.savePage(p);
  });
  ipcMain.handle('meta:types', () => mtype.listTypes());
  ipcMain.handle('meeting:toggle', () => {
    if (state === 'idle') return startMeeting();
    if (state === 'meeting') return stopMeeting();
    return { ok: false, error: '処理中です' };
  });
  ipcMain.handle('meeting:discard', () => discardMeeting());
  ipcMain.handle('meeting:status', () => meetingStatus());
  ipcMain.handle('meeting:set-memo', (_e, memo) => { if (meeting) { meeting.memo = String(memo || ''); writeDraft(); } return true; });
  // 終了後の文字起こし待ちを打ち切る（#42）。記録中（終了前）は打ち切れない。待ちの区間は
  // 「（文字起こしを打ち切り）」の失敗扱いでページに残し、wav は消す（mainlib.skipPendingSegments）。
  // 進行中・待ち行列の結果は世代（gen）で無効にし、待ち件数を 0 にして締める
  ipcMain.handle('meeting:skipPending', () => {
    if (!meeting || !meeting.stopping) return { ok: false, error: '記録を終了したあとにだけ打ち切れます' };
    const m = meeting;
    m.gen++;
    const r = skipPendingSegments(m.segments);
    for (const f of r.wavs) unlinkQuiet(f);
    m.skipped += r.count;
    m.inFlightSince = 0;
    pendingSegs = 0;
    // 録音側の最後の区間がまだ届いていなければ、届いてから締める（届いた区間も打ち切り扱い）。
    // 録音側が落ちて最後が来ないときのために 60 秒で諦めて締める
    m.skipAll = true;
    if (!m.finalSeen) {
      setTimeout(() => {
        if (meeting === m && m.skipAll && !m.finalSeen) {
          m.finalSeen = true;
          maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
        }
      }, 60000);
    }
    writeDraft();
    sendToMainWin('meeting:update', meetingStatus());
    maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    return { ok: true, skipped: r.count };
  });

  ipcMain.handle('clipboard:copy', async (_e, t) => { await copyPrivate(String(t ?? '')); return true; });
  ipcMain.handle('app:test', async () => {
    const problem = engineCheck(whisperEng);   // 原因を名指しする（#32）
    if (problem) return { ok: false, error: problem };
    const ok = await ensureEngineReady(whisperEng);
    if (!ok) return { ok: false, error: whisperEng.lastError || '起動に失敗しました' };
    const vad = settings.useVad ? resolveVadModel() : '';
    const notes = [vad ? `VAD有効（${path.basename(vad)}）` : 'VAD無効'];
    if (settings.suppressNst) notes.push('非発話トークン抑制');
    return { ok: true, info: `文字起こしエンジンは起動済みです（${notes.join(' / ')}）` };
  });
  ipcMain.handle('app:test-sum', async () => {
    const problem = engineCheck(sumEng);
    if (problem) return { ok: false, error: problem };
    const ok = await ensureEngineReady(sumEng);
    return ok ? { ok: true, info: '要約エンジンは起動済みです（オフライン動作可）' }
      : { ok: false, error: sumEng.lastError || '起動に失敗しました' };
  });
  // 辞書が初期プロンプトの予算に収まっているか（#23）。kept: 収まった語数、total: 辞書の語数。
  // 尻尾（直前の発言）は付けずに数える（辞書そのものの収まり具合を見せるため）
  ipcMain.handle('prompt:info', () => {
    const r = promptParts('');
    return { ok: true, kept: r.kept, total: r.total, over: r.over };
  });
  ipcMain.handle('app:vad-status', () => {
    const p = resolveVadModel();
    return { path: p, auto: Boolean(p) && p !== settings.vadModelPath };
  });
  // 開くのはいまのデータフォルダ（移動後はそこ。#29）
  ipcMain.handle('app:open-data-dir', () => { shell.openPath(dataRoot()); return true; });
  // Windows のサウンド設定を開く。録音されるスピーカーは「既定の再生デバイス」
  // で決まり、アプリ側から選ぶ手段は無いので、変える場所へ案内する。
  ipcMain.handle('app:open-sound-settings', () => {
    // URL は固定。画面から受け取った文字列を開くと、任意のURIを開けてしまう。
    shell.openExternal('ms-settings:sound').catch(() => {});
    return true;
  });
  ipcMain.handle('app:open-releases', () => {
    // URL は REPO 定数から組み立てる。画面から受け取ったURLを開くと、
    // 表示中の文字列次第で任意のページを開けてしまう。
    shell.openExternal(`https://github.com/${updater.REPO}/releases/latest`);
    return true;
  });
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), repo: updater.REPO }));
  ipcMain.handle('update:check', async () => {
    const r = await updater.check(app.getVersion(), app.getPath('userData'));
    // 画面側が「更新して再起動」を出すか「ダウンロード」を出すかの判断に使う
    return { ...r, applyable: updateTarget().ok };
  });
  ipcMain.handle('update:apply', async (_e, url) => {
    if (isSummarizing()) return { ok: false, error: '要約を作成中です。終わってから更新してください' };
    const t = updateTarget();
    if (!t.ok) return { ok: false, error: t.error };
    return updater.apply(url, t.root, app.getPath('userData'),
      (msg) => sendToMainWin('update:progress', { message: msg }));
  });
  ipcMain.handle('app:restart', () => {
    if (isSummarizing()) return { ok: false, error: '要約を作成中です。終わってから再起動してください' };
    quitting = true;
    stopEngine(whisperEng); stopEngine(sumEng); stopPaster();
    app.relaunch();
    app.exit(0);
    return true;
  });
  ipcMain.handle('dialog:pick', async (_e, kind) => {
    // フォルダ（データ保存先の移動先。#29）。戻り値はパスか ''
    if (kind === 'folder') {
      const res = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
      return res.canceled ? '' : (res.filePaths[0] || '');
    }
    const filters = kind === 'exe'
      ? [{ name: '実行ファイル', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }]
      : [{ name: 'モデルファイル', extensions: ['bin', 'gguf'] }];
    const res = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.on('overlay:confirm', () => {
    if (state === 'recording') stopRecording();
    else if (state === 'meeting') stopMeeting();
  });
  ipcMain.on('overlay:cancel-request', () => { if (state === 'recording') cancelRecording(); });
  ipcMain.on('audio:done', (_e, { buffer, durationMs }) => handleDictationAudio(Buffer.from(buffer), durationMs));
  ipcMain.on('audio:segment', (_e, { buffer, durationMs, final }) => onMeetingSegment(Buffer.from(buffer), durationMs, Boolean(final)));
  // 録音側が実際に何を録れているかを受け取る。設定がオンでも、再生デバイスが
  // 無い・他のアプリが排他で掴んでいる等で失敗しうる。黙ってマイクだけで進むと、
  // 会議が終わってから片側しか残っていないことに気づく——それが一番まずい。
  // 一時停止の状態を受け取る。記録中バーにも出す（オーバーレイを
  // 隠したまま席を外すと、止めたつもりが録れている／その逆が起きる）。
  ipcMain.on('overlay:pause', (_e, { paused }) => {
    if (!meeting) return;
    if (paused && !meeting.paused) { meeting.paused = true; meeting.pausedAt = Date.now(); }
    else if (!paused && meeting.paused) {
      meeting.paused = false;
      meeting.pausedMs += Date.now() - meeting.pausedAt;
    }
    sendToMainWin('meeting:update', meetingStatus());
  });
  // 録音側が実際にどのマイクを掴んだか。設定のマイクが抜かれている・名前が
  // 変わっている等で要求と合わなかったときだけ「代替中」にする（#56）。
  ipcMain.on('overlay:mic', (_e, info) => {
    // 音声入力（議事録なし）からも届く。議事録が無いのに meeting:update を送ると、
    // 画面が「記録していない」状態として描き直し、走っている要約の進捗表示を消す
    if (!meeting) return;
    meeting.micFallback = !!(info && info.requested && !info.matched);
    sendToMainWin('meeting:update', meetingStatus());
  });
  ipcMain.on('overlay:source', (_e, { systemAudio, wanted }) => {
    if (!meeting) return;
    meeting.systemAudio = Boolean(systemAudio);
    sendToMainWin('meeting:update', meetingStatus());
    if (wanted && !systemAudio) {
      sendToMainWin('app:notice',
        'パソコンから出ている音を取り込めませんでした。マイクの音だけで議事録を記録します。');
    }
  });
  ipcMain.on('audio:error', (_e, { message }) => {
    if (state === 'meeting' || state === 'meeting-finalizing') {
      if (meeting) {
        // 録音側は最後の区間を送り終えてからこれを送る（overlay の settleSeg）ので、
        // ここで締めに入っても変換中の区間を取りこぼさない
        if (state === 'meeting') {
          // 会議の長さはここまで（stopMeeting と同じ締め方。文字起こし待ちを混ぜない）
          meeting.stoppedAt = Date.now();
          if (meeting.paused) { meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt; meeting.paused = false; meeting.pausedAt = 0; }
          sendToMainWin('app:notice', `${message || 'マイクにアクセスできません'}。ここまでの録音で議事録を作成します。`);
        }
        meeting.stopping = true; state = 'meeting-finalizing';
        sendToMainWin('meeting:update', meetingStatus());
        maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
      }
    } else finishWithError(message || 'マイクにアクセスできません');
  });
  ipcMain.on('overlay:hidden-request', () => hideOverlayIfIdle());
}

// ---------------------------------------------------------------- 起動
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createMainWindow());
  app.whenReady().then(() => {
    loadStores();
    recoverDraftIfAny();
    if (!recoveryQueue) recoveryQueue = loadSavedRecoveryQueue();   // 前回エンジンが無くて残した分
    cleanOrphanSegbuf(recoveryQueue ? recoveryQueue.dir : '');   // 復旧の後で（復旧中のフォルダは残す）
    applyTheme();
    setupIpc();
    // 相手の声（パソコンから出ている音）を録るための受け口。
    // これを設定しないと getDisplayMedia は必ず失敗する。
    // 第2引数（useSystemPicker）は Electron 33 以降のもの。ここで渡すと
    // ハンドラごと無効になるので、引数はコールバック1つだけにする。
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request && request.frame;
      callback(chooseDisplayMedia({
        platform: process.platform,
        frame,
        enabled: Boolean(settings.useSystemAudio),   // 設定がオフなら誰にも渡さない
        url: frame ? frame.url : '',
      }));
    });
    createOverlay();
    // 登録できなかった側だけ既定に落として再試行する（成功した側はそのまま）。
    // 有効なキーは activeHotkeys にだけ持ち、settings には書かない。settings に書くと
    // settings:get が既定を返して設定画面に既定が出、次の無関係な保存（自動起動の
    // 切り替えなど）でディスクにも漏れて、利用者が選んだキーが黙って消える。
    // トレイより先に決めておく（トレイの表示は activeHotkeys から組む）。
    {
      const r = resolveStartupHotkeys(settings, DEFAULT_SETTINGS, applyHotkeys);
      activeHotkeys = r.active;
      hotkeyState = r.state;
      hotkeyNote = r.note;
      if (!r.state.ok) engineLog(`ホットキー: ${r.state.message}`);
    }
    createTray();
    if (engineValid(whisperEng)) startEngine(whisperEng);
    // 使われないエンジンを 60 秒ごとに見て止める（#58。判断は mainlib.idleEnginesToStop）
    setInterval(releaseIdleEngines, ENGINE_IDLE_CHECK_MS);
    // 復旧ページに文字起こし待ちの音声が残っていれば、エンジンの用意を待って順に片付ける
    transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${e.message}`));
    ensurePaster();
    createMainWindow();
    app.on('activate', () => createMainWindow());

    // 起動から少し置いて更新確認。オフラインなら黙って諦める
    setTimeout(async () => {
      const r = await updater.check(app.getVersion(), app.getPath('userData'));
      if (r.ok && r.update) sendToMainWin('update:available', { ...r, applyable: updateTarget().ok });
    }, 8000);
  });
  app.on('window-all-closed', () => { /* トレイ常駐 */ });
  app.on('before-quit', () => {
    quitting = true;
    // 要約の途中で終了するなら、そのページに「中断された」と書いておく（#52。同期・できる範囲で）。
    // 書かないと、次に開いたときに要約が空のまま何も言わないページになる。
    for (const id of runSummary.running()) {
      try {
        saveIfExists(store, id, (p) => { p.summaryError = '要約が中断されました。「要約を生成」で作り直せます'; });
      } catch (_) { /* noop */ }
    }
    stopEngine(whisperEng); stopEngine(sumEng); stopPaster();
  });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopEngine(whisperEng); stopEngine(sumEng); stopPaster(); });
}
