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

// ================= #45 アクションタブは 1 回の IPC =================
// 以前は openActions() と assigneeList() の 2 回を呼び、絞り込みは画面側で行っていた。
// 検索語と担当の絞り込みを store 側に寄せ、pagesActionView({ q, assignee }) の 1 回で
// 行・担当チップ・絞る前の件数（total）をまとめて受け取る。
const 今日から = (d) => { const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() + d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const act = (blockId, text, extra = {}) => Object.assign({ pageId: 'p1', blockId, pageTitle: '一つ目', date: '9/1', text, assignee: '', due: '', dueRaw: '', dueApprox: false }, extra);
const 例 = () => ({
  actions: [
    act('b1', '超過した仕事', { due: 今日から(-3), assignee: '佐藤' }),
    act('b2', '今日の仕事', { due: 今日から(0), assignee: '佐藤' }),
    act('b3', '今週の仕事', { due: 今日から(5), assignee: '田中' }),
    act('b4', '先の仕事', { due: 今日から(30) }),
    act('b5', '期限なしの仕事', { dueRaw: '来月あたり' }),
  ],
  people: [{ name: '佐藤', count: 2 }, { name: '田中', count: 1 }],
  total: 5,
});
const チップ = (l) => 一覧(l).querySelectorAll('.chip').map((b) => b.textContent);
const 行本文 = (l) => 一覧(l).querySelectorAll('.actrow').map((r) => r.querySelector('.body').childNodes[0].textContent);
const 見出し = (l) => 一覧(l).querySelectorAll('.agroup').map((h) => h.textContent);
const IPC = (l) => l.called('pagesActionView').map((c) => c.args[0]);
async function アクション表示(returns = {}) {
  const l = await load(APP, { preloadSrc: STAGE3(), returns: Object.assign({ pagesActionView: () => 例() }, returns) });
  l.byId.get('fltActions').dispatchEvent({ type: 'click' });
  await l.drain();
  return l;
}

test('#45 「アクション」を押すと pagesActionView を 1 回だけ呼び、openActions / assigneeList は呼ばない', async () => {
  const l = await アクション表示();
  assert.deepStrictEqual(IPC(l), [{ q: '', assignee: '' }], 'IPC が 1 回でない、または引数の形が違う');
  assert.deepStrictEqual(l.called('openActions'), [], '古い openActions をまだ呼んでいる');
  assert.deepStrictEqual(l.called('assigneeList'), [], '古い assigneeList をまだ呼んでいる');
  assert.strictEqual(行本文(l).length, 5, '行が actions から描かれていない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('#45 担当チップは people から（「全員」+ 先頭 8 人。count をそのまま表示）', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `担当${i}`, count: 20 - i }));
  const l = await アクション表示({ pagesActionView: () => Object.assign(例(), { people: many }) });
  const chips = チップ(l);
  assert.strictEqual(chips[0], '全員');
  assert.deepStrictEqual(chips.slice(1), many.slice(0, 8).map((p) => `${p.name} ${p.count}`), 'people の先頭 8 人と count が出ていない');
  assert.strictEqual(chips.length, 9);
  assert.ok(一覧(l).querySelectorAll('.chip')[0].classList.contains('on'), '絞っていないときは「全員」が選択中');
});

test('#45 担当チップを押すと assignee を添えて 1 回だけ呼び直す。もう一度押すと外れる', async () => {
  const l = await アクション表示();
  const 佐藤 = () => 一覧(l).querySelectorAll('.chip').find((b) => /^佐藤/.test(b.textContent));
  佐藤().dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(IPC(l), [{ q: '', assignee: '' }, { q: '', assignee: '佐藤' }], 'チップ 1 回で IPC が 1 回になっていない');
  assert.ok(佐藤().classList.contains('on'), '押したチップが選択中にならない');
  assert.ok(!一覧(l).querySelectorAll('.chip')[0].classList.contains('on'), '「全員」が選択中のまま');
  佐藤().dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(IPC(l).slice(2), [{ q: '', assignee: '' }], 'もう一度押しても絞り込みが外れない');
  // 絞り込みは store 側で行う。画面は返ってきた行をそのまま描く（絞り直さない）
  assert.strictEqual(行本文(l).length, 5);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('#45 検索語はそのまま q として渡す（畳むのは store 側）。打鍵では即時に IPC しない（220ms のデバウンス）', async () => {
  const l = await アクション表示();
  const box = l.byId.get('searchBox');
  box.value = '予算案の、作成';
  for (let i = 0; i < 5; i++) box.dispatchEvent({ type: 'input' });
  await l.drain();
  assert.strictEqual(IPC(l).length, 1, '打鍵のたびに IPC が走っている（デバウンスが外れた）');
  // デバウンスが起こす refreshList と同じ経路（チップ）で、q が畳まれずに渡ることを見る
  l.byId.get('fltActions').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(IPC(l)[1], { q: '予算案の、作成', assignee: '' });
});

test('#45 打鍵 → デバウンス → IPC が 1 回（タイマーを実際に起こして見る）', async () => {
  // simrun はタイマーを起こさないので、タイマーを溜める boot で見る（preload はファイルで渡す）
  const os = require('os');
  const { boot } = require('./helpers/boot.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-stage3-'));
  const pre = path.join(dir, 'preload.js');
  fs.writeFileSync(pre, STAGE3());
  try {
    const r = boot('src/renderer/app.html', { preload: pre, replies: Object.assign({}, require('./helpers/replies.js'), { pagesActionView: () => 例() }) });
    await r.drain();
    r.doc.getElementById('fltActions')._fire('click');
    await r.drain();
    const n0 = r.calls.filter((c) => c === 'pagesActionView').length;
    assert.strictEqual(n0, 1, '前提: 「アクション」で 1 回');
    const box = r.doc.getElementById('searchBox');
    const t0 = r.timers.length;
    box.value = '予算';
    box._fire('input'); box._fire('input'); box._fire('input');
    await r.drain();
    assert.strictEqual(r.calls.filter((c) => c === 'pagesActionView').length, n0, '打鍵で即時に IPC が走った');
    const pending = r.timers.slice(t0);
    assert.ok(pending.length >= 1, 'デバウンスのタイマーが仕掛けられていない');
    pending[pending.length - 1]();   // 最後に仕掛けたタイマーだけが生き残る（前のは clearTimeout される）
    await r.drain();
    assert.strictEqual(r.calls.filter((c) => c === 'pagesActionView').length, n0 + 1, 'デバウンス後の IPC が 1 回でない');
    assert.deepStrictEqual(r.errors, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#45 分類（期限超過／今日／今週中／先の予定／期限なし）は今のまま', async () => {
  const l = await アクション表示();
  assert.deepStrictEqual(見出し(l), ['期限超過（1）', '今日（1）', '今週中（1）', '先の予定（1）', '期限なし（1）']);
  assert.deepStrictEqual(行本文(l), ['超過した仕事', '今日の仕事', '今週の仕事', '先の仕事', '期限なしの仕事']);
  const tags = 一覧(l).querySelectorAll('.atag.due').map((t) => t.textContent);
  assert.ok(tags.some((t) => /3日超過/.test(t)), '期限超過の札が出ない');
  assert.ok(tags.includes('来月あたり'), '日付にできない期限（dueRaw）がそのまま出ない');
});

test('#45 絞った結果が空でも未完了が残っていれば（total > 0）、「無い」ではなく絞り込みのせいだと分かる', async () => {
  const l = await アクション表示({ pagesActionView: ({ assignee }) => (assignee ? { actions: [], people: 例().people, total: 5 } : 例()) });
  一覧(l).querySelectorAll('.chip').find((b) => /^田中/.test(b.textContent)).dispatchEvent({ type: 'click' });
  await l.drain();
  const empty = 一覧(l).querySelector('.empty');
  assert.ok(empty, '空の表示が無い');
  assert.ok(!/未完了のアクションはありません/.test(empty.textContent), '絞り込みで空なのに「未完了は無い」と出る');
  assert.ok(/5/.test(empty.textContent), '絞る前の件数（total）が出ない');
  assert.ok(チップ(l).length >= 2, '空でもチップは残す（絞り込みを外せるように）');
  // 本当に何も無いときは今までの文言
  const l2 = await アクション表示({ pagesActionView: () => ({ actions: [], people: [], total: 0 }) });
  assert.ok(/未完了のアクションはありません/.test(一覧(l2).querySelector('.empty').textContent));
});

test('#45 pagesActionView の無い古い preload と組んでも、「アクション」で例外にならない', async () => {
  const l = await load(APP);
  l.byId.get('fltActions').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
  assert.deepStrictEqual(l.called('openActions'), [], '古い openActions に戻っている');
  assert.ok(一覧(l).querySelector('.empty'), '空の表示が出ない');
});
