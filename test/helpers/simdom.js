/*
 * simdom.js — 依存ゼロの最小DOMシミュレータ
 *
 * app.html / overlay.html の <script> を素の Node 上で「実際に実行」するために、
 * document / Element の必要最小限だけを実装する。
 * 完全な再現は狙わない。狙いは「本物と同じところで壊れる」こと
 * （存在しない id は null を返す、input.value は文字列に強制する、など）。
 */
'use strict';

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const RAW = new Set(['script','style']);

/* ---------------- HTML → 木 ---------------- */

function parseAttrs(s) {
  const at = {};
  const re = /([A-Za-z_:@][-A-Za-z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(s))) {
    let v = m[2] === undefined ? '' : m[2];
    if (v && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
    at[m[1].toLowerCase()] = v;
  }
  return at;
}

/** HTML をパースして木にする。errors は閉じ忘れ・相手違いの閉じタグ。 */
function parseHTML(src) {
  const root = new Element('#document');
  const stack = [root];
  const errors = [];
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(stack[stack.length - 1], src.slice(i)); break; }
    if (lt > i) addText(stack[stack.length - 1], src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    if (src.startsWith('</', lt)) {
      const e = src.indexOf('>', lt);
      const name = src.slice(lt + 2, e).trim().toLowerCase();
      let k = stack.length - 1;
      while (k > 0 && stack[k].tagName !== name) k--;
      if (k === 0) errors.push({ line: lineAt(lt), msg: `対応する開始タグの無い </${name}>` });
      else {
        stack[k]._end = src.indexOf('>', lt) + 1;
        for (let j = stack.length - 1; j > k; j--) errors.push({ line: lineAt(lt), msg: `<${stack[j].tagName}>（${stack[j]._line}行）が閉じられないまま </${name}> が来た` });
        stack.length = k;
      }
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    let e = lt + 1, q = 0;
    while (e < src.length) {
      const c = src[e];
      if (q) { if (c === q) q = 0; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      e++;
    }
    const inner = src.slice(lt + 1, e);
    const sp = inner.search(/[\s/]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).toLowerCase();
    const selfClose = inner.trimEnd().endsWith('/');
    const el = new Element(name);
    el._line = lineAt(lt);
    el._start = lt;
    el._end = e + 1;
    el._indent = lt - (src.lastIndexOf('\n', lt - 1) + 1);
    for (const [k, v] of Object.entries(parseAttrs(sp < 0 ? '' : inner.slice(sp)))) el.setAttribute(k, v);
    stack[stack.length - 1].appendChild(el);
    i = e + 1;
    if (VOID.has(name) || selfClose) continue;
    if (RAW.has(name)) {
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      const end = close < 0 ? src.length : close;
      el._raw = src.slice(i, end);
      addText(el, el._raw);
      i = close < 0 ? src.length : src.indexOf('>', close) + 1;
      continue;
    }
    stack.push(el);
  }
  for (let j = stack.length - 1; j > 0; j--) errors.push({ line: stack[j]._line, msg: `<${stack[j].tagName}> が閉じられていない` });
  return { root, errors };
}

function addText(parent, t) { if (!t) return; const n = new Element('#text'); n._text = t; parent.appendChild(n); }
function textNode(s) { const n = new Element('#text'); n._text = String(s); return n; }

/* ---------------- セレクタ（子孫結合と , だけ） ---------------- */

function parseSimple(s) {
  const out = { tag: null, id: null, cls: [] };
  const re = /([#.]?)([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] === '#') out.id = m[2];
    else if (m[1] === '.') out.cls.push(m[2]);
    else out.tag = m[2].toLowerCase();
  }
  return out;
}
function matchSimple(el, p) {
  if (el.tagName.startsWith('#')) return false;
  if (p.tag && el.tagName !== p.tag) return false;
  if (p.id && el.id !== p.id) return false;
  for (const c of p.cls) if (!el.classList.contains(c)) return false;
  return true;
}
function matches(el, sel) {
  return String(sel).split(',').some((one) => {
    const parts = one.trim().split(/\s+/).filter(Boolean).map(parseSimple);
    if (!parts.length) return false;
    let k = parts.length - 1;
    if (!matchSimple(el, parts[k])) return false;
    k--;
    let node = el.parentNode;
    while (k >= 0 && node) { if (matchSimple(node, parts[k])) k--; node = node.parentNode; }
    return k < 0;
  });
}

/* ---------------- Element ---------------- */

let uid = 0;

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this._text = '';
    this._listeners = {};
    this._uid = ++uid;
    this._line = 0;
    this._indent = 0;
    const self = this;
    this.classList = {
      contains: (c) => String(self.className).split(/\s+/).includes(c),
      add: (...cs) => { const s = String(self.className).split(/\s+/).filter(Boolean); for (const c of cs) if (c && !s.includes(c)) s.push(c); self.className = s.join(' '); },
      remove: (...cs) => { self.className = String(self.className).split(/\s+/).filter((x) => x && !cs.includes(x)).join(' '); },
      toggle: (c, on) => { const has = self.classList.contains(c); const want = on === undefined ? !has : Boolean(on); if (want) self.classList.add(c); else self.classList.remove(c); return want; },
      toString: () => String(self.className),
    };
  }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }
  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = String(v); }
  get children() { return this.childNodes.filter((n) => !n.tagName.startsWith('#')); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] || null) : null; }
  get parentElement() { return this.parentNode && !this.parentNode.tagName.startsWith('#') ? this.parentNode : null; }

  setAttribute(k, v) {
    k = k.toLowerCase();
    this.attributes[k] = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    if (k === 'value') this._value = String(v);
    if (k === 'checked') this.checked = true;
    if (k === 'hidden') this.hidden = true;
  }
  getAttribute(k) { const v = this.attributes[String(k).toLowerCase()]; return v === undefined ? null : v; }
  removeAttribute(k) { delete this.attributes[String(k).toLowerCase()]; }
  hasAttribute(k) { return String(k).toLowerCase() in this.attributes; }
  matches(sel) { return matches(this, sel); }
  closest(sel) { let n = this; while (n && !n.tagName.startsWith('#')) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }

  /* 本物と同じく value は常に文字列（ここを手抜きすると .trim() で偽陽性が出る） */
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'select') { const o = this.children.find((c) => c.tagName === 'option'); return o ? (o.getAttribute('value') ?? o.textContent) : ''; }
    return '';
  }
  set value(v) { this._value = v === null || v === undefined ? '' : String(v); }

  get textContent() { return this.tagName === '#text' ? this._text : this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; this._text = ''; if (v !== '' && v !== null && v !== undefined) addText(this, String(v)); }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this._html !== undefined ? this._html : this.textContent; }
  set innerHTML(v) {
    this._html = String(v);
    this.childNodes = [];
    const { root } = parseHTML(String(v));
    for (const c of [...root.childNodes]) this.appendChild(c);
  }

  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === 'string' ? textNode(n) : n); }
  prepend(...ns) { for (const n of [...ns].reverse()) { const x = typeof n === 'string' ? textNode(n) : n; if (x.parentNode) x.parentNode.removeChild(x); x.parentNode = this; this.childNodes.unshift(x); } }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    n.parentNode = this;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...ns) { this.childNodes = []; this.append(...ns); }

  _walk(out) { for (const c of this.childNodes) { if (!c.tagName.startsWith('#')) out.push(c); c._walk(out); } return out; }
  querySelectorAll(sel) { return this._walk([]).filter((e) => matches(e, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { const a = this._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  dispatchEvent(ev) {
    const e = Object.assign({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }, ev);
    const on = this['on' + e.type];
    if (typeof on === 'function') on.call(this, e);
    for (const fn of [...(this._listeners[e.type] || [])]) fn.call(this, e);
    return true;
  }
  focus() {} blur() {} select() {} scrollIntoView() {}
  click() { return this.dispatchEvent({ type: 'click' }); }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  getContext() { return canvas2d(this); }
  add(opt) { this.appendChild(opt); }          // select.add()
  cloneNode() { const c = new Element(this.tagName); Object.assign(c.attributes, this.attributes); return c; }
  get scrollTop() { return this._st || 0; } set scrollTop(v) { this._st = v; }
  get scrollHeight() { return 0; }
  get offsetHeight() { return 0; } get clientHeight() { return 0; }
}

/* canvas の 2D コンテキスト。fillStyle / strokeStyle だけは記録する */
function canvas2d(el) {
  const state = { canvas: el, fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '' };
  el._paints = el._paints || [];
  const noop = () => {};
  return new Proxy(state, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: (t, k, v) => { t[k] = v; if (k === 'fillStyle' || k === 'strokeStyle') el._paints.push(String(v)); return true; },
  });
}

module.exports = { parseHTML, Element, matches, textNode, VOID };
