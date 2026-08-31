/*
 * run.js — 画面（app.html / overlay.html）の <script> を最小DOM上で実際に走らせる
 *
 * 目的は「文字列があるか」ではなく「初期化が最後まで走るか」を見ること。
 * IPC（window.koeApp / koeOverlay）は preload.js の exposeInMainWorld から
 * 名前を自動抽出して偽物を作るので、APIが増えてもここは手を入れなくてよい。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseHTML, Element, textNode } = require('./dom.js');

const ROOT = path.join(__dirname, '..', '..');

/* ---- preload.js から公開APIの名前を読む（手書きの二重管理をしない） ---- */
function preloadApis(preloadSrc) {
  const src = preloadSrc !== undefined ? preloadSrc : fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const out = {};
  const re = /exposeInMainWorld\(\s*'([^']+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    // 対応する閉じ括弧まで取る
    let i = re.lastIndex, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const body = src.slice(re.lastIndex, i - 1);
    const names = [];
    // ネストの浅い（＝直下の）キーだけを拾う
    let d = 0;
    for (const line of body.split('\n')) {
      const t = line.trim();
      const k = d === 0 && /^([A-Za-z_$][\w$]*)\s*:/.exec(t);
      if (k) names.push(k[1]);
      for (const c of line) { if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; }
      d = Math.max(0, d);
    }
    out[m[1]] = names;
  }
  return out;
}

/* ---- IPC の戻り値。初期化を最後まで通すのに要るものだけ ---- */
const RETURNS = {
  getSettings: () => ({
    localServerExe: 'C:\\srv\\whisper.exe', localModelPath: 'C:\\m\\ggml.bin', localThreads: 4, localPort: 8990,
    vadModelPath: '', useVad: true, suppressNst: true,
    sumServerExe: 'C:\\srv\\sum.exe', sumModelPath: 'C:\\m\\sum.gguf', sumThreads: 4, sumPort: 8991,
    hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75, pillPos: 'bottom',
    language: 'ja', autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false,
    dictionary: ['固有名詞'], useBuiltinTerms: true, stayInTray: false, theme: 'system',
    useSystemAudio: false, micId: '',
  }),
  saveSettings: () => ({ ok: true }),
  appVersion: () => ({ version: '0.10.4' }),
  vadStatus: () => ({ path: 'C:\\m\\vad.onnx', auto: true }),
  meetingStatus: () => ({ active: false }),
  meetingTypes: () => [],
  getHistory: () => [],
  pagesSearch: () => [],
  pagesSearchFull: () => [],
  openActions: () => [],
  assigneeList: () => [],
  pageGet: () => null,
  testApi: () => ({ ok: true, info: 'OK' }),
  testSum: () => ({ ok: true, info: 'OK' }),
  updateCheck: () => null,
  pickFile: () => '',
  copy: () => ({ ok: true }),
};

/**
 * HTML を最小DOM上で読み込み、<script> を実行する。
 * 返り値の log に、初期化で観測したものが全部入る。
 */
async function load(htmlPath, opt = {}) {
  const src = fs.readFileSync(htmlPath, 'utf8');
  const { root, errors } = parseHTML(src);
  const log = {
    errors: [],            // 実行時例外
    missingIds: [],        // getElementById が null を返した id
    calls: [],             // IPC 呼び出し {api, method, args}
    consoleErrors: [],
    parseErrors: errors,
    handlers: () => wired(root),
  };

  const byId = new Map();
  for (const el of root._walk([])) if (el.id && !byId.has(el.id)) byId.set(el.id, el);

  const document = {
    _root: root,
    documentElement: root.querySelector('html') || new Element('html'),
    body: root.querySelector('body') || new Element('body'),
    head: root.querySelector('head') || new Element('head'),
    getElementById(id) {
      const el = byId.get(id);
      if (!el) { log.missingIds.push(id); return null; }
      return el;
    },
    createElement(tag) { const e = new Element(String(tag).toLowerCase()); if (tag === 'option') { e.value = ''; } return e; },
    createTextNode: (s) => textNode(s),
    createDocumentFragment: () => new Element('#fragment'),
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    addEventListener() {}, removeEventListener() {},
    execCommand: () => true,
    activeElement: null,
  };

  /* ---- 偽 IPC ---- */
  const apis = preloadApis(opt.preloadSrc);
  const cbs = {};   // onXxx で登録されたコールバック
  const win = {};
  for (const [name, methods] of Object.entries(apis)) {
    const obj = {};
    for (const mth of methods) {
      if (/^on[A-Z]/.test(mth)) {
        obj[mth] = (cb) => { (cbs[name + '.' + mth] = cbs[name + '.' + mth] || []).push(cb); log.calls.push({ api: name, method: mth, args: [] }); };
      } else {
        obj[mth] = (...args) => {
          log.calls.push({ api: name, method: mth, args });
          const r = (opt.returns && opt.returns[mth]) || RETURNS[mth];
          const v = r ? r(...args) : { ok: true };
          return name === 'koeApp' ? Promise.resolve(v) : v;
        };
      }
    }
    win[name] = obj;
  }
  log.fire = (key, ...a) => { for (const cb of cbs[key] || []) cb(...a); };

  /* ---- 画面まわりの最小スタブ ---- */
  const timers = new Set();
  const noop = () => {};
  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect: () => ({ connect: noop }), start: noop, stop: noop }; }
    createGain() { return { gain: { setValueAtTime: noop, exponentialRampToValueAtTime: noop, value: 1 }, connect: (x) => x, disconnect: noop }; }
    createAnalyser() { return { fftSize: 0, frequencyBinCount: 128, getByteTimeDomainData: (a) => a.fill(128), getByteFrequencyData: (a) => a.fill(0), connect: (x) => x, disconnect: noop }; }
    createMediaStreamSource() { return { connect: (x) => x, disconnect: noop }; }
    createMediaStreamDestination() { return { stream: fakeStream(), connect: noop }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  function fakeStream() {
    return { getTracks: () => [{ stop: noop, kind: 'audio', enabled: true }], getAudioTracks: () => [{ stop: noop, kind: 'audio', enabled: true }], addTrack: noop };
  }
  class FakeMediaRecorder {
    constructor() { this.state = 'inactive'; this.ondataavailable = null; this.onstop = null; this.onerror = null; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (this.onstop) this.onstop(); }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    static isTypeSupported() { return true; }
  }

  const window = Object.assign(win, {
    document,
    setTimeout: (fn, ms) => { const id = setTimeout(() => {}, 0); timers.add(id); return id; },
    clearTimeout: (id) => { clearTimeout(id); timers.delete(id); },
    setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
    addEventListener: noop, removeEventListener: noop,
    AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext,
    MediaRecorder: FakeMediaRecorder,
    Blob: class { constructor(p) { this.parts = p || []; this.size = 0; } arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)); } },
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve(fakeStream()),
        getDisplayMedia: () => Promise.resolve(fakeStream()),
        enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', deviceId: 'default', label: 'マイク' }]),
      },
      clipboard: { writeText: () => Promise.resolve() },
    },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    prompt: () => null, confirm: () => false, alert: noop,
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
    location: { href: '', reload: noop },
    Option: function Option(text, value) { const e = document.createElement('option'); e.textContent = text ?? ''; e.value = value ?? ''; return e; },
  });
  window.window = window;
  window.self = window;

  const console2 = {
    log: noop, warn: noop, info: noop, debug: noop,
    error: (...a) => log.consoleErrors.push(a.map(String).join(' ')),
  };

  /* ---- 実行 ---- */
  const scripts = root.querySelectorAll('script').filter((s) => !s.getAttribute('src'));
  if (!scripts.length) throw new Error(`${htmlPath}: <script> が1つも無い（検査が空振りしている）`);
  for (const s of scripts) {
    try {
      const fn = new Function('window', 'document', 'navigator', 'console', 'setTimeout', 'clearTimeout',
        'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'AudioContext',
        'MediaRecorder', 'Blob', 'Option', 'alert', 'confirm', 'prompt', 'getComputedStyle', 'matchMedia', 'self',
        `with (window) { ${s._raw} }`);
      fn(window, document, window.navigator, console2, window.setTimeout, window.clearTimeout,
        window.setInterval, window.clearInterval, window.requestAnimationFrame, window.cancelAnimationFrame,
        window.AudioContext, window.MediaRecorder, window.Blob, window.Option, window.alert, window.confirm,
        window.prompt, window.getComputedStyle, window.matchMedia, window);
    } catch (e) {
      log.errors.push(e);
    }
  }
  // 非同期の初期化（await window.koeApp.getSettings() …）を最後まで進める
  const trap = (e) => { log.errors.push(e); };
  process.on('unhandledRejection', trap);
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  process.off('unhandledRejection', trap);
  for (const id of timers) clearTimeout(id);

  log.window = window;
  log.document = document;
  log.byId = byId;
  log.root = root;
  return log;
}

/** 初期化後、実際にハンドラが付いた要素を列挙する */
function wired(root) {
  const out = [];
  for (const el of root._walk([])) {
    const evs = Object.keys(el).filter((k) => /^on[a-z]+$/.test(k) && typeof el[k] === 'function');
    const ls = Object.keys(el._listeners || {}).filter((t) => el._listeners[t].length);
    if (evs.length || ls.length) out.push({ id: el.id, tag: el.tagName, on: evs, listeners: ls, el });
  }
  return out;
}

module.exports = { load, preloadApis, wired, RETURNS };
