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

// 検索用の畳み込み（#53）。normalize とは別に持つ。normalize は出典のスコアに効くので、
// 検索の都合（NFKC・「/」の除去）で触ると、出典の付き方が静かに変わる。
// NFKC で全角英数・半角カナ・互換文字を寄せ、句読点・括弧・記号・空白を落として小文字にする。
// 「では、予算案の、作成を」が「予算案の作成」に、「ＡＩ戦略」が「ai戦略」に当たる。
function searchFold(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[、。「」『』（）()［］\[\]【】・,.!?！？"'`~\-—…:：;；*_\/\s]/g, '')
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
// 節ごとの照合（matchLine）では担当名を各節の末尾に足す（citeTail）。最後の節だけに
// 付くと、作業を書いた先頭の節が担当を見ずに照合され、別人への発言を指す。
function citeTail(b) {
  return (b.type === 'todo' && b.assignee) ? String(b.assignee) : '';
}
function citeText(b) {
  const tail = citeTail(b);
  return tail ? `${b.text} ${tail}` : b.text;
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

// ---------------------------------------------------------------- 節ごとの照合（#2）
//
// matchOne は要点1行の全バイグラムに対する被覆率で足切りする。2〜3 の発言をまとめた
// 要点（「認証の実装が遅れているがテストは予定通りで、リリース日は変えない」）では
// 各発言が要点の 1/3 しか覆えず、被覆率のふるい（minCoverage）に掛かって、
// チップが1つだけになるか（2〜3 発言）、1つも付かなくなる（4 発言以上）。
// 要点を節に割り、節ごとに「同じ閾値で」照合して和を取る。閾値は一切下げない。
//
// 節の切れ目: 「。」「、」と、述語のあとの接続助詞（「〜ているが」「〜したので」「〜たため」）。
//   - 「が」は主格（「実装が」）にも現れるので、活用語尾（〜いる/〜ない/〜した/〜です 等の
//     末尾の仮名）の直後に限る。「し」は読点なしでは「見直し案」「話し合い」と区別できない
//     ので「し、」だけ（読点で切れる）。「ので」「ため」は「のです」「ために」「ための」を除く。
//   - 述語を持たない断片（「来週の定例で、」「営業部の山田さんが、」）と短い断片
//     （正規化後 MIN_CITE_CHARS 未満）は次の断片に併合する（standsAlone を参照）。
//     節は元の文字列を切り分けた部分文字列なので、全ての節をつなぐと元の要点に戻る。
// 節が1つなら matchOne(text) と全く同じ結果（分割しない要点の挙動は変えない）。
const CLAUSE_CUT = /[。、]|(?<=[うくぐすずつぬぶむるいただ])が(?![、。])|ので(?![、。すはもし])|ため(?![、。にのはでらす])/g;
const MIN_CLAUSE_GRAMS = 3;      // 固有のバイグラムがこれより少ない節は単独で照合しない
const MAX_CITES_PER_LINE = 4;    // 要点1行に付ける出典の上限（節ごとは matchOne の max）

// 断片を単独の節として照合してよいか。
// 単独で照合するのは「述語を持つ」断片だけ。「来週の定例で、」「先週の会議で、」のような
// 連用修飾の断片を単独で照合すると、同じ場や時に触れただけの無関係な発言に満点で当たる
// （実験で確認: 「来週の定例で、認証の遅れを報告する」が「来週の定例では採用の話をします」を
// 指した）。誤リンクは無リンクより有害なので、そうした断片は次の断片に併合する。
//   (A) 格助詞・係助詞で終わる → 続きがある断片。述語に続かない「が」（主格）も同じ。
//   (B) 活用語尾・接続助詞で終わる（〜る/〜い/〜た/〜て/〜し/〜ず/〜ので/〜ため、述語+が）→ 節
//   (C) それ以外（名詞・「で」で終わる）→ 中に主題・主格（は/が/も）があれば名詞述語の節
//       （「テストは予定通りで」「応募は8名」）、無ければ続きがある断片（「来週の定例で」）。
const TRAIL = /[、。\s]+$/;
const ENDS_PARTICLE = /(?:として|について|において|にて|[にへをとはもの]|や|から|まで|より|など)$|(?<![うくぐすずつぬぶむるいただ])が$/;
const ENDS_PREDICATE = /(?:[うくぐすずつぬぶむるいただてしずり]|ので|ため|ながら|つつ)$|(?<=[うくぐすずつぬぶむるいただ])が$/;
function standsAlone(fragment) {
  const f = String(fragment || '').replace(TRAIL, '');
  if (normalize(f).length < MIN_CITE_CHARS) return false;
  if (ENDS_PARTICLE.test(f)) return false;
  if (ENDS_PREDICATE.test(f)) return true;
  return /[はがも]/.test(f);
}

function splitClauses(text) {
  const s = String(text || '');
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(CLAUSE_CUT)) {
    const end = m.index + m[0].length;
    parts.push(s.slice(last, end));
    last = end;
  }
  parts.push(s.slice(last));
  // 節にならない断片は次の断片へ、末尾に残った断片は前の節へ併合する
  const out = [];
  let acc = '';
  for (const p of parts) {
    acc += p;
    if (standsAlone(acc)) { out.push(acc); acc = ''; }
  }
  if (acc) {
    if (out.length) out[out.length - 1] += acc;
    else out.push(acc);
  }
  return out;
}

// 節の主題（最初の助詞まで）。主題の助詞（は/が/も）を優先し、無ければ格助詞（を/に/で/へ/と）。
// 語頭の「はい」「もう」を主題と取らないよう、2 文字目以降の助詞だけを見る。
// 「結論としては据え置き」で「と」を取ると主題が「結論と」になり述語の側に「しては」が残って
// 検査が緩むので、主題の助詞を先に探す。
function clauseHead(clause) {
  const t = String(clause || '').replace(TRAIL, '');
  for (const re of [/[はがも]/g, /[をにでへと]/g]) {
    const m = [...t.matchAll(re)].find((x) => x.index >= 2);
    if (m) return t.slice(0, m.index + 1);
  }
  return t;
}

// 節の根拠にしてよい発言か。主題と述語の「両方」に一致するバイグラムがある発言だけを採る。
// 節は短いので、述語だけの一致（「〜は据え置きで」）や主題だけの一致（「結論としては〜」）でも
// 被覆率に届いてしまう。要点1行を丸ごと照合していた頃は残りの本文がそれを薄めていたが、
// 節ごとに照合するとその薄めが無くなる（実験で確認: 「採用計画は据え置きで」が
// 「価格改定の方針は据え置きで決まりました」を指した）。
function backsClause(clause, counts) {
  if (!counts) return false;
  const t = String(clause || '').replace(TRAIL, '');
  const head = clauseHead(t);
  const has = (s) => bigrams(s).some((g) => counts.has(g));
  if (!has(head)) return false;
  const rest = t.slice(head.length);
  return normalize(rest).length < 2 || has(rest);
}

/**
 * 要点1行を節に割って照合し、和を取る。
 * @param {string} text 要点の本文
 * @param {object} idx  buildIndex の結果
 * @param {object} [opts] matchOne の閾値に加えて tail（各節のクエリ末尾に足す語。todo の担当名）
 * @returns {Array<{id:string, score:number}>} 最良スコア順、要点あたり最大 MAX_CITES_PER_LINE 件
 */
function matchLine(text, idx, opts) {
  const o = opts || {};
  const tail = o.tail ? ` ${o.tail}` : '';
  const clauses = splitClauses(text);
  if (clauses.length <= 1) return matchOne(`${text}${tail}`, idx, o);
  const best = new Map();   // segId -> 最良の一致
  for (const c of clauses) {
    // 併合で文字数は足りていても、同じ文字の繰り返しなどで固有のバイグラムが少ない節は
    // 偶然一致の温床なので単独では照合しない。
    if (new Set(bigrams(c)).size < MIN_CLAUSE_GRAMS) continue;
    for (const h of matchOne(`${c}${tail}`, idx, o)) {
      if (!backsClause(c, idx.segBigrams.get(h.id))) continue;
      const cur = best.get(h.id);
      if (!cur || h.score > cur.score) best.set(h.id, h);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CITES_PER_LINE);
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
    // 人が足した行（store が citeState:'manual' を付ける）は照合しない。
    // 照合すると「手書き（照合対象外）」の札と時刻チップが同じ行に並んで矛盾する。
    if (b.citeState === 'manual') continue;
    if (!isCitable(b.text)) { b.citeSkip = true; skipped++; continue; }
    delete b.citeSkip;
    total++;
    const hits = matchLine(b.text, idx, Object.assign({}, opts, { tail: citeTail(b) }));
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
    if (b.citeState === 'manual' || !isCitable(b.text)) continue;
    if (Array.isArray(b.cites) && b.cites.length) linked++;
  }
  return { linked, total: r.total, skipped: r.skipped };
}

/**
 * 文字起こしの世代をまたいで出典を付ける（#4）。
 *
 * 文字起こしをやり直す（別モデル・別設定で再認識する）と、区間は id と時刻が同じまま
 * text だけ変わる。要約は古い世代の本文から作られていることがあり、新しい本文だけに
 * 照合すると、「アイス推進室」（旧）の文言で書かれた要点が「AI推進室」（新）の区間に届かない。
 *
 * id が同じで text が違う区間は「新しい本文 + 改行 + 古い本文」を1区間として照合する。
 * どちらの言い回しでも同じ id に当たり、cites に入るのは実在の id だけ
 * （合成区間の id は元の id そのもの。古い世代にしか無い区間は使わない —
 * もう文字起こしに無い発言へはリンクできない）。
 * 認識に失敗した区間（failed）は両側とも材料にしない。失敗の定型文を要約が写して
 * いても、そこへリンクしても何も読めない。
 * 古い世代が無い・全て同じ本文なら attachCitations(blocks, fresh) と同じ結果になる。
 * @returns {{linked:number, total:number, skipped:number}}
 */
function attachCitationsAcross(blocks, freshSegments, oldSegments, opts) {
  const fresh = (Array.isArray(freshSegments) ? freshSegments : []).filter((s) => s && !s.failed);
  const old = new Map();
  for (const s of (Array.isArray(oldSegments) ? oldSegments : [])) {
    if (s && !s.failed && typeof s.text === 'string') old.set(s.id, s);
  }
  const merged = fresh.map((s) => {
    const o = old.get(s.id);
    return (o && o.text !== s.text) ? { ...s, text: `${s.text}\n${o.text}` } : s;
  });
  return attachCitations(blocks, merged, opts);
}

module.exports = { attachCitations, refreshCitations, attachCitationsAcross, buildIndex, matchOne,
  matchLine, splitClauses, bigrams, normalize, searchFold, isCitable, citeText, citeTail,
  MIN_CITE_CHARS, MAX_CITES_PER_LINE };
