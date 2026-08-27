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
  ipcMain, clipboard, nativeImage, screen, dialog, shell,
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
const { markdownToBlocks, blocksToMarkdown } = require('./minutes');

const CPU_OLD_DEFAULT_THREADS = Math.max(4, Math.floor(os.cpus().length / 2));
const CPU_DEFAULT_THREADS = Math.max(4, os.cpus().length - 2);
const MIN_RECORD_MS = 400;
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
  dictionary: [],
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
  } catch (e) { console.error('loadJson', file, e.message); }
  return fallback;
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
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

function buildPrompt(extraTail) {
  const parts = [];
  if (settings.language === 'ja') parts.push('以下は日本語の会議の録音です。句読点を含めて正確に書き起こします。');
  if (Array.isArray(settings.dictionary) && settings.dictionary.length > 0) {
    parts.push(`用語: ${settings.dictionary.join('、')}`);
  }
  if (extraTail) parts.push(extraTail);
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
async function transcribeLocal(wavBuffer, extraPromptTail) {
  const ok = await ensureEngineReady(whisperEng);
  if (!ok) throw new Error(whisperEng.lastError || '文字起こしエンジンが起動していません');
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  if (settings.language && settings.language !== 'auto') form.append('language', settings.language);
  const prompt = buildPrompt(extraPromptTail);
  if (prompt) form.append('prompt', prompt);

  const res = await fetch(`http://127.0.0.1:${settings.localPort}/inference`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(240000) });
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
  return text;
}

async function generateMinutes(plain, memo, onProgress, type) {
  const MINUTES_FORMAT = mtype.getFormat(type);
  const ok = await ensureEngineReady(sumEng);
  if (!ok) throw new Error(sumEng.lastError || '要約エンジンが起動していません');
  const sys = 'あなたは優秀な議事録作成アシスタントです。会議の文字起こしを分析し、正確で実用的な議事録を日本語のMarkdownで作成します。'
    + '文字起こしに無い情報を創作せず、雑談は省いてください。';
  const memoBlock = memo && memo.trim() ? `【会議メモ・アジェンダ（要約のヒント）】\n${memo.trim()}\n\n` : '';

  const CHUNK = 5500;
  if (plain.length <= CHUNK + 1500) {
    return llmChat([
      { role: 'system', content: sys },
      { role: 'user', content: `${memoBlock}【会議の文字起こし】\n${plain}\n\n上記から、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${MINUTES_FORMAT}` },
    ], 1600);
  }

  const chunks = [];
  for (let i = 0; i < plain.length; i += CHUNK) chunks.push(plain.slice(i, i + CHUNK + 200));
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(`要約中… (${i + 1}/${chunks.length})`);
    const part = await llmChat([
      { role: 'system', content: sys },
      { role: 'user', content: `以下は長い会議の文字起こしの一部（${i + 1}/${chunks.length}）です。重要な発言・決定・依頼・課題・数字を漏らさず、簡潔な箇条書きで抽出してください。\n\n${chunks[i]}` },
    ], 700);
    notes.push(`--- パート${i + 1} ---\n${part}`);
  }
  if (onProgress) onProgress('議事録をまとめています…');
  return llmChat([
    { role: 'system', content: sys },
    { role: 'user', content: `${memoBlock}【会議の要点メモ（時系列）】\n${notes.join('\n\n')}\n\n上記の要点メモを統合し、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${MINUTES_FORMAT}` },
  ], 1600);
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
  mainWin.on('close', (e) => { if (!quitting) { e.preventDefault(); mainWin.hide(); } });
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
  if (state === 'recording') globalShortcut.unregister('Escape');
  state = 'processing'; updateTray();
  if (durationMs < MIN_RECORD_MS || buffer.byteLength < 1000) { finishWithError('録音が短すぎます'); return; }
  sendToOverlay('overlay:phase', { phase: 'processing', message: '文字起こし中…' });
  try {
    const t0 = Date.now();
    const raw = await transcribeLocal(buffer);
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
  meeting = { startedAt: Date.now(), memo: '', segments: [], offsetMs: 0, stopping: false, seq: 0 };
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'meeting';
  writeDraft();
  ensureEngineReady(whisperEng);
  if (engineValid(sumEng)) startEngine(sumEng);
  positionOverlay();
  overlayWin.showInactive();
  sendToOverlay('overlay:start', {
    mode: 'meeting', segmentSec: settings.segmentSec || 75,
    micId: settings.micId || '', sound: Boolean(settings.soundFeedback),
  });
  updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}

function stopMeeting() {
  if (state !== 'meeting') return { ok: false };
  state = 'meeting-finalizing';
  meeting.stopping = true;
  sendToOverlay('overlay:stop', {});
  sendToOverlay('overlay:phase', { phase: 'processing', message: '議事録を作成中…' });
  sendToMainWin('meeting:progress', { message: '録音を終了し、残りの文字起こしを処理しています…' });
  updateTray();
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
  const segOffset = meeting.offsetMs;
  meeting.offsetMs += durationMs;
  pendingSegs++;
  sendToMainWin('meeting:update', meetingStatus());
  segChain = segChain.then(async () => {
    if (!meeting) return;
    if (buffer.byteLength < 4000) return;
    const tail = meeting.segments.length ? meeting.segments[meeting.segments.length - 1].text.slice(-100) : '';
    let text = '';
    try {
      text = await transcribeLocal(buffer, tail);
    } catch (e) {
      meeting.segments.push({ id: `s${++meeting.seq}`, atMs: segOffset, text: `（この区間の認識に失敗: ${e.message}）`, failed: true });
      writeDraft(); sendToMainWin('meeting:update', meetingStatus());
      return;
    }
    if (!meeting) return;
    if (settings.removeFillers) text = removeFillersRule(text);
    if (!text) return;
    const prev = meeting.segments.length ? meeting.segments[meeting.segments.length - 1].text : '';
    if (prev && text.length > 6 && prev === text) return; // 繰り返しハルシネーション抑制
    meeting.segments.push({ id: `s${++meeting.seq}`, atMs: segOffset, text });
    writeDraft();
    sendToMainWin('meeting:update', meetingStatus());
  }).catch(() => {}).finally(() => {
    pendingSegs--;
    sendToMainWin('meeting:update', meetingStatus());
    if (isFinal || (meeting && meeting.stopping && pendingSegs === 0)) maybeFinalizeMeeting();
  });
}

async function maybeFinalizeMeeting() {
  if (!meeting || !meeting.stopping || pendingSegs > 0) return;
  if (state !== 'meeting-finalizing') return;
  const m = meeting;
  meeting = null;

  const durationSec = Math.round((Date.now() - m.startedAt) / 1000);
  const dt = new Date(m.startedAt);
  const fallbackTitle = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} の議事録`;

  const page = store.createPage({
    title: fallbackTitle,
    date: dt.toISOString().slice(0, 10),
    durationSec, memo: m.memo, blocks: [],
    segments: m.segments,
    createdAt: dt.toISOString(),
  });
  store.clearDraft();

  state = 'idle'; updateTray();
  sendToOverlay('overlay:phase', { phase: 'done', message: '議事録を保存しました' });
  setTimeout(hideOverlayIfIdle, 2000);
  // 録音状態の解除をUIへ通知する。これを送らないと画面が「作成中…」のまま止まる
  sendToMainWin('meeting:update', meetingStatus());
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

  // 会議タイプ: 手動指定があればそれを尊重し、無ければタイトルと冒頭から推定
  if (!page.meetingType || page.typeAuto !== false) {
    page.meetingType = mtype.detectType(page.title, plain.slice(0, 1200));
    page.typeAuto = true;
  }

  sendToMainWin('meeting:progress', {
    message: `要約エンジンで議事録を作成中…（${mtype.getLabel(page.meetingType)}として要約します）`,
  });
  try {
    const md = await generateMinutes(
      plain, page.memo,
      (msg) => sendToMainWin('meeting:progress', { message: msg }),
      page.meetingType,
    );
    const blocks = markdownToBlocks(md);
    const stat = attachCitations(blocks, usable);
    const actStat = enrichActionBlocks(blocks, new Date(page.createdAt));
    page.blocks = blocks;
    page.summaryError = '';
    page.citeStat = stat;
    page.actionStat = actStat;
    store.savePage(page);
    clearUi();
    sendToMainWin('pages:updated', store.listPages());
    sendToMainWin('page:updated', { page, segments });
    return { ok: true, page, stat };
  } catch (e) {
    page.summaryError = e.message;
    store.savePage(page);
    clearUi();
    sendToMainWin('page:updated', { page, segments });
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

function makeTrayIcon(recording) {
  const glyph = recording
    ? '<circle cx="16" cy="16" r="7" fill="#fff"/>'
    : '<rect x="12.5" y="6" width="7" height="12" rx="3.5" fill="#fff"/>'
      + '<path d="M9 13a7 7 0 0 0 14 0" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
      + '<path d="M16 20v5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'
      + '<path d="M12 26h8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">`
    + `<rect x="1" y="1" width="30" height="30" rx="8" fill="${recording ? '#8b9bff' : '#5b6ee1'}"/>${glyph}</svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function updateTray() {
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

  ipcMain.handle('pages:list', () => store.listPages());
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
  ipcMain.handle('page:export', async (_e, id) => {
    const page = store.getPage(id);
    if (!page) return { ok: false, error: 'ページが見つかりません' };
    const segments = store.getTranscript(id);
    const d = new Date(page.createdAt);
    const def = `議事録_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.md`;
    const res = await dialog.showSaveDialog(mainWin, { defaultPath: def, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (res.canceled || !res.filePath) return { ok: false };
    try {
      fs.writeFileSync(res.filePath, blocksToMarkdown(page, segments), 'utf8');
      return { ok: true, path: res.filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

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
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), repo: updater.REPO }));
  ipcMain.handle('update:check', () => updater.check(app.getVersion(), app.getPath('userData')));
  ipcMain.handle('update:apply', async (_e, url) => {
    const root = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
    if (app.isPackaged) {
      return { ok: false, error: 'インストーラー版はこの方法で更新できません。新しいインストーラーを実行してください。' };
    }
    return updater.apply(url, root, app.getPath('userData'),
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
  ipcMain.on('audio:error', (_e, { message }) => {
    if (state === 'meeting' || state === 'meeting-finalizing') {
      if (meeting) { meeting.stopping = true; state = 'meeting-finalizing'; maybeFinalizeMeeting(); }
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
    setupIpc();
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
      if (r.ok && r.update) sendToMainWin('update:available', r);
    }, 8000);
  });
  app.on('window-all-closed', () => { /* トレイ常駐 */ });
  app.on('before-quit', () => { quitting = true; stopEngine(whisperEng); stopEngine(sumEng); stopPaster(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); stopEngine(whisperEng); stopEngine(sumEng); stopPaster(); });
}
