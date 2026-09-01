'use strict';
// PowerShell を字句だけ追って、括弧の対応と引用符の閉じ忘れを見る。
// 実行はしない（構文の全部は見ない）。閉じ忘れという一番多い壊れ方だけを止める。
function scanPs1(src) {
  const s = String(src).replace(/^﻿/, '');
  const viol = [];
  const stack = [];
  const pair = { '}': '{', ')': '(', ']': '[' };
  let line = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') { line++; continue; }
    if (c === '`') { i++; if (s[i] === '\n') line++; continue; }   // バッククォートは次の1文字を打ち消す
    if (c === '#' && !(s[i - 1] === '$' || s[i - 1] === '{')) {     // 行コメント
      while (i < s.length && s[i] !== '\n') i++;
      line++; continue;
    }
    if (c === '<' && s[i + 1] === '#') {                            // ブロックコメント
      const end = s.indexOf('#>', i + 2);
      if (end < 0) { viol.push(`${line}行: <# が閉じていない`); break; }
      for (let k = i; k < end; k++) if (s[k] === '\n') line++;
      i = end + 1; continue;
    }
    if (c === "'" || c === '"') {                                   // 文字列
      const q = c; const open = line;
      i++;
      for (; i < s.length; i++) {
        if (s[i] === '\n') line++;
        else if (q === '"' && s[i] === '`') { i++; continue; }       // "..." 内は ` が打ち消し
        else if (s[i] === q) {
          if (s[i + 1] === q) { i++; continue; }                     // '' / "" は文字そのもの
          break;
        }
      }
      if (i >= s.length) viol.push(`${open}行: ${q} が閉じていない`);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') { stack.push({ c, line }); continue; }
    if (c === '}' || c === ')' || c === ']') {
      const top = stack.pop();
      if (!top) { viol.push(`${line}行: 対応する ${pair[c]} が無い ${c}`); continue; }
      if (top.c !== pair[c]) viol.push(`${line}行: ${top.line}行の ${top.c} に対して ${c} が来ている`);
    }
  }
  for (const t of stack) viol.push(`${t.line}行: ${t.c} が閉じていない`);
  return viol;
}
module.exports = { scanPs1 };
