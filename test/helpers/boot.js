'use strict';
// 画面の <script> を素の Node 上で実際に実行する。Electron も GUI も要らない。
// preload.js から公開 API 名を自動抽出して偽物を作るので、API が増えても手入れ不要。

const fs = require('fs');
const path = require('path');
const html = require('./html.js');
const { Doc, El, canvasCtx } = require('./dom.js');

const ROOT = path.join(__dirname, '..', '..');

// preload.js の exposeInMainWorld('名前', { ... }) を読み、API 名の一覧を返す
function preloadApis(src) {
  const out = {};
  const re = /exposeInMainWorld\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex - 1, depth = 0, end = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } } }
    const body = src.slice(re.lastIndex, end);
    const names = [...body.matchAll(/(?:^|[\s,{])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:\(|async|function)/g)].map((x) => x[1]);
    out[m[1]] = [...new Set(names)];
  }
  return out;
}

// 偽の API。呼ばれた名前を記録し、on* は登録された cb を保持して後から発火できるようにする
function fakeApi(names, calls, cbs, replies) {
  const o = {};
  for (const n of names) {
    o[n] = (...a) => {
      calls.push(n);
      if (/^on[A-Z]/.test(n) && typeof a[0] === 'function') { (cbs[n] = cbs[n] || []).push(a[0]); return undefined; }
      const r = replies[n];
      const v = typeof r === 'function' ? r(...a) : r;
      return /^on[A-Z]/.test(n) ? v : Promise.resolve(v === undefined ? {} : v);
    };
  }
  return o;
}

// 画面を起動する。opts.replies で preload API の戻り値を差し替えられる。
function boot(file, opts = {}) {
  const src = fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8');
  const tree = html.parse(src);
  const doc = new Doc(tree);
  const apis = preloadApis(fs.readFileSync(opts.preload || path.join(ROOT, 'src', 'preload.js'), 'utf8'));
  const calls = [], cbs = {}, errors = [], logs = [];
  const timers = [];
  const win = {};
  const nav = {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {}, kind: 'audio', label: 'mic' }], getAudioTracks: () => [{ stop() {} }] }),
      enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', label: 'マイク' }],
      addEventListener() {},
    },
    clipboard: { writeText: async () => {} }, userAgent: 'node', platform: 'Win32', language: 'ja',
  };
  Object.assign(win, {
    document: doc, navigator: nav, location: { href: 'file:///app.html', reload() {} },
    localStorage: { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } },
    addEventListener: (t, fn) => { (win._l = win._l || {}), ((win._l[t] = win._l[t] || []).push(fn)); },
    removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, media: '' }),
    requestAnimationFrame: (fn) => { timers.push(fn); return timers.length; }, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    alert() {}, confirm: () => true, prompt: () => '', scrollTo() {}, getComputedStyle: () => new Proxy({}, { get: () => '' }),
    innerWidth: 1120, innerHeight: 780, devicePixelRatio: 1, isSecureContext: true,
  });
  win.window = win; win.self = win; win.globalThis = win;
  for (const [ns, names] of Object.entries(apis)) win[ns] = fakeApi(names, calls, cbs, opts.replies || {});

  const AudioCtxProto = { createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createAnalyser: () => ({ fftSize: 0, frequencyBinCount: 64, getByteTimeDomainData() {}, getByteFrequencyData() {}, connect() {}, disconnect() {}, smoothingTimeConstant: 0 }), createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }), createScriptProcessor: () => ({ connect() {}, disconnect() {}, onaudioprocess: null }), close: async () => {}, resume: async () => {}, destination: {}, sampleRate: 48000, state: 'running', audioWorklet: { addModule: async () => {} } };
  function AudioContext() { return Object.create(AudioCtxProto); }
  function MediaRecorder() { return { start() {}, stop() {}, pause() {}, resume() {}, requestData() {}, state: 'inactive', ondataavailable: null, onstop: null, onerror: null, addEventListener() {}, mimeType: 'audio/webm' }; }
  MediaRecorder.isTypeSupported = () => true;

  const sandbox = {
    window: win, document: doc, navigator: nav, console: { log: (...a) => logs.push(a.join(' ')), warn: () => {}, error: (...a) => logs.push('ERROR ' + a.join(' ')), info: () => {}, debug: () => {} },
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval,
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
    localStorage: win.localStorage, location: win.location, alert: win.alert, confirm: win.confirm, prompt: win.prompt,
    AudioContext, webkitAudioContext: AudioContext, MediaRecorder, Blob: class { constructor(p, o) { this.parts = p || []; this.type = (o || {}).type || ''; this.size = 1; } arrayBuffer() { return Promise.resolve(new ArrayBuffer(8)); } },
    File: class {}, FileReader: class { readAsArrayBuffer() { if (this.onload) this.onload({ target: { result: new ArrayBuffer(8) } }); } },
    Image: class { constructor() { this.onload = null; } }, Option: function (t, v) { const e = new El('option', doc); e.textContent = t === undefined ? '' : t; e.value = v === undefined ? t : v; return e; },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    performance: { now: () => Date.now() }, getComputedStyle: win.getComputedStyle, matchMedia: win.matchMedia,
    ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} },
  };
  for (const [ns] of Object.entries(apis)) sandbox[ns] = win[ns];

  const scripts = tree.nodes.filter((n) => n.tag === 'script' && n.text && !n.attrs.src);
  const keys = Object.keys(sandbox);
  for (const s of scripts) {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function(...keys, s.text);
      fn(...keys.map((k) => sandbox[k]));
    } catch (e) { errors.push(`${file} の <script>(${s.line}行) で例外: ${e && e.message}`); }
  }
  // マイクロタスクを消化する（await の続きで落ちるものを拾う）
  const drain = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

  return {
    file, tree, doc, win, calls, cbs, errors, logs, timers, scripts: scripts.length,
    missing: [...new Set(doc._missing)], asked: [...new Set(doc._asked)], wired: doc._wired,
    drain,
    // 登録済みのハンドラを全部叩く（$('tab'+t) のような計算で作る id の破壊を捕まえる）
    fireAll() {
      const seen = new Set(); const errs = [];
      const all = [];
      const collect = (n) => { for (const c of n.children) { all.push(c); collect(c); } };
      collect(doc.documentElement);
      for (const el of all) {
        for (const t of Object.keys(el._handlers)) {
          if (typeof el._handlers[t] !== 'function') continue;
          const k = el._uid + ':' + t; if (seen.has(k)) continue; seen.add(k);
          try { el._fire(t); } catch (e) { errs.push(`#${el.id || el.tag} の on${t} で例外: ${e && e.message}`); }
        }
        for (const t of Object.keys(el._listeners)) for (const fn of el._listeners[t]) {
          try { fn.call(el, { preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el, key: 'a', dataTransfer: { setData() {}, getData: () => '' } }); }
          catch (e) { errs.push(`#${el.id || el.tag} の ${t} リスナで例外: ${e && e.message}`); }
        }
      }
      return errs;
    },
    // 登録した on* コールバックを発火する
    fire(name, ...args) { const errs = []; for (const cb of cbs[name] || []) { try { cb(...args); } catch (e) { errs.push(`${name} のコールバックで例外: ${e && e.message}`); } } return errs; },
  };
}

module.exports = { boot, preloadApis };
