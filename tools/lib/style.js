'use strict';
// CSS を「規則の並び」として読む。コメントは行番号を保ったまま空白にするので、
// コメントの中の語に検査が当たることは原理的に起きない。
function strip(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}
// [{sel, decls:{prop:value}, at:'@keyframes pulse'|null, line}]
function rules(css) {
  const s = strip(css);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  // @ブロックの範囲を先に押さえる
  const ats = [];
  const reAt = /@[a-z-]+[^{]*\{/gi;
  let a;
  while ((a = reAt.exec(s))) {
    let d = 1, i = reAt.lastIndex;
    for (; i < s.length && d > 0; i++) { if (s[i] === '{') d++; else if (s[i] === '}') d--; }
    ats.push({ name: s.slice(a.index, reAt.lastIndex - 1).trim(), from: a.index, to: i });
  }
  let m;
  while ((m = re.exec(s))) {
    const sel = m[1].trim();
    if (sel.startsWith('@') || !sel) continue;
    const decls = {};
    for (const d of m[2].split(';')) {
      const k = d.indexOf(':');
      if (k < 0) continue;
      decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim();
    }
    const at = ats.find((x) => m.index > x.from && m.index < x.to);
    out.push({ sel, decls, at: at ? at.name : null, line: s.slice(0, m.index).split('\n').length });
  }
  return out;
}
const styleOf = (html) => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

// 色 -> {r,g,b,a} / 相対輝度 / 地に合成
function color(s) {
  s = String(s).trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length >= 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    let al = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a: al };
  }
  const named = { white: [255, 255, 255], black: [0, 0, 0], transparent: null };
  if (s.toLowerCase() in named) { const v = named[s.toLowerCase()]; return v ? { r: v[0], g: v[1], b: v[2], a: 1 } : null; }
  return null;
}
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const colorsIn = (v) => [...String(v).matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]).map(color).filter(Boolean);

module.exports = { strip, rules, styleOf, color, lum, over, colorsIn };
