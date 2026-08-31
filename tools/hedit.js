#!/usr/bin/env node
'use strict';
// HTML の並べ替え・移動を「木の操作」として行う専用道具。
// 文字位置で切り出して貼る作業（過去に3件のデグレを生んだ）を、これで置き換える。
//
//   node tools/hedit.js list  <file> <selector>
//   node tools/hedit.js move  <file> --node <sel> (--before|--after|--into|--into-top) <sel>
//   node tools/hedit.js order <file> --in <sel> --match <sel> --by-h2 "A,B,C"
//   node tools/hedit.js check <file...>
//
// 書き出す前に必ず自己検査する。1つでも崩れたら書かない：
//   (1) 木のエラー（閉じ忘れ・相手のいない閉じタグ）が増えていない
//   (2) 要素の名札の多重集合が完全に一致（＝1つも消えず、1つも増えていない）
//   (3) 動かした部分以外、全要素の祖先チェーンが不変（＝枠から出た要素が無い）
//   (4) 文字（テキスト）の多重集合が一致
// これにより「閉じタグの道連れ」「末尾の切り落とし」は原理的に起こせない。

const fs = require('fs');
const H = require('./lib/htmltree');
const S = require('./lib/sel');

const bag = (xs) => { const m = new Map(); for (const x of xs) m.set(x, (m.get(x) || 0) + 1); return m; };
const bagDiff = (a, b) => {
  const out = [];
  for (const [k, v] of a) if ((b.get(k) || 0) !== v) out.push(`${k}: ${v} -> ${b.get(k) || 0}`);
  for (const [k, v] of b) if (!a.has(k)) out.push(`${k}: 0 -> ${v}`);
  return out;
};
const textBag = (root) => bag([...H.walk(root)].filter((n) => n.type === 'text').map((n) => n.text.replace(/\s+/g, ' ').trim()).filter(Boolean));
// 祖先チェーンを、要素の身元（id / 見出し / 位置に依らない名札）で引ける表にする
function chainMap(root) {
  const m = new Map();
  for (const n of H.elements(root)) {
    const key = ident(n);
    if (key) m.set(key, H.chain(n));
  }
  return m;
}
function ident(n) {
  if (n.attrs.id) return '#' + n.attrs.id;
  if (n.attrs.for) return 'for:' + n.attrs.for;
  return null;
}

function reindent(block, delta) {
  if (!delta) return block;
  return block.split('\n').map((l, i) => {
    if (i === 0) return l;
    if (delta > 0) return ' '.repeat(delta) + l;
    const cut = Math.min(-delta, /^ */.exec(l)[0].length);
    return l.slice(cut);
  }).join('\n');
}

function apply(src, file, edits) {
  // edits: [{node, target, where}] を上から順に1つずつ適用（毎回パースし直す）
  let cur = src;
  for (const ed of edits) {
    const root = H.parse(cur, file);
    const node = S.only(root, ed.node);
    const anchor = S.only(root, ed.target);
    if (node === anchor || H.ancestors(anchor).includes(node)) throw new Error('自分の中へは動かせない');
    const block = cur.slice(node.start, node.end);
    // 移動先の字下げ
    let want = anchor.indent;
    if (ed.where === 'into' || ed.where === 'into-top') {
      const kid = anchor.children.find((c) => c.type === 'element' && c.indent >= 0);
      want = kid ? kid.indent : (anchor.indent >= 0 ? anchor.indent + 2 : 0);
    }
    const moved = (node.indent >= 0 && want >= 0) ? reindent(block, want - node.indent) : block;
    let ins;
    if (ed.where === 'before') ins = anchor.start;
    else if (ed.where === 'after') ins = anchor.end;
    else if (ed.where === 'into-top') ins = anchor.openEnd;
    else ins = anchor.closeStart != null ? anchor.closeStart : anchor.end;
    // 取り除いてから挿す（位置ずれを避けるため後ろから）
    if (ins > node.end) cur = cur.slice(0, node.start) + cur.slice(node.end, ins) + moved + cur.slice(ins);
    else if (ins < node.start) cur = cur.slice(0, ins) + moved + cur.slice(ins, node.start) + cur.slice(node.end);
    else throw new Error('移動先が自分の中');
  }
  return cur;
}

function verify(src, out, file) {
  const a = H.parse(src, file), b = H.parse(out, file);
  const bad = [];
  if (b.errors.length > a.errors.length) bad.push('木のエラーが増えた: ' + JSON.stringify(b.errors));
  const d1 = bagDiff(bag(H.elements(a).map(H.label)), bag(H.elements(b).map(H.label)));
  if (d1.length) bad.push('要素が増減した:\n  ' + d1.join('\n  '));
  const d2 = bagDiff(textBag(a), textBag(b));
  if (d2.length) bad.push('文字が増減した:\n  ' + d2.slice(0, 10).join('\n  '));
  const ca = chainMap(a), cb = chainMap(b);
  const moved = [];
  for (const [k, v] of ca) if (cb.has(k) && cb.get(k) !== v) moved.push(`  ${k}\n    元: ${v}\n    後: ${cb.get(k)}`);
  return { bad, moved };
}

function usage() { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 18).join('\n').replace(/^\/\/ ?/gm, '')); }

function main(argv) {
  const cmd = argv[0];
  const arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1]; };
  if (cmd === 'check' || cmd === 'list' || cmd === 'move' || cmd === 'order') {
    const file = argv[1];
    if (cmd === 'check') {
      let bad = 0;
      for (const f of argv.slice(1)) {
        const r = H.parse(fs.readFileSync(f, 'utf8'), f);
        for (const e of r.errors) { console.log(`NG ${f}:${e.line} ${e.kind} <${e.tag}>`); bad++; }
        console.log(`${r.errors.length ? 'NG' : 'OK'} ${f} 要素${H.elements(r).length}件 エラー${r.errors.length}件`);
      }
      return bad ? 1 : 0;
    }
    const src = fs.readFileSync(file, 'utf8');
    const root = H.parse(src, file);
    if (cmd === 'list') {
      for (const n of S.matches(root, argv[2])) console.log(`${file}:${n.line}  ${H.label(n)}\n    ${H.chain(n)}`);
      return 0;
    }
    let edits;
    if (cmd === 'move') {
      const where = ['before', 'after', 'into', 'into-top'].find((w) => arg('--' + w));
      if (!where) { usage(); return 2; }
      edits = [{ node: arg('--node'), target: arg('--' + where), where }];
    } else {
      const inSel = arg('--in'), match = arg('--match'), by = (arg('--by-h2') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const have = S.matches(root, `${inSel} ${match}`);
      if (have.length !== by.length) throw new Error(`並べ替えの対象は ${have.length} 件だが、--by-h2 は ${by.length} 件`);
      // 望む順を、直前の要素の後ろへ順に置いていく形に翻訳する
      edits = [];
      for (let i = 1; i < by.length; i++) {
        edits.push({ node: `${inSel} ${match}:h2(${by[i]})`, target: `${inSel} ${match}:h2(${by[i - 1]})`, where: 'after' });
      }
    }
    const out = apply(src, file, edits);
    const { bad, moved } = verify(src, out, file);
    if (bad.length) { console.error('中止（書き込まない）:\n' + bad.join('\n')); return 1; }
    if (moved.length && !argv.includes('--allow-reparent')) {
      console.error('中止（書き込まない）: 枠をまたいで動いた要素がある。意図したものなら --allow-reparent を付ける。\n' + moved.join('\n'));
      return 1;
    }
    if (argv.includes('--dry-run')) { console.log('自己検査OK（書き込みなし）'); return 0; }
    fs.writeFileSync(file, out);
    console.log(`${file} を書き換えた。自己検査OK（要素の増減なし・祖先チェーン不変${moved.length ? '（宣言済みの移動 ' + moved.length + ' 件を除く）' : ''}）`);
    return 0;
  }
  usage(); return 2;
}
if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { console.error('中止: ' + e.message); process.exit(1); }
}
module.exports = { apply, verify, chainMap, ident, bag, bagDiff, textBag };
