'use strict';
// 検査対象を「1回だけ」読み解いて、不変条件から参照できる形にまとめたもの。
// 不変条件の側は文字列を触らず、ここで作った木・規則・起動結果だけを見る。

const fs = require('fs');
const path = require('path');
const H = require('./html.js');
const C = require('./css.js');
const { boot, preloadApis } = require('./boot.js');
const REPLIES = require('./replies.js');

const ROOT = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// main.js の new BrowserWindow({ ... }) を波括弧対応で切り出す
function windows(mainSrc) {
  const src = mainSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const out = [];
  const re = /new\s+BrowserWindow\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex - 1, depth = 0, end = i;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } } }
    const body = src.slice(m.index, end + 1);
    // このウィンドウ変数が読み込む HTML を探す
    const varName = (src.slice(Math.max(0, m.index - 200), m.index).match(/([A-Za-z_$][\w$]*)\s*=\s*$/) || [])[1];
    let file = null;
    if (varName) {
      const lf = src.slice(end).match(new RegExp(varName.replace(/\$/g, '\\$') + "\\.loadFile\\([^)]*?['\"]([\\w.-]+\\.html)['\"]"));
      if (lf) file = lf[1];
    }
    const opt = (k) => { const mm = body.match(new RegExp('(?:^|[\\s,{])' + k + '\\s*:\\s*([^,}\\n]+)')); return mm ? mm[1].trim() : undefined; };
    out.push({ varName, body, file, opt, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

let cache = null;
function world() {
  if (cache) return cache;
  const screens = {};
  for (const [name, rel] of [['app', 'src/renderer/app.html'], ['overlay', 'src/renderer/overlay.html']]) {
    const src = rd(rel);
    const tree = H.parse(src);
    const styleText = tree.nodes.filter((n) => n.tag === 'style').map((n) => n.text || '').join('\n');
    const scriptText = tree.nodes.filter((n) => n.tag === 'script' && !n.attrs.src).map((n) => n.text || '').join('\n');
    screens[name] = {
      name, rel, src, tree, styleText, scriptText,
      css: C.parse(styleText),
      ids: tree.nodes.filter((n) => n.attrs.id).map((n) => n.attrs.id),
      rule: (sel) => C.parse(styleText).filter((r) => r.selectors.includes(sel) && !r.at),
    };
  }
  const mainSrc = rd('src/main.js');
  const preloadSrc = rd('src/preload.js');
  const run = {};
  for (const k of Object.keys(screens)) {
    const un = [];
    const onUn = (e) => un.push(String((e && e.message) || e));
    process.on('unhandledRejection', onUn);
    const r = boot(screens[k].rel, { replies: REPLIES });
    r.unhandled = un;
    r._off = () => process.removeListener('unhandledRejection', onUn);
    run[k] = r;
  }
  cache = {
    ROOT, rd, screens, mainSrc, preloadSrc,
    apis: preloadApis(preloadSrc),
    windows: windows(mainSrc),
    run,
    // git 管理下のファイル一覧。git が無い環境（履歴の切り出しなど）では実ファイルを歩く。
    trackedFiles: () => {
      try { return require('child_process').execSync('git ls-files', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean); }
      catch { 
        const out = []; const walk = (d, pre) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (['node_modules', '.git', 'release', 'dist'].includes(e.name)) continue;
          if (e.isDirectory()) walk(path.join(d, e.name), pre + e.name + '/'); else out.push(pre + e.name); } };
        walk(ROOT, ''); return out;
      }
    },
  };
  return cache;
}

module.exports = { world, windows };
