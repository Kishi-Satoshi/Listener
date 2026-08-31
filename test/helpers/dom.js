'use strict';
// 依存ゼロの最小 DOM。画面のスクリプトを素の Node 上で「実際に走らせる」ためだけのもの。
// 完全な再現は狙わない。狙いは「初期化が最後まで到達するか」「どの id が null だったか」。

const html = require('./html.js');

class ClassList {
  constructor(el) { this.el = el; }
  get _s() { return (this.el.attrs.class || '').split(/\s+/).filter(Boolean); }
  _set(a) { this.el.attrs.class = a.join(' '); }
  add(...c) { const s = this._s; for (const x of c) if (x && !s.includes(x)) s.push(x); this._set(s); }
  remove(...c) { this._set(this._s.filter((x) => !c.includes(x))); }
  toggle(c, on) { const h = this.contains(c); const want = on === undefined ? !h : !!on; if (want) this.add(c); else this.remove(c); return want; }
  contains(c) { return this._s.includes(c); }
  get length() { return this._s.length; }
  toString() { return this._s.join(' '); }
}

let uid = 0;
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.tag = String(tag).toLowerCase();
    this.attrs = {}; this.children = []; this.parent = null; this.doc = doc;
    this.classList = new ClassList(this); this.style = new Proxy({}, { set: (t, k, v) => (t[k] = v, true), get: (t, k) => (k in t ? t[k] : '') });
    this.dataset = {}; this._listeners = {}; this._handlers = {};
    this._text = ''; this._value = ''; this.checked = false; this.disabled = false;
    this.options = []; this.selectedIndex = -1; this.files = []; this._uid = ++uid;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.offsetHeight = 0; this.offsetWidth = 0;
  }
  // 本物の DOM と同じく value は必ず文字列（型強制を真似ないと誤検知が出る）
  get value() { return this._value; } set value(v) { this._value = v === null || v === undefined ? '' : String(v); }
  get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; if (v) this.doc._ids.set(v, this); }
  get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this.children = []; this._text = v === undefined || v === null ? '' : String(v); }
  get innerHTML() { return this._html || ''; }
  set innerHTML(v) { this._html = String(v); this.children = []; for (const c of this.doc._fragment(String(v))) { c.parent = this; this.children.push(c); } }
  get innerText() { return this.textContent; } set innerText(v) { this.textContent = v; }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get parentElement() { return this.parent; } get parentNode() { return this.parent; }
  get nextElementSibling() { const s = this.parent ? this.parent.children : []; return s[s.indexOf(this) + 1] || null; }
  get previousElementSibling() { const s = this.parent ? this.parent.children : []; return s[s.indexOf(this) - 1] || null; }
  get childNodes() { return this.children; }
  get childElementCount() { return this.children.length; }
  contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parent; } return false; }
  setAttribute(k, v) { k = String(k).toLowerCase(); this.attrs[k] = String(v); if (k === 'id') this.doc._ids.set(String(v), this); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); }
  getAttribute(k) { const v = this.attrs[String(k).toLowerCase()]; return v === undefined ? null : v; }
  removeAttribute(k) { delete this.attrs[String(k).toLowerCase()]; }
  hasAttribute(k) { return String(k).toLowerCase() in this.attrs; }
  appendChild(c) { if (!c) return c; if (c._frag) { for (const x of c.children) this.appendChild(x); return c; } c.parent = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? this.doc.createTextNode(c) : c); }
  prepend(c) { c.parent = this; this.children.unshift(c); }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); c.parent = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; return c; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  replaceChildren(...cs) { this.children = []; for (const c of cs) this.appendChild(c); }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); this.doc._wired.push({ id: this.id, tag: this.tag, type: t }); }
  removeEventListener(t, fn) { const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  dispatchEvent() { return true; }
  click() { this._fire('click'); }
  focus() {} blur() {} select() {} scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n; return null; }
  matches(sel) { return matchSel(this, sel); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { const out = []; walk(this, (n) => { if (n !== this && matchSel(n, sel)) out.push(n); }); return out; }
  getElementsByTagName(t) { return this.querySelectorAll(t); }
  getContext() { return canvasCtx(); }   // <canvas>
  add(o) { this.options.push(o); this.appendChild(o); }   // <select>
  _fire(type, ev) {
    const e = ev || { preventDefault() {}, stopPropagation() {}, target: this, currentTarget: this, key: '', dataTransfer: { setData() {}, getData: () => '' } };
    const h = this['on' + type]; if (typeof h === 'function') h.call(this, e);
    for (const fn of this._listeners[type] || []) fn.call(this, e);
  }
}
// on* 代入も記録する
for (const t of ['click','change','input','keydown','keyup','submit','dragstart','dragover','drop','dragend','blur','focus','paste','contextmenu','mousedown','mouseup','wheel']) {
  Object.defineProperty(El.prototype, 'on' + t, {
    get() { return this._handlers[t]; },
    set(fn) { this._handlers[t] = fn; if (fn) this.doc._wired.push({ id: this.id, tag: this.tag, type: t }); },
  });
}
function walk(n, fn) { for (const c of n.children) { fn(c); walk(c, fn); } }
// 対応するのは tag / .class / #id とその連結、コンマ区切り、子孫（空白）まで
function matchOne(n, s) {
  if (s === '*') return true;
  const re = /([.#]?)([A-Za-z0-9_-]+)|\[([^\]]+)\]/g; let m;
  while ((m = re.exec(s))) {
    if (m[3]) { const [k, v] = m[3].split('='); if (n.getAttribute(k.trim()) !== (v ? v.replace(/["']/g, '') : n.getAttribute(k.trim()))) return false; continue; }
    if (m[1] === '.') { if (!n.classList.contains(m[2])) return false; }
    else if (m[1] === '#') { if (n.id !== m[2]) return false; }
    else if (n.tag !== m[2].toLowerCase()) return false;
  }
  return true;
}
function matchSel(n, sel) {
  for (const alt of String(sel).split(',')) {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    if (!matchOne(n, parts[parts.length - 1])) continue;
    let ok = true, cur = n.parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (cur && !matchOne(cur, parts[i])) cur = cur.parent;
      if (!cur) { ok = false; break; }
      cur = cur.parent;
    }
    if (ok) return true;
  }
  return false;
}
function canvasCtx() {
  const noop = () => {};
  return new Proxy({ canvas: { width: 160, height: 18 }, measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop: noop }), getImageData: () => ({ data: [] }) },
    { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => (t[k] = v, true) });
}

class Doc {
  constructor(tree) {
    this._ids = new Map(); this._wired = []; this._missing = []; this._asked = [];
    this.body = new El('body', this); this.head = new El('head', this);
    this.documentElement = new El('html', this);
    this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body);
    if (tree) this._build(tree);
  }
  _build(tree) {
    const conv = (n, parent) => {
      const e = new El(n.tag, this);
      for (const [k, v] of Object.entries(n.attrs)) e.setAttribute(k, v);
      if (n.tag === 'style' || n.tag === 'script') e._text = n.text || '';
      parent.appendChild(e);
      for (const c of n.children) conv(c, e);
      return e;
    };
    const bodyNode = tree.nodes.find((n) => n.tag === 'body');
    const headNode = tree.nodes.find((n) => n.tag === 'head');
    if (headNode) for (const c of headNode.children) conv(c, this.head);
    if (bodyNode) for (const c of bodyNode.children) conv(c, this.body);
    else for (const c of tree.root.children) conv(c, this.body);
  }
  _fragment(s) {
    const t = html.parse(s); const out = [];
    const conv = (n, parent) => { const e = new El(n.tag, this); for (const [k, v] of Object.entries(n.attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); for (const c of n.children) conv(c, e); return e; };
    for (const n of t.root.children) out.push(conv(n, null));
    return out;
  }
  getElementById(id) {
    this._asked.push(id);
    const e = this._ids.get(id) || null;
    if (!e) this._missing.push(id);
    return e;
  }
  createElement(t) { return new El(t, this); }
  createTextNode(t) { const e = new El('#text', this); e._text = String(t); return e; }
  createDocumentFragment() { const e = new El('#fragment', this); e._frag = true; return e; }
  querySelector(s) { return this.documentElement.querySelector(s); }
  querySelectorAll(s) { return this.documentElement.querySelectorAll(s); }
  getElementsByTagName(t) { return this.documentElement.querySelectorAll(t); }
  addEventListener(t, fn) { (this._docListeners = this._docListeners || {}), ((this._docListeners[t] = this._docListeners[t] || []).push(fn)); }
  removeEventListener() {}
  createEvent() { return { initEvent() {} }; }
  execCommand() { return true; }
  get activeElement() { return this.body; }
  get readyState() { return 'complete'; }
  get hidden() { return false; }
}

module.exports = { Doc, El, ClassList, canvasCtx };
