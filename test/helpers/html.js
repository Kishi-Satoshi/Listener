'use strict';
// 依存ゼロの最小 HTML パーサ。木の「形」を検査するために使う。
// 正規表現でソースの文字列を見るのではなく、親子関係を見られるようにするのが目的。

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const RAW = new Set(['script','style']);

function lineAt(src, i) { let n = 1; for (let k = 0; k < i; k++) if (src[k] === '\n') n++; return n; }

function parseAttrs(s) {
  const a = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`=]+)))?/g;
  let m;
  while ((m = re.exec(s))) a[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return a;
}

// 返り値: { root, nodes, errors }
// node = { tag, attrs, parent, children, line, col, text? }
function parse(src) {
  const root = { tag: '#root', attrs: {}, parent: null, children: [], line: 1, col: 0 };
  const nodes = [];
  const errors = [];
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    const close = src.startsWith('</', lt);
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const inner = src.slice(lt + (close ? 2 : 1), gt);
    const tag = (inner.match(/^[a-zA-Z][-a-zA-Z0-9]*/) || [''])[0].toLowerCase();
    if (!tag) { i = gt + 1; continue; }
    if (close) {
      let k = stack.length - 1;
      while (k > 0 && stack[k].tag !== tag) k--;
      if (k === 0) errors.push(`${lineAt(src, lt)}行: 対応する開きタグの無い </${tag}>`);
      else {
        for (let j = stack.length - 1; j > k; j--) errors.push(`${stack[j].line}行: <${stack[j].tag}> が閉じられていない（${lineAt(src, lt)}行の </${tag}> で強制的に閉じた）`);
        stack.length = k;
      }
      i = gt + 1; continue;
    }
    const selfClose = src[gt - 1] === '/';
    const attrs = parseAttrs(inner.slice(tag.length));
    // 行頭からの字下げ（その行でタグより前が空白だけのときのみ意味を持つ）
    const bol = src.lastIndexOf('\n', lt - 1) + 1;
    const before = src.slice(bol, lt);
    const node = {
      tag, attrs, parent: stack[stack.length - 1], children: [],
      line: lineAt(src, lt), col: /^\s*$/.test(before) ? before.length : -1,
    };
    node.parent.children.push(node);
    nodes.push(node);
    if (RAW.has(tag) && !selfClose) {
      const end = src.toLowerCase().indexOf(`</${tag}`, gt);
      node.text = src.slice(gt + 1, end < 0 ? src.length : end);
      node.textLine = node.line;
      i = end < 0 ? src.length : src.indexOf('>', end) + 1;
      continue;
    }
    if (!selfClose && !VOID.has(tag)) stack.push(node);
    i = gt + 1;
  }
  for (let j = stack.length - 1; j > 0; j--) errors.push(`${stack[j].line}行: <${stack[j].tag}> が閉じられていない（ファイル末尾まで）`);
  return { root, nodes, errors };
}

const classesOf = (n) => (n.attrs.class || '').split(/\s+/).filter(Boolean);
const has = (n, c) => classesOf(n).includes(c);
function ancestors(n) { const a = []; for (let p = n.parent; p && p.tag !== '#root'; p = p.parent) a.push(p); return a; }
function within(n, pred) { return ancestors(n).some(pred); }
function path(n) { return [...ancestors(n)].reverse().concat([n]).map((x) => x.tag + (x.attrs.id ? '#' + x.attrs.id : '') + classesOf(x).map((c) => '.' + c).join('')).join(' > '); }

module.exports = { parse, classesOf, has, ancestors, within, path, VOID };
