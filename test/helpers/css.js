'use strict';
// 依存ゼロの最小 CSS パーサと色の計算。
// 「文字列が一致するか」ではなく「色の関係が正しいか」を検査するために使う。

// コメントは行番号を保ったまま空白に置換する（コメント中の語に一致して素通りするのを防ぐ）
function strip(css) { return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')); }

// 返り値: [{ selectors:[], decls:{prop:value}, at:'' , line }]
function parse(css) {
  const src = strip(css);
  const rules = [];
  const stack = [];
  let i = 0, buf = '', line = 1, bufLine = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') line++;
    if (c === '{') {
      const head = buf.trim();
      if (head.startsWith('@') && /^@(media|supports|keyframes|-webkit-keyframes|layer)/.test(head)) {
        stack.push(head); buf = ''; bufLine = line; i++; continue;
      }
      // 宣言ブロック
      let d = i + 1, depth = 1;
      while (d < src.length && depth) { if (src[d] === '{') depth++; else if (src[d] === '}') depth--; if (depth) d++; }
      const body = src.slice(i + 1, d);
      const decls = {};
      for (const part of body.split(';')) {
        const k = part.indexOf(':');
        if (k < 0) continue;
        const p = part.slice(0, k).trim(); const v = part.slice(k + 1).trim();
        if (p && !p.includes('{')) decls[p] = v;
      }
      rules.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), decls, at: stack.join(' '), line: bufLine, body });
      for (const ch of src.slice(i, d)) if (ch === '\n') line++;
      i = d + 1; buf = ''; bufLine = line; continue;
    }
    if (c === '}') { stack.pop(); buf = ''; bufLine = line; i++; continue; }
    if (buf === '' && /\S/.test(c)) bufLine = line;
    buf += c; i++;
  }
  return rules;
}

// ---- 色 ----
function color(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = (k) => parseInt(h.slice(k, k + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)/i);
  if (m) {
    let a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  const named = { white: '#ffffff', black: '#000000', transparent: '#00000000' };
  if (named[s.toLowerCase()]) return color(named[s.toLowerCase()]);
  return null;
}
// 値の中に現れる全ての色リテラル
function colorsIn(v) {
  const out = [];
  for (const m of String(v || '').matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) { const c = color(m[0]); if (c) out.push({ raw: m[0], ...c }); }
  return out;
}
const chan = (x) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
// 半透明の色を地に合成する
function over(fg, bg) { const a = fg.a === undefined ? 1 : fg.a; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }; }
function contrast(fg, bg) { const l1 = lum(over(fg, bg)), l2 = lum(bg); const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1]; return (a + 0.05) / (b + 0.05); }

module.exports = { parse, strip, color, colorsIn, lum, over, contrast };
