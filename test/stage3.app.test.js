/*
 * stage3.app.test.js — 第3段（v0.11.0）の画面側の変更を、最小DOM上で実際に走らせて固定する
 *
 *  - #43 文字起こし検索の件数表示（n件 ／ n件中 m件を表示（先頭から））
 *  - #45 アクションタブは pagesActionView の 1 回の IPC で描く（openActions / assigneeList を使わない）
 *  - 設定: 要約の文脈長（sumCtx）・エンジンの自動停止（engineIdleMin）・データ保存先の表示と移動
 *
 * preload にまだ無い公開名は、runtime.app.test.js と同じ手でテスト側の preload 文字列に補う
 * （main / preload は別の作業で足される。画面の側だけ先に作って検査できるようにする）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;

const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
// 既にある名前は二重に足さない（統合後にそのまま通る）
const preloadWith = (...names) => names.reduce((src, n) => (new RegExp(`^\\s+${n}\\s*:`, 'm').test(src) ? src
  : src.replace("exposeInMainWorld('koeApp', {", `exposeInMainWorld('koeApp', {\n  ${n}: (...a) => ipcRenderer.invoke('test:${n}', ...a),`)), PRELOAD);
// 第3段で足る公開名を全部入れた preload
const STAGE3 = () => preloadWith('pagesActionView', 'dataDirGet', 'dataDirMove', 'hotkeyState', 'promptInfo', 'meetingSkipPending');

const 一覧 = (l) => l.byId.get('plist');
const 件数行 = (l) => 一覧(l).querySelector('.count');
const 行数 = (l) => 一覧(l).querySelectorAll('.pitem').length;
const 全文検索 = async (l, q) => {
  l.byId.get('searchBox').value = q;
  l.byId.get('fltFull').dispatchEvent({ type: 'click' });
  await l.drain();
};
const 全部 = async (l) => { l.byId.get('fltAll').dispatchEvent({ type: 'click' }); await l.drain(); };
const hit = (id) => ({ id, title: `議事録 ${id}`, date: '9/1', durationSec: 60, hasSummary: true, snippet: '当たった文' });

// ================= #43 文字起こし検索の件数 =================
test('#43 全文検索が打ち切られたときは「n件中 m件を表示（先頭から）」が一覧の先頭に出る', async () => {
  const l = await load(APP, { returns: { pagesSearchFull: () => ({ hits: [hit('p1'), hit('p2')], total: 57, truncated: true }) } });
  await 全文検索(l, '締め');
  const c = 件数行(l);
  assert.ok(c, '件数の行が無い');
  assert.strictEqual(c.textContent, '57件中 2件を表示（先頭から）');
  assert.strictEqual(一覧(l).childNodes[0], c, '件数が一覧の先頭に無い');
  assert.strictEqual(行数(l), 2, '行の数が変わった');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('#43 打ち切られていなければ「n件」だけ（「中 m件」を付けない）', async () => {
  const l = await load(APP, { returns: { pagesSearchFull: () => ({ hits: [hit('p1'), hit('p2'), hit('p3')], total: 3, truncated: false }) } });
  await 全文検索(l, '締め');
  assert.strictEqual(件数行(l).textContent, '3件');
  assert.strictEqual(行数(l), 3);
});

test('#43 移行中（配列で返る古い形）でも件数が出て落ちない', async () => {
  const l = await load(APP, { returns: { pagesSearchFull: () => [hit('p1')] } });
  await 全文検索(l, '締め');
  assert.strictEqual(件数行(l).textContent, '1件');
  assert.strictEqual(行数(l), 1);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('#43 当たりが無くても「0件」と出る。「すべて」へ戻すと件数の行は消える', async () => {
  const l = await load(APP, { returns: {
    pagesSearch: () => [hit('p1')],
    pagesSearchFull: () => ({ hits: [], total: 0, truncated: false }),
  } });
  await 全文検索(l, '無い語');
  assert.strictEqual(件数行(l).textContent, '0件');
  await 全部(l);
  assert.strictEqual(件数行(l), null, '「すべて」の一覧に件数の行が残っている');
  assert.ok(行数(l) >= 1, '「すべて」の一覧が描かれない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('#43 件数の行は一覧の行（.pitem）ではない（高さ・行の形を変えない）', async () => {
  const l = await load(APP, { returns: { pagesSearchFull: () => ({ hits: [hit('p1')], total: 9, truncated: true }) } });
  await 全文検索(l, '締め');
  const c = 件数行(l);
  assert.ok(!c.classList.contains('pitem'));
  assert.strictEqual(c.getAttribute('role'), null, '件数の行が選択肢（option）として読み上げられる');
  const row = 一覧(l).querySelector('.pitem');
  assert.ok(row.querySelector('.t') && row.querySelector('.m'), '行の形が変わった');
});
