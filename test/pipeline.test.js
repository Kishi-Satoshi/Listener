/*
 * pipeline.test.js — 要約パイプラインの結合テスト
 *
 * 要約エンジン（llama.cpp）は実行せず、モデルが返しそうなMarkdownを固定入力として与え、
 * そこから先（ブロック化 → 出典付与 → 担当・期限抽出）を通しで検証する。
 * 実機で確認できないのは「モデルが何を書くか」だけで、
 * 書かれたものをどう扱うかはここで押さえられる。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { markdownToBlocks, dropRedundantEmpty } = require('../src/minutes');
const { attachCitations } = require('../src/cite');
const { enrichActionBlocks } = require('../src/actions');
const mtype = require('../src/meetingType');
const { STANDUP_SEGMENTS, STANDUP_SUMMARY_MD, STANDUP_UNGROUNDED } = require('./fixtures');

// runSummary と同じ順序で実行する。
// 担当・期限の抽出が先。出典の突き合わせは「（担当: ○○ / 期限: ○○）」を
// 落とした本文に対して行う（書式が残るとその語がクエリに混ざって一致がぶれる）。
function runPipeline(md, segments, baseDate) {
  // 「特になし」の混入を先に落とす。ここで落とさないと
  // 「- [ ] 特になし」がアクション1件として数えられる。
  const blocks = dropRedundantEmpty(markdownToBlocks(md));
  const actionStat = enrichActionBlocks(blocks, baseDate);
  const citeStat = attachCitations(blocks, segments);
  return { blocks, citeStat, actionStat };
}

const BASE = new Date(2026, 9, 5); // 2026-10-05 (月)

test('要約Markdownが見出し・箇条書き・チェックボックスに正しく分解される', () => {
  const blocks = markdownToBlocks(STANDUP_SUMMARY_MD);
  const headings = blocks.filter((b) => b.type === 'heading').map((b) => b.text);
  assert.deepStrictEqual(headings,
    ['概要', '報告事項', '決定事項', 'アクションアイテム', '課題・持ち越し事項']);
  assert.strictEqual(blocks.filter((b) => b.type === 'todo').length, 3);
  assert.ok(blocks.filter((b) => b.type === 'bullet').length >= 6);
  // 「概要」直下の地の文は paragraph として残る（取りこぼさない）
  assert.ok(blocks.some((b) => b.type === 'paragraph' && b.text.includes('週次定例')));
});

test('要約の行が1行も失われない', () => {
  const nonEmptyLines = STANDUP_SUMMARY_MD.split('\n').filter((l) => l.trim()).length;
  assert.strictEqual(markdownToBlocks(STANDUP_SUMMARY_MD).length, nonEmptyLines);
});

test('出典リンクは必ず実在するセグメントを指す（捏造リンクが無い）', () => {
  const { blocks } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  const ids = new Set(STANDUP_SEGMENTS.map((s) => s.id));
  for (const b of blocks) {
    for (const id of b.cites || []) {
      assert.ok(ids.has(id), `存在しないセグメントID ${id} が ${b.type} 「${b.text}」に付いた`);
    }
  }
});

test('出典リンクが根拠となった発言を指している', () => {
  const { blocks } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  // 出典の対象は bullet / todo のみ。見出しと地の文は対象外なので探索から除く
  const find = (needle) => blocks.find(
    (b) => (b.type === 'bullet' || b.type === 'todo') && b.text.includes(needle));

  const batch = find('1万件の取り込みに4分');
  assert.ok(batch, '対象の要点が見つからない');
  assert.ok(batch.cites.includes('s3'),
    `バッチ性能の要点は s3 を指すべき: ${JSON.stringify(batch.cites)}`);

  const hiring = find('応募は8名');
  assert.ok(hiring.cites.includes('s6'),
    `採用実績の要点は s6 を指すべき: ${JSON.stringify(hiring.cites)}`);

  const release = find('11月15日で確定');
  assert.ok(release.cites.some((c) => c === 's9' || c === 's10'),
    `リリース日の決定は s9/s10 を指すべき: ${JSON.stringify(release.cites)}`);
});

test('文字起こしに根拠が無い要点には出典を付けない', () => {
  const { blocks } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  for (const text of STANDUP_UNGROUNDED) {
    const b = blocks.find((x) => x.text === text);
    assert.ok(b, `対象の行が見つからない: ${text}`);
    assert.deepStrictEqual(b.cites, [],
      `根拠の無い行に出典が付いた（誤リンクは無リンクより有害）: ${text}`);
  }
});

test('見出しと地の文には出典を付けない（対象は bullet / todo のみ）', () => {
  const { blocks } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  for (const b of blocks) {
    if (b.type === 'heading' || b.type === 'paragraph') {
      assert.deepStrictEqual(b.cites, [], `${b.type} に出典が付いた: ${b.text}`);
    }
  }
});

test('出典の統計が実際のブロック数と一致する', () => {
  const { blocks, citeStat } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  const target = blocks.filter((b) => (b.type === 'bullet' || b.type === 'todo') && b.text);
  const linked = target.filter((b) => b.cites.length);
  assert.strictEqual(citeStat.total, target.length);
  assert.strictEqual(citeStat.linked, linked.length);
  assert.ok(citeStat.linked / citeStat.total >= 0.6,
    `出典の被覆率が低すぎる: ${citeStat.linked}/${citeStat.total}`);
});

test('アクションアイテムから担当者と期限が取り出される', () => {
  const { blocks } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  const todos = blocks.filter((b) => b.type === 'todo');

  const idx = todos.find((b) => b.text.includes('実行計画'));
  assert.strictEqual(idx.assignee, '山田');
  assert.strictEqual(idx.due, '2026-10-16'); // 2026-10-05(月) の「来週金曜」
  assert.ok(!idx.text.includes('担当'), `本文に書式が残っている: ${idx.text}`);

  const job = todos.find((b) => b.text.includes('求人票'));
  assert.strictEqual(job.assignee, '佐藤');
  assert.strictEqual(job.due, '2026-10-31'); // 今月末

  // 担当・期限が書かれていない項目は空のまま（推測で埋めない）
  const fix = todos.find((b) => b.text.includes('残不具合'));
  assert.strictEqual(fix.assignee, '');
  assert.strictEqual(fix.due, '');
});

test('アクションの統計が実際のブロックと一致する', () => {
  const { blocks, actionStat } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  const todos = blocks.filter((b) => b.type === 'todo');
  assert.strictEqual(actionStat.total, todos.length);
  assert.strictEqual(actionStat.withAssignee, todos.filter((b) => b.assignee).length);
  assert.strictEqual(actionStat.withDue, todos.filter((b) => b.due).length);
});

test('担当・期限の抽出でアクションの本文が空にならない', () => {
  const { blocks } = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  for (const b of blocks.filter((x) => x.type === 'todo')) {
    assert.ok(b.text.trim().length > 0, 'アクションの本文が空になった');
  }
});

test('会議タイプが判定され、そのテンプレートの見出しが要約に使われる', () => {
  const plain = STANDUP_SEGMENTS.map((s) => s.text).join('\n');
  const type = mtype.detectType('週次定例', plain.slice(0, 1200));
  assert.strictEqual(type, 'standup');

  // テンプレートの見出しと、実際に生成された見出しが対応していること
  const wanted = mtype.getFormat(type).split('\n')
    .filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
  const got = markdownToBlocks(STANDUP_SUMMARY_MD)
    .filter((b) => b.type === 'heading').map((b) => b.text);
  assert.deepStrictEqual(got, wanted);
});

test('空の要約でもパイプラインが落ちない', () => {
  for (const md of ['', '   ', '\n\n\n', null, undefined]) {
    const r = runPipeline(md, STANDUP_SEGMENTS, BASE);
    assert.deepStrictEqual(r.blocks, []);
    assert.strictEqual(r.citeStat.total, 0);
  }
});

test('文字起こしが空でも出典付与が落ちない', () => {
  const r = runPipeline(STANDUP_SUMMARY_MD, [], BASE);
  assert.strictEqual(r.citeStat.total, 0);
  assert.strictEqual(r.citeStat.linked, 0);
  assert.ok(r.blocks.length > 0);
});

// ---------------------------------------------------------------- 文字起こしの編集
// 認識ミスで崩れた区間を人が直したら、その区間を根拠にすべき要点に出典が付き直る。
// 他の要点の出典は動かない（人が書き直した要点の出典が消える事故を防ぐ）。
test('崩れていた区間を直すと、その要点の出典が正しい発言へ移る。他の要点は動かない', () => {
  const { refreshCitations } = require('../src/cite');
  const broken = STANDUP_SEGMENTS.map((s) =>
    (s.id === 's6' ? { ...s, text: 'ご視聴ありがとうございました。' } : s));   // 無音区間で whisper が出す定番の幻聴
  const { blocks } = runPipeline(STANDUP_SUMMARY_MD, broken, BASE);
  const find = (needle) => blocks.find((b) => (b.type === 'bullet' || b.type === 'todo') && b.text.includes(needle));
  const hiring = find('応募は8名');
  assert.ok(hiring, '対象の要点が見つからない');
  assert.ok(!hiring.cites.includes('s6'), `前提が崩れた（崩れた文に一致してしまう）: ${JSON.stringify(hiring.cites)}`);
  const before = new Map(blocks.map((b) => [b.id, JSON.stringify(b.cites || [])]));

  const stat = refreshCitations(blocks, STANDUP_SEGMENTS, 's6');
  assert.ok(hiring.cites.includes('s6'), `直したのに s6 を指さない: ${JSON.stringify(hiring.cites)}`);
  for (const b of blocks) {
    if (b === hiring) continue;
    assert.strictEqual(JSON.stringify(b.cites || []), before.get(b.id), `編集と無関係な要点「${b.text}」の出典が動いた`);
  }
  const ids = new Set(STANDUP_SEGMENTS.map((s) => s.id));
  for (const b of blocks) for (const c of b.cites || []) assert.ok(ids.has(c), `存在しない id ${c}`);
  assert.ok(stat.total > 0 && stat.linked <= stat.total);
});

// ---------------------------------------------------------------- 表で書かれた報告
// 数値の多い会議でモデルが表を書いてくる。paragraph に落ちると出典が付かず、
// 「数値は必ず残す」と指示した肝心の行が根拠なしで並ぶ。
test('表で出た数値行に出典が付く', () => {
  const md = '## 報告事項\n| 項目 | 状況 |\n|---|---|\n'
    + '| 在庫連携のバッチ処理 | 1万件の取り込みに4分、目標は90秒 |\n'
    + '| 採用の応募 | 今月8名、一次面接まで進んだのが3名 |';
  const { blocks, citeStat } = runPipeline(md, STANDUP_SEGMENTS, BASE);
  const rows = blocks.filter((b) => b.type === 'bullet');
  assert.strictEqual(rows.length, 2, JSON.stringify(blocks.map((b) => `${b.type}:${b.text}`)));
  assert.ok(rows[0].cites.includes('s3'), `バッチの行: ${JSON.stringify(rows[0].cites)}`);
  assert.ok(rows[1].cites.includes('s6'), `採用の行: ${JSON.stringify(rows[1].cites)}`);
  assert.strictEqual(citeStat.total, 2);
  assert.strictEqual(citeStat.linked, 2);
});

// ---------------------------------------------------------------- 文字起こしのやり直し（#4）
// 旧世代（s6 が誤認識）から作った要約は、その誤認識の文言で書かれている。新世代（直った
// 文字起こし）に対して出典を付け直しても、その要点は同じ id（s6）を指し、他の要点は
// 新世代だけで付けた結果と 1 文字も変わらない。
test('やり直した文字起こしに対しても、旧文言の要点が同じ区間を指し、他の要点は動かない', () => {
  const { attachCitationsAcross } = require('../src/cite');
  const BROKEN = '再曜の往復は今月八名でした。位置面接まで済んだのが参名です。';
  const oldGen = STANDUP_SEGMENTS.map((s) => (s.id === 's6' ? { ...s, text: BROKEN } : s));
  // 旧世代から作った要約: 採用の行だけ誤認識の文言を写している
  const md = STANDUP_SUMMARY_MD.replace('- 今月の応募は8名、一次面接まで進んだのが3名、内定は0名。', '- 再曜の往復は今月八名。');
  assert.notStrictEqual(md, STANDUP_SUMMARY_MD, '置換対象の行が要約に無い');

  const plain = runPipeline(md, STANDUP_SEGMENTS, BASE);   // 新世代だけで付けた結果
  const blocks = dropRedundantEmpty(markdownToBlocks(md));
  enrichActionBlocks(blocks, BASE);
  const stat = attachCitationsAcross(blocks, STANDUP_SEGMENTS, oldGen);

  const find = (bs) => bs.find((b) => b.type === 'bullet' && b.text.includes('再曜の往復'));
  assert.deepStrictEqual(find(plain.blocks).cites, [], '前提が崩れた（新世代だけで旧文言の要点に出典が付いている）');
  assert.deepStrictEqual(find(blocks).cites, ['s6'], `旧文言の要点が s6 を指さない: ${JSON.stringify(find(blocks).cites)}`);
  for (const b of blocks) {
    if (b === find(blocks)) continue;
    const same = plain.blocks.find((x) => x.text === b.text && x.type === b.type);
    assert.ok(same, `比較対象の行が見つからない: ${b.text}`);
    assert.deepStrictEqual(b.cites || [], same.cites || [], `旧世代の混入で無関係な要点「${b.text}」の出典が動いた`);
  }
  const ids = new Set(STANDUP_SEGMENTS.map((s) => s.id));
  for (const b of blocks) for (const c of b.cites || []) assert.ok(ids.has(c), `存在しない id ${c}`);
  assert.strictEqual(stat.total, plain.citeStat.total);
  assert.strictEqual(stat.linked, plain.citeStat.linked + 1);
});

// ---------------------------------------------------------------- 複数の発言をまとめた要点（#2）
// モデルは 2〜3 の発言を 1 行にまとめることがある。要点1行の被覆率では各発言が 1/3 しか
// 覆えず出典が 1 つ（か 0）になっていた。節ごとに照合して全ての発言を指す。
// 節が 1 つの行は要点1行の照合（matchOne）と 1 文字も変わらない。
test('3つの発言をまとめた要点に3つ全ての出典が付き、節が1つの要点は要点1行の照合と同じ', () => {
  const { matchOne, buildIndex, splitClauses, citeText } = require('../src/cite');
  const line = '- 結合テストは完了したが、在庫連携のバッチは目標未達で、リリース日は11月15日で確定した';
  const md = STANDUP_SUMMARY_MD.replace('## 決定事項\n', `## 決定事項\n${line}\n`);
  assert.notStrictEqual(md, STANDUP_SUMMARY_MD, '差し込む見出しが要約に無い');
  const plain = runPipeline(STANDUP_SUMMARY_MD, STANDUP_SEGMENTS, BASE);
  const { blocks, citeStat } = runPipeline(md, STANDUP_SEGMENTS, BASE);

  const merged = blocks.find((b) => b.type === 'bullet' && b.text.startsWith('結合テストは完了したが'));
  assert.ok(merged, '差し込んだ要点が見つからない');
  assert.strictEqual(splitClauses(merged.text).length, 3);
  for (const id of ['s2', 's3']) assert.ok(merged.cites.includes(id), `${id} が無い: ${JSON.stringify(merged.cites)}`);
  assert.ok(merged.cites.some((c) => c === 's9' || c === 's10'), `リリース日の発言が無い: ${JSON.stringify(merged.cites)}`);
  assert.ok(merged.cites.length <= 4);
  // 要点1行の照合ではこの行に 3 つは付かなかった（付くならこの機能は要らない）
  const idx = buildIndex(STANDUP_SEGMENTS);
  assert.ok(matchOne(merged.text, idx).length < 3, '前提が崩れた（要点1行の照合で3つに届いている）');

  // 他の行: 節が1つなら matchOne と同じ。全ての行で、差し込みの前後で出典が動かない
  for (const b of blocks) {
    if ((b.type !== 'bullet' && b.type !== 'todo') || b === merged) continue;
    const same = plain.blocks.find((x) => x.type === b.type && x.text === b.text);
    assert.ok(same, `比較対象の行が見つからない: ${b.text}`);
    assert.deepStrictEqual(b.cites, same.cites, `差し込みで無関係な要点「${b.text}」の出典が動いた`);
    if (splitClauses(b.text).length === 1) {
      assert.deepStrictEqual(b.cites, matchOne(citeText(b), idx).map((h) => h.id), `節が1つの行が matchOne と違う: ${b.text}`);
    }
  }
  for (const text of STANDUP_UNGROUNDED) {
    assert.deepStrictEqual(blocks.find((x) => x.text === text).cites, [], `根拠の無い行に出典が付いた: ${text}`);
  }
  const ids = new Set(STANDUP_SEGMENTS.map((s) => s.id));
  for (const b of blocks) for (const c of b.cites || []) assert.ok(ids.has(c), `存在しない id ${c}`);
  assert.strictEqual(citeStat.total, plain.citeStat.total + 1);
  assert.strictEqual(citeStat.linked, plain.citeStat.linked + 1);
});
