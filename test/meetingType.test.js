/*
 * meetingType.test.js — 会議タイプの判定とテンプレート
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mtype = require('../src/meetingType');

test('タイトルから会議タイプを判定する', () => {
  const cases = [
    ['週次定例', 'standup'],
    ['朝会', 'standup'],
    ['開発チーム 進捗確認', 'standup'],
    ['10月度 部会', 'review'],
    ['事業本部 月次報告会', 'review'],
    ['1on1', 'oneonone'],
    ['キャリア面談', 'oneonone'],
    ['協業の商談', 'sales'],
    ['再販契約の打ち合わせ', 'sales'],
    ['中途採用 一次面接', 'interview'],
    ['入社前の顔合わせ', 'interview'],
    ['新機能のブレスト', 'brainstorm'],
    ['方針のディスカッション', 'brainstorm'],
  ];
  for (const [title, want] of cases) {
    assert.strictEqual(mtype.detectType(title, ''), want, `「${title}」の判定`);
  }
});

test('手がかりが無ければ general に落とす（誤った型を当てない）', () => {
  for (const title of ['打ち合わせ', 'ミーティング', '', '10/05 の記録', null, undefined]) {
    assert.strictEqual(mtype.detectType(title, ''), 'general', `「${title}」`);
  }
});

test('本文だけの弱い一致では型を決めない', () => {
  // 本文一致は1点。閾値3に届かないので general のまま
  assert.strictEqual(mtype.detectType('打ち合わせ', '本日は商談の件で伺いました'), 'general');
});

test('タイトル一致は本文一致より優先される', () => {
  // タイトルに「面接」（interview）、本文に「定例」（standup）
  assert.strictEqual(mtype.detectType('一次面接', '定例 定例 定例'), 'interview');
});

test('すべてのタイプがテンプレートを持ち、アクション節を含む', () => {
  for (const key of mtype.ORDER) {
    const f = mtype.getFormat(key);
    assert.ok(f && f.length > 0, `${key} のテンプレートが空`);
    assert.ok(f.includes('## 概要'), `${key} に概要が無い`);
    assert.ok(f.includes('- [ ]'), `${key} にアクション節が無い（チェックボックス化の起点）`);
  }
});

test('テンプレートの見出しが markdownToBlocks で見出しとして解釈できる', () => {
  const { markdownToBlocks } = require('../src/minutes');
  for (const key of mtype.ORDER) {
    const headings = mtype.getFormat(key).split('\n').filter((l) => l.startsWith('## '));
    const blocks = markdownToBlocks(headings.join('\n'));
    assert.strictEqual(blocks.length, headings.length, `${key}`);
    assert.ok(blocks.every((b) => b.type === 'heading'), `${key} の見出しが heading にならない`);
  }
});

test('未知のタイプは general にフォールバックする', () => {
  assert.strictEqual(mtype.getFormat('nonexistent'), mtype.getFormat('general'));
  assert.strictEqual(mtype.getLabel('nonexistent'), mtype.getLabel('general'));
  assert.strictEqual(mtype.getFormat(undefined), mtype.getFormat('general'));
});

test('listTypes が UI 用に全タイプを返す', () => {
  const list = mtype.listTypes();
  assert.strictEqual(list.length, mtype.ORDER.length);
  for (const t of list) {
    assert.ok(t.key && t.label && typeof t.hint === 'string');
  }
});

test('キーワードに重複が無い（重複すると同じ語で二重加点される）', () => {
  for (const key of mtype.ORDER) {
    const kws = mtype.TYPES[key].keywords;
    assert.strictEqual(new Set(kws).size, kws.length,
      `${key} のキーワードが重複: ${kws.filter((k, i) => kws.indexOf(k) !== i)}`);
  }
});
