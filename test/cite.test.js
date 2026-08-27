/*
 * cite.test.js — 出典マッチング
 *
 * この製品の中核。誤リンク（無関係な発言に飛ぶ）は無リンクより有害なので、
 * 「拾えること」より「間違ったものを拾わないこと」を厚く確認する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { attachCitations, buildIndex, matchOne, bigrams, normalize } = require('../src/cite');

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
    assert.deepStrictEqual(stat, { linked: 0, total: 0 });
    assert.deepStrictEqual(blocks[0].cites, []);
  }
});

test('再実行しても結果が変わらない（冪等）', () => {
  const mk = () => [{ id: 'b1', type: 'bullet', text: '採用の応募は今月8名だった', cites: [] }];
  const a = mk(); attachCitations(a, SEGS);
  const b = mk(); attachCitations(b, SEGS); attachCitations(b, SEGS);
  assert.deepStrictEqual(a[0].cites, b[0].cites);
});
