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

// インライン Markdown（**太字** など）を落とす。
// 見た目の問題だけではない。cite.js の正規化は「*」を落とさないため、
// 記号がバイグラムに残ると索引に無い gram が増えて被覆率が薄まり、
// 短い要点では出典が丸ごと消える。出典が消えるのはこの製品では最も痛い壊れ方。
//
// 落とすのは「**」「***」「`」だけにしている。
// 「*」1個の強調（*これ*）と「__これ__」は扱わない。理由:
//   「工数は 3人*2日*5週」が「工数は 3人2日5週」になる。
//   要約の数字が黙って別の数字に変わるのは、装飾が残るより遥かに悪い。
//   （「__init__」から下線が消えるのも同じ筋）
// モデルが実際に書いてくるのはほぼ「**」なので、取りこぼしは小さい。
// 残った記号は cite.js の正規化が落とすので、出典には響かない。
function stripInlineMarkdown(s) {
  return String(s || '')
    .replace(/\*\*\*(?!\s)([^*\n]*[^*\s\n])\*\*\*/g, '$1')
    .replace(/\*\*(?!\s)([^*\n]*[^*\s\n])\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
}

// 行頭のチェックボックス書式。実機のモデルは「- [ ]」だけでなく
// 「・[ ]」「- []」「［ ］」のような揺れた書き方をしてくる。
// 拾い損ねると箇条書きになり、画面に「[ ]」がそのまま見えるうえ、
// アクション件数にも担当・期限の抽出にも入らない。
// 「[1] を参照」のような角括弧は中身が空白/x でないので誤爆しない。
const CHECKBOX_HEAD = /^[\[［]([ xXｘＸ×　]?)[\]］]\s*/;

// Markdown → ブロック配列（Notion のブロックモデル相当）
function markdownToBlocks(md) {
  const blocks = [];
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      blocks.push({ id: store.newId('b'), type: 'heading', text: stripInlineMarkdown(m[1]), cites: [] });
    // 「]」「・」の直後に空白が無い書き方をモデルがよくする。
    // ここで拾い損ねるとその行は paragraph になり、出典リンクも
    // 担当・期限の抽出も対象外になって、静かに機能が欠ける。
    // 「-」「*」は空白必須のまま（"*強調*" や "-5%" を誤って箇条書きにしないため）。
    } else if ((m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/))) {
      blocks.push({ id: store.newId('b'), type: 'todo', text: stripInlineMarkdown(m[2]), checked: m[1].toLowerCase() === 'x', cites: [] });
    } else if ((m = line.match(/^\s*(?:[-*]\s+|・\s*)(.*)$/))
        || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      const c = m[1].match(CHECKBOX_HEAD);
      if (c) {
        blocks.push({ id: store.newId('b'), type: 'todo',
          text: stripInlineMarkdown(m[1].slice(c[0].length)),
          checked: /[xXｘＸ×]/.test(c[1] || ''), cites: [] });
      } else {
        blocks.push({ id: store.newId('b'), type: 'bullet', text: stripInlineMarkdown(m[1]), cites: [] });
      }
    } else {
      blocks.push({ id: store.newId('b'), type: 'paragraph', text: stripInlineMarkdown(line), cites: [] });
    }
  }
  return blocks;
}

// 「特になし」だけの行を、中身のある節から落とす。
//
// テンプレートが各節に「なければ『特になし』」と条件付きで指示しているが、
// ローカルの小型モデルはこの条件を守り切れず、実項目を書いたうえで
// 「特になし」も並べてくる。放っておくとアクションの件数が水増しされ、
// Markdown 書き出しにも残る。
//
// 誤って本物の内容を消さないため、次の3条件を全て満たすときだけ落とす。
//   1. 対象は見出し配下の bullet / todo のみ（見出しと地の文は絶対に触らない）
//   2. 定型句に完全一致（「決定事項は特になし、次回に持ち越す」のような
//      中身のある行は残す）
//   3. 同じ節に定型句でない bullet / todo が1つ以上ある
//      （全部が定型句なら、その節は本当に空なので1行も落とさない）
const EMPTY_PHRASE = /^(?:特に(?:は)?(?:なし|無し|ありません|ございません)|なし|無し|該当(?:なし|無し)|不要)[。.、,]?$/;

function isEmptyPhrase(text) {
  return EMPTY_PHRASE.test(String(text || '').replace(/[\s（）()「」]/g, ''));
}

function dropRedundantEmpty(blocks) {
  const out = [];
  let section = [];          // 現在の節の bullet / todo
  const flush = () => {
    if (!section.length) return;
    const real = section.filter((b) => !isEmptyPhrase(b.text));
    // 実項目が1つでもあれば、定型句だけの行を捨てる
    for (const b of section) {
      if (real.length && isEmptyPhrase(b.text)) continue;
      // 「- [ ] 特になし」はアクションではない。チェックボックスのままだと
      // 「アクション 1件」と数えられ、横断アクション一覧にも架空の
      // タスクとして並ぶ。節が本当に空でも、ここは箇条書きに落とす。
      if (b.type === 'todo' && isEmptyPhrase(b.text)) {
        out.push({ ...b, type: 'bullet', checked: undefined });
        continue;
      }
      out.push(b);
    }
    section = [];
  };
  for (const b of blocks) {
    if (b.type === 'bullet' || b.type === 'todo') { section.push(b); continue; }
    flush();
    out.push(b);            // 見出し・地の文が節の切れ目になる
  }
  flush();
  return out;
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

module.exports = { fmtClock, markdownToBlocks, blocksToMarkdown, stripInlineMarkdown, dropRedundantEmpty };
