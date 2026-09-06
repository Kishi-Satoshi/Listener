/*
 * simcss.js — <style> の中身を「文字列」ではなく「規則」として読む小さな道具。
 * コメントを潰してから読むので、コメント中の語に一致して素通りすることが構造的に無い。
 */
'use strict';

/** css → [{ at, sel, decls }] （@media は中身を展開、@keyframes は at 名を付けて返す） */
function parse(css, at = '') {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let d = 1, j = open + 1;
    while (j < src.length && d > 0) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@')) {
      const inner = parse(body, head);
      if (inner.length) out.push(...inner);
      else out.push({ at: at ? `${at} ${head}` : head, sel: head, decls: decls(body) });
    } else if (body.includes('{')) {
      // 規則の中に規則がネストされている（CSS ネスト）。ブラウザは内側を
      // 「親 子」の複合セレクタとして効かせるので、読み飛ばさずに独立した
      // 規則として返す（nested に親を記す）。@media の外にネストされた
      // ダーク専用色がライトにも当たった事故を、対比計算で捕まえるため。
      let k = 0, own = '';
      const at0 = out.length;   // 親の規則は内側より前（出現順）に置く
      while (k < body.length) {
        const o = body.indexOf('{', k);
        if (o < 0) { own += body.slice(k); break; }
        const pre = body.slice(k, o);
        const semi = pre.lastIndexOf(';');
        own += pre.slice(0, semi + 1);
        const inner = pre.slice(semi + 1).trim();
        let d2 = 1, j2 = o + 1;
        while (j2 < body.length && d2 > 0) { if (body[j2] === '{') d2++; else if (body[j2] === '}') d2--; j2++; }
        out.push({ at, sel: inner, nested: head, decls: decls(body.slice(o + 1, j2 - 1)) });
        k = j2;
      }
      out.splice(at0, 0, { at, sel: head, decls: decls(own) });
    } else {
      out.push({ at, sel: head, decls: decls(body) });
    }
    i = j;
  }
  return out;
}

function decls(body) {
  const o = {};
  let depth = 0, buf = '';
  const push = (t) => { const k = t.indexOf(':'); if (k > 0) o[t.slice(0, k).trim().toLowerCase()] = t.slice(k + 1).trim(); };
  for (const c of body) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ';' && depth === 0) { push(buf); buf = ''; } else buf += c;
  }
  push(buf);
  return o;
}

/** 規則の集合から、あるセレクタに書かれた宣言を集める（後勝ち） */
function declsFor(rules, sel, opt = {}) {
  const o = {};
  for (const r of rules) {
    if (opt.at !== undefined && r.at !== opt.at) continue;
    if (r.sel.split(',').map((s) => s.trim()).includes(sel)) Object.assign(o, r.decls);
  }
  return o;
}

/* ---------------- 色 ---------------- */

const NAMED = { white: [255,255,255,1], black: [0,0,0,1], transparent: [0,0,0,0] };

/** '#rgb' '#rrggbb' 'rgb(...)' 'rgba(...)' → [r,g,b,a] / 色でなければ null */
function parseColor(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (NAMED[s]) return NAMED[s].slice();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    const ex = (x) => parseInt(x.length === 1 ? x + x : x, 16);
    if (h.length === 3 || h.length === 4) return [ex(h[0]), ex(h[1]), ex(h[2]), h.length === 4 ? ex(h[3]) / 255 : 1];
    if (h.length === 6 || h.length === 8) return [ex(h.slice(0,2)), ex(h.slice(2,4)), ex(h.slice(4,6)), h.length === 8 ? ex(h.slice(6,8)) / 255 : 1];
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
    return [p[0], p[1], p[2], p.length > 3 && !Number.isNaN(p[3]) ? p[3] : 1];
  }
  return null;
}

/** 宣言の値から最初の色を取り出す（background: #262626 / 1px solid rgba(...) など） */
function firstColor(v) {
  if (!v) return null;
  const m = String(v).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b|\btransparent\b/);
  return m ? parseColor(m[0]) : null;
}

function over(fg, bg) {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}
function luminance(c) {
  const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

module.exports = { parse, decls, declsFor, parseColor, firstColor, over, luminance, contrast };
