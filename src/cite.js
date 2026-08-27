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
 */
'use strict';

// 全角記号・空白を落として比較用に正規化する
function normalize(s) {
  return String(s || '')
    .replace(/[、。「」『』（）()［］\[\]【】・,.!?！？"'`~\-—…:：;；\s]/g, '')
    .toLowerCase();
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
 * @returns {{linked:number, total:number}}
 */
function attachCitations(blocks, segments, opts) {
  if (!Array.isArray(segments) || segments.length === 0) return { linked: 0, total: 0 };
  const idx = buildIndex(segments);
  let linked = 0;
  let total = 0;

  for (const b of blocks) {
    if (b.type !== 'bullet' && b.type !== 'todo') continue;
    if (!b.text || normalize(b.text).length < 6) continue;
    total++;
    const hits = matchOne(b.text, idx, opts);
    b.cites = hits.map((h) => h.id);
    if (b.cites.length) linked++;
  }
  return { linked, total };
}

module.exports = { attachCitations, buildIndex, matchOne, bigrams, normalize };
