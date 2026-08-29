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

const store = require('./store');
const { attachCitations } = require('./cite');
const mtype = require('./meetingType');
const { enrichActionBlocks } = require('./actions');
const updater = require('./updater');
const { chooseDisplayMedia } = require('./loopback');
const { markdownToBlocks, dropRedundantEmpty } = require('./minutes');

const CPU_OLD_DEFAULT_THREADS = Math.max(4, Math.floor(os.cpus().length / 2));
const CPU_DEFAULT_THREADS = Math.max(4, os.cpus().length - 2);
const MIN_RECORD_MS = 400;
// メモはプロンプトにそのまま前置きされるので、文脈を食い潰さない範囲に収める
const MEMO_MAX = 1500;
const SUM_MAX_TOKENS = 3000;   // 最終的な議事録
const NOTE_MAX_TOKENS = 900;   // 分割要約の各パート
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
function applyTheme() {
  // themeSource を切り替えると、レンダラー側の prefers-color-scheme が
  // 変わり、CSSのダーク定義がそのまま効く。画面側のJSは不要。
  try {
    nativeTheme.themeSource = settings.theme === 'light' || settings.theme === 'dark'
      ? settings.theme : 'system';
  } catch (_) { /* noop */ }
}

function updatePowerBlock() {
  const busy = state !== 'idle';
  if (busy && powerBlockId === null) {
    try { powerBlockId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) { powerBlockId = null; }
  } else if (!busy && powerBlockId !== null) {
    try { powerSaveBlocker.stop(powerBlockId); } catch (_) { /* noop */ }
    powerBlockId = null;
  }
}
let pasterProc = null;
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
  settings = { ...DEFAULT_SETTINGS, ...loadJson(settingsPath(), {}) };
  if (CPU_DEFAULT_THREADS > CPU_OLD_DEFAULT_THREADS) {
    if (settings.localThreads === CPU_OLD_DEFAULT_THREADS) settings.localThreads = CPU_DEFAULT_THREADS;
    if (settings.sumThreads === CPU_OLD_DEFAULT_THREADS) settings.sumThreads = CPU_DEFAULT_THREADS;
  }
  history = loadJson(historyPath(), []);
  if (!Array.isArray(history)) history = [];
  store.init(app.getPath('userData'));
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
  '不具合', '改修', '仕様', '要件', '結合テスト', '単体テスト', '検収', 'リリース',
  '課題', '懸案', '進捗', '稼働', '納期', '見積', '工数', '案件', '所感',
  '今週', '来週', '今月', '来月', '月末', '期末',
  '定例', '共有', '対応', '確認', '検討', '展開', '棚卸し',
];

// whisper.cpp の初期プロンプトは n_text_ctx/2（既定 224 トークン）で切られる。
// どちら側から切られるかはビルドで変わりうるので、そもそも溢れさせない。
// 日本語は最悪 1文字 1トークンとみて、文字数で見積もる。
const PROMPT_MAX_CHARS = 200;

function buildPrompt(extraTail) {
  const parts = [];
  const ja = settings.language === 'ja';
  // ここは指示文ではなく「この後に続く文章の文例」。モデルは指示に従うのでは
  // なく真似るだけで、実機では文例中の語がそのまま本文へ漏れた
  // （「不具合の報告」が「句読報告」になった）。丸めの誘導は文例自体の
  // 「、」「。」で行い、漏れても会議の発言として無害な語だけで書く。
  if (ja) parts.push('お疲れさまです。よろしくお願いします。');
  const tail = String(extraTail || '');

  // ユーザーが入れた語は今までどおり全部渡す。ここを予算で切ると、
  // 辞書を育ててきた利用者の認識精度が黙って落ちる。
  const terms = [];
  for (const raw of (Array.isArray(settings.dictionary) ? settings.dictionary : [])) {
    const w = String(raw || '').trim();
    if (w && !terms.includes(w)) terms.push(w);
  }

  // 既定語彙は日本語のときだけ。英語や自動判定で日本語の語を渡すと、
  // その語がそのまま出力に漏れたり、言語の推定を日本語へ引っぱったりする。
  // 余った予算に収まる分だけ足す（長い語が1つあっても後続を捨てないよう continue）。
  if (ja && settings.useBuiltinTerms !== false) {
    let budget = PROMPT_MAX_CHARS - parts.join(' ').length - tail.length
      - terms.join('、').length - 6;
    for (const w of BUILTIN_TERMS) {
      if (terms.includes(w)) continue;
      if (budget - (w.length + 1) < 0) continue;
      terms.push(w); budget -= w.length + 1;
    }
  }
  // 接頭辞は付けない。「用語:」のような不自然な語も文例として漏れうる。
  if (terms.length) parts.push(`${terms.join('、')}。`);
  if (tail) parts.push(tail);
  return parts.join(' ');
}

// ---------------------------------------------------------------- エンジン管理
function makeEngine(name) {
  return { name, proc: null, ready: false, lastError: '', readyPromise: null, sig: '', stderrTail: '', stopping: false };
}
const whisperEng = makeEngine('文字起こしエンジン');
const sumEng = makeEngine('要約エンジン');

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
    '-c', '16384',
  ];
}
const engineExe = (e) => (e === whisperEng ? settings.localServerExe : settings.sumServerExe);
const engineModel = (e) => (e === whisperEng ? settings.localModelPath : settings.sumModelPath);
const enginePort = (e) => (e === whisperEng ? settings.localPort : settings.sumPort);
const engineConfigured = (e) => Boolean(engineExe(e) && engineModel(e));
const engineValid = (e) => engineConfigured(e) && fs.existsSync(engineExe(e)) && fs.existsSync(engineModel(e));

function engineSignature(eng) {
  return [engineExe(eng), engineModel(eng), enginePort(eng),
    eng === whisperEng ? settings.localThreads : settings.sumThreads,
    eng === whisperEng ? settings.language : '',
    eng === whisperEng ? `${settings.useVad ? resolveVadModel() : ''}|${settings.suppressNst}` : ''].join('|');
}

function startEngine(eng) {
  if (eng.proc) return;
  if (!engineValid(eng)) { eng.lastError = `${eng.name}の実行ファイルまたはモデルが見つかりません`; return; }
  eng.lastError = ''; eng.ready = false; eng.stopping = false; eng.stderrTail = '';
  eng.sig = engineSignature(eng);
  engineLog(`${eng.name} 起動: ${engineExe(eng)} ${engineSpawnArgs(eng).join(' ')}`);
  try {
    eng.proc = spawn(engineExe(eng), engineSpawnArgs(eng), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    eng.lastError = `${eng.name}を起動できません: ${e.message}`; engineLog(eng.lastError); eng.proc = null; return;
  }
  eng.proc.stderr.on('data', (d) => { eng.stderrTail = (eng.stderrTail + d.toString()).slice(-1500); });
  eng.proc.on('error', (e) => {
    eng.lastError = `${eng.name}を起動できません: ${e.message}`; engineLog(eng.lastError);
    eng.proc = null; eng.ready = false;
  });
  eng.proc.on('exit', (code) => {
    if (!quitting && !eng.stopping) {
      const tail = eng.stderrTail.split('\n').filter(Boolean).slice(-3).join(' / ');
      eng.lastError = `${eng.name}が終了しました (code ${code})${tail ? `: ${tail}` : ''}`.trim();
      engineLog(eng.lastError);
    }
    eng.proc = null; eng.ready = false; eng.readyPromise = null;
  });
}

function stopEngine(eng) {
  if (eng.proc) { eng.stopping = true; try { eng.proc.kill(); } catch (_) { /* noop */ } eng.proc = null; }
  eng.ready = false; eng.readyPromise = null;
}

function ensureEngineReady(eng) {
  if (eng.ready && eng.proc) return Promise.resolve(true);
  if (eng.readyPromise) return eng.readyPromise;
  eng.readyPromise = (async () => {
    if (!eng.proc) startEngine(eng);
    if (!eng.proc) return false;
    const url = `http://127.0.0.1:${enginePort(eng)}/`;
    const deadline = Date.now() + ENGINE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!eng.proc) return false;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok || res.status === 404) { eng.ready = true; return true; }
      } catch (_) { /* 起動中 */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!eng.lastError) {
      const tail = eng.stderrTail.split('\n').filter(Boolean).slice(-3).join(' / ');
      eng.lastError = `${eng.name}の起動がタイムアウトしました${tail ? `: ${tail}` : '（モデル読み込み中の可能性）'}`;
    }
    return false;
  })().finally(() => { eng.readyPromise = null; });
  return eng.readyPromise;
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
  const waitMs = Math.min(1800000, Math.max(240000, Math.round(durationMs || 0) * 5 + 60000));
  const res = await fetch(`http://127.0.0.1:${settings.localPort}/inference`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(waitMs) });
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
async function llmChat(messages, maxTokens) {
  const res = await fetch(`http://127.0.0.1:${settings.sumPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature: 0.2, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(900000),
  });
  if (!res.ok) throw new Error(`要約エンジンエラー (${res.status})`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('要約エンジンの応答が空でした');
  // 長さ上限で打ち切られると末尾の議題が黙って欠ける。
  // 黙って欠けるより、欠けたと分かる方がよい。
  const truncated = data?.choices?.[0]?.finish_reason === 'length';
  return { text, truncated };
}

async function generateMinutes(plain, memo, onProgress, type) {
  const MINUTES_FORMAT = mtype.getFormat(type);
  // 節ごとに「なければ特になし」と書くと、小型モデルが条件を守り切れず
  // 実項目と「特になし」を両方並べてくる。ルールは全体で1回だけ言う。
  // （それでも混ざるので minutes.js の dropRedundantEmpty で後始末する）
  // 装飾を禁じるのは見た目のためではない。「**」が残ると出典の一致が
  // 薄まり、短い要点でリンクが消えるため。
  const OUTPUT_RULE = '書き方のきまり:\n'
    + '- 該当する内容が本当に一つも無い見出しにだけ「特になし」と書く。'
    + '一つでも書くことがあれば「特になし」は書かない。\n'
    + '- 太字（**）や斜体などの装飾は使わない。素の文章で書く。\n'
    + '- 文体は報告文書として使える常体で書く（「〜を実施」「〜は完了」「〜する」）。'
    + '「です」「ます」は使わない。';
  const ok = await ensureEngineReady(sumEng);
  if (!ok) throw new Error(sumEng.lastError || '要約エンジンが起動していません');
  const sys = 'あなたは議事録作成の専門家です。会議の文字起こしを分析し、正確で実用的な議事録を日本語のMarkdownで作成します。'
    + '文体は報告文書の常体（だ・である調、体言止め）で、「です・ます」は使いません。'
    + '文字起こしに無い情報を創作せず、雑談は省いてください。';
  // メモはユーザーが好きなだけ書けるうえ、そのままプロンプトに前置きされる。
  // 長すぎると文脈を食い潰して文字起こし側が押し出されるので上限を設ける。
  const memoText = String(memo || '').trim().slice(0, MEMO_MAX);
  const memoBlock = memoText ? `【会議メモ・アジェンダ（要約のヒント）】\n${memoText}\n\n` : '';

  const CHUNK = 5500;
  // メモの分も含めて1回で収まるかを判断する
  if (plain.length + memoBlock.length <= CHUNK + 1500) {
    const one = await llmChat([
      { role: 'system', content: sys },
      { role: 'user', content: `${memoBlock}【会議の文字起こし】\n${plain}\n\n上記から、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${MINUTES_FORMAT}\n\n${OUTPUT_RULE}` },
    ], SUM_MAX_TOKENS);
    return { md: one.text, truncated: one.truncated };
  }

  const chunks = [];
  for (let i = 0; i < plain.length; i += CHUNK) {
    // 残りが重なり幅以下なら、直前のチャンクに完全に含まれるので作らない
    if (i > 0 && plain.length - i <= 200) break;
    chunks.push(plain.slice(i, i + CHUNK + 200));
  }
  const notes = [];
  let truncated = false;
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(`要約中… (${i + 1}/${chunks.length})`);
    const part = await llmChat([
      { role: 'system', content: sys },
      { role: 'user', content: `以下は長い会議の文字起こしの一部（${i + 1}/${chunks.length}）です。重要な発言・決定・依頼・課題・数字を漏らさず、簡潔な箇条書きで抽出してください。文体は常体（だ・である調、体言止め）。\n\n${chunks[i]}` },
    ], NOTE_MAX_TOKENS);
    if (part.truncated) truncated = true;
    notes.push(`--- パート${i + 1} ---\n${part.text}`);
  }
  if (onProgress) onProgress('議事録をまとめています…');
  const final = await llmChat([
    { role: 'system', content: sys },
    { role: 'user', content: `${memoBlock}【会議の要点メモ（時系列）】\n${notes.join('\n\n')}\n\n上記の要点メモを統合し、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${MINUTES_FORMAT}\n\n${OUTPUT_RULE}` },
  ], SUM_MAX_TOKENS);
  return { md: final.text, truncated: truncated || final.truncated };
}

// ---------------------------------------------------------------- 貼り付け
function ensurePaster() {
  if (process.platform !== 'win32') return null;
  if (pasterProc && pasterProc.stdin && pasterProc.stdin.writable) return pasterProc;
  const script = "$ErrorActionPreference='SilentlyContinue';"
    + 'Add-Type -AssemblyName System.Windows.Forms;'
    + 'while($true){ $l=[Console]::In.ReadLine(); if($null -eq $l){break};'
    + " if($l -eq 'paste'){ [System.Windows.Forms.SendKeys]::SendWait('^v') } }";
  try {
    pasterProc = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    pasterProc.on('exit', () => { pasterProc = null; });
    pasterProc.on('error', () => { pasterProc = null; });
  } catch (_) { pasterProc = null; }
  return pasterProc;
}
function stopPaster() {
  if (pasterProc) { try { pasterProc.stdin.end(); pasterProc.kill(); } catch (_) { /* noop */ } pasterProc = null; }
}
function simulatePaste() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const p = ensurePaster();
      if (p && p.stdin.writable) { p.stdin.write('paste\n'); setTimeout(resolve, 30); return; }
      execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"],
      { windowsHide: true }, () => resolve());
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], () => resolve());
    } else {
      execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], () => resolve());
    }
  });
}
async function deliverText(text) {
  clipboard.writeText(text);
  if (settings.autoPaste) { await new Promise((r) => setTimeout(r, 50)); await simulatePaste(); }
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      // 録音の区切りは setTimeout で刻んでいる。画面が隠れると Chromium が
      // タイマーを間引き、75秒の区切りが数分遅れる。実機で1区間が9分になり、
      // 文字起こしが時間切れで丸ごと失われた。この窓では間引かせない。
      backgroundThrottling: false,
    },
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
    backgroundColor: '#E9EDF5',
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
    if (state === 'meeting' || state === 'meeting-finalizing') {
      // 記録中の閉じ間違いで会議を失わせない。draft からの復旧はあるが、
      // 要約前の状態に戻るので、一度は確認を挟む。
      const r = dialog.showMessageBoxSync(mainWin, {
        type: 'warning', buttons: ['終了する', 'キャンセル'], defaultId: 1, cancelId: 1,
        message: '議事録を記録中です',
        detail: '終了すると録音が止まります。ここまでの文字起こしは、次回起動時に復旧できます。',
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
  if (!engineValid(whisperEng)) {
    createMainWindow();
    sendToMainWin('app:notice', '文字起こしエンジンが未設定です。設定タブでパスを指定してください。');
    return;
  }
  ensureEngineReady(whisperEng);
  state = 'recording';
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

// ---------------------------------------------------------------- 議事録
function meetingStatus() {
  return {
    active: state === 'meeting' || state === 'meeting-finalizing',
    finalizing: state === 'meeting-finalizing',
    startedAt: meeting ? meeting.startedAt : null,
    memo: meeting ? meeting.memo : '',
    segments: meeting ? meeting.segments : [],
    pending: pendingSegs,
    stoppedAt: meeting && meeting.stoppedAt ? meeting.stoppedAt : null,
    systemAudio: Boolean(meeting && meeting.systemAudio),
  };
}

function writeDraft() {
  if (!meeting) return;
  store.writeDraft({
    startedAt: meeting.startedAt, memo: meeting.memo,
    segments: meeting.segments, offsetMs: meeting.offsetMs, savedAt: Date.now(),
  });
}

function recoverDraftIfAny() {
  const d = store.readDraft();
  if (!d || !Array.isArray(d.segments) || d.segments.length === 0) { store.clearDraft(); return; }
  const dt = new Date(d.startedAt || Date.now());
  const page = store.createPage({
    title: `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} の議事録（復旧）`,
    date: dt.toISOString().slice(0, 10),
    durationSec: Math.round((d.offsetMs || 0) / 1000),
    memo: d.memo || '',
    blocks: [],
    segments: d.segments,
    createdAt: new Date(d.startedAt || Date.now()).toISOString(),
    recovered: true,
  });
  page.summaryError = '録音が中断されたため要約は未生成です。「要約を生成」で作成できます。';
  store.savePage(page);
  store.clearDraft();
  recoveredPageId = page.id;
}

function startMeeting() {
  if (state !== 'idle') return { ok: false, error: '他の処理を実行中です' };
  if (!engineValid(whisperEng)) return { ok: false, error: '文字起こしエンジンが未設定です。設定タブでパスを指定してください。' };
  meeting = { startedAt: Date.now(), memo: '', segments: [], offsetMs: 0, stopping: false, seq: 0, systemAudio: false };
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'meeting';
  writeDraft();
  ensureEngineReady(whisperEng);
  if (engineValid(sumEng)) startEngine(sumEng);
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
  pendingSegs++;
  sendToMainWin('meeting:update', meetingStatus());
  segChain = segChain.then(async () => {
    if (meeting !== m) return;
    if (buffer.byteLength < 4000) return;
    const tail = m.segments.length ? m.segments[m.segments.length - 1].text.slice(-100) : '';
    let text = '';
    try {
      text = await transcribeLocal(buffer, tail, durationMs);
    } catch (e) {
      if (meeting !== m) return;
      m.segments.push({ id: `s${++m.seq}`, atMs: segOffset, text: `（この区間の認識に失敗: ${e.message}）`, failed: true });
      writeDraft(); sendToMainWin('meeting:update', meetingStatus());
      return;
    }
    if (meeting !== m) return;
    if (settings.removeFillers) text = removeFillersRule(text);
    if (!text) return;
    const prev = m.segments.length ? m.segments[m.segments.length - 1].text : '';
    if (prev && text.length > 6 && prev === text) return; // 繰り返しハルシネーション抑制
    m.segments.push({ id: `s${++m.seq}`, atMs: segOffset, text });
    writeDraft();
    sendToMainWin('meeting:update', meetingStatus());
  }).catch(() => {}).finally(() => {
    // 破棄済みの議事録の区間は、破棄時に数え直した件数を減らさない
    if (meeting === m) pendingSegs = Math.max(0, pendingSegs - 1);
    sendToMainWin('meeting:update', meetingStatus());
    if (meeting === m && (isFinal || (m.stopping && pendingSegs === 0))) {
      maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    }
  });
}

async function maybeFinalizeMeeting() {
  if (!meeting || !meeting.stopping || pendingSegs > 0) return;
  if (state !== 'meeting-finalizing') return;
  const m = meeting;
  meeting = null;

  const durationSec = Math.round(((m.stoppedAt || Date.now()) - m.startedAt) / 1000);
  const dt = new Date(m.startedAt);
  const fallbackTitle = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} の議事録`;

  let page = null;
  try {
    page = store.createPage({
      title: fallbackTitle,
      date: dt.toISOString().slice(0, 10),
      durationSec, memo: m.memo, blocks: [],
      segments: m.segments,
      createdAt: dt.toISOString(),
    });
    store.clearDraft();
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
}

// 要約の生成 → ブロック化 → 出典付与 → 保存
async function runSummary(pageId) {
  // どの経路で抜けても進捗表示と録音状態を必ず解除する
  const clearUi = () => {
    sendToMainWin('meeting:progress', { message: '' });
    sendToMainWin('meeting:update', meetingStatus());
  };
  const page = store.getPage(pageId);
  if (!page) { clearUi(); return { ok: false, error: 'ページが見つかりません' }; }
  const segments = store.getTranscript(pageId);
  const usable = segments.filter((s) => !s.failed);
  const plain = usable.map((s) => s.text).join('\n');

  if (!plain.trim()) {
    page.summaryError = '文字起こしが空のため要約できません';
    store.savePage(page);
    clearUi();
    sendToMainWin('page:updated', { page, segments });
    return { ok: false, error: page.summaryError };
  }
  if (!engineValid(sumEng)) {
    page.summaryError = '要約エンジンが未設定のため、文字起こしのみ保存しました。'
      + 'setup-summarizer.ps1 を実行し、設定タブでパスを指定すると「要約を生成」で作成できます。';
    store.savePage(page);
    clearUi();
    sendToMainWin('page:updated', { page, segments });
    sendToMainWin('app:notice', page.summaryError);
    return { ok: false, error: page.summaryError };
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
    const { md, truncated } = await generateMinutes(
      plain, page.memo,
      (msg) => sendToMainWin('meeting:progress', { message: msg }),
      page.meetingType,
    );
    // 「特になし」の混入を先に落とす。ここで落とさないと
    // 「- [ ] 特になし」がアクション1件として数えられてしまう。
    const blocks = dropRedundantEmpty(markdownToBlocks(md));
    // 担当・期限を先に抜く。出典の突き合わせは
    // 「（担当: ○○ / 期限: ○○）」を落とした本文に対して行いたい。
    // 書式が残ったままだと、その語がクエリに混ざって一致がぶれる。
    const actStat = enrichActionBlocks(blocks, new Date(page.createdAt));
    const stat = attachCitations(blocks, usable);

    // 要約は数分かかる。その間にタイトルやメモが編集されているかもしれないので、
    // 読み込み時のページを丸ごと書き戻さず、生成物だけを最新のページに載せる。
    const saved = store.getPage(pageId) || page;
    saved.blocks = blocks;
    saved.meetingType = page.meetingType;
    saved.typeAuto = page.typeAuto;
    saved.autoType = page.autoType;
    saved.citeStat = stat;
    saved.actionStat = actStat;
    saved.summaryError = truncated
      ? '要約が長さの上限で打ち切られた可能性があります。末尾の議題が欠けていないか確認してください。'
      : '';
    store.savePage(saved);
    clearUi();
    sendToMainWin('pages:updated', store.listPages());
    sendToMainWin('page:updated', { page: saved, segments });
    return { ok: true, page: saved, stat };
  } catch (e) {
    const saved = store.getPage(pageId) || page;
    saved.summaryError = e.message;
    store.savePage(saved);
    clearUi();
    sendToMainWin('page:updated', { page: saved, segments });
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------- ホットキー / トレイ
function applyHotkeys(hk, mhk) {
  globalShortcut.unregisterAll();
  const okA = globalShortcut.register(hk, toggleRecording);
  const okB = mhk ? globalShortcut.register(mhk, toggleMeetingByHotkey) : true;
  if (!okA || !okB) { globalShortcut.unregisterAll(); return { ok: false, which: !okA ? '音声入力' : '議事録' }; }
  return { ok: true };
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
  items.push({ type: 'separator' });
  items.push({ label: '終了', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(
    state === 'meeting' ? 'Listener — 議事録を記録中'
      : state === 'recording' ? 'Listener — 録音中'
        : state === 'processing' || state === 'meeting-finalizing' ? 'Listener — 処理中'
          : `Listener — ${settings.hotkey}: 音声入力 / ${settings.meetingHotkey || '未設定'}: 議事録`,
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
    const prevHotkey = settings.hotkey;
    const prevMeetingHotkey = settings.meetingHotkey;
    const prevAutoLaunch = settings.autoLaunch;
    const prevPillPos = settings.pillPos;
    const merged = { ...settings, ...next };
    merged.dictionary = Array.isArray(merged.dictionary) ? merged.dictionary.map((w) => String(w).trim()).filter(Boolean) : [];
    merged.localPort = Math.max(1024, Math.min(65535, parseInt(merged.localPort, 10) || 8990));
    merged.sumPort = Math.max(1024, Math.min(65535, parseInt(merged.sumPort, 10) || 8991));
    merged.localThreads = Math.max(1, Math.min(64, parseInt(merged.localThreads, 10) || CPU_DEFAULT_THREADS));
    merged.sumThreads = Math.max(1, Math.min(64, parseInt(merged.sumThreads, 10) || CPU_DEFAULT_THREADS));
    merged.segmentSec = Math.max(20, Math.min(300, parseInt(merged.segmentSec, 10) || 75));

    if (merged.hotkey !== prevHotkey || merged.meetingHotkey !== prevMeetingHotkey) {
      const r = applyHotkeys(merged.hotkey, merged.meetingHotkey);
      if (!r.ok) {
        applyHotkeys(prevHotkey, prevMeetingHotkey);
        return { ok: false, error: `${r.which}のホットキーを登録できませんでした（他アプリと競合の可能性）` };
      }
    }
    if (merged.pillPos !== prevPillPos) merged.pillCustom = null;
    settings = merged;
    persistSettings();
    applyTheme();
    restartEnginesIfNeeded();
    if (settings.autoLaunch !== prevAutoLaunch) {
      try { app.setLoginItemSettings({ openAtLogin: settings.autoLaunch }); } catch (_) { /* noop */ }
    }
    updateTray();
    return { ok: true };
  });

  ipcMain.handle('history:get', () => history);
  ipcMain.handle('history:delete', (_e, id) => { history = history.filter((h) => h.id !== id); persistHistory(); return history; });
  ipcMain.handle('history:clear', () => { history = []; persistHistory(); return history; });
  ipcMain.handle('app:toggle-recording', () => { toggleRecording(); return state; });

  ipcMain.handle('pages:search', (_e, q) => store.searchIndex(q || ''));
  ipcMain.handle('pages:searchFull', (_e, q) => store.searchFullText(q || '', 60));
  ipcMain.handle('pages:openActions', () => store.openActions());
  ipcMain.handle('pages:assignees', () => store.assigneeList());
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

  ipcMain.handle('clipboard:copy', (_e, t) => { clipboard.writeText(String(t ?? '')); return true; });
  ipcMain.handle('app:test', async () => {
    if (!engineValid(whisperEng)) return { ok: false, error: 'whisper-server.exe またはモデルファイルのパスが正しくありません' };
    const ok = await ensureEngineReady(whisperEng);
    if (!ok) return { ok: false, error: whisperEng.lastError || '起動に失敗しました' };
    const vad = settings.useVad ? resolveVadModel() : '';
    const notes = [vad ? `VAD有効（${path.basename(vad)}）` : 'VAD無効'];
    if (settings.suppressNst) notes.push('非発話トークン抑制');
    return { ok: true, info: `文字起こしエンジンは起動済みです（${notes.join(' / ')}）` };
  });
  ipcMain.handle('app:test-sum', async () => {
    if (!engineValid(sumEng)) return { ok: false, error: 'llama-server.exe またはモデルファイルのパスが正しくありません' };
    const ok = await ensureEngineReady(sumEng);
    return ok ? { ok: true, info: '要約エンジンは起動済みです（オフライン動作可）' }
      : { ok: false, error: sumEng.lastError || '起動に失敗しました' };
  });
  ipcMain.handle('app:vad-status', () => {
    const p = resolveVadModel();
    return { path: p, auto: Boolean(p) && p !== settings.vadModelPath };
  });
  ipcMain.handle('app:open-data-dir', () => { shell.openPath(app.getPath('userData')); return true; });
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
    const t = updateTarget();
    if (!t.ok) return { ok: false, error: t.error };
    return updater.apply(url, t.root, app.getPath('userData'),
      (msg) => sendToMainWin('update:progress', { message: msg }));
  });
  ipcMain.handle('app:restart', () => {
    quitting = true;
    stopEngine(whisperEng); stopEngine(sumEng); stopPaster();
    app.relaunch();
    app.exit(0);
    return true;
  });
  ipcMain.handle('dialog:pick', async (_e, kind) => {
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
        meeting.stopping = true; state = 'meeting-finalizing';
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
    createTray();
    if (!applyHotkeys(settings.hotkey, settings.meetingHotkey).ok) {
      settings.hotkey = DEFAULT_SETTINGS.hotkey;
      settings.meetingHotkey = DEFAULT_SETTINGS.meetingHotkey;
      applyHotkeys(settings.hotkey, settings.meetingHotkey);
    }
    if (engineValid(whisperEng)) startEngine(whisperEng);
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
  app.on('before-quit', () => { quitting = true; stopEngine(whisperEng); stopEngine(sumEng); stopPaster(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopEngine(whisperEng); stopEngine(sumEng); stopPaster(); });
}
