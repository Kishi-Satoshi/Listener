/*
 * minutes.test.js — Markdown ⇄ ブロック変換
 *
 * ローカル3Bモデルの出力は書式が揺れる。取りこぼすと要点が静かに消えるので、
 * 実際に出てきうる書き方を並べて確認する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { markdownToBlocks, blocksToMarkdown, fmtClock } = require('../src/minutes');

const types = (md) => markdownToBlocks(md).map((b) => b.type);

test('見出しは # から #### まで', () => {
  assert.deepStrictEqual(types('# A\n## B\n### C\n#### D'),
    ['heading', 'heading', 'heading', 'heading']);
  assert.strictEqual(markdownToBlocks('## 決定事項')[0].text, '決定事項');
});

test('チェックボックスは todo になり、チェック状態を拾う', () => {
  const b = markdownToBlocks('- [ ] 未完了\n- [x] 完了\n* [X] 大文字も完了');
  assert.deepStrictEqual(b.map((x) => x.type), ['todo', 'todo', 'todo']);
  assert.deepStrictEqual(b.map((x) => x.checked), [false, true, true]);
  assert.strictEqual(b[0].text, '未完了');
});

test('箇条書きの各種記号', () => {
  assert.deepStrictEqual(types('- ハイフン\n* アスタリスク\n・ 中黒'),
    ['bullet', 'bullet', 'bullet']);
});

test('中黒は空白なしでも箇条書きにする（日本語で普通に使われる書き方）', () => {
  // paragraph に落ちると出典リンクの対象外になり、機能が静かに欠ける
  const b = markdownToBlocks('・在庫連携のバッチ処理が遅い');
  assert.strictEqual(b[0].type, 'bullet');
  assert.strictEqual(b[0].text, '在庫連携のバッチ処理が遅い');
});

test('チェックボックスは直後の空白が無くても todo にする', () => {
  const b = markdownToBlocks('- [ ]資料を作る\n- [x]完了した作業');
  assert.deepStrictEqual(b.map((x) => x.type), ['todo', 'todo']);
  assert.deepStrictEqual(b.map((x) => x.text), ['資料を作る', '完了した作業']);
  assert.deepStrictEqual(b.map((x) => x.checked), [false, true]);
});

test('強調やマイナス値を箇条書きと誤認しない', () => {
  assert.strictEqual(markdownToBlocks('*重要な補足*')[0].type, 'paragraph');
  assert.strictEqual(markdownToBlocks('-5%の減少が見られる')[0].type, 'paragraph');
});

test('番号付きリストも箇条書きにする', () => {
  assert.deepStrictEqual(types('1. 一つ目\n2) 二つ目'), ['bullet', 'bullet']);
  assert.strictEqual(markdownToBlocks('1. 一つ目')[0].text, '一つ目');
});

test('字下げされた箇条書きも拾う', () => {
  assert.deepStrictEqual(types('  - 字下げ\n    - さらに字下げ'), ['bullet', 'bullet']);
});

test('該当しない行は paragraph として残す（捨てない）', () => {
  const b = markdownToBlocks('会議全体の概要をここに書く。');
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].type, 'paragraph');
});

test('空行は落とすが、中身のある行は1行も落とさない', () => {
  const md = '## 概要\n\n\n本文\n\n- 項目\n\n';
  assert.strictEqual(markdownToBlocks(md).length, 3);
});

test('すべてのブロックに一意のIDと cites 配列が付く', () => {
  const b = markdownToBlocks('## A\n- B\n- [ ] C\n本文');
  assert.strictEqual(new Set(b.map((x) => x.id)).size, b.length);
  for (const x of b) {
    assert.ok(x.id.startsWith('b'));
    assert.deepStrictEqual(x.cites, []);
  }
});

test('チェックボックスは箇条書きより先に判定される', () => {
  // 「- [ ] …」を bullet として飲み込むとアクションが消える
  assert.strictEqual(markdownToBlocks('- [ ] 資料を作る')[0].type, 'todo');
  assert.strictEqual(markdownToBlocks('- [ ] 資料を作る')[0].text, '資料を作る');
});

test('空・null 入力で落ちない', () => {
  for (const v of ['', null, undefined, '\n\n']) {
    assert.deepStrictEqual(markdownToBlocks(v), []);
  }
});

test('fmtClock が時:分:秒を組み立てる', () => {
  assert.strictEqual(fmtClock(0), '0:00');
  assert.strictEqual(fmtClock(65000), '1:05');
  assert.strictEqual(fmtClock(3600000), '1:00:00');
  assert.strictEqual(fmtClock(3725000), '1:02:05');
});

test('blocksToMarkdown が議事録と文字起こしを書き出す', () => {
  const page = {
    title: '週次定例',
    createdAt: '2026-10-05T09:00:00.000Z',
    durationSec: 1830,
    memo: '議題: 進捗 / 採用',
    blocks: [
      { type: 'heading', text: '決定事項' },
      { type: 'bullet', text: 'リリース日を11月15日で確定' },
      { type: 'todo', text: '実行計画を確認する', checked: false },
      { type: 'todo', text: '求人票を直す', checked: true },
      { type: 'paragraph', text: '補足の地の文' },
    ],
  };
  const segs = [{ id: 's1', atMs: 0, text: 'おはようございます' }, { id: 's2', atMs: 75000, text: '始めます' }];
  const md = blocksToMarkdown(page, segs);

  assert.ok(md.startsWith('# 週次定例'));
  assert.ok(md.includes('- 録音時間: 30:30'));
  assert.ok(md.includes('## メモ・アジェンダ\n議題: 進捗 / 採用'));
  assert.ok(md.includes('## 決定事項'));
  assert.ok(md.includes('- [ ] 実行計画を確認する'));
  assert.ok(md.includes('- [x] 求人票を直す'));
  assert.ok(md.includes('補足の地の文'));
  assert.ok(md.includes('## 文字起こし全文'));
  assert.ok(md.includes('[0:00] おはようございます'));
  assert.ok(md.includes('[1:15] 始めます'));
});

test('メモが無ければメモ節を出さない', () => {
  const page = { title: 'A', createdAt: '2026-10-05T09:00:00.000Z', durationSec: 0, memo: '   ', blocks: [] };
  assert.ok(!blocksToMarkdown(page, []).includes('メモ・アジェンダ'));
});

test('書き出し → 読み戻しで議事録の中身が保たれる', () => {
  const page = {
    title: 'T', createdAt: '2026-10-05T09:00:00.000Z', durationSec: 0, memo: '',
    blocks: [
      { type: 'heading', text: 'アクションアイテム' },
      { type: 'todo', text: '資料を作る', checked: false },
      { type: 'bullet', text: '応募は8名' },
    ],
  };
  // 文字起こし節より前だけを読み戻す
  const body = blocksToMarkdown(page, []).split('## 文字起こし全文')[0];
  const back = markdownToBlocks(body);
  assert.ok(back.some((b) => b.type === 'heading' && b.text === 'アクションアイテム'));
  assert.ok(back.some((b) => b.type === 'todo' && b.text === '資料を作る' && b.checked === false));
  assert.ok(back.some((b) => b.type === 'bullet' && b.text === '応募は8名'));
});
