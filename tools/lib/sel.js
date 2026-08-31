'use strict';
// ごく小さなセレクタ。#id / tag / .class / 子孫（空白）/ 直下（>）/ :h2(見出し文字列)
const H = require('./htmltree');

function parseSel(s) {
  return s.trim().split(/\s+(?![^(]*\))/).map((tok) => {
    if (tok === '>') return { comb: true };
    const m = { tag: null, id: null, cls: [], h2: null };
    const h = /:h2\(([^)]*)\)/.exec(tok);
    if (h) { m.h2 = h[1]; tok = tok.replace(h[0], ''); }
    const t = /^[a-zA-Z][\w:-]*/.exec(tok);
    if (t) m.tag = t[0].toLowerCase();
    const id = /#([\w:-]+)/.exec(tok); if (id) m.id = id[1];
    for (const c of tok.matchAll(/\.([\w-]+)/g)) m.cls.push(c[1]);
    return m;
  });
}
function one(n, m) {
  if (n.type !== 'element') return false;
  if (m.tag && n.tag !== m.tag) return false;
  if (m.id && n.attrs.id !== m.id) return false;
  const c = H.cls(n);
  for (const x of m.cls) if (!c.includes(x)) return false;
  if (m.h2 != null) {
    const h = n.children.find((k) => k.type === 'element' && k.tag === 'h2');
    if (!h) return false;
    const txt = [...H.walk(h)].filter((k) => k.type === 'text').map((k) => k.text).join('').trim();
    if (!txt.startsWith(m.h2)) return false;
  }
  return true;
}
function matches(root, sel) {
  const parts = parseSel(sel);
  let cur = [root];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.comb) { const q = parts[++i]; cur = cur.flatMap((n) => n.children.filter((c) => one(c, q))); continue; }
    cur = cur.flatMap((n) => [...H.walk(n)].filter((c) => one(c, p)));
  }
  return [...new Set(cur)];
}
function only(root, sel) {
  const r = matches(root, sel);
  if (r.length !== 1) throw new Error(`セレクタ ${sel} が ${r.length} 件に一致（1件でなければ動かせない）`);
  return r[0];
}
module.exports = { matches, only };
