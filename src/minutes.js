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

// 行頭の箇条書き記号。実機のモデルは「•」「＊」「－」「１．」のような
// 全角・記号違いの行頭を混ぜてくる。paragraph に落ちると出典リンクも
// 担当・期限の抽出も対象外になり、機能が静かに欠ける。
//
// 入れない記号:
//   「ー」（長音）… 「ーん」のような語頭に出るので誤爆する
//   「※」… 注記の印であり、要点ではなく地の文として残したい
// 「・」以外は直後の空白を必須にする。半角の「-」「*」で守っている
// 「-5%」「*強調*」を箇条書きにしない意図を、全角の「－5%」「＊強調＊」にも揃える。
// チェックボックスは記号と「[」の間の空白が無くても拾う（「-[ ]」は普通の文にならない）。
const TODO_HEAD = /^\s*[-*＊－–—•◦▪]\s*[\[［]([ xXｘＸ×　]?)[\]］]\s*(.*)$/;
const BULLET_HEAD = /^\s*(?:[-*＊－–—•◦▪]\s+|・\s*)(.*)$/;
// 番号は全角と「、」も見る（「１．背景」「1、目的」は空白なしが普通）。
// ただし直後が数字なら番号ではない（「12.5%の増加」「1、2、3の順」を切り刻まない）。
const NUMBER_HEAD = /^\s*[0-9０-９]+[.．)）、](?![0-9０-９])\s*(.*)$/;

// 表とコードフェンス。数値の多い会議でモデルが表で書いてくることがあり、
// 「| 応募 | 8名 |」がそのまま画面に出るうえ出典も付かない。
// 表の各行は「列1: 列2」の箇条書きに畳む。ヘッダ行と区切り行は要点ではないので捨てる。
// フェンス（```）は行だけ捨て、中身は普通の行として読む（要約全体を ```markdown で
// 包んでくるモデルがいる。中身を捨てると要約が丸ごと消える）。
const FENCE_LINE = /^\s*`{3,}\s*[\w-]*\s*$/;
// 揃え記号付きの「:-:」は横棒が1本なので、本数は問わない
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

// 表の1行を箇条書きの本文にする。空セルは詰める（「a:  / b」を避ける）。
// 2列なら「a: b」、3列以上は「a: b / c」。
function tableRowText(inner) {
  const cells = inner.split('|').map((c) => stripInlineMarkdown(c)).filter(Boolean);
  if (cells.length === 0) return '';
  if (cells.length === 1) return cells[0];
  return `${cells[0]}: ${cells.slice(1).join(' / ')}`;
}

// Markdown → ブロック配列（Notion のブロックモデル相当）
function markdownToBlocks(md) {
  const blocks = [];
  let lastRow = null;   // 直前に表の行から作ったブロック（区切り行が来たらヘッダとして捨てる）
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (FENCE_LINE.test(line)) continue;
    if (TABLE_SEP.test(line)) {
      // 区切り行の直前の行がヘッダ。表の行以外（本物の要点）は巻き添えにしない
      if (lastRow && blocks[blocks.length - 1] === lastRow) blocks.pop();
      lastRow = null;
      continue;
    }
    let m;
    if ((m = line.match(TABLE_ROW))) {
      const text = tableRowText(m[1]);
      lastRow = null;
      if (!text) continue;
      lastRow = { id: store.newId('b'), type: 'bullet', text, cites: [] };
      blocks.push(lastRow);
      continue;
    }
    lastRow = null;
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      blocks.push({ id: store.newId('b'), type: 'heading', text: stripInlineMarkdown(m[1]), cites: [] });
    // 「]」「・」の直後に空白が無い書き方をモデルがよくする。
    // ここで拾い損ねるとその行は paragraph になり、出典リンクも
    // 担当・期限の抽出も対象外になって、静かに機能が欠ける。
    // 「-」「*」は空白必須のまま（"*強調*" や "-5%" を誤って箇条書きにしないため）。
    } else if ((m = line.match(TODO_HEAD))) {
      blocks.push({ id: store.newId('b'), type: 'todo', text: stripInlineMarkdown(m[2]), checked: /[xXｘＸ×]/.test(m[1] || ''), cites: [] });
    } else if ((m = line.match(BULLET_HEAD)) || (m = line.match(NUMBER_HEAD))) {
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

// プロンプトの記入例の丸写しを落とす。
//
// テンプレートは各節に「（箇条書き）」「- [ ] 内容（担当: ○○ / 期限: ○○）」と
// 書き方の例を添えているが、小型モデルはこれをそのまま書いてくる。
// 「内容」が todo として数えられ、担当「○○」が横断アクション一覧に並ぶ。
//
// 消すのは、記入例の行と正規化後に完全一致するブロックだけ。
// 部分一致は使わない。「契約内容を確認する」「会議全体を3〜5行で要約した資料」のような
// 本物の要点が記入例の語を含むことは普通にあり、そこを消すと要約が静かに欠ける。
// 見出しは対象にしない（節の名前が記入例の語と重なっても構造は壊さない）。
//
// キーの作り方（templateText の見出し以外の各行から）:
//   - 行全体
//   - 「」で括られた例（ACTION_RULE は「- [ ] 内容（担当: ○○ / 期限: ○○）」を
//     説明文の中に埋めているので、括りの中だけを取り出す）
//   - 例の末尾の「（担当: ○○ / 期限: ○○）」を、丸ごと外したもの・片方だけ残したもの
//     （ルールに「無ければその項目は書かず」とあるので、モデルは「内容」
//      「内容（担当: ○○）」の形でも写してくる）
const TEMPLATE_KEY_STRIP = /[\s（）()「」『』【】［］\[\]、。,.:：;；/／・\-—–…!?！？*_]/g;
function templateKey(text) {
  return String(text || '').replace(TEMPLATE_KEY_STRIP, '').toLowerCase();
}
const LIST_MARK = /^\s*(?:[-*＊－–—•◦▪・]\s*(?:[\[［][ xXｘＸ×　]?[\]］]\s*)?|[0-9０-９]+[.．)）、]\s*)/;

function templateKeys(templateText) {
  const keys = new Set();
  const addVariants = (frag) => {
    const body = frag.replace(LIST_MARK, '').trim();
    if (!body) return;
    keys.add(templateKey(body));
    // 「内容（担当: ○○ / 期限: ○○）」→ 「内容」「内容（担当: ○○）」「内容（期限: ○○）」
    const paren = body.match(/^(.*?)[（(]([^（()）]*)[）)]\s*$/);
    if (!paren) return;
    const head = paren[1].trim();
    if (head) keys.add(templateKey(head));
    const parts = paren[2].split(/[/／]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) for (const p of parts) keys.add(templateKey(`${head}（${p}）`));
  };
  for (const raw of String(templateText || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^#{1,4}\s/.test(line)) continue;
    addVariants(line);
    for (const q of line.matchAll(/「([^「」]+)」/g)) addVariants(q[1]);
  }
  keys.delete('');
  return keys;
}

function dropTemplateEcho(blocks, templateText) {
  if (!templateText || !String(templateText).trim()) return blocks;
  const keys = templateKeys(templateText);
  if (keys.size === 0) return blocks;
  return blocks.filter((b) => b.type === 'heading' || !keys.has(templateKey(b.text)));
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

module.exports = { fmtClock, markdownToBlocks, blocksToMarkdown, stripInlineMarkdown, dropRedundantEmpty, dropTemplateEcho };
