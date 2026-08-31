'use strict';
// HTML を「木」として読む。文字位置ではなく木を扱うための土台。
// 依存ゼロ。node --test / CLI の両方から使う。
//
// 目的は完全な HTML5 パーサではなく、この製品の app.html / overlay.html を
// 取り違えなく読み、要素の開始〜終了の文字範囲（自分の閉じタグを含む）を
// 正確に持つこと。「文字位置で切り出す」作業を、この範囲に置き換える。

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

function parseAttrs(s) {
  const at = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) at[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return at;
}

// 位置 -> 行番号（1始まり）
function lineAt(src, pos) {
  let n = 1;
  for (let i = 0; i < pos && i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

// その行の字下げ（行頭からタグ開始までが空白だけなら、その空白数。違えば -1）
function indentAt(src, pos) {
  let i = pos - 1, n = 0;
  while (i >= 0 && src[i] !== '\n') {
    if (src[i] === ' ') n++;
    else if (src[i] === '\t') n += 4;
    else return -1;
    i--;
  }
  return n;
}

function parse(src, name = '<html>') {
  const root = { type: 'root', tag: '#root', attrs: {}, children: [], parent: null, start: 0, end: src.length };
  const stack = [root];
  const errors = [];
  let i = 0;

  const push = (node) => { node.parent = stack[stack.length - 1]; node.parent.children.push(node); };

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { if (i < src.length) push({ type: 'text', tag: '#text', attrs: {}, children: [], start: i, end: src.length, text: src.slice(i) }); break; }
    if (lt > i) push({ type: 'text', tag: '#text', attrs: {}, children: [], start: i, end: lt, text: src.slice(i, lt) });

    if (src.startsWith('<!--', lt)) {
      let e = src.indexOf('-->', lt + 4);
      e = e < 0 ? src.length : e + 3;
      push({ type: 'comment', tag: '#comment', attrs: {}, children: [], start: lt, end: e, text: src.slice(lt, e) });
      i = e; continue;
    }
    if (src.startsWith('<!', lt)) {
      let e = src.indexOf('>', lt);
      e = e < 0 ? src.length : e + 1;
      push({ type: 'doctype', tag: '#doctype', attrs: {}, children: [], start: lt, end: e, text: src.slice(lt, e) });
      i = e; continue;
    }
    if (src.startsWith('</', lt)) {
      const gt = src.indexOf('>', lt);
      const e = gt < 0 ? src.length : gt + 1;
      const tag = src.slice(lt + 2, gt < 0 ? src.length : gt).trim().toLowerCase();
      const top = stack[stack.length - 1];
      if (top.tag === tag && stack.length > 1) {
        top.end = e; top.closeStart = lt; stack.pop();
      } else {
        // 相手のいない閉じタグ。祖先に相手がいれば、その間を閉じ忘れとして報告。
        const at = stack.map((n) => n.tag).lastIndexOf(tag);
        if (at > 0) {
          for (let k = stack.length - 1; k > at; k--) {
            errors.push({ kind: 'unclosed', tag: stack[k].tag, line: lineAt(src, stack[k].start), file: name });
          }
          stack.length = at + 1;
          const t2 = stack.pop(); t2.end = e; t2.closeStart = lt;
        } else {
          errors.push({ kind: 'stray-close', tag, line: lineAt(src, lt), file: name });
        }
      }
      i = e; continue;
    }
    // 開始タグ
    const m = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(lt));
    if (!m) { push({ type: 'text', tag: '#text', attrs: {}, children: [], start: lt, end: lt + 1, text: '<' }); i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    // 属性値の中の '>' を避けつつ終端を探す
    let j = lt + m[0].length, q = null, gt = -1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '>') { gt = j; break; }
    }
    if (gt < 0) gt = src.length - 1;
    const attrSrc = src.slice(lt + m[0].length, gt);
    const selfClose = /\/\s*$/.test(attrSrc);
    const node = {
      type: 'element', tag, attrs: parseAttrs(attrSrc), children: [], parent: null,
      start: lt, openEnd: gt + 1, end: gt + 1, closeStart: null,
      line: lineAt(src, lt), indent: indentAt(src, lt),
    };
    push(node);
    i = gt + 1;
    if (VOID.has(tag) || selfClose) continue;
    if (RAW.has(tag)) {
      const close = src.toLowerCase().indexOf('</' + tag, i);
      const cs = close < 0 ? src.length : close;
      if (cs > i) node.children.push({ type: 'text', tag: '#text', attrs: {}, children: [], parent: node, start: i, end: cs, text: src.slice(i, cs) });
      const gt2 = close < 0 ? src.length : (src.indexOf('>', close) + 1 || src.length);
      node.closeStart = close < 0 ? null : close;
      node.end = gt2;
      if (close < 0) errors.push({ kind: 'unclosed', tag, line: node.line, file: name });
      i = gt2; continue;
    }
    stack.push(node);
  }
  for (let k = stack.length - 1; k > 0; k--) errors.push({ kind: 'unclosed', tag: stack[k].tag, line: lineAt(src, stack[k].start), file: name });
  root.src = src; root.file = name; root.errors = errors;
  return root;
}

function* walk(node) {
  for (const c of node.children) { yield c; yield* walk(c); }
}
const elements = (root) => [...walk(root)].filter((n) => n.type === 'element');
const cls = (n) => (n.attrs.class || '').trim().split(/\s+/).filter(Boolean);

// 要素の見た目の名札。並び順に依存しないので、兄弟の入れ替えでは変わらない。
function label(n) {
  if (n.type !== 'element') return n.tag;
  let s = n.tag;
  if (n.attrs.id) s += '#' + n.attrs.id;
  const c = cls(n);
  if (c.length) s += '.' + c.join('.');
  return s;
}
const ancestors = (n) => { const a = []; for (let p = n.parent; p && p.type === 'element'; p = p.parent) a.push(p); return a.reverse(); };
const chain = (n) => ancestors(n).map(label).join(' > ');

// 木のうち、この範囲の元テキスト
const text = (root, n) => root.src.slice(n.start, n.end);

module.exports = { parse, walk, elements, cls, label, ancestors, chain, text, lineAt, VOID, RAW };
