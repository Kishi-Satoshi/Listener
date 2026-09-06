/*
 * cite.js — 要約の各要点に「根拠となった発言」を対応付ける
 *
 * 方針: LLM にセグメントIDを出力させない。
 *   3B クラスのローカルモデルは存在しないIDを平然と捏造するため、
 *   リンクを踏むと無関係な発言に飛ぶという最悪の壊れ方をする。
 *   代わりに、生成後の要約テキストと文字起こしを機械的に突き合わせる。
 *
 * 手法: 文字バイグラムの IDF 重み付き一致スコア（BM25 の簡略版）。
 *   日本語は単語境界が無いため形態素解析が必要になるが、
 *   バイグラムなら辞書なしで同等の効果が得られる。
 *   「です」「ます」のような頻出バイグラムは IDF が下がり自動的に無視される。
 *
 * 区間長の正規化（BM25 の b）を持たない理由: スコアはクエリ側のバイグラムを
 *   含むときしか上がらず、長いだけの区間は上がらない（反証で確認済み）。
 */
'use strict';

// 全角記号・空白を落として比較用に正規化する
function normalize(s) {
  return String(s || '')
    // 「*」「_」も落とす。要約側で除去してはいるが、ユーザーが手で書いた
    // 「**重要**」のような記号が残ると、索引に無いバイグラムが増えて
    // 被覆率のふるい（minCoverage）に掛かり、出典が静かに消える。
    .replace(/[、。「」『』（）()［］\[\]【】・,.!?！？"'`~\-—…:：;；*_\s]/g, '')
    .toLowerCase();
}

// 照合の対象にする最短の長さ（正規化後の文字数）。
// これより短い要点は偶然一致が多く、誤リンクは無リンクより有害なので照合しない。
// 閾値は attachCitations / refreshCitations の両方で使うので、ここ1か所に置く。
const MIN_CITE_CHARS = 6;
function isCitable(text) {
  return normalize(text).length >= MIN_CITE_CHARS;
}

// 照合に使うクエリ。表示本文はそのまま、担当付きの todo だけ担当名を足す。
// 担当・期限は本文から抜いてから照合する（書式が混ざると一致がぶれる）が、
// その結果「同じ作業を別の人に振った」todo が本文だけでは区別できず、
// 互いの発言を指してしまう。担当名を足せば、その人に向けた発言の方が勝つ。
function citeText(b) {
  return (b.type === 'todo' && b.assignee) ? `${b.text} ${b.assignee}` : b.text;
}

function bigrams(s) {
  const t = normalize(s);
  const out = [];
  if (t.length === 1) return [t];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * セグメント集合から逆引き索引と IDF を作る。
 * @param {Array<{id:string,text:string}>} segments
 */
function buildIndex(segments) {
  const df = new Map();          // bigram -> 出現セグメント数
  const segBigrams = new Map();  // segId -> Map(bigram -> 出現回数)

  for (const seg of segments) {
    const counts = new Map();
    for (const g of bigrams(seg.text)) counts.set(g, (counts.get(g) || 0) + 1);
    segBigrams.set(seg.id, counts);
    for (const g of counts.keys()) df.set(g, (df.get(g) || 0) + 1);
  }

  const N = Math.max(1, segments.length);
  const idf = new Map();
  for (const [g, d] of df) {
    // 頻出バイグラムほど小さく、稀なものほど大きく
    idf.set(g, Math.log(1 + N / (1 + d)));
  }
  return { segBigrams, idf, segments };
}

/**
 * 要約1行に対する根拠セグメントを返す。
 * @returns {Array<{id:string, score:number}>} スコア降順・閾値超えのみ
 */
function matchOne(text, idx, opts) {
  const o = Object.assign({ threshold: 0.22, minCoverage: 0.34, max: 2 }, opts || {});
  const queryGrams = bigrams(text);
  if (queryGrams.length === 0) return [];

  // クエリ側の自己スコア（正規化の分母）
  let selfScore = 0;
  const qSet = new Set(queryGrams);
  for (const g of qSet) selfScore += idx.idf.get(g) || Math.log(2);
  if (selfScore <= 0) return [];

  const scored = [];
  for (const seg of idx.segments) {
    const counts = idx.segBigrams.get(seg.id);
    if (!counts) continue;
    let s = 0;
    let hit = 0;
    for (const g of qSet) {
      if (counts.has(g)) { s += idx.idf.get(g) || 0; hit++; }
    }
    if (s <= 0) continue;
    // IDF スコアと「素の被覆率」の両方を見る。
    // セグメント数が少ないと IDF が信用できず、「について」のような
    // 機能語だけの偶然一致が高スコアになるため、被覆率で足切りする。
    const coverage = hit / qSet.size;
    if (coverage < o.minCoverage) continue;
    scored.push({ id: seg.id, score: s / selfScore, coverage });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((x) => x.score >= o.threshold).slice(0, o.max);

  // 2件目が1件目に比べて明らかに弱ければ捨てる（無関係な発言を巻き込まない）
  if (top.length === 2 && top[1].score < top[0].score * 0.6) top.length = 1;
  return top;
}

/**
 * ブロック配列に cites を付与する（破壊的）。
 * 根拠が閾値に届かないブロックにはあえてリンクを張らない。
 * 「根拠が示せない要点」は正直にそう見せる方が、誤リンクより有用なため。
 *
 * 短くて照合しなかった行には citeSkip を付ける（対象になった行からは外す）。
 * 「根拠を探したが無かった」と「そもそも探していない」は画面で別物として見せたい。
 * @returns {{linked:number, total:number, skipped:number}}
 */
function attachCitations(blocks, segments, opts) {
  if (!Array.isArray(segments) || segments.length === 0) return { linked: 0, total: 0, skipped: 0 };
  const idx = buildIndex(segments);
  let linked = 0;
  let total = 0;
  let skipped = 0;

  for (const b of blocks) {
    if (b.type !== 'bullet' && b.type !== 'todo') continue;
    if (!isCitable(b.text)) { b.citeSkip = true; skipped++; continue; }
    delete b.citeSkip;
    total++;
    const hits = matchOne(citeText(b), idx, opts);
    b.cites = hits.map((h) => h.id);
    if (b.cites.length) linked++;
  }
  return { linked, total, skipped };
}

/**
 * 1区間の本文が編集された後の、出典の付け直し。
 *
 * 全要点を引き直さない。理由は2つ。
 *  - 人が自分の言葉に書き直した要点（updateBlock は出典を触らない）を再照合すると
 *    閾値に届かず「根拠なし」に落ちる。編集していない行の出典が消えるのは事故。
 *  - IDF は全区間で決まるので、1区間の変更で無関係な行が閾値の境目で反転しうる。
 *
 * 触るのは「その区間を根拠にしていた要点」と「根拠なしの要点」だけ。
 * それ以外の要点の cites はそのまま戻す。決定的で、二度掛けても結果は変わらない。
 * citeSkip の付け外しは attachCitations に任せる（閾値を二重に持たない）。
 * @returns {{linked:number, total:number, skipped:number}}
 */
function refreshCitations(blocks, segments, segId) {
  const keep = new Map();
  for (const b of blocks) {
    if (Array.isArray(b.cites) && b.cites.length && !b.cites.includes(segId)) keep.set(b.id, b.cites.slice());
  }
  const r = attachCitations(blocks, segments, undefined);
  for (const b of blocks) {
    if (!keep.has(b.id)) continue;
    // 直した区間が新たに根拠になった要点は、新しい結果を採る。
    // 崩れた区間のせいで隣の発言を指していた要点が、直した後に正しい発言へ移る経路。
    if (Array.isArray(b.cites) && b.cites.includes(segId)) continue;
    b.cites = keep.get(b.id);
  }
  if (r.total === 0) return { linked: 0, total: 0, skipped: r.skipped };
  let linked = 0;
  for (const b of blocks) {
    if (b.type !== 'bullet' && b.type !== 'todo') continue;
    if (!isCitable(b.text)) continue;
    if (Array.isArray(b.cites) && b.cites.length) linked++;
  }
  return { linked, total: r.total, skipped: r.skipped };
}

module.exports = { attachCitations, refreshCitations, buildIndex, matchOne, bigrams, normalize,
  isCitable, citeText, MIN_CITE_CHARS };
