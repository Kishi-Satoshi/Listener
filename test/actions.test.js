/*
 * actions.test.js — 担当者・期限の抽出
 *
 * 期待値は「会議で人がそう言ったとき何日を指すか」から決めている。
 * 基準日は 2026-10-05（月）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseDue, parseAction, cleanName, enrichActionBlocks } = require('../src/actions');

const BASE = new Date(2026, 9, 5); // 2026-10-05 (月)
const due = (s) => parseDue(s, BASE).date;

test('絶対日付', () => {
  assert.strictEqual(due('2026年8月30日'), '2026-08-30');
  assert.strictEqual(due('2026/8/30'), '2026-08-30');
  assert.strictEqual(due('11/15'), '2026-11-15');
  assert.strictEqual(due('11月15日'), '2026-11-15');
  // 年の無い日付が基準日より前なら翌年（過去の期限は付けない）
  assert.strictEqual(due('8/30'), '2027-08-30');
});

test('日のみの指定は今月、過ぎていれば来月', () => {
  assert.strictEqual(due('30日'), '2026-10-30');
  assert.strictEqual(due('3日'), '2026-11-03');
});

test('日数・週数の相対指定', () => {
  assert.strictEqual(due('3日後'), '2026-10-08');
  assert.strictEqual(due('2週間後'), '2026-10-19');
  assert.strictEqual(due('1ヶ月後'), '2026-11-05');
  assert.strictEqual(due('本日'), '2026-10-05');
  assert.strictEqual(due('明日'), '2026-10-06');
  assert.strictEqual(due('明後日'), '2026-10-07');
});

test('曜日指定', () => {
  // 基準日は月曜。「来週金曜」は翌週（10/12始まり）の金曜
  assert.strictEqual(due('来週金曜'), '2026-10-16');
  assert.strictEqual(due('来週金曜日'), '2026-10-16');
  // 修飾なしは基準日以降で最も近いその曜日
  assert.strictEqual(due('金曜'), '2026-10-09');
  assert.strictEqual(due('今週水曜'), '2026-10-07');
  // 基準日と同じ曜日なら翌週（今日を期限にはしない）
  assert.strictEqual(due('月曜'), '2026-10-12');
});

test('週末・月末', () => {
  assert.strictEqual(due('今週中'), '2026-10-09');
  assert.strictEqual(due('今週末'), '2026-10-09');
  assert.strictEqual(due('来週末'), '2026-10-16');
  assert.strictEqual(due('今月末'), '2026-10-31');
  assert.strictEqual(due('月末'), '2026-10-31');
  assert.strictEqual(due('来月末'), '2026-11-30');
  assert.strictEqual(due('来月初'), '2026-11-01');
});

test('月を明示した月末は、その月の末日になる', () => {
  // 「9月末」を『基準日の月の末日』に丸めない
  assert.strictEqual(due('12月末'), '2026-12-31');
  assert.strictEqual(due('10月末'), '2026-10-31');
  // 年が無く基準日より前なら翌年（8/30 と同じ扱い）
  assert.strictEqual(due('9月末'), '2027-09-30');
});

test('月をまたぐ日付指定で日が捨てられない', () => {
  assert.strictEqual(due('来月10日'), '2026-11-10');
  assert.strictEqual(due('今月20日'), '2026-10-20');
  assert.strictEqual(due('再来月1日'), '2026-12-01');
});

test('「N日以内」を月内日付と誤読しない', () => {
  assert.strictEqual(due('3日以内'), '2026-10-08');
  assert.strictEqual(due('7日以内'), '2026-10-12');
});

test('「今週◯曜」は当週を指す（基準日と同じ曜日でも翌週に飛ばない）', () => {
  // 基準日は月曜
  assert.strictEqual(due('今週月曜'), '2026-10-05');
  assert.strictEqual(due('今週水曜'), '2026-10-07');
  // 「今週」が付かなければ従来どおり翌週
  assert.strictEqual(due('月曜'), '2026-10-12');
});

test('「来週末まで」が今週の金曜にならない', () => {
  assert.strictEqual(due('来週末まで'), '2026-10-16');
  assert.strictEqual(due('今週末まで'), '2026-10-09');
});

test('曖昧な表現は実日付にせず空で返す（推測で誤った期限を入れない）', () => {
  for (const s of ['9月上旬', '来月中旬', '今月下旬']) {
    const r = parseDue(s, BASE);
    assert.strictEqual(r.date, '', `${s} が実日付に変換された`);
    assert.strictEqual(r.approx, true);
  }
});

test('期限なしを表す語は空で返す', () => {
  for (const s of ['未定', 'なし', '特になし', 'TBD', '随時', '']) {
    assert.strictEqual(parseDue(s, BASE).date, '', s);
  }
});

test('期間を表す語を期限と誤読しない', () => {
  // 「10日間」は所要期間であって締切ではない
  assert.strictEqual(due('10日間'), '');
  assert.strictEqual(due('3日間'), '');
});

test('おおよその指定には approx が立つ', () => {
  assert.strictEqual(parseDue('来週', BASE).approx, true);
  assert.strictEqual(parseDue('来月', BASE).approx, true);
  assert.strictEqual(parseDue('来週金曜', BASE).approx, false);
  assert.strictEqual(parseDue('11/15', BASE).approx, false);
});

test('敬称・役職を落として姓に名寄せする', () => {
  assert.strictEqual(cleanName('山田さん'), '山田');
  assert.strictEqual(cleanName('佐藤部長'), '佐藤');
  assert.strictEqual(cleanName('鈴木課長'), '鈴木');
  assert.strictEqual(cleanName('@田中'), '田中');
  assert.strictEqual(cleanName('  高橋様  '), '高橋');
  assert.strictEqual(cleanName(''), '');
  // 役職だけの場合は担当者名として扱わない
  assert.strictEqual(cleanName('部長'), '');
});

test('括弧つきの定型書式から担当と期限を取り出す', () => {
  const r = parseAction('実行計画を確認する（担当: 山田 / 期限: 来週金曜）', BASE);
  assert.strictEqual(r.assignee, '山田');
  assert.strictEqual(r.dueRaw, '来週金曜');
  assert.strictEqual(r.due, '2026-10-16');
  assert.strictEqual(r.text, '実行計画を確認する');
});

test('スラッシュを含む日付が書式の区切りで切れない', () => {
  const r = parseAction('見積を出す（担当: 佐藤 / 期限: 11/15）', BASE);
  assert.strictEqual(r.assignee, '佐藤');
  assert.strictEqual(r.dueRaw, '11/15');
  assert.strictEqual(r.due, '2026-11-15');
});

test('括弧なしの定型書式', () => {
  const r = parseAction('資料を作成する 担当: 鈴木 期限: 今月末', BASE);
  assert.strictEqual(r.assignee, '鈴木');
  assert.strictEqual(r.due, '2026-10-31');
  assert.strictEqual(r.text, '資料を作成する');
});

test('@メンション形式', () => {
  const r = parseAction('@高橋 テスト仕様書をレビューする', BASE);
  assert.strictEqual(r.assignee, '高橋');
  assert.ok(r.text.includes('テスト仕様書'));
});

test('自然文からの担当・期限の推定', () => {
  const r = parseAction('山田さんが実行計画を来週金曜までに確認する', BASE);
  assert.strictEqual(r.assignee, '山田');
  assert.strictEqual(r.due, '2026-10-16');
});

test('担当も期限も書かれていなければ空のまま（埋めない）', () => {
  const r = parseAction('残不具合2件を修正する', BASE);
  assert.strictEqual(r.assignee, '');
  assert.strictEqual(r.dueRaw, '');
  assert.strictEqual(r.due, '');
  assert.strictEqual(r.text, '残不具合2件を修正する');
});

test('書式の括弧が行末に無くても、値が行末まで飲み込まれない', () => {
  const r = parseAction('（担当: 山田 / 期限: 今月末）を反映する', BASE);
  assert.strictEqual(r.assignee, '山田');
  assert.strictEqual(r.dueRaw, '今月末');
  assert.strictEqual(r.due, '2026-10-31');
  assert.strictEqual(r.text, 'を反映する', '本文が消えている');
});

test('期限らしき語が「まで」を伴わなければ期限にしない', () => {
  // 「月末処理」「先月末の請求書」に期限を付けない（誤った期限より空の方がよい）
  for (const t of ['月末処理の手順を文書化する', '先月末の請求書を確認する', '週末の当番表を作る']) {
    const r = parseAction(t, BASE);
    assert.strictEqual(r.due, '', `${t} に期限が付いた: ${r.dueRaw}`);
    assert.strictEqual(r.text, t, '本文が変わった');
  }
});

test('自然文の「9月末までに」で月の指定が落ちない', () => {
  const r = parseAction('9月末までに棚卸を終える', BASE);
  assert.strictEqual(r.dueRaw, '9月末');
  assert.strictEqual(r.due, '2027-09-30');
});

test('本文中の括弧を書式と誤認しない', () => {
  const r = parseAction('受注管理システム（旧システムを含む）の移行手順を作る', BASE);
  assert.strictEqual(r.text, '受注管理システム（旧システムを含む）の移行手順を作る');
  assert.strictEqual(r.assignee, '');
});

test('enrichActionBlocks は todo だけを対象にし、本文を空にしない', () => {
  const blocks = [
    { id: 'b1', type: 'heading', text: 'アクションアイテム' },
    { id: 'b2', type: 'todo', text: '資料を作る（担当: 山田 / 期限: 今月末）' },
    { id: 'b3', type: 'bullet', text: '担当: 佐藤 / 期限: 来週' },
    { id: 'b4', type: 'todo', text: '（担当: 鈴木）' },
  ];
  const stat = enrichActionBlocks(blocks, BASE);
  assert.strictEqual(stat.total, 2);
  assert.strictEqual(stat.withAssignee, 2);
  assert.strictEqual(stat.withDue, 1);
  assert.strictEqual(blocks[1].text, '資料を作る');
  // bullet は触られない
  assert.strictEqual(blocks[2].assignee, undefined);
  // 本文が書式だけでも空文字にはしない（画面から行が消えてしまうため）
  assert.ok(blocks[3].text.trim().length > 0, 'todo の本文が空になった');
});

test('基準日を渡さなくても落ちない', () => {
  assert.doesNotThrow(() => parseAction('資料を作る（担当: 山田 / 期限: 来週）', undefined));
});

// ---------------------------------------------------------------- 情報ゼロの担当・期限
//
// モデルは「（担当なし）」「（担当: なし / 期限: 未定）」とも書いてくる。
// 「なし」は情報ゼロなので本文から落とすだけにする。推測で埋めない。
test('「担当なし」「期限未定」は落とすだけ（推測で埋めない）', () => {
  const B = new Date(2026, 7, 29);
  let p = parseAction('テスト環境の2台目の用意を検討する（担当なし）', B);
  assert.strictEqual(p.text, 'テスト環境の2台目の用意を検討する');
  assert.strictEqual(p.assignee, '');
  p = parseAction('設計書の更新を依頼する（担当: なし / 期限: 未定）', B);
  assert.strictEqual(p.text, '設計書の更新を依頼する');
  assert.strictEqual(p.assignee, '');
  assert.strictEqual(p.due, '');
  // 情報のある括弧は今まで通り
  p = parseAction('実行計画を確認する（担当: 山田 / 期限: 来週金曜）', B);
  assert.strictEqual(p.assignee, '山田');
  assert.strictEqual(p.due, '2026-09-04');
  // 担当・期限と無関係な括弧は触らない
  p = parseAction('リリース内容を確定する（費用は要確認）', B);
  assert.strictEqual(p.text, 'リリース内容を確定する（費用は要確認）');
});
