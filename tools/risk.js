#!/usr/bin/env node
'use strict';
// 変更の危険度ゲート。コミット前／リリース前に、変更を「前の版」と突き合わせて
// 危険な変更を機械的に止め、実機確認が要る変更には手順を強制する。
//
//   node tools/risk.js                      … HEAD と作業ツリーを比べる
//   node tools/risk.js --base A --head B     … 任意の2版を比べる（過去の検証用）
//   node tools/risk.js --checklist out.md    … 実機確認チェックリストを書き出す
//   node tools/risk.js --base-tag ...        … 直近のタグを基準にする（リリース時）
//
// 設計の柱は「新しく壊れたものだけを見る」こと。前の版で既に違反しているものは
// 報告しない。これで、既存の動的生成や設計上の例外に対する誤検知が構造的に出ない。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const H = require('./lib/htmltree');
const St = require('./lib/style');
const MINES = require('./lib/mines');

const ROOT = path.resolve(__dirname, '..');
const git = (a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 64 << 20 }).toString();
// rev: null=作業ツリー / 'INDEX'=コミット予定の内容 / それ以外=git の版
const at = (rev, f) => {
  try {
    if (rev === null) return fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (rev === 'INDEX') return git(['show', `:${f}`]);
    return git(['show', `${rev}:${f}`]);
  } catch { return null; }
};

let F = [];
const add = (level, rule, file, msg, how) => F.push({ level, rule, file, msg, how });

// ---------- HTML: 木の健全さ / 要素の消失 / 枠からの離脱 / 参照の破れ ----------
const idsOf = (root) => new Map(H.elements(root).filter((n) => n.attrs.id).map((n) => [n.attrs.id, n]));
// script が静的に名指ししている id
function refIds(html) {
  const s = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const out = new Set();
  for (const m of s.matchAll(/\$\(\s*'([^']+)'\s*\)|getElementById\(\s*'([^']+)'\s*\)|querySelector\(\s*'#([\w-]+)'\s*\)/g)) out.add(m[1] || m[2] || m[3]);
  return out;
}
// 「枠」＝身元のある祖先（id か class を持つ要素）。無名の <div> は枠と見なさない。
// 枠から出たかどうかだけを見るので、兄弟の入れ替えや、包み直し（祖先が増える）では鳴らない。
const framesOf = (n) => H.ancestors(n).filter((a) => a.attrs.id || H.cls(a).length);
function lostFrames(bn, hn) {
  const ha = H.ancestors(hn);
  const out = [];
  for (const a of framesOf(bn)) {
    const same = ha.some((x) => a.attrs.id
      ? x.attrs.id === a.attrs.id
      : (x.tag === a.tag && H.cls(a).some((c) => H.cls(x).includes(c))));
    if (!same) out.push(H.label(a));
  }
  return out;
}

function checkHtml(file, before, after) {
  const b = before == null ? null : H.parse(before, file);
  const a = H.parse(after, file);
  const bErr = b ? b.errors.length : 0;
  if (a.errors.length > bErr) {
    for (const e of a.errors.slice(0, 8)) add('BLOCK', 'HTML-木の破損', file, `${e.kind === 'unclosed' ? '閉じ忘れ' : '相手のいない閉じタグ'} <${e.tag}> ${file}:${e.line}`, 'tools/hedit.js check で確認し、木として正しい形に直す');
    return;
  }
  if (!b) return;
  const bi = idsOf(b), ai = idsOf(a);
  const bref = refIds(before), aref = refIds(after);

  // (1) 要素の消失（v0.10.3 / v0.10.4 の型）
  for (const [id, n] of bi) {
    if (ai.has(id)) continue;
    const used = aref.has(id);
    add(used ? 'BLOCK' : 'WARN', 'HTML-要素の消失', file,
      `id="${id}"（${H.label(n)}、元 ${file}:${n.line}）が消えた${used ? '。画面のスクリプトはまだこの id を参照している → 初期化が例外で止まり、以降の結線が全て死ぬ' : ''}`,
      used ? '消すなら参照側も同時に消す。並べ替えの巻き添えなら tools/hedit.js order をやり直す' : '意図的なら、参照側も消えていることを確かめる');
  }
  // (2) 枠からの離脱（v0.10.2 の型）。祖先が「増えた」のは包み直しなので見ない。
  const groups = new Map();
  for (const [id, n] of bi) {
    const m = ai.get(id); if (!m) continue;
    const lost = lostFrames(n, m);
    if (!lost.length) continue;
    const key = lost.join(' / ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, n, m });
  }
  for (const [lost, xs] of groups) {
    const s0 = xs[0];
    add('BLOCK', 'HTML-枠からの離脱', file,
      `${lost} の外へ出た要素が ${xs.length} 件（${xs.slice(0, 6).map((x) => '#' + x.id).join(', ')}${xs.length > 6 ? ' ほか' : ''}）\n      例 id="${s0.id}" ${file}:${s0.m.line}\n      元: ${H.chain(s0.n)}\n      後: ${H.chain(s0.m)}`,
      '文字位置で切り貼りすると閉じタグが道連れになる。tools/hedit.js move / order を使う');
  }
  // (3) 参照の破れ（前の版では解決していた参照だけを見る＝動的生成の誤検知が出ない）
  for (const id of aref) {
    if (ai.has(id) || !bi.has(id) || !bref.has(id)) continue;
    add('BLOCK', 'HTML-参照の破れ', file, `スクリプトが参照する id="${id}" が HTML から無くなった`, '要素を戻すか、参照側を消す');
  }
}

// ---------- main.js: 透過ウィンドウの地雷 ----------
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
function windows(mainSrc) {
  const src = stripJs(mainSrc);
  const out = [];
  for (const m of src.matchAll(/new BrowserWindow\(\s*\{/g)) {
    let i = m.index + m[0].length - 1, d = 0, j = i;
    for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
    const body = src.slice(i + 1, j);
    const opts = {};
    let depth = 0, key = null, buf = '', k = 0;
    for (let p = 0; p < body.length; p++) {
      const c = body[p];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      if (!depth && c === ':' && key === null) { key = buf.trim(); buf = ''; continue; }
      if (!depth && c === ',') { if (key) opts[key] = buf.trim(); key = null; buf = ''; continue; }
      buf += c;
    }
    if (key) opts[key] = buf.trim();
    // webPreferences の中も同じ平面に載せる（backgroundThrottling はここに入る）
    const wp = opts.webPreferences;
    if (wp && wp.includes('{')) {
      const inner = wp.slice(wp.indexOf('{') + 1, wp.lastIndexOf('}'));
      let d2 = 0, k2 = null, b2 = '';
      const flush = () => { if (k2) opts[k2.trim()] = b2.trim(); k2 = null; b2 = ''; };
      for (let p2 = 0; p2 < inner.length; p2++) {
        const c = inner[p2];
        if (c === '{' || c === '(' || c === '[') d2++;
        else if (c === '}' || c === ')' || c === ']') d2--;
        if (!d2 && c === ':' && k2 === null) { k2 = b2; b2 = ''; continue; }
        if (!d2 && c === ',') { flush(); continue; }
        b2 += c;
      }
      flush();
    }
    // この窓が読み込む HTML
    const after = src.slice(j, j + 2000);
    const lf = /loadFile\([^)]*'([\w.]+\.html)'/.exec(after);
    out.push({ opts, html: lf ? lf[1] : null, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}
function mineHits(win, htmlSrc) {
  const hits = [];
  if (String(win.opts.transparent).trim() !== 'true') return hits;
  for (const r of MINES.windowOpts) {
    const v = win.opts[r.key];
    if (r.key === 'transparent') continue;
    if (v === undefined) { if (r.key === 'hasShadow') hits.push({ what: `hasShadow が未指定`, why: r.why, seen: r.seen }); continue; }
    if (r.bad(String(v))) hits.push({ what: `${r.key}: ${v}`, why: r.why, seen: r.seen });
  }
  if (htmlSrc) {
    for (const rule of St.rules(St.styleOf(htmlSrc))) {
      if (rule.at) continue; // @keyframes 等は窓の矩形に落ちない
      for (const r of MINES.css) {
        const v = rule.decls[r.prop];
        if (v !== undefined && r.bad(v)) hits.push({ what: `${rule.sel} { ${r.prop}: ${v} }`, why: r.why, seen: r.seen });
      }
    }
  }
  return hits;
}

// ---------- 地とインクの向き ----------
function inkFindings(htmlSrc) {
  if (!htmlSrc) return [];
  const rules = St.rules(St.styleOf(htmlSrc));
  const pill = rules.find((r) => r.sel === '.pill');
  if (!pill || !pill.decls.background) return [];
  const g = St.colorsIn(pill.decls.background)[0];
  if (!g) return [];
  const gl = St.lum(g);
  const dark = gl < 0.18;
  const out = [];
  const test = (label, c) => {
    const l = St.lum(St.over(c, g));
    if (dark ? l <= gl + 0.02 : l >= gl - 0.02) out.push(`${label}（地の輝度 ${gl.toFixed(3)} に対し ${l.toFixed(3)}。${dark ? '暗い地に暗いインク' : '明るい地に明るいインク'}）`);
  };
  const js = [...htmlSrc.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
  for (const m of stripJs(js).matchAll(/(fillStyle|strokeStyle)\s*=\s*([^;\n]+)/g))
    for (const c of St.colorsIn(m[2])) test(`${m[1]} = ${m[2].trim().slice(0, 60)}`, c);
  for (const r of rules) {
    if (r.at) continue;
    for (const p of ['color', 'border-top-color']) {
      const v = r.decls[p]; if (!v) continue;
      for (const c of St.colorsIn(v)) test(`${r.sel} { ${p}: ${v} }`, c);
    }
  }
  return out;
}

// ---------- 配布物（.ps1） ----------
function checkPs1(rev) {
  const files = git(['ls-files']).split('\n').filter((f) => f.endsWith('.ps1'));
  for (const f of files) {
    let buf;
    try {
      buf = rev === null ? fs.readFileSync(path.join(ROOT, f))
        : execFileSync('git', ['show', rev === 'INDEX' ? `:${f}` : `${rev}:${f}`], { cwd: ROOT, maxBuffer: 1 << 24 });
    } catch { continue; }
    if (!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf))
      add('BLOCK', '配布-ps1', f, 'BOM が無い。PowerShell 5.1 が Shift-JIS と誤読して構文エラーになる', 'tools/write-ps1.js を通して書き出す');
  }
  // 生成器を通さずに .ps1 を書いているコードが無いこと
  for (const f of git(['ls-files']).split('\n').filter((x) => /\.(js|cjs|mjs)$/.test(x) && !x.startsWith('tools/write-ps1'))) {
    const s = at(rev, f) || '';
    if (/writeFileSync\([^)]*\.ps1/.test(stripJs(s)))
      add('BLOCK', '配布-ps1', f, '.ps1 を直接書き出している', 'tools/write-ps1.js の writePs1() を使う（BOM+CRLF を必ず付ける）');
  }
}

// ---------- 復旧の導線 ----------
function checkRecovery(mainSrc) {
  if (!mainSrc) return;
  const s = stripJs(mainSrc);
  for (const r of MINES.recovery)
    if (!r.mainPattern.test(s))
      add('BLOCK', '復旧の導線', 'src/main.js', `「${r.name}」への入口が main 側（トレイ／アプリメニュー）に無い。画面が1か所で倒れると復旧できなくなる`, 'Menu/Tray のテンプレートに、レンダラーを経由しない項目を足す');
}

function analyze(base, head) {
  F = [];
  const changed = new Set(
    (head === null ? git(['diff', '--name-only', base])
      : head === 'INDEX' ? git(['diff', '--name-only', '--cached', base])
      : git(['diff', '--name-only', base, head]))
      .split('\n').filter(Boolean));
  const htmls = ['src/renderer/app.html', 'src/renderer/overlay.html'];

  for (const f of htmls) {
    const a = at(head, f); if (a == null) continue;
    checkHtml(f, at(base, f), a);
  }
  // 透過ウィンドウの地雷（新しく踏んだものだけ）
  const mainA = at(head, 'src/main.js'), mainB = at(base, 'src/main.js');
  const snap = (m, get) => {
    if (!m) return new Map();
    const out = new Map();
    for (const w of windows(m)) {
      if (String(w.opts.transparent).trim() !== 'true') continue;
      const html = w.html ? get('src/renderer/' + w.html) : null;
      for (const h of mineHits(w, html)) out.set(h.what, h);
    }
    return out;
  };
  // 透過そのものを外した／窓が透過でなくなった（v0.9.11 と同じ症状を別の踏み方で出す）
  const byHtml = (m) => new Map((m ? windows(m) : []).filter((w) => w.html).map((w) => [w.html, w]));
  const wb = byHtml(mainB), wa = byHtml(mainA);
  for (const [html, w] of wb) {
    if (String(w.opts.transparent).trim() !== 'true') continue;
    const n = wa.get(html);
    if (!n) continue;
    if (String(n.opts.transparent).trim() !== 'true')
      add('BLOCK', '透過ウィンドウの地雷', 'src/main.js', `${html} の窓から transparent:true が外れた（今は ${n.opts.transparent}）\n      理由: 透過をやめると、ピルの角の外に地色の矩形が出る（v0.9.11 と同じ症状）`, '透過は録音バーの前提。外すなら overlay.html の角丸と影も同時に作り直す');
  }
  const hb = snap(mainB, (f) => at(base, f)), ha = snap(mainA, (f) => at(head, f));
  for (const [k, h] of ha) if (!hb.has(k)) add('BLOCK', '透過ウィンドウの地雷', 'src/main.js + overlay.html', `${k}\n      理由: ${h.why}（${h.seen}）`, 'tools/lib/mines.js の台帳にある。撤去する');
  // 地とインクの向き（新しく壊れたものだけ）
  const ib = new Set(inkFindings(at(base, 'src/renderer/overlay.html')));
  for (const x of inkFindings(at(head, 'src/renderer/overlay.html')))
    if (!ib.has(x)) add('BLOCK', '地とインクの向き', 'src/renderer/overlay.html', x, '地の色を変えたら、その面に載る色を全て見直す');
  checkPs1(head);
  checkRecovery(mainA);

  // 実機確認が要る変更の判定
  const needs = [];
  if ([...changed].some((f) => f.includes('overlay.html'))) needs.push('録音バーの透過（ピルの外に矩形が出ていないか）と、暗い地の上で波形・文字が読めるか');
  if (mainA !== mainB && /new BrowserWindow/.test(mainA || '')) needs.push('ウィンドウの生成条件を変えた。透過・影・常に手前の挙動を実機で見る');
  if ([...changed].some((f) => f.includes('app.html'))) needs.push('設定画面の全カードが見え、値が読み込まれ、自動保存が効くか');
  if ([...changed].some((f) => f.endsWith('.ps1'))) needs.push('PowerShell 5.1（Windows 標準）で .ps1 が構文エラーにならないか');
  if ([...changed].some((f) => /updater|main\.js/.test(f))) needs.push('トレイの「更新を確認」が、設定画面を開かずに動くか');

  return { findings: F.slice(), needs, changed };
}

function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
  let base = arg('--base', 'HEAD');
  // リリース時は「前のタグ」を基準にする。既定の HEAD のままだと、
  // コミット済みの変更が差分に入らず、最も効くべき瞬間に
  // 必ず「危険な変更は見つからなかった」と言ってしまう。
  if (argv.includes('--base-tag')) {
    try {
      base = require('child_process')
        .execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT }).toString().trim();
    } catch (_) {
      base = require('child_process')
        .execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT }).toString().trim().split('\n')[0];
    }
  }
  const head = argv.includes('--staged') ? 'INDEX' : (argv.includes('--head') ? arg('--head') : null);
  const { findings, needs, changed } = analyze(base, head);
  const blocks = findings.filter((f) => f.level === 'BLOCK');
  const warns = findings.filter((f) => f.level === 'WARN');
  const target = head === null ? '作業ツリー' : head === 'INDEX' ? 'コミット予定の内容' : head;
  console.log(`■ 変更危険度ゲート  基準=${base}  対象=${target}  変更ファイル ${changed.size} 件\n`);
  const STANDING = new Set(['復旧の導線', '配布-ps1']);
  const show = (title, xs) => { if (!xs.length) return; console.log(`── ${title} ──\n`); for (const f of xs) console.log(`[${f.level}] ${f.rule}  ${f.file}\n   ${f.msg}\n   → ${f.how}\n`); };
  show('この変更で新たに危険になったもの', [...blocks, ...warns].filter((f) => !STANDING.has(f.rule)));
  show('常時の不変条件（この変更とは無関係に破れている）', [...blocks, ...warns].filter((f) => STANDING.has(f.rule)));
  if (!findings.length) console.log('危険な変更は見つからなかった。\n');
  const a0 = { errTotal: findings.filter((f) => f.rule === 'HTML-木の破損').length };
  const md = ['# リリース前チェックリスト（自動生成）', '', `基準 ${base} → ${target}`, ''];
  if (needs.length) { md.push('## 実機（Windows）で見ること', ''); needs.forEach((n, i) => md.push(`- [ ] ${i + 1}. ${n}`)); }
  else md.push('実機確認が必要な変更は含まれていない。');
  const line = (name, n) => n ? `- [ ] ${name}: ${n} 件見つかった（直すまでリリースしない）` : `- [x] ${name}: 問題なし`;
  md.push('', '## 機械が確認したこと（実機で見る必要がないもの）', '',
    line('HTML の木の健全さ（閉じ忘れ・相手のいない閉じタグ）', a0.errTotal),
    line('要素の消失・枠からの離脱・参照の破れ', blocks.filter((b) => b.rule.startsWith('HTML')).length),
    line('透過ウィンドウの地雷（台帳 tools/lib/mines.js）', blocks.filter((b) => b.rule.includes('地雷')).length),
    line('地とインクの向き', blocks.filter((b) => b.rule.includes('インク')).length),
    line('.ps1 の BOM と書き出し口', blocks.filter((b) => b.rule.includes('ps1')).length),
    line('復旧の導線が main 側にあること', blocks.filter((b) => b.rule.includes('復旧')).length));
  const out = arg('--checklist');
  if (out) { fs.writeFileSync(out, md.join('\n') + '\n'); console.log('チェックリストを書き出した: ' + out); }
  else if (needs.length) console.log('― 実機で見ること ―\n' + needs.map((n, i) => `  ${i + 1}. ${n}`).join('\n') + '\n');
  console.log(`結果: BLOCK ${blocks.length} 件 / WARN ${warns.length} 件`);
  return blocks.length ? 1 : 0;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { analyze, checkHtml, windows, mineHits, inkFindings, refIds };
