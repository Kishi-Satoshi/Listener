/*
 * cite.test.js — 出典マッチング
 *
 * この製品の中核。誤リンク（無関係な発言に飛ぶ）は無リンクより有害なので、
 * 「拾えること」より「間違ったものを拾わないこと」を厚く確認する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { attachCitations, refreshCitations, attachCitationsAcross, buildIndex, matchOne, matchLine, splitClauses,
  bigrams, normalize, citeTail, MAX_CITES_PER_LINE,
  isCitable, citeText, MIN_CITE_CHARS } = require('../src/cite');

const SEGS = [
  { id: 's1', atMs: 0, text: '在庫連携のバッチ処理ですが、1万件の取り込みに4分かかっています。' },
  { id: 's2', atMs: 75000, text: '採用の応募は今月8名でした。一次面接まで進んだのが3名です。' },
  { id: 's3', atMs: 150000, text: 'リリース日は11月15日で確定ということでよろしいですね。' },
  { id: 's4', atMs: 225000, text: 'そうですね。はい。分かりました。' },
  { id: 's5', atMs: 300000, text: '請求書の締め処理は毎月20日までにお願いします。' },
];

test('normalize が記号と空白を落とす', () => {
  assert.strictEqual(normalize('こんにちは、世界！ (テスト)'), 'こんにちは世界テスト');
  assert.strictEqual(normalize(''), '');
  assert.strictEqual(normalize(null), '');
});

test('bigrams が隣接2文字を返す', () => {
  assert.deepStrictEqual(bigrams('あいう'), ['あい', 'いう']);
  assert.deepStrictEqual(bigrams('あ'), ['あ']);
  assert.deepStrictEqual(bigrams(''), []);
});

test('言い換えた要点が元の発言を指す', () => {
  const idx = buildIndex(SEGS);
  const hits = matchOne('在庫連携のバッチ処理は1万件の取り込みに4分かかっている', idx);
  assert.ok(hits.length > 0, '根拠が見つからなかった');
  assert.strictEqual(hits[0].id, 's1');
});

test('別の話題の発言を拾わない', () => {
  const idx = buildIndex(SEGS);
  const hits = matchOne('採用の応募は今月8名だった', idx);
  assert.strictEqual(hits[0].id, 's2');
  assert.ok(!hits.some((h) => h.id === 's1'), 'バッチ処理の発言を巻き込んだ');
});

test('文字起こしに無い内容には根拠を返さない', () => {
  const idx = buildIndex(SEGS);
  const hits = matchOne('全社的なクラウド移行の方針決定が遅れている', idx);
  assert.deepStrictEqual(hits, []);
});

test('相槌のような中身の無い発言に引っ張られない', () => {
  const idx = buildIndex(SEGS);
  for (const q of ['請求書の締め処理は毎月20日まで', 'リリース日を11月15日で確定する']) {
    const hits = matchOne(q, idx);
    assert.ok(!hits.some((h) => h.id === 's4'), `相槌セグメントが選ばれた: ${q}`);
  }
});

test('返す根拠は最大2件', () => {
  const idx = buildIndex(SEGS);
  for (const q of SEGS.map((s) => s.text)) {
    assert.ok(matchOne(q, idx).length <= 2);
  }
});

test('スコアは降順', () => {
  const idx = buildIndex(SEGS);
  const hits = matchOne('リリース日は11月15日で確定', idx, { threshold: 0, minCoverage: 0, max: 5 });
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
});

test('閾値を上げると根拠が減る（調整が効く）', () => {
  const idx = buildIndex(SEGS);
  const q = '採用の応募は今月8名だった';
  const loose = matchOne(q, idx, { threshold: 0, minCoverage: 0, max: 5 }).length;
  const strict = matchOne(q, idx, { threshold: 0.95, minCoverage: 0.9, max: 5 }).length;
  assert.ok(strict <= loose);
});

test('attachCitations は存在しないセグメントIDを作らない', () => {
  const blocks = [
    { id: 'b1', type: 'bullet', text: 'バッチ処理は1万件で4分かかっている', cites: [] },
    { id: 'b2', type: 'bullet', text: '宇宙開発の予算が増額された', cites: [] },
    { id: 'b3', type: 'todo', text: '請求書の締め処理を毎月20日までに行う', cites: [] },
  ];
  attachCitations(blocks, SEGS);
  const ids = new Set(SEGS.map((s) => s.id));
  for (const b of blocks) for (const c of b.cites) assert.ok(ids.has(c), `捏造ID: ${c}`);
  assert.deepStrictEqual(blocks[1].cites, [], '無関係な要点にリンクが付いた');
});

test('attachCitations は heading / paragraph を対象にしない', () => {
  const blocks = [
    { id: 'b1', type: 'heading', text: '在庫連携のバッチ処理について' },
    { id: 'b2', type: 'paragraph', text: '在庫連携のバッチ処理は1万件で4分かかっている' },
  ];
  const stat = attachCitations(blocks, SEGS);
  assert.strictEqual(stat.total, 0);
  assert.strictEqual(blocks[0].cites, undefined);
  assert.strictEqual(blocks[1].cites, undefined);
});

test('短すぎる要点は対象外（偶然一致を避ける）', () => {
  const blocks = [{ id: 'b1', type: 'bullet', text: '完了', cites: [] }];
  const stat = attachCitations(blocks, SEGS);
  assert.strictEqual(stat.total, 0);
});

test('文字起こしが無い・空でも落ちない', () => {
  const mk = () => [{ id: 'b1', type: 'bullet', text: 'バッチ処理は1万件で4分かかっている', cites: [] }];
  for (const segs of [[], null, undefined]) {
    const blocks = mk();
    const stat = attachCitations(blocks, segs);
    assert.deepStrictEqual(stat, { linked: 0, total: 0, skipped: 0 });
    assert.deepStrictEqual(blocks[0].cites, []);
  }
});

test('再実行しても結果が変わらない（冪等）', () => {
  const mk = () => [{ id: 'b1', type: 'bullet', text: '採用の応募は今月8名だった', cites: [] }];
  const a = mk(); attachCitations(a, SEGS);
  const b = mk(); attachCitations(b, SEGS); attachCitations(b, SEGS);
  assert.deepStrictEqual(a[0].cites, b[0].cites);
});

// ---------------------------------------------------------------- 記号の正規化
//
// 要約に「**内定**: 0名」のような装飾が残ると、索引に無いバイグラムが増えて
// 被覆率のふるいに掛かり、出典が丸ごと消える。要約側で落としてはいるが、
// ユーザーが手で書いた記号もあるので、ここでも落とす。
test('装飾の記号は突き合わせの前に落ちる', () => {
  assert.strictEqual(normalize('**内定**: 0名'), '内定0名');
  assert.strictEqual(normalize('__強調__'), '強調');
  assert.strictEqual(normalize('内定は0名'), '内定は0名');
});

test('装飾が付いていても同じ発言に当たる', () => {
  const segs = [
    { id: 's1', text: '採用の状況ですが、応募は8名で、内定は0名です。' },
    { id: 's2', text: '来週の定例で、在庫連携のバッチ処理の話をします。' },
  ];
  const idx = buildIndex(segs);
  const plain = matchOne('内定は0名', idx);
  const decorated = matchOne('**内定**は0名', idx);
  assert.deepStrictEqual(decorated.map((h) => h.id), plain.map((h) => h.id),
    '装飾の有無で出典が変わってはいけない');
  assert.ok(plain.length > 0, '素の文でも出典が付いていない（前提が崩れている）');
});

// ---------------------------------------------------------------- 文字起こしの編集後の付け直し
// 文字起こしを直したあと、全要点を引き直してはいけない。人が自分の言葉に書き直した
// 要点（updateBlock は出典を触らない）が再照合で「根拠なし」に落ちるため。
// 触ってよいのは「その区間を根拠にしていた要点」と「根拠なしの要点」だけ。

function mkBlocks() {
  return [
    { id: 'h1', type: 'heading', text: '進捗', cites: [] },
    { id: 'b1', type: 'bullet', text: '在庫連携のバッチは1万件の取り込みに4分かかっている', cites: [] },
    { id: 'b2', type: 'bullet', text: '採用の応募は今月8名、一次面接に進んだのは3名', cites: [] },
    { id: 'b3', type: 'bullet', text: 'リリース日は11月15日で確定', cites: [] },
  ];
}

test('refreshCitations: 編集した区間を根拠にしていない要点の出典は、1文字も動かない', () => {
  const blocks = mkBlocks();
  attachCitations(blocks, SEGS);
  // b1 を人が自分の言葉に書き直した想定。再照合すると根拠なしに落ちる文にする
  const b1 = blocks.find((b) => b.id === 'b1');
  assert.deepStrictEqual(b1.cites, ['s1']);
  b1.text = '性能問題は継続調査';
  const before = JSON.parse(JSON.stringify(blocks.map((b) => b.cites)));
  // s2（採用）を編集した → s1 を根拠にしていた b1 は触らない
  refreshCitations(blocks, SEGS, 's2');
  assert.deepStrictEqual(b1.cites, ['s1'], '編集していない区間の出典が動いた');
  assert.deepStrictEqual(blocks.find((b) => b.id === 'b3').cites, before[3]);
});

test('refreshCitations: 編集した区間を根拠にしていた要点は再照合される（根拠が消えれば外れる）', () => {
  const blocks = mkBlocks();
  attachCitations(blocks, SEGS);
  const b2 = blocks.find((b) => b.id === 'b2');
  assert.deepStrictEqual(b2.cites, ['s2']);
  // s2 の本文を空にした（実質の削除）
  const segs = SEGS.map((s) => (s.id === 's2' ? { ...s, text: '' } : s));
  const r = refreshCitations(blocks, segs, 's2');
  assert.deepStrictEqual(b2.cites, [], '根拠が消えたのにリンクが残っている');
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.linked, 2);
});

test('refreshCitations: 根拠なしだった要点は、区間を直したあとに出典が付く', () => {
  // 認識ミスで s2 が崩れている状態から始める
  const broken = SEGS.map((s) => (s.id === 's2' ? { ...s, text: '再曜の往復は今月八名でした。位置面接まで済んだのが参名です。' } : s));
  const blocks = mkBlocks();
  attachCitations(blocks, broken);
  const b2 = blocks.find((b) => b.id === 'b2');
  assert.deepStrictEqual(b2.cites, [], '前提が崩れた（崩れた文に一致してしまう）');
  // 人が s2 を直した
  const r = refreshCitations(blocks, SEGS, 's2');
  assert.deepStrictEqual(b2.cites, ['s2'], '直したのに出典が付かない');
  assert.strictEqual(r.linked, 3);
});

test('refreshCitations: 全ての出典が実在する区間を指す', () => {
  const blocks = mkBlocks();
  attachCitations(blocks, SEGS);
  refreshCitations(blocks, SEGS, 's3');
  const ids = new Set(SEGS.map((s) => s.id));
  for (const b of blocks) for (const c of b.cites || []) assert.ok(ids.has(c), `存在しない id ${c}`);
});

test('refreshCitations: 二度掛けても結果が変わらない（冪等）', () => {
  const blocks = mkBlocks();
  attachCitations(blocks, SEGS);
  blocks.find((b) => b.id === 'b1').text = '性能問題は継続調査';
  const r1 = refreshCitations(blocks, SEGS, 's2');
  const snap = JSON.stringify(blocks.map((b) => b.cites));
  const r2 = refreshCitations(blocks, SEGS, 's2');
  assert.strictEqual(JSON.stringify(blocks.map((b) => b.cites)), snap);
  assert.deepStrictEqual(r1, r2);
});

test('refreshCitations: 区間が空なら {0,0} を返し、出典に触らない', () => {
  const blocks = mkBlocks();
  attachCitations(blocks, SEGS);
  const snap = JSON.stringify(blocks.map((b) => b.cites));
  const r = refreshCitations(blocks, [], 's1');
  assert.deepStrictEqual(r, { linked: 0, total: 0, skipped: 0 });
  assert.strictEqual(JSON.stringify(blocks.map((b) => b.cites)), snap);
});

// ---------------------------------------------------------------- 照合対象外の印
// 短い要点は偶然一致を避けるため照合しない。その閾値は1か所（MIN_CITE_CHARS）に置き、
// 対象外になった行には citeSkip を付けて「根拠なし」と見分けられるようにする。
// 「根拠を探したが無かった」と「そもそも探していない」は画面で区別したい。
test('isCitable: 正規化後の文字数で判定する（生の文字数ではない）', () => {
  assert.strictEqual(MIN_CITE_CHARS, 6);
  // 生6文字・正規化5文字（「。」が落ちる）
  assert.strictEqual(isCitable('A社と合意。'), false);
  assert.strictEqual(isCitable('A社との合意。'), true);
  assert.strictEqual(isCitable(''), false);
  assert.strictEqual(isCitable(null), false);
});

test('attachCitations: 短い行に citeSkip が付き、total に入らない', () => {
  const blocks = [
    { id: 'b1', type: 'bullet', text: 'A社と合意。', cites: [] },
    { id: 'b2', type: 'todo', text: '完了', cites: [] },
    { id: 'b3', type: 'bullet', text: '採用の応募は今月8名だった', cites: [] },
    { id: 'h1', type: 'heading', text: '短い' },
  ];
  const stat = attachCitations(blocks, SEGS);
  assert.strictEqual(blocks[0].citeSkip, true);
  assert.strictEqual(blocks[1].citeSkip, true);
  assert.strictEqual(blocks[2].citeSkip, undefined);
  assert.strictEqual(blocks[3].citeSkip, undefined, '見出しには印を付けない');
  assert.strictEqual(stat.total, 1);
  assert.strictEqual(stat.skipped, 2);
  assert.strictEqual(stat.linked, 1);
});

test('attachCitations: 行を長く直したら citeSkip が消える', () => {
  const blocks = [{ id: 'b1', type: 'bullet', text: 'A社と合意。', cites: [] }];
  attachCitations(blocks, SEGS);
  assert.strictEqual(blocks[0].citeSkip, true);
  blocks[0].text = '採用の応募は今月8名だった';
  const stat = attachCitations(blocks, SEGS);
  assert.strictEqual(blocks[0].citeSkip, undefined);
  assert.strictEqual(stat.skipped, 0);
  assert.strictEqual(stat.total, 1);
});

test('refreshCitations: citeSkip の付け外しと skipped は attachCitations と同じ', () => {
  const blocks = mkBlocks();
  blocks.push({ id: 'b4', type: 'bullet', text: 'A社と合意。', cites: [] });
  attachCitations(blocks, SEGS);
  blocks[4].text = '採用の応募は今月8名だった';
  blocks[1].text = '合意。';
  const r = refreshCitations(blocks, SEGS, 's2');
  assert.strictEqual(blocks[4].citeSkip, undefined);
  assert.strictEqual(blocks[1].citeSkip, true);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.total, 3);
});

// ---------------------------------------------------------------- 担当名を含めた照合
// 担当・期限は本文から抜いてから照合する（書式が混ざると一致がぶれる）。
// その結果、同じ作業を別の人に振った todo が本文だけでは区別できず、
// 互いの発言を指してしまう。担当名だけをクエリに戻して照合する。
const ASSIGN_SEGS = [
  { id: 's1', atMs: 0, text: '田中さんは来期の予算案の資料を作成してください。' },
  { id: 's2', atMs: 1000, text: '在庫連携のバッチ処理は今週中に見直します。' },
  { id: 's3', atMs: 2000, text: '佐藤さんは来期の予算案の資料を作成してください。' },
];

test('citeText: 担当付きの todo だけ担当名をクエリに足す（表示本文は変えない）', () => {
  assert.strictEqual(citeText({ type: 'todo', text: '資料を作成する', assignee: '田中' }), '資料を作成する 田中');
  assert.strictEqual(citeText({ type: 'todo', text: '資料を作成する', assignee: '' }), '資料を作成する');
  assert.strictEqual(citeText({ type: 'todo', text: '資料を作成する' }), '資料を作成する');
  assert.strictEqual(citeText({ type: 'bullet', text: '資料を作成する', assignee: '田中' }), '資料を作成する');
});

test('同じ作業を別人に割り当てた todo が、それぞれの担当への発言を指す', () => {
  const blocks = [
    { id: 'b1', type: 'todo', text: '来期の予算案の資料を作成する', assignee: '田中', cites: [] },
    { id: 'b2', type: 'todo', text: '来期の予算案の資料を作成する', assignee: '佐藤', cites: [] },
  ];
  attachCitations(blocks, ASSIGN_SEGS);
  assert.strictEqual(blocks[0].cites[0], 's1', `田中の todo: ${JSON.stringify(blocks[0].cites)}`);
  assert.strictEqual(blocks[1].cites[0], 's3', `佐藤の todo: ${JSON.stringify(blocks[1].cites)}`);
  assert.strictEqual(blocks[0].text, '来期の予算案の資料を作成する', '表示本文が変わった');
});

test('refreshCitations でも担当名を含めて照合する', () => {
  const blocks = [
    { id: 'b1', type: 'todo', text: '来期の予算案の資料を作成する', assignee: '佐藤', cites: [] },
  ];
  attachCitations(blocks, ASSIGN_SEGS);
  refreshCitations(blocks, ASSIGN_SEGS, 's3');
  assert.strictEqual(blocks[0].cites[0], 's3');
});

// ---------------------------------------------------------------- 人が足した行は照合しない
test('attachCitations / refreshCitations は citeState=manual の行を照合せず、分母にも数えない', () => {
  const blocks = mkBlocks();
  blocks.push({ id: 'm1', type: 'bullet', text: '在庫連携のバッチ処理は1万件の取り込みに4分かかっている', cites: [], citeState: 'manual' });
  const r = attachCitations(blocks, SEGS);
  const m1 = blocks.find((b) => b.id === 'm1');
  assert.deepStrictEqual(m1.cites, [], '手書きの行に出典が付いた（「手書き」の札と時刻チップが同じ行に並ぶ）');
  assert.strictEqual(m1.citeSkip, undefined);
  assert.strictEqual(r.total, 3, '手書きの行が分母に入った');
  const r2 = refreshCitations(blocks, SEGS, 's1');
  assert.deepStrictEqual(m1.cites, [], 'refreshCitations が手書きの行に出典を付けた');
  assert.strictEqual(r2.total, 3);
});

// ---------------------------------------------------------------- 文字起こしの世代をまたぐ出典（#4）
// 文字起こしをやり直すと区間は id と時刻が同じまま本文だけ変わる。要約が古い世代の
// 文言で書かれていても、同じ id の区間に出典が付くこと。実在しない id・古い世代にしか
// 無い区間・認識に失敗した区間へはリンクしないこと（誤リンクは無リンクより有害）。
const GEN_OLD = [
  { id: 's1', atMs: 0, text: 'アイス推進室は来期に立ち上げます。' },                 // 旧: 誤認識
  { id: 's2', atMs: 1000, text: '在庫連携のバッチ処理は今週中に見直します。' },
  { id: 's3', atMs: 2000, text: '採用の応募は今月8名でした。' },                     // 旧は読めたが新は失敗
  { id: 's4', atMs: 3000, text: '（この区間の認識に失敗: timeout）', failed: true },   // 旧は失敗、新は読めた
  { id: 's9', atMs: 9000, text: '宇宙開発の予算が増額されました。' },                 // 旧世代にしか無い区間
];
const GEN_NEW = [
  { id: 's1', atMs: 0, text: 'AI推進室は来期に立ち上げます。' },
  { id: 's2', atMs: 1000, text: '在庫連携のバッチ処理は今週中に見直します。' },
  { id: 's3', atMs: 2000, text: '（この区間の認識に失敗: timeout）', failed: true },
  { id: 's4', atMs: 3000, text: '請求書の締め処理は毎月20日までにお願いします。' },
];

test('attachCitationsAcross: 古い文言（アイス推進室）の要点が、新しい本文（AI推進室）の同じ区間を指す', () => {
  // 要点の大半が変わった語で占められていて、新しい本文だけでは被覆率に届かない形にする
  // （少しの違いならバイグラム照合がもともと吸収するので、この機能の効き目が見えない）
  const mk = () => [{ id: 'b1', type: 'bullet', text: 'アイス推進室を新設', cites: [] }];
  const only = mk();
  attachCitations(only, GEN_NEW.filter((s) => !s.failed));
  assert.deepStrictEqual(only[0].cites, [], '前提が崩れた（新しい本文だけで届いている）');
  const across = mk();
  const r = attachCitationsAcross(across, GEN_NEW, GEN_OLD);
  assert.deepStrictEqual(across[0].cites, ['s1']);
  assert.deepStrictEqual(r, { linked: 1, total: 1, skipped: 0 });
});

test('attachCitationsAcross: 出典は新しい世代に実在する id だけ（旧世代にしか無い区間・失敗した区間は使わない）', () => {
  const blocks = [
    { id: 'b1', type: 'bullet', text: '宇宙開発の予算が増額', cites: [] },        // 旧世代にしか無い s9
    { id: 'b2', type: 'bullet', text: '採用の応募は今月8名', cites: [] },          // 新世代で失敗した s3
    { id: 'b3', type: 'bullet', text: 'この区間の認識に失敗', cites: [] },        // 旧世代の失敗の定型文（s4）
    { id: 'b4', type: 'bullet', text: '請求書の締め処理は毎月20日まで', cites: [] }, // 新世代で読めた s4
    { id: 'b5', type: 'bullet', text: '全社的なクラウド移行の方針決定が遅れている', cites: [] },
  ];
  attachCitationsAcross(blocks, GEN_NEW, GEN_OLD);
  assert.deepStrictEqual(blocks[0].cites, [], '旧世代にしか無い区間へリンクした');
  assert.deepStrictEqual(blocks[1].cites, [], '新世代で失敗した区間へリンクした');
  assert.deepStrictEqual(blocks[2].cites, [], '旧世代の失敗の定型文が照合の材料になった');
  assert.deepStrictEqual(blocks[3].cites, ['s4']);
  assert.deepStrictEqual(blocks[4].cites, [], '無関係な要点にリンクが付いた');
  const ids = new Set(GEN_NEW.filter((s) => !s.failed).map((s) => s.id));
  for (const b of blocks) for (const c of b.cites) assert.ok(ids.has(c), `実在しない id ${c}`);
});

test('attachCitationsAcross: 旧世代と新世代が同じなら attachCitations(blocks, fresh) と同じ結果', () => {
  const a = mkBlocks();
  const b = mkBlocks();
  const ra = attachCitations(a, SEGS);
  const rb = attachCitationsAcross(b, SEGS, JSON.parse(JSON.stringify(SEGS)));
  assert.deepStrictEqual(b.map((x) => x.cites), a.map((x) => x.cites));
  assert.deepStrictEqual(rb, ra);
  assert.ok(ra.linked > 0, '前提が崩れた（比較対象に出典が1つも無い）');
});

test('attachCitationsAcross: 旧世代が無い・空でも attachCitations と同じで、落ちない', () => {
  for (const old of [undefined, null, []]) {
    const a = mkBlocks();
    const b = mkBlocks();
    const ra = attachCitations(a, SEGS);
    const rb = attachCitationsAcross(b, SEGS, old);
    assert.deepStrictEqual(b.map((x) => x.cites), a.map((x) => x.cites));
    assert.deepStrictEqual(rb, ra);
  }
  const c = mkBlocks();
  assert.deepStrictEqual(attachCitationsAcross(c, [], GEN_OLD), { linked: 0, total: 0, skipped: 0 });
  assert.deepStrictEqual(c.map((x) => x.cites), mkBlocks().map((x) => x.cites), '新世代が空なのに出典に触った');
});

test('attachCitationsAcross: 渡した区間配列を書き換えない（合成は照合用の写しだけ）', () => {
  const freshSnap = JSON.stringify(GEN_NEW);
  const oldSnap = JSON.stringify(GEN_OLD);
  attachCitationsAcross(mkBlocks(), GEN_NEW, GEN_OLD);
  assert.strictEqual(JSON.stringify(GEN_NEW), freshSnap);
  assert.strictEqual(JSON.stringify(GEN_OLD), oldSnap);
});

// ---------------------------------------------------------------- 節ごとの照合（#2）
// 2〜3 の発言をまとめた要点は、要点1行の被覆率では各発言が 1/3 しか覆えず、チップが
// 1つになるか（2〜3 発言）、1つも付かなくなる（4 発言以上）。節に割って同じ閾値で照合する。
// 閾値は下げない。節が1つの要点は matchOne と全く同じ結果でなければならない。
// 節に割ると「残りの本文が偶然一致を薄める」効果が消えるので、精度の試験を厚くする。
const CLAUSE_SEGS = [
  { id: 'a1', atMs: 0, text: '認証まわりの実装ですが、二週間ほど遅れています。' },
  { id: 'a2', atMs: 1000, text: 'テストの方は予定通り進んでいます。' },
  { id: 'a3', atMs: 2000, text: 'リリース日は来月末のまま変更しない、ということでお願いします。' },
  { id: 'a4', atMs: 3000, text: 'はい、そうですね。分かりました。' },
  { id: 'a5', atMs: 4000, text: '来週の定例では採用の話をします。' },
  { id: 'a6', atMs: 5000, text: '価格改定の方針は据え置きで決まりました。' },
  { id: 'a7', atMs: 6000, text: '結論としては、来期に持ち越しです。' },
];
const THREE = '認証の実装が二週間遅れているがテストは予定通りで、リリース日は来月末のまま変更しない';

test('splitClauses: 句読点と述語のあとの「が」で節に割れ、つなぐと元に戻る', () => {
  const clauses = splitClauses(THREE);
  assert.deepStrictEqual(clauses, ['認証の実装が二週間遅れているが', 'テストは予定通りで、', 'リリース日は来月末のまま変更しない']);
  assert.strictEqual(clauses.join(''), THREE);
  // 主格の「が」（実装が）では切らない
  assert.ok(!clauses.includes('認証の実装が'));
  assert.deepStrictEqual(splitClauses('今月の応募は8名、一次面接まで進んだのが3名、内定は0名。'),
    ['今月の応募は8名、', '一次面接まで進んだのが3名、内定は0名。']);
});

test('splitClauses: 述語を持たない断片・短い断片は次の節に併合し、末尾の「。」は節を増やさない', () => {
  // 「来週の定例で、」「営業部の山田さんが、」は連用修飾・主題。単独で照合すると
  // 同じ場や人物に触れただけの発言に満点で当たるので、節にしない
  for (const text of [
    '来週の定例で、認証の実装の遅れについて報告する',
    '営業部の山田さんが、来週の定例で報告する',
    '今月末までに、在庫連携のバッチ処理を見直す',
    '価格、納期、品質の三点で、A社と再交渉する',
    'A社と、合意した',
    'リリース日を11月15日で確定する。',
    '採用の応募は今月8名だった',
  ]) {
    assert.deepStrictEqual(splitClauses(text), [text], `節に割れてしまった: ${JSON.stringify(splitClauses(text))}`);
  }
  assert.deepStrictEqual(splitClauses(''), []);
  assert.deepStrictEqual(splitClauses(null), []);
});

test('matchLine: 3つの発言をまとめた要点に、3つ全ての出典が付く', () => {
  const idx = buildIndex(CLAUSE_SEGS);
  const whole = matchOne(THREE, idx).map((h) => h.id);
  assert.ok(whole.length <= 1, `前提が崩れた（要点1行の照合で複数に届いている）: ${whole}`);
  const ids = matchLine(THREE, idx).map((h) => h.id);
  for (const id of ['a1', 'a2', 'a3']) assert.ok(ids.includes(id), `${id} が無い: ${ids}`);
  assert.ok(!ids.includes('a4') && !ids.includes('a5'), `無関係な発言を巻き込んだ: ${ids}`);
});

test('matchLine: 無関係な話題の要点には、節に割っても出典が付かない', () => {
  const idx = buildIndex(CLAUSE_SEGS);
  for (const text of [
    '全社的なクラウド移行の方針決定が遅れているので、来期の予算は据え置きとする',
    '営業部の目標は据え置き。マーケの予算は倍増、広告は削減する。',
  ]) {
    assert.ok(splitClauses(text).length >= 2, `前提が崩れた（節に割れていない）: ${text}`);
    assert.deepStrictEqual(matchLine(text, idx), [], `無関係な要点に出典が付いた: ${text}`);
  }
});

test('matchLine: 節が1つの要点は matchOne と全く同じ結果（要点1行の挙動は変えない）', () => {
  const idx = buildIndex(SEGS);
  for (const text of [
    '在庫連携のバッチ処理は1万件の取り込みに4分かかっている', '採用の応募は今月8名だった',
    '全社的なクラウド移行の方針決定が遅れている', '請求書の締め処理は毎月20日まで',
    'リリース日を11月15日で確定する', '内定は0名', 'バッチ処理は1万件で4分かかっている',
    '来週の定例で、認証の実装の遅れについて報告する',
  ]) {
    assert.strictEqual(splitClauses(text).length, 1, `前提が崩れた（節が1つでない）: ${text}`);
    assert.deepStrictEqual(matchLine(text, idx), matchOne(text, idx), text);
    assert.deepStrictEqual(matchLine(text, idx, { tail: '田中' }), matchOne(`${text} 田中`, idx), `${text} + 担当`);
  }
  // 要約の固定入力のうち節が1つの行も同じ
  const { STANDUP_SEGMENTS, STANDUP_SUMMARY_MD } = require('./fixtures');
  const { markdownToBlocks } = require('../src/minutes');
  const idx2 = buildIndex(STANDUP_SEGMENTS);
  let single = 0;
  for (const b of markdownToBlocks(STANDUP_SUMMARY_MD)) {
    if ((b.type !== 'bullet' && b.type !== 'todo') || splitClauses(b.text).length !== 1) continue;
    single++;
    assert.deepStrictEqual(matchLine(b.text, idx2), matchOne(b.text, idx2), b.text);
  }
  assert.ok(single >= 3, `節が1つの要点が少なすぎて比較になっていない: ${single}`);
});

test('matchLine: 連用修飾の断片（来週の定例で）を単独で照合せず、同じ場に触れただけの発言を指さない', () => {
  const idx = buildIndex(CLAUSE_SEGS);
  const text = '来週の定例で、認証の実装の遅れについて報告する';
  assert.ok(!matchLine(text, idx).some((h) => h.id === 'a5'), '「来週の定例では採用の話をします」を指した');
  assert.deepStrictEqual(matchLine(text, idx), matchOne(text, idx));
});

test('matchLine: 述語だけ・主題だけが一致する発言は節の根拠にしない', () => {
  const idx = buildIndex(CLAUSE_SEGS);
  // 「〜は据え置きで」だけが共通（主題が違う）→ 価格改定の発言を指してはいけない
  const t1 = '採用計画は据え置きで、来週の定例で最終確認する';
  // 「結論としては」だけが共通（述語が違う）→ 持ち越しの発言を指してはいけない
  const t2 = '結論としては据え置きで、詳細は次回に回す';
  for (const [text, bad] of [[t1, 'a6'], [t2, 'a7']]) {
    assert.ok(splitClauses(text).length >= 2, `前提が崩れた（節に割れていない）: ${text}`);
    const ids = matchLine(text, idx).map((h) => h.id);
    assert.ok(!ids.includes(bad), `${bad} を指した: ${ids}`);
    assert.deepStrictEqual(ids, matchOne(text, idx).map((h) => h.id), '要点1行の照合より多くの出典が付いた');
  }
});

test('matchLine: 要点1行の出典は最大 MAX_CITES_PER_LINE 件、スコア降順、重複なし、実在する id だけ', () => {
  const { STANDUP_SEGMENTS } = require('./fixtures');
  const idx = buildIndex(STANDUP_SEGMENTS);
  const text = STANDUP_SEGMENTS.slice(1, 8).map((s) => s.text.slice(0, 20)).join('、');
  assert.ok(splitClauses(text).length > MAX_CITES_PER_LINE, '前提が崩れた（節が上限より少ない）');
  const hits = matchLine(text, idx);
  assert.strictEqual(MAX_CITES_PER_LINE, 4);
  assert.strictEqual(hits.length, MAX_CITES_PER_LINE);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
  assert.strictEqual(new Set(hits.map((h) => h.id)).size, hits.length);
  const ids = new Set(STANDUP_SEGMENTS.map((s) => s.id));
  for (const h of hits) assert.ok(ids.has(h.id), `実在しない id ${h.id}`);
});

test('citeTail: 担当付きの todo だけ担当名を返す（citeText はその組み立て）', () => {
  assert.strictEqual(citeTail({ type: 'todo', text: 'x', assignee: '田中' }), '田中');
  assert.strictEqual(citeTail({ type: 'todo', text: 'x' }), '');
  assert.strictEqual(citeTail({ type: 'bullet', text: 'x', assignee: '田中' }), '');
  assert.strictEqual(citeText({ type: 'todo', text: '資料を作成する', assignee: '田中' }), '資料を作成する 田中');
});

test('attachCitations: 節ごとの照合でも担当名は各節に効く（作業を書いた先頭の節が別人の発言を指さない）', () => {
  const segs = [...ASSIGN_SEGS, { id: 's4', atMs: 3000, text: '来週の定例で共有しましょう。' }];
  const blocks = [
    { id: 'b1', type: 'todo', text: '来期の予算案の資料を作成し、来週の定例で共有する', assignee: '田中', cites: [] },
    { id: 'b2', type: 'todo', text: '来期の予算案の資料を作成し、来週の定例で共有する', assignee: '佐藤', cites: [] },
  ];
  assert.strictEqual(splitClauses(blocks[0].text).length, 2);
  attachCitations(blocks, segs);
  assert.strictEqual(blocks[0].cites[0], 's1', `田中の todo: ${JSON.stringify(blocks[0].cites)}`);
  assert.strictEqual(blocks[1].cites[0], 's3', `佐藤の todo: ${JSON.stringify(blocks[1].cites)}`);
  assert.ok(blocks[0].cites.includes('s4'), `2つ目の節の出典が無い: ${JSON.stringify(blocks[0].cites)}`);
  assert.strictEqual(blocks[0].text, '来期の予算案の資料を作成し、来週の定例で共有する', '表示本文が変わった');
});

test('attachCitations / refreshCitations: 節ごとの照合でも冪等で、統計は実際の出典と一致する', () => {
  const idx = buildIndex(CLAUSE_SEGS);
  const mk = () => [
    { id: 'b1', type: 'bullet', text: THREE, cites: [] },
    { id: 'b2', type: 'bullet', text: '営業部の目標は据え置き。マーケの予算は倍増、広告は削減する。', cites: [] },
  ];
  const a = mk();
  const r = attachCitations(a, CLAUSE_SEGS);
  assert.deepStrictEqual(a[0].cites, matchLine(THREE, idx).map((h) => h.id));
  assert.deepStrictEqual(a[1].cites, []);
  assert.deepStrictEqual(r, { linked: 1, total: 2, skipped: 0 });
  const snap = JSON.stringify(a.map((b) => b.cites));
  attachCitations(a, CLAUSE_SEGS);
  assert.strictEqual(JSON.stringify(a.map((b) => b.cites)), snap);
  const r2 = refreshCitations(a, CLAUSE_SEGS, 'a2');
  assert.strictEqual(JSON.stringify(a.map((b) => b.cites)), snap);
  assert.deepStrictEqual(r2, r);
});
