/*
 * simrun.js — 画面の <script> を最小DOM上で実際に走らせる
 *
 * 見るのは「文字列があるか」ではなく「初期化が最後まで走るか」。
 * IPC（window.koeApp / koeOverlay）は preload.js の exposeInMainWorld から
 * 名前を自動抽出して偽物を作るので、APIが増えてもここは手を入れなくてよい。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseHTML, Element, textNode } = require('./simdom.js');

const ROOT = path.join(__dirname, '..', '..');

/*
 * 非同期の初期化で出た例外は unhandledRejection でしか拾えないが、
 * これはプロセス全体の合図なので、そのままだと別のテストの例外を
 * 拾ってしまう（実際に、app.html の変異が overlay.html のテストを
 * 巻き添えで落とした）。実行ごとに sourceURL を振り、
 * スタックにその印が無い例外は自分のものとして数えない。
 */
let runSeq = 0;
const openRuns = new Map();   // mark -> log
process.on('unhandledRejection', (e) => {
  const stack = (e && e.stack) || '';
  for (const [mark, log] of openRuns) if (stack.includes(mark)) { log.errors.push(e); return; }
  // 印が無いもの（スタックを持たない値など）は、今開いている最後の実行に付ける
  const last = [...openRuns.values()].pop();
  if (last) last.errors.push(e);
});

/** preload.js から公開APIの名前を読む（テスト側で二重管理しない） */
function preloadApis(src) {
  if (src === undefined) src = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const out = {};
  const re = /exposeInMainWorld\(\s*'([^']+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1;
    while (i < src.length && depth > 0) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; i++; }
    const body = src.slice(re.lastIndex, i - 1);
    const names = [];
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

/* ---- 偽の音（#36）。decode / render が返す AudioBuffer 風は実機と同じ形にする ---- */
/** MediaRecorder の 1 chunk が表すバイト数／秒。chunk 1 つ = 1 秒ぶんの音 */
const BYTES_PER_SEC = 4000;
const RECORDED_CHUNK = Uint8Array.from({ length: BYTES_PER_SEC }, (_, i) => (i * 7 + 3) & 0xff);
/** Float32Array を AudioBuffer 風に包む（getChannelData(0) がその配列） */
function audioBufferOf(data, sampleRate) {
  return {
    duration: data.length / sampleRate, sampleRate, length: data.length, numberOfChannels: 1,
    getChannelData(ch) { if (ch !== 0) throw new RangeError(`channel ${ch} は無い（mono）`); return data; },
  };
}
/** 決定的で非無音の AudioBuffer 風: 440Hz・振幅 0.5 の正弦波 */
function sineBuffer(frames, sampleRate = 48000) {
  const data = new Float32Array(Math.max(1, frames));
  for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  return audioBufferOf(data, sampleRate);
}

/** IPC の既定の戻り値。初期化を最後まで通すのに要るものだけ書く */
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
  updateCheck: () => ({ ok: true, update: false, version: '0.10.4', applyable: true }),
  pickFile: () => 'C:\\選んだ\\path.bin',
  copy: () => ({ ok: true }),
};

async function load(htmlPath, opt = {}) {
  const src = opt.html !== undefined ? opt.html : fs.readFileSync(htmlPath, 'utf8');
  const { root, errors } = parseHTML(src);
  const log = { errors: [], missingIds: [], calls: [], consoleErrors: [], parseErrors: errors, root, created: [], paints: [], lookups: new Set() };

  const byId = new Map();
  for (const el of root._walk([])) if (el.id && !byId.has(el.id)) byId.set(el.id, el);
  log.byId = byId;

  const document = {
    _root: root,
    documentElement: root.querySelector('html') || new Element('html'),
    body: root.querySelector('body') || new Element('body'),
    head: root.querySelector('head') || new Element('head'),
    getElementById(id) {
      // 本物と同じく「今の木」を引く。あとから作って挿した要素も見つかる。
      log.lookups.add(String(id));
      const hit = byId.get(id);
      if (hit && hit._inTree === undefined) return hit;
      const live = root._walk([]).find((e) => e.id === String(id));
      if (live) { byId.set(String(id), live); return live; }
      log.missingIds.push(String(id));
      return null;
    },
    createElement(tag) { const e = new Element(String(tag).toLowerCase()); log.created.push(e); return e; },
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
  const cbs = {};
  const win = {};
  for (const [name, methods] of Object.entries(apis)) {
    const obj = {};
    for (const mth of methods) {
      if (/^on[A-Z]/.test(mth)) {
        obj[mth] = (cb) => { (cbs[mth] = cbs[mth] || []).push(cb); log.calls.push({ api: name, method: mth, args: [] }); };
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
  log.apis = apis;
  /** メイン側から送られてくるイベント（onStart など）を発火する */
  log.fire = (name, ...a) => { const l = cbs[name] || []; for (const cb of l) cb(...a); return l.length; };
  log.called = (m) => log.calls.filter((c) => c.method === m);

  /* ---- 画面まわりの最小スタブ ---- */
  const noop = () => {};
  const timers = new Set();
  const rafQ = [];
  let rafId = 0;
  let rafLeft = opt.frames === undefined ? 4 : opt.frames;   // 描画ループは有限回だけ回す
  function fakeStream() {
    const track = { stop: noop, kind: 'audio', enabled: true, addEventListener: noop, onended: null };
    return { getTracks: () => [track], getAudioTracks: () => [track], addTrack: noop, active: true };
  }
  /*
   * 音の経路は「本物のバイト列」を通す（#36）。
   *   MediaRecorder が止まると決定的なバイト列の chunk が届き、Blob はそれを連結して
   *   本物の ArrayBuffer を返し、decodeAudioData はその長さぶんの正弦波（非無音）を返し、
   *   OfflineAudioContext は繋いで start() した音源を間引いてレンダリングする。
   *   以前は decode が {duration} だけを返し、レンダリングは全部 0 だったので、
   *   0 バイトを送る壊れ方でも「区間が送られた」検査が通っていた。
   */
  class FakeBlob {
    constructor(parts, o) {
      this.parts = parts || [];
      this.type = (o && o.type) || '';
      this._bytes = concatBytes(this.parts);
      this.size = this._bytes.length;
    }
    arrayBuffer() { return Promise.resolve(this._bytes.slice().buffer); }
  }
  function concatBytes(parts) {
    const bs = parts.map((p) => {
      if (p instanceof FakeBlob) return p._bytes;
      if (p instanceof ArrayBuffer) return new Uint8Array(p);
      if (ArrayBuffer.isView(p)) return new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
      return new Uint8Array(Buffer.from(String(p), 'utf8'));
    });
    const out = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
    let off = 0;
    for (const b of bs) { out.set(b, off); off += b.length; }
    return out;
  }
  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; this.sampleRate = 48000; }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect: () => ({ connect: noop }), start: noop, stop: noop }; }
    createGain() { return { gain: { value: 1, setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop }, connect: (x) => x || { connect: noop }, disconnect: noop }; }
    createAnalyser() { return { fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0, getByteTimeDomainData: (a) => a.fill(128), getByteFrequencyData: (a) => a.fill(0), connect: (x) => x, disconnect: noop }; }
    createMediaStreamSource() { return { connect: (x) => x || { connect: noop }, disconnect: noop }; }
    createMediaStreamDestination() { return { stream: fakeStream(), connect: noop }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    // 実機と同じく ArrayBuffer 以外は TypeError、0 バイトは EncodingError で失敗する。
    // 中身は見ず、長さに比例した正弦波を返す（録れたバイト列が空なら変換は失敗する）。
    decodeAudioData(arr) {
      if (!(arr instanceof ArrayBuffer)) return Promise.reject(new TypeError('decodeAudioData: ArrayBuffer ではない'));
      if (arr.byteLength === 0) return Promise.reject(Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' }));
      return Promise.resolve(sineBuffer(Math.round(arr.byteLength / BYTES_PER_SEC * 48000), 48000));
    }
  }
  class FakeOfflineAudioContext {
    constructor(ch, len, rate) { this.numberOfChannels = ch; this.length = len; this.sampleRate = rate; this.destination = { _offline: this }; this._sources = []; }
    createBufferSource() {
      const dest = this.destination;
      const src = { buffer: null, _connected: false, _started: false, connect(node) { if (node === dest) src._connected = true; return node; }, start() { src._started = true; }, stop: noop };
      this._sources.push(src);
      return src;
    }
    startRendering() {
      const out = new Float32Array(this.length);
      // 実機どおり、destination に繋いで start() した音源だけが音になる。素朴な間引きで再標本化する
      for (const s of this._sources) {
        if (!s._connected || !s._started || !s.buffer) continue;
        const inp = s.buffer.getChannelData(0), ratio = s.buffer.sampleRate / this.sampleRate;
        for (let i = 0; i < out.length; i++) { const j = Math.floor(i * ratio); if (j < inp.length) out[i] += inp[j]; }
      }
      return Promise.resolve(audioBufferOf(out, this.sampleRate));
    }
  }
  class FakeMediaRecorder {
    constructor(stream, o) { this.stream = stream; this.mimeType = (o && o.mimeType) || 'audio/webm'; this.state = 'inactive'; this.ondataavailable = null; this.onstop = null; this.onerror = null; }
    start() { this.state = 'recording'; }
    // 実機と同じく、止めると（state が inactive になってから）溜まっていたデータが先に届き、その後に onstop
    stop() { this.state = 'inactive'; this._flush(); if (this.onstop) this.onstop(); }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    requestData() { this._flush(); }
    /** 録れたデータを1つの chunk として届ける（決定的なバイト列。1 chunk = 1 秒ぶん） */
    _flush() { if (this.ondataavailable) this.ondataavailable({ data: new FakeBlob([RECORDED_CHUNK], { type: this.mimeType }) }); }
    static isTypeSupported() { return true; }
  }

  const window = Object.assign(win, {
    document,
    setTimeout: (fn, ms) => { const id = setTimeout(noop, 0); timers.add(id); return id; },
    clearTimeout: (id) => { clearTimeout(id); timers.delete(id); },
    setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: (fn) => { if (rafLeft > 0) { rafLeft--; rafQ.push(fn); } return ++rafId; },
    cancelAnimationFrame: () => { rafQ.length = 0; },
    addEventListener: noop, removeEventListener: noop,
    AudioContext: FakeAudioContext, webkitAudioContext: FakeAudioContext, OfflineAudioContext: FakeOfflineAudioContext,
    MediaRecorder: FakeMediaRecorder,
    Blob: FakeBlob,
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve(fakeStream()),
        getDisplayMedia: () => Promise.resolve(fakeStream()),
        enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', deviceId: 'default', label: 'マイク (既定)' }]),
        addEventListener: noop,
      },
      clipboard: { writeText: () => Promise.resolve() },
    },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    prompt: () => null, confirm: () => false, alert: noop,
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
    location: { href: '', reload: noop },
    Option: function Option(text, value) { const e = new Element('option'); e.textContent = text === undefined ? '' : text; e.value = value === undefined ? '' : value; return e; },
  });
  window.window = window;
  window.self = window;
  const console2 = { log: noop, warn: noop, info: noop, debug: noop, error: (...a) => log.consoleErrors.push(a.map((x) => (x && x.message) || String(x)).join(' ')) };

  /* ---- 実行 ---- */
  const mark = `listener-run-${++runSeq}.js`;
  log.mark = mark;
  openRuns.set(mark, log);
  const scripts = root.querySelectorAll('script').filter((s) => !s.getAttribute('src'));
  if (!scripts.length) throw new Error(`${htmlPath}: 実行できる <script> が無い（検査が空振りしている）`);
  const names = ['window','document','navigator','console','setTimeout','clearTimeout','setInterval','clearInterval',
    'requestAnimationFrame','cancelAnimationFrame','AudioContext','webkitAudioContext','MediaRecorder','Blob','Option',
    'alert','confirm','prompt','getComputedStyle','matchMedia','self','location'];
  for (const s of scripts) {
    try {
      const fn = new Function(...names, `with (window) {\n${s._raw}\n}\n//# sourceURL=${mark}`);
      fn(window, document, window.navigator, console2, window.setTimeout, window.clearTimeout, window.setInterval,
        window.clearInterval, window.requestAnimationFrame, window.cancelAnimationFrame, window.AudioContext,
        window.webkitAudioContext, window.MediaRecorder, window.Blob, window.Option, window.alert, window.confirm,
        window.prompt, window.getComputedStyle, window.matchMedia, window, window.location);
    } catch (e) { log.errors.push(e); }
  }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setImmediate(r));
    const fn = rafQ.shift();
    if (fn) { try { fn(i); } catch (e) { log.errors.push(e); } }
  }
  for (const id of timers) clearTimeout(id);

  log.window = window;
  log.document = document;
  log.wired = () => wired(root);
  /** イベントを起こした後に、非同期と描画ループをもう一度進める */
  log.drain = async (n = 40) => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setImmediate(r));
      const fn = rafQ.shift();
      if (fn) { try { fn(i); } catch (e) { log.errors.push(e); } }
    }
    log.paints = [...new Set(root._walk([]).flatMap((e) => e._paints || []))];
    return log;
  };
  /** canvas に実際に設定された fillStyle / strokeStyle（描画を走らせた結果） */
  log.paints = [...new Set(root._walk([]).flatMap((e) => e._paints || []))];
  /** 画面が自分で作った id は「HTMLに無くて当然」なので除外候補になる */
  // 画面が自分で作った id（innerHTML で作った中身も含む）は「HTMLに無くて当然」
  log.createdIds = new Set(log.created.flatMap((e) => [e.id, ...e._walk([]).map((x) => x.id)]).filter(Boolean));
  /** 結線されたハンドラを全部叩く（計算で作る id の破壊もここで出る） */
  log.clickAll = async (types = ['click', 'change', 'input']) => {
    for (const w of wired(root)) {
      for (const t of types) {
        const has = typeof w.el['on' + t] === 'function' || (w.el._listeners[t] || []).length;
        if (!has) continue;
        try { w.el.dispatchEvent({ type: t, key: 'a', keyCode: 65 }); } catch (e) { log.errors.push(e); }
      }
    }
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    return log;
  };
  return log;
}

/** 初期化後に実際にハンドラが付いた要素を列挙する（文字列照合ではなく観測値） */
function wired(root) {
  const out = [];
  for (const el of root._walk([])) {
    const on = Object.keys(el).filter((k) => /^on[a-z]+$/.test(k) && typeof el[k] === 'function');
    const ls = Object.keys(el._listeners || {}).filter((t) => el._listeners[t].length);
    if (on.length || ls.length) out.push({ id: el.id, tag: el.tagName, on, listeners: ls, el });
  }
  return out;
}

module.exports = { load, preloadApis, wired, RETURNS, sineBuffer, audioBufferOf, BYTES_PER_SEC };
