/*
 * store.test.js — 保存層を実際に実行して検査する
 *
 * これまで store.js は repo.test.js からソース文字列として見られているだけで、
 * 一度も実行されていなかった。文字起こしの編集（updateSegment）を入れるにあたり、
 * 一時ディレクトリに本物のファイルを書いて読み戻す形で固定する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const { STANDUP_SEGMENTS } = require('./fixtures');

let dir;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-store-'));
  store.init(dir);
});
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ } });

const clone = (x) => JSON.parse(JSON.stringify(x));
const mkPage = () => store.createPage({ title: 'テスト', segments: clone(STANDUP_SEGMENTS) });
const tfile = (id) => path.join(dir, 'data', 'transcripts', `${id}.json`);

test('updateSegment: 本文が変わり、getTranscript で読み戻せる', () => {
  const p = mkPage();
  const r = store.updateSegment(p.id, 's3', { text: '直した文' });
  assert.ok(Array.isArray(r));
  assert.strictEqual(store.getTranscript(p.id).find((s) => s.id === 's3').text, '直した文');
});

test('updateSegment: id・atMs・順序・他の区間は変わらない', () => {
  const p = mkPage();
  const before = store.getTranscript(p.id);
  store.updateSegment(p.id, 's3', { text: '直した文' });
  const after = store.getTranscript(p.id);
  assert.deepStrictEqual(after.map((s) => s.id), before.map((s) => s.id), '順序か id が変わった');
  assert.deepStrictEqual(after.map((s) => s.atMs), before.map((s) => s.atMs), 'atMs が変わった');
  for (const s of before) if (s.id !== 's3') assert.deepStrictEqual(after.find((x) => x.id === s.id), s, `${s.id} に触っている`);
});

test('updateSegment: 存在しない区間なら null を返し、ファイルに触らない', () => {
  const p = mkPage();
  const raw = fs.readFileSync(tfile(p.id), 'utf8');
  assert.strictEqual(store.updateSegment(p.id, 's999', { text: 'x' }), null);
  assert.strictEqual(fs.readFileSync(tfile(p.id), 'utf8'), raw);
});

test('updateSegment: 存在しないページなら null', () => {
  assert.strictEqual(store.updateSegment('p_nothing', 's1', { text: 'x' }), null);
});

test('updateSegment: text 以外の patch は無視する（id / atMs は書き換えられない）', () => {
  const p = mkPage();
  store.updateSegment(p.id, 's3', { text: '直した文', id: 'zz', atMs: 1, evil: 1 });
  const s = store.getTranscript(p.id).find((x) => x.id === 's3');
  assert.ok(s, 'id が書き換わった');
  assert.strictEqual(s.atMs, STANDUP_SEGMENTS[2].atMs);
  assert.strictEqual(s.evil, undefined);
  assert.strictEqual(s.text, '直した文');
});

test('updateSegment: text が文字列でなければ何も変えない', () => {
  const p = mkPage();
  store.updateSegment(p.id, 's3', { text: 123 });
  assert.strictEqual(store.getTranscript(p.id).find((x) => x.id === 's3').text, STANDUP_SEGMENTS[2].text);
});

test('updateSegment: 「認識に失敗」の区間を書き直すと failed が外れる', () => {
  const segs = clone(STANDUP_SEGMENTS);
  segs[4] = { id: 's5', atMs: segs[4].atMs, text: '（この区間の認識に失敗: timeout）', failed: true };
  const p = store.createPage({ title: 't', segments: segs });
  store.updateSegment(p.id, 's5', { text: '分かりました。実行計画を確認します。' });
  const s = store.getTranscript(p.id).find((x) => x.id === 's5');
  assert.strictEqual(s.failed, undefined, 'failed が残っている（要約から除外され続ける）');
});

test('updateSegment: 一時ファイルが残らず、書いた JSON は parse できる', () => {
  const p = mkPage();
  store.updateSegment(p.id, 's1', { text: '' });
  assert.ok(!fs.existsSync(tfile(p.id) + '.tmp'), '.tmp が残っている');
  const j = JSON.parse(fs.readFileSync(tfile(p.id), 'utf8'));
  assert.strictEqual(j.id, p.id);
  assert.strictEqual(j.segments.find((x) => x.id === 's1').text, '');
});

test('updateSegment: ページ本体（updatedAt）には触らない — ページ保存は main 側が1回だけ行う', () => {
  const p = mkPage();
  const before = store.getPage(p.id).updatedAt;
  store.updateSegment(p.id, 's2', { text: '直した文' });
  assert.strictEqual(store.getPage(p.id).updatedAt, before);
});
