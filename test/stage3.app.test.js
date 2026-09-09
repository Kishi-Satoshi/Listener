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

// ================= 設定: 要約の文脈長（sumCtx）とエンジンの自動停止（engineIdleMin） =================
// 設定キーの契約: sumCtx（整数、既定 32768、4096〜131072）、engineIdleMin（整数、既定 10、0〜120、0 = 止めない）。
// 範囲の丸めは main（normalizeSettings）が行い、採らなかった値は applied で欄へ戻る（既存の流儀）。
const { RETURNS } = require('./helpers/simrun.js');
const 設定 = (extra) => Object.assign({}, RETURNS.getSettings(), extra);
const カード見出し = (el) => { const c = el.closest('.card'); return c ? c.querySelector('h2').textContent : ''; };
async function 保存した(l) {
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const c = l.called('saveSettings');
  return c[c.length - 1].args[0];
}

test('設定: 要約の文脈長の欄が要約エンジンのカードにあり、ラベルと説明が指定どおり', async () => {
  const l = await load(APP);
  const el = l.byId.get('sumCtx');
  assert.ok(el, '#sumCtx が無い');
  assert.match(カード見出し(el), /^要約エンジン/, '要約エンジンのカードに無い');
  const field = el.closest('.field');
  assert.strictEqual(field.querySelector('label').textContent, '要約の文脈長');
  assert.strictEqual(field.querySelector('.desc').textContent.trim(),
    '要約エンジンに渡すトークン数（-c）。既定 32768。Qwen2.5-3B はここまで。大きいほどメモリを使い、小さいと長い会議の統合で足りなくなります');
});

test('設定: エンジンの自動停止の欄が「動作」のカードにあり、単位「分」とラベル・説明が指定どおり', async () => {
  const l = await load(APP);
  const el = l.byId.get('engineIdleMin');
  assert.ok(el, '#engineIdleMin が無い');
  assert.strictEqual(カード見出し(el), '動作');
  const field = el.closest('.field');
  assert.strictEqual(field.querySelector('label').textContent, '使わないエンジンを止めるまで（分）');
  assert.strictEqual(field.querySelector('.desc').textContent.trim(),
    '記録も要約もしていない時間がこれを超えたらエンジンを止めてメモリを空けます（次に使うとき起動し直します。0 で止めない）');
});

test('設定: sumCtx / engineIdleMin を読み込んで欄に出し、無ければ既定（32768 / 10）。0 分は 0 のまま（既定に化けない）', async () => {
  const a = await load(APP, { returns: { getSettings: () => 設定({ sumCtx: 8192, engineIdleMin: 0 }) } });
  assert.strictEqual(a.byId.get('sumCtx').value, '8192');
  assert.strictEqual(a.byId.get('engineIdleMin').value, '0', '0（止めない）が既定に化けた');
  const b = await load(APP, { returns: { getSettings: () => 設定({}) } });
  assert.strictEqual(b.byId.get('sumCtx').value, '32768');
  assert.strictEqual(b.byId.get('engineIdleMin').value, '10');
  assert.deepStrictEqual(a.errors.map(fmt).concat(b.errors.map(fmt)), []);
});

test('設定: sumCtx / engineIdleMin は自動保存で数として送る（0 分も 0 で送る）', async () => {
  const l = await load(APP, { returns: { getSettings: () => 設定({ sumCtx: 32768, engineIdleMin: 10 }) } });
  l.byId.get('sumCtx').value = '65536';
  l.byId.get('engineIdleMin').value = '0';
  const sent = await 保存した(l);
  assert.strictEqual(sent.sumCtx, 65536);
  assert.strictEqual(sent.engineIdleMin, 0);
  // 空欄・数でない入力は既定に落とす（main が丸める前に NaN を送らない）
  l.byId.get('sumCtx').value = '';
  l.byId.get('engineIdleMin').value = 'abc';
  const sent2 = await 保存した(l);
  assert.strictEqual(sent2.sumCtx, 32768);
  assert.strictEqual(sent2.engineIdleMin, 10);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('設定: main が丸めた値（applied）は sumCtx / engineIdleMin の欄にも戻る', async () => {
  const l = await load(APP, { returns: { saveSettings: () => ({ ok: true, applied: { sumCtx: 131072, engineIdleMin: 120 } }) } });
  l.byId.get('sumCtx').value = '999999';
  l.byId.get('engineIdleMin').value = '500';
  await 保存した(l);
  assert.strictEqual(l.byId.get('sumCtx').value, '131072', '丸められた文脈長が欄に戻らない');
  assert.strictEqual(l.byId.get('engineIdleMin').value, '120', '丸められた分が欄に戻らない');
});

test('設定: 記録中は要約の文脈長（エンジン起動時の -c）は触れず、自動停止の分は触れる', async () => {
  const l = await load(APP);
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [] });
  await l.drain();
  assert.strictEqual(l.byId.get('sumCtx').disabled, true, '記録中に文脈長を変えられる（エンジンが再起動する）');
  assert.ok(!l.byId.get('engineIdleMin').disabled, '自動停止の分はエンジンの設定ではない');
  l.fire('onMeetingUpdate', { active: false });
  await l.drain();
  assert.strictEqual(l.byId.get('sumCtx').disabled, false, '記録後も触れない');
});

// ================= 設定: データ保存先 =================
// dataDirGet() → { dir, isDefault }、dataDirMove(dir) → { ok, dir, error? }、pickFile('folder') → パスか ''。
const DEF = 'C:\\Users\\someone\\AppData\\Roaming\\Listener';
const 別 = 'D:\\Listener';
const 保存先欄 = (l) => l.byId.get('dataDirNow');
const 移動ボタン = (l) => l.byId.get('dataDirMoveBtn');
const 既定以外 = (l) => l.byId.get('dataDirNote');
async function 設定画面(returns = {}) {
  return load(APP, { preloadSrc: STAGE3(), returns: Object.assign({
    dataDirGet: () => ({ dir: DEF, isDefault: true }),
    dataDirMove: (dir) => ({ ok: true, dir }),
    pickFile: () => 別,
  }, returns) });
}

test('データ保存先: 欄は「動作」のカードにあり、起動時に dataDirGet で現在の場所を出す。説明とボタンの文言が指定どおり', async () => {
  const l = await 設定画面();
  assert.strictEqual(l.called('dataDirGet').length, 1, '起動時に保存先を聞いていない');
  assert.strictEqual(カード見出し(保存先欄(l)), '動作');
  assert.strictEqual(保存先欄(l).value, DEF);
  assert.ok(既定以外(l).hidden, '既定なのに「（既定以外）」が出る');
  const field = 保存先欄(l).closest('.field');
  assert.match(field.querySelector('label').textContent, /^データ保存先/);
  assert.strictEqual(移動ボタン(l).textContent, '保存先を変更…');
  assert.strictEqual(field.querySelector('.desc').textContent.trim(),
    '議事録と設定の保存先。Roaming（既定）は社内のプロファイル同期で複製されることがあります。移動しても元の場所のデータは消しません');
  // 既存の「データ保存先を開く」はそのまま
  const open = l.byId.get('openDataBtn');
  assert.strictEqual(open.textContent, 'データ保存先を開く');
  assert.ok(l.wired().some((x) => x.id === 'openDataBtn' && x.on.includes('onclick')), '「データ保存先を開く」の結線が消えた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('データ保存先: 既定以外の場所なら「（既定以外）」を添える', async () => {
  const l = await 設定画面({ dataDirGet: () => ({ dir: 別, isDefault: false }) });
  assert.strictEqual(保存先欄(l).value, 別);
  assert.ok(!既定以外(l).hidden, '「（既定以外）」が出ない');
  assert.strictEqual(既定以外(l).textContent, '（既定以外）');
});

test('データ保存先: 「保存先を変更…」はフォルダを選ばせ、空なら何もしない。確認で取り消せば移さない', async () => {
  const l = await 設定画面({ pickFile: () => '' });
  移動ボタン(l).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pickFile').map((c) => c.args[0]), ['folder'], "pickFile('folder') で選ばせていない");
  assert.deepStrictEqual(l.called('dataDirMove'), [], '空のパスで移動を呼んだ');
  // simrun の confirm は常に false（取り消し）
  const l2 = await 設定画面();
  移動ボタン(l2).dispatchEvent({ type: 'click' });
  await l2.drain();
  assert.strictEqual(l2.called('pickFile').length, 1);
  assert.deepStrictEqual(l2.called('dataDirMove'), [], '確認で取り消したのに移した');
  assert.strictEqual(保存先欄(l2).value, DEF, '取り消したのに表示が変わった');
  assert.deepStrictEqual(l.errors.map(fmt).concat(l2.errors.map(fmt)), []);
});

// boot の confirm は常に true（了承）。移す経路はこちらで見る
async function 起動して移す(replies) {
  const os = require('os');
  const { boot } = require('./helpers/boot.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-stage3-'));
  const pre = path.join(dir, 'preload.js');
  fs.writeFileSync(pre, STAGE3());
  try {
    let cur = { dir: DEF, isDefault: true };
    const r = boot('src/renderer/app.html', { preload: pre, replies: Object.assign({}, require('./helpers/replies.js'), {
      dataDirGet: () => cur,
      pickFile: () => 別,
      dataDirMove: (d) => { cur = { dir: d, isDefault: false }; return { ok: true, dir: d }; },
    }, replies) });
    await r.drain();
    const $ = (id) => r.doc.getElementById(id);
    $('dataDirMoveBtn')._fire('click');
    for (let i = 0; i < 5; i++) await r.drain();
    return { r, $ };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('データ保存先: 了承すれば dataDirMove(選んだフォルダ) を呼び、ok なら表示を更新して知らせる', async () => {
  const { r, $ } = await 起動して移す();
  assert.deepStrictEqual(r.calls.filter((c) => c === 'dataDirMove').length, 1, 'dataDirMove が 1 回でない');
  assert.strictEqual($('dataDirNow').value, 別, '移した先が表示に反映されない');
  assert.strictEqual($('dataDirNote').hidden, false, '移した後に「（既定以外）」が出ない');
  assert.match($('toast').textContent, /移しました/, '移したことを知らせていない');
  assert.ok(!$('dataDirMoveBtn').disabled, '移した後にボタンが押せないまま');
  assert.deepStrictEqual(r.errors, []);
});

test('データ保存先: 移せなければ error を通知に出し、表示は元のまま', async () => {
  const { r, $ } = await 起動して移す({ dataDirMove: () => ({ ok: false, error: '書き込めないフォルダです' }) });
  assert.match($('toast').textContent, /書き込めないフォルダです/, 'error が通知に出ない');
  assert.strictEqual($('dataDirNow').value, DEF, '失敗したのに表示が変わった');
  assert.ok(!$('dataDirMoveBtn').disabled, '失敗後にボタンが押せないまま');
  assert.deepStrictEqual(r.errors, []);
});

test('データ保存先: 記録中・作成中（finalizing）は「保存先を変更…」を止めて理由を出し、終われば戻す', async () => {
  const l = await 設定画面();
  const note = l.byId.get('dataDirLock');
  assert.ok(!移動ボタン(l).disabled && note.hidden, '前提: 記録前は押せて理由も出ない');
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [] });
  await l.drain();
  assert.strictEqual(移動ボタン(l).disabled, true, '記録中に保存先を変えられる');
  assert.ok(!note.hidden && /記録中|要約中/.test(note.textContent), '理由が出ない');
  l.fire('onMeetingUpdate', { active: false, finalizing: true, startedAt: Date.now() - 60000, stoppedAt: Date.now(), segments: [] });
  await l.drain();
  assert.strictEqual(移動ボタン(l).disabled, true, '作成中（要約中）に保存先を変えられる');
  l.fire('onMeetingUpdate', { active: false });
  await l.drain();
  assert.strictEqual(移動ボタン(l).disabled, false, '記録が終わっても押せない');
  assert.ok(note.hidden, '記録が終わっても理由が残る');
  // 押しても IPC しない
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [] });
  await l.drain();
  移動ボタン(l).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pickFile'), [], '記録中に押せてしまう');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('データ保存先: 「要約を再生成」の最中も止め、終われば戻す', async () => {
  const { PAGE } = require('./helpers/replies.js');
  const { STANDUP_SEGMENTS } = require('./fixtures.js');
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let done;
  const l = await 設定画面({
    pageGet: () => ({ page: clone(PAGE), segments: clone(STANDUP_SEGMENTS) }),
    pageSummarize: () => new Promise((r) => { done = r; }),
  });
  l.fire('onPageOpen', 'p1');
  await l.drain();
  const btn = () => l.byId.get('pActs').querySelectorAll('button').find((b) => /要約/.test(b.textContent) || /生成中/.test(b.textContent));
  btn().dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('pageSummarize').length, 1, '前提: 要約が走っている');
  assert.strictEqual(移動ボタン(l).disabled, true, '要約中に保存先を変えられる');
  assert.ok(!l.byId.get('dataDirLock').hidden, '理由が出ない');
  done({ ok: true, stat: { linked: 1, total: 1 } });
  await l.drain();
  assert.strictEqual(移動ボタン(l).disabled, false, '要約が終わっても押せない');
  assert.ok(l.byId.get('dataDirLock').hidden, '要約が終わっても理由が残る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('データ保存先: dataDirGet / dataDirMove の無い古い preload と組んでも、設定画面は生きて押しても落ちない', async () => {
  // preload は追いついたので、古い preload はここで作る（当該の行を落とす）
  const old = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8').replace(/^\s{2}(dataDirGet|dataDirMove):.*\n/gm, '');
  assert.ok(!/dataDirMove/.test(old), '前提: 古い preload に dataDirMove が残っている');
  const l = await load(APP, { preloadSrc: old });
  assert.deepStrictEqual(l.errors.map(fmt), []);
  assert.deepStrictEqual(l.consoleErrors, []);
  移動ボタン(l).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
  assert.deepStrictEqual(l.called('pickFile'), [], '移せないのにフォルダを選ばせた');
});
