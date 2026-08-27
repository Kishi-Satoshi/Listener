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

const { markdownToBlocks } = require('../src/minutes');
const { attachCitations } = require('../src/cite');
const { enrichActionBlocks } = require('../src/actions');
const mtype = require('../src/meetingType');
const { STANDUP_SEGMENTS, STANDUP_SUMMARY_MD, STANDUP_UNGROUNDED } = require('./fixtures');

// runSummary と同じ順序で実行する
function runPipeline(md, segments, baseDate) {
  const blocks = markdownToBlocks(md);
  const citeStat = attachCitations(blocks, segments);
  const actionStat = enrichActionBlocks(blocks, baseDate);
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
