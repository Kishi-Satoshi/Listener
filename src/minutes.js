/*
 * minutes.js — 議事録の Markdown とブロック配列を相互変換する
 *
 * main.js から切り出している。Electron に依存しない純粋な変換なので、
 * ここに置くことでエンジンを起動せずに単体で検証できる。
 * 要約の品質は「LLMの出力を取りこぼさずブロック化できるか」に大きく依存し、
 * 取りこぼしは静かに起きる（要点が1行消えても画面上は自然に見える）ため、
 * この層はテストで押さえておきたい。
 */
'use strict';

const store = require('./store');

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

// Markdown → ブロック配列（Notion のブロックモデル相当）
function markdownToBlocks(md) {
  const blocks = [];
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      blocks.push({ id: store.newId('b'), type: 'heading', text: m[1].trim(), cites: [] });
    // 「]」「・」の直後に空白が無い書き方をモデルがよくする。
    // ここで拾い損ねるとその行は paragraph になり、出典リンクも
    // 担当・期限の抽出も対象外になって、静かに機能が欠ける。
    // 「-」「*」は空白必須のまま（"*強調*" や "-5%" を誤って箇条書きにしないため）。
    } else if ((m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/))) {
      blocks.push({ id: store.newId('b'), type: 'todo', text: m[2].trim(), checked: m[1].toLowerCase() === 'x', cites: [] });
    } else if ((m = line.match(/^\s*(?:[-*]\s+|・\s*)(.*)$/))) {
      blocks.push({ id: store.newId('b'), type: 'bullet', text: m[1].trim(), cites: [] });
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      blocks.push({ id: store.newId('b'), type: 'bullet', text: m[1].trim(), cites: [] });
    } else {
      blocks.push({ id: store.newId('b'), type: 'paragraph', text: line.trim(), cites: [] });
    }
  }
  return blocks;
}

function blocksToMarkdown(page, segments) {
  let md = `# ${page.title || '議事録'}\n\n`;
  md += `- 日時: ${new Date(page.createdAt).toLocaleString('ja-JP')}\n`;
  md += `- 録音時間: ${fmtClock((page.durationSec || 0) * 1000)}\n\n`;
  if (page.memo && page.memo.trim()) md += `## メモ・アジェンダ\n${page.memo.trim()}\n\n`;
  for (const b of page.blocks) {
    if (b.type === 'heading') md += `\n## ${b.text}\n`;
    else if (b.type === 'todo') md += `- [${b.checked ? 'x' : ' '}] ${b.text}\n`;
    else if (b.type === 'bullet') md += `- ${b.text}\n`;
    else md += `${b.text}\n`;
  }
  md += '\n## 文字起こし全文\n\n';
  for (const s of segments) md += `[${fmtClock(s.atMs)}] ${s.text}\n`;
  return md;
}

module.exports = { fmtClock, markdownToBlocks, blocksToMarkdown };
