/*
 * runtime.app.test.js — メイン画面（app.html）を最小DOM上で実際に走らせて検査する
 *
 * repo.test.js の多くはソースを正規表現で見るが、実機で出たデグレは
 * 「構文は正しいが、実行すると初期化が途中で死ぬ」型だった（v0.10.3 / v0.10.4）。
 * ここでは <script> を実際に評価し、初期化がどこまで到達したかを観測値で見る。
 *
 * 読み込みは before で一度だけ行う。非同期の初期化で出た例外は
 * unhandledRejection として遅れて届くので、読み込みを個々のテストの中で
 * すると、別のテストに巻き添えで付く（実際にそうなった）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { parseHTML } = require('./helpers/simdom.js');
const { load, RETURNS } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;

let 待機, 記録中, 押した, 未読込;

test.before(async () => {
  待機 = await load(APP);
  記録中 = await load(APP, { returns: { meetingStatus: () => ({ active: true, systemAudio: true, pending: 0, startedAt: Date.now() }) } });
  押した = await load(APP);
  await 押した.clickAll();
  // 設定がまだ返ってこない状態（読み込みが遅い／失敗している最中）
  未読込 = await load(APP, { returns: { getSettings: () => new Promise(() => {}) } });
});

test('HTMLが木として整合している（閉じ忘れも相手違いの閉じタグも無い）', () => {
  const { root, errors } = parseHTML(fs.readFileSync(APP, 'utf8'));
  assert.deepStrictEqual(errors.map((e) => `${e.line}行 ${e.msg}`), []);
  assert.ok(root._walk([]).length > 100, '木が空。パーサが空振りしている');
});

test('初期化が例外なく完走し、設定の読み込みまで到達する', () => {
  assert.deepStrictEqual(待機.errors.map(fmt), [], '初期化で例外');
  assert.deepStrictEqual(待機.consoleErrors, [], '初期化で console.error');
  // 到達の証拠。例外が無くても、途中で止まっていればここが 0 になる。
  assert.strictEqual(待機.called('getSettings').length, 1, '設定の読み込みまで到達していない');
  assert.strictEqual(待機.called('getHistory').length, 1, '履歴の読み込みまで到達していない');
  assert.strictEqual(待機.called('meetingStatus').length, 1, '初期化の最後まで到達していない');
});

test('参照した id は、HTMLにあるか画面が自分で作ったもののどちらか', () => {
  // 動的に作る要素は「除外リスト」で逃がさず、その状態を実際に作って解決させる
  const missing = new Set(), created = new Set(), looked = new Set();
  for (const l of [待機, 記録中, 押した]) {
    l.missingIds.forEach((i) => missing.add(i));
    l.createdIds.forEach((i) => created.add(i));
    l.lookups.forEach((i) => looked.add(i));
  }
  assert.deepStrictEqual([...missing].filter((i) => !created.has(i)), [], 'HTMLに無い id を参照している');
  assert.ok(looked.size >= 40, `id の参照が ${looked.size} 件しかない。検査が空振りしている`);
});

test('設定を読んで入力欄に反映する（fill が走っている）', () => {
  const s = RETURNS.getSettings();
  const v = (id) => 待機.byId.get(id) && 待機.byId.get(id).value;
  assert.strictEqual(v('hotkey'), s.hotkey, 'ホットキー欄に設定が入っていない');
  assert.strictEqual(v('localServerExe'), s.localServerExe, 'エンジンのパス欄に設定が入っていない');
  assert.strictEqual(v('dictionary'), s.dictionary.join('\n'), 'ユーザー辞書欄に設定が入っていない');
  assert.strictEqual(待機.byId.get('useVad').checked, true, 'チェックボックスに設定が入っていない');
});

test('初期化のあいだ一度も設定を保存しない', () => {
  assert.deepStrictEqual(待機.called('saveSettings'), [],
    '初期化中に保存が走った。画面が空のまま保存されると、ディスクの設定を空で上書きしてしまう');
});

test('設定をまだ読めていない間に設定タブを触っても、保存しない', async () => {
  const tab = 未読込.byId.get('tabSettings');
  assert.ok(未読込.wired().some((x) => x.id === 'tabSettings' && x.listeners.includes('change')),
    '自動保存の結線が設定の読み込みより後にある（この検査が空振りする）');
  tab.dispatchEvent({ type: 'change' });
  await 未読込.drain();
  assert.deepStrictEqual(未読込.called('saveSettings'), [],
    '設定を読めていないのに保存した。ディスクの設定を空で上書きしてしまう');
});

test('自動保存は、設定を読み込んだ後の値で保存する', async () => {
  const l = await load(APP);
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const saved = l.called('saveSettings');
  assert.strictEqual(saved.length, 1, '設定タブの change で自動保存が走らない（結線が死んでいる）');
  assert.strictEqual(saved[0].args[0].hotkey, 'Control+Shift+Space', '読み込み前の空の値で保存している');
  assert.ok(saved[0].args[0].localServerExe, '読み込み前の空の値で保存している');
});

test('要となるボタンに、実際にハンドラが付く', () => {
  const w = new Set(待機.wired().map((x) => x.id).filter(Boolean));
  // 更新の2つは「壊れたときに直すための道」なので、特に落ちてはいけない
  for (const id of ['chkUpdBtn', 'applyUpdBtn', 'openDataBtn', 'testBtn', 'testSumBtn',
                    'tabBtnNotes', 'tabBtnDictation', 'tabBtnSettings']) {
    assert.ok(w.has(id), `${id} にハンドラが付いていない（ボタンが効かない）`);
  }
  assert.ok(待機.wired().some((x) => x.id === 'tabSettings' && x.listeners.includes('change')),
    '設定の自動保存が結線されていない');
});

test('結線済みハンドラを全部叩いても例外が出ない', () => {
  assert.ok(押した.wired().length >= 20, `結線が ${押した.wired().length} 件しかない。検査が空振りしている`);
  assert.deepStrictEqual(押した.errors.map(fmt), [], 'ハンドラの実行で例外');
});

test('設定タブのカードは全部スクロール枠の中にある', () => {
  const cards = 待機.byId.get('tabSettings').querySelectorAll('.card');
  assert.ok(cards.length >= 4, `設定カードが ${cards.length} 枚しかない`);
  assert.deepStrictEqual(cards.filter((c) => !c.closest('.scroll')).map((c) => `${c._line}行`), [],
    'スクロール枠の外に出たカードがある（画面に出ない／スクロールで届かない）');
});

// ================= 文字起こしの編集 =================
// 行の本文をその場で直せる。保存は blur、Enter で確定、Escape で取り消し。
// 日本語入力の変換確定 Enter では抜けない。保存に失敗したら元に戻して知らせる。
const { PAGE } = require('./helpers/replies.js');
const { STANDUP_SEGMENTS } = require('./fixtures.js');
const clone = (x) => JSON.parse(JSON.stringify(x));

async function 開いた(extra = {}) {
  const segs = clone(STANDUP_SEGMENTS);
  const returns = Object.assign({
    pageGet: (id) => ({ page: Object.assign(clone(PAGE), { id, title: id === 'p2' ? '二つ目の議事録' : PAGE.title }), segments: segs }),
    segmentUpdate: (pageId, segId, patch) => ({
      page: Object.assign(clone(PAGE), { id: pageId }),
      segments: segs.map((s) => (s.id === segId ? Object.assign({}, s, { text: patch.text }) : s)),
    }),
  }, extra);
  const l = await load(APP, { returns });
  l.fire('onPageOpen', 'p1');
  await l.drain();
  return l;
}
const 行 = (l) => l.byId.get('pScript').querySelectorAll('.seg');
const 本文 = (row) => row.querySelector('.txt');
const spyBlur = (el) => { let n = 0; el.blur = () => { n++; }; return () => n; };

test('文字起こしの各行が編集できる形で描かれ、出典が飛び先に使う id は据え置き', async () => {
  const l = await 開いた();
  const rows = 行(l);
  assert.strictEqual(rows.length, STANDUP_SEGMENTS.length, '行数が合わない');
  for (const [i, r] of rows.entries()) {
    assert.strictEqual(r.id, `seg-${STANDUP_SEGMENTS[i].id}`, '出典チップが飛ぶ id が変わった');
    const t = 本文(r);
    assert.ok(t, '本文の要素が無い');
    assert.strictEqual(t.contentEditable, 'true', `${r.id} が編集できない`);
    assert.strictEqual(t.textContent, STANDUP_SEGMENTS[i].text);
  }
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('文を変えて blur すると、その区間だけ保存され、要約側（出典チップ）が描き直される', async () => {
  const l = await 開いた();
  const noteBefore = l.byId.get('pNote').childNodes[0];
  const t = 本文(行(l)[2]);
  t.textContent = '在庫連携のバッチ処理ですが、性能が出ていません。';
  t.dispatchEvent({ type: 'blur' });
  await l.drain();
  const calls = l.called('segmentUpdate');
  assert.strictEqual(calls.length, 1, '保存が1回でない');
  assert.deepStrictEqual(calls[0].args, ['p1', 's3', { text: '在庫連携のバッチ処理ですが、性能が出ていません。' }]);
  assert.notStrictEqual(l.byId.get('pNote').childNodes[0], noteBefore, '要約タブが描き直されていない（出典チップが古いまま）');
  // 文字起こし面は描き直さない（次の行の編集を壊さない）
  assert.strictEqual(本文(行(l)[2]), t, '文字起こし面が描き直された');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('変えずに blur しても保存しない', async () => {
  const l = await 開いた();
  本文(行(l)[0]).dispatchEvent({ type: 'blur' });
  await l.drain();
  assert.deepStrictEqual(l.called('segmentUpdate'), []);
});

test('Enter で確定（blur）し、Escape は元の文に戻して抜ける', async () => {
  const l = await 開いた();
  const t = 本文(行(l)[1]);
  const blurs = spyBlur(t);
  t.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.strictEqual(blurs(), 1, 'Enter で確定しない');
  t.textContent = '途中まで書いた';
  t.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.strictEqual(t.textContent, STANDUP_SEGMENTS[1].text, 'Escape で元に戻らない');
  assert.strictEqual(blurs(), 2, 'Escape で抜けない');
});

test('日本語入力の変換確定 Enter では抜けない（isComposing / keyCode 229）', async () => {
  const l = await 開いた();
  const t = 本文(行(l)[1]);
  const blurs = spyBlur(t);
  t.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: true });
  t.dispatchEvent({ type: 'keydown', key: 'Enter', keyCode: 229 });
  assert.strictEqual(blurs(), 0, '変換確定の Enter で編集が終わってしまう');
});

test('保存に失敗したら知らせて、画面の文を元に戻す', async () => {
  const l = await 開いた({ segmentUpdate: () => null });
  const t = 本文(行(l)[4]);
  t.textContent = '保存できない文';
  t.dispatchEvent({ type: 'blur' });
  await l.drain();
  assert.ok(/保存できませんでした/.test(l.byId.get('toast').textContent), 'toast が出ない');
  assert.strictEqual(t.textContent, STANDUP_SEGMENTS[4].text, '失敗したのに画面の文が新しいまま（保存されたように見える）');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('編集中に page:updated が来ても、文字起こし面を描き直さない', async () => {
  const l = await 開いた();
  const row = 行(l)[3];
  const t = 本文(row);
  t.dispatchEvent({ type: 'focus' });
  assert.ok(row.classList.contains('editing'), '編集中の印が付かない');
  l.fire('onPageUpdated', { page: clone(PAGE), segments: clone(STANDUP_SEGMENTS) });
  await l.drain();
  assert.strictEqual(行(l)[3], row, '編集中の行が作り直された（入力中の文が消える）');
  t.dispatchEvent({ type: 'blur' });
  assert.ok(!row.classList.contains('editing'), '編集を抜けたのに印が残る');
});

test('保存中に別のページへ移ったら、遅れて戻ってきた古いページの結果で画面を上書きしない', async () => {
  const segs = clone(STANDUP_SEGMENTS);
  const l = await 開いた({
    pageGet: (id) => ({
      page: Object.assign(clone(PAGE), { id, title: id === 'p2' ? '二つ目の議事録' : PAGE.title, blocks: id === 'p2' ? [{ id: 'q1', type: 'bullet', text: '二つ目の要点', cites: [] }] : PAGE.blocks }),
      segments: segs,
    }),
    // 保存の応答が、ページ切替より後に届く
    segmentUpdate: () => new Promise((res) => setTimeout(() => res({
      page: Object.assign(clone(PAGE), { blocks: [{ id: 'o1', type: 'bullet', text: '古いページの保存結果', cites: [] }] }),
      segments: segs,
    }), 10)),
  });
  const t = 本文(行(l)[0]);
  t.textContent = '別の文';
  t.dispatchEvent({ type: 'blur' });         // 保存が走り始める（応答は 10ms 後）
  l.fire('onPageOpen', 'p2');                // その直後にページ切替
  await l.drain();
  const texts = () => l.byId.get('pNote').querySelectorAll('.txt').map((e) => e.textContent);
  assert.deepStrictEqual(texts(), ['二つ目の要点'], '切替が反映されていない（前提）');
  await new Promise((r) => setTimeout(r, 30));   // 古い保存の応答が届く
  await l.drain();
  assert.deepStrictEqual(texts(), ['二つ目の要点'], '古いページの保存結果で要約タブが上書きされた');
  assert.strictEqual(l.byId.get('pTitle').textContent, '二つ目の議事録');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('空にした行はコピーに含めない', async () => {
  const l = await 開いた();
  const t = 本文(行(l)[0]);
  t.textContent = '';
  t.dispatchEvent({ type: 'blur' });
  await l.drain();
  l.byId.get('paneBtnScript').dispatchEvent({ type: 'click' });
  const copyBtn = l.byId.get('pActs').querySelectorAll('button').find((b) => b.textContent === 'コピー');
  assert.ok(copyBtn, 'コピーのボタンが無い');
  copyBtn.dispatchEvent({ type: 'click' });
  await l.drain();
  const c = l.called('copy');
  assert.strictEqual(c.length, 1);
  assert.ok(!/\[0:00\] *\n/.test(c[0].args[0] + '\n'), '空の行が [0:00] だけで写っている');
  assert.ok(c[0].args[0].includes(STANDUP_SEGMENTS[1].text), '残りの行が写っていない');
});

// ================= 編集中の内容を失わない（メモ・要点・タイトル） =================
// 保存は「発火したときのページ」に対して行い、ページ切替・記録開始の前には
// 保留中の編集を確定させる。監査で見つかった取りこぼしをここに移した。
const メモ欄 = (l) => l.byId.get('pMemo').querySelector('textarea');
const ブロック = (l, id) => l.byId.get('pNote').querySelectorAll('.blk').find((e) => e.dataset.id === id);

test('メモの遅延保存は、書いたときに開いていたページへ書く（切替後の別ページに書かない）', async () => {
  const l = await 開いた();
  const ta = メモ欄(l);
  assert.ok(ta, 'メモ欄が無い');
  ta.value = '前のページに書いたメモ';
  ta.dispatchEvent({ type: 'input' });
  l.fire('onPageOpen', 'p2');            // 保存が走る前にページ切替
  await l.drain();
  const calls = l.called('pageSetMemo');
  assert.strictEqual(calls.length, 1, '切替の前に保留中のメモが確定されない');
  assert.deepStrictEqual(calls[0].args, ['p1', '前のページに書いたメモ']);
  assert.strictEqual(l.byId.get('pTitle').textContent, '二つ目の議事録');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('ホットキーで記録開始しても、編集中の要点とタイトルは元のページへ保存される', async () => {
  const l = await 開いた();
  const t = ブロック(l, 'b2').querySelector('.txt');
  t.textContent = '週次の締めを木曜にする';
  l.byId.get('pTitle').textContent = '新しい題';
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [] });   // 記録開始（blur は来ない）
  await l.drain();
  assert.deepStrictEqual(l.called('blockUpdate').map((c) => c.args), [['p1', 'b2', { text: '週次の締めを木曜にする' }]]);
  assert.deepStrictEqual(l.called('pageSetTitle').map((c) => c.args), [['p1', '新しい題']]);
  // 記録開始で議事録は閉じているので、画面（白紙）は触らない
  assert.strictEqual(l.byId.get('pTitle').textContent, '');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('変えていない要点・タイトルは、ページ切替のたびに保存しない', async () => {
  const l = await 開いた();
  l.fire('onPageOpen', 'p2');
  await l.drain();
  assert.deepStrictEqual(l.called('blockUpdate'), []);
  assert.deepStrictEqual(l.called('pageSetTitle'), []);
});

// ================= IME の変換確定 Enter =================
const TODO_PAGE = () => Object.assign(clone(PAGE), {
  blocks: [{ id: 't1', type: 'todo', text: '見積を送る', cites: [], assignee: '', dueRaw: '' }],
});

test('日本語入力の変換確定 Enter は、要点・担当チップ・タイトルのどれでも確定にならない', async () => {
  const l = await 開いた({ pageGet: (id) => ({ page: Object.assign(TODO_PAGE(), { id }), segments: clone(STANDUP_SEGMENTS) }) });
  const ime = [{ type: 'keydown', key: 'Enter', isComposing: true }, { type: 'keydown', key: 'Enter', keyCode: 229 }];
  // 要点: Enter は行の追加、空行の Backspace は削除。変換中はどちらも走らない
  const txt = ブロック(l, 't1').querySelector('.txt');
  for (const ev of ime) txt.dispatchEvent(ev);
  txt.textContent = '';
  txt.dispatchEvent({ type: 'keydown', key: 'Backspace', keyCode: 229 });
  await l.drain();
  assert.deepStrictEqual(l.called('blockInsert'), [], '変換確定の Enter で行が追加される');
  assert.deepStrictEqual(l.called('blockRemove'), [], '変換中の Backspace で行が消える');
  // 担当チップ: Enter で確定して入力欄がボタンに戻る。変換中は戻らない
  const who = ブロック(l, 't1').querySelector('.atag');
  // 最小DOMに replaceWith が無いので、ここだけ本物と同じ動きを補う
  const replaceWith = function (n) { this.parentNode.insertBefore(n, this); this.remove(); };
  who.replaceWith = replaceWith;
  who.dispatchEvent({ type: 'click' });
  const inp = ブロック(l, 't1').querySelector('.atag-edit');
  assert.ok(inp, '担当の入力欄が出ない');
  inp.replaceWith = replaceWith;
  for (const ev of ime) inp.dispatchEvent(ev);
  assert.ok(ブロック(l, 't1').querySelector('.atag-edit'), '変換確定の Enter で担当の編集が終わってしまう');
  // タイトル
  const title = l.byId.get('pTitle');
  const blurs = spyBlur(title);
  for (const ev of ime) title.dispatchEvent(ev);
  assert.strictEqual(blurs(), 0, '変換確定の Enter でタイトルの編集が終わってしまう');
  title.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.strictEqual(blurs(), 1, '普通の Enter で確定しない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= 記録中のタブ =================
test('記録中に区間が届いても、見ていたメモタブから文字起こしタブへ引き戻さない', async () => {
  const l = await load(APP);
  const st = { active: true, startedAt: Date.now(), segments: [] };
  l.fire('onMeetingUpdate', st);
  await l.drain();
  assert.ok(l.byId.get('pScript').classList.contains('active'), '記録開始で文字起こしタブに切り替わらない（前提）');
  l.byId.get('paneBtnMemo').dispatchEvent({ type: 'click' });
  for (let i = 1; i <= 3; i++) {
    l.fire('onMeetingUpdate', Object.assign({}, st, { pending: i, segments: [{ id: `s${i}`, atMs: i * 1000, text: `発言${i}` }] }));
    await l.drain();
  }
  assert.ok(l.byId.get('pMemo').classList.contains('active'), '区間が届くたびに文字起こしタブへ強制切替される');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= ダーク専用色がライトに漏れない =================
const simcss = require('./helpers/simcss.js');
test('ライト配色で button.ghost の文字は地に対して 4.5:1 以上ある（ダーク用の薄灰色が漏れていない）', () => {
  const { root } = parseHTML(fs.readFileSync(APP, 'utf8'));
  const css = root.querySelectorAll('style').map((s) => s._raw).join('\n');
  const rules = simcss.parse(css);
  const light = { at: '' };
  const ink = simcss.firstColor(simcss.declsFor(rules, 'button.ghost', light).color);
  const ground = simcss.firstColor(simcss.declsFor(rules, 'body', light).background);
  assert.ok(ink && ground, '色が読めない（検査が空振りしている）');
  // ボタンの面は白の半透明。地そのものと純白のどちらの上でも読めること
  for (const bg of [ground, [255, 255, 255, 1]]) {
    const c = simcss.contrast(simcss.over(ink, bg), bg);
    assert.ok(c >= 4.5, `button.ghost の文字 ${JSON.stringify(ink)} の対比が ${c.toFixed(2)} しかない`);
  }
});

// ================= 要約ボタンの二重押し =================
test('要約の生成中は、page:updated で描き直されてもボタンが押せないまま', async () => {
  let done;
  const l = await 開いた({ pageSummarize: () => new Promise((r) => { done = r; }) });
  const btn = () => l.byId.get('pActs').querySelectorAll('button').find((b) => /要約/.test(b.textContent) || /生成中/.test(b.textContent));
  btn().dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('pageSummarize').length, 1);
  l.fire('onPageUpdated', { page: clone(PAGE), segments: clone(STANDUP_SEGMENTS) });
  await l.drain();
  assert.strictEqual(btn().disabled, true, '描き直しでボタンが押せるようになっている（二重起動できる）');
  done({ ok: true, stat: { linked: 1, total: 1 } });
  await l.drain();
  assert.ok(!btn().disabled, '完了後もボタンが押せない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= ホットキーの登録状態 =================
// preload にまだ無い公開名は、テスト側で名前だけ補う（main / preload は別の作業で足される。
// 画面の側だけ先に作って検査できるようにする）。既にある名前は二重に足さない。
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const preloadWith = (...names) => names.reduce((src, n) => (new RegExp(`^\\s+${n}\\s*:`, 'm').test(src) ? src
  : src.replace("exposeInMainWorld('koeApp', {", `exposeInMainWorld('koeApp', {\n  ${n}: (...a) => ipcRenderer.invoke('test:${n}', ...a),`)), PRELOAD);
const preloadWithHotkey = () => preloadWith('hotkeyState');

test('登録できなかったホットキーの欄の下に、赤い説明が出る（設定の表示時と保存後）', async () => {
  let st = { ok: false, failed: ['議事録'], message: '' };
  const l = await load(APP, { preloadSrc: preloadWithHotkey(), returns: {
    hotkeyState: () => st,
    saveSettings: () => ({ ok: true, warning: '議事録ホットキーを登録できませんでした' }),
  } });
  assert.deepStrictEqual(l.errors.map(fmt), []);
  assert.ok(l.called('hotkeyState').length >= 1, '設定の表示時に登録状態を見ていない');
  const warn = (id) => l.document.getElementById(id + 'Warn');
  assert.ok(warn('meetingHotkey') && !warn('meetingHotkey').hidden, '議事録ホットキーの警告が出ない');
  assert.ok(/他のアプリが使用中/.test(warn('meetingHotkey').textContent), '警告の文言が違う');
  assert.ok(!warn('hotkey') || warn('hotkey').hidden, '登録できている方にも警告が出ている');
  assert.ok(warn('meetingHotkey').closest('.field') === l.byId.get('meetingHotkey').closest('.field'), '警告が欄の下に無い');
  // 保存 → 戻り値の warning を toast で出し、状態を取り直す
  st = { ok: true, failed: [], message: '' };
  const before = l.called('hotkeyState').length;
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.ok(/登録できませんでした/.test(l.byId.get('toast').textContent), 'warning が toast に出ない');
  assert.ok(l.called('hotkeyState').length > before, '保存後に登録状態を取り直していない');
  assert.ok(warn('meetingHotkey').hidden, '登録できるようになったのに警告が残る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('保存が ok:false のときは、これまで通り保存メッセージに赤で出る', async () => {
  const l = await load(APP, { preloadSrc: preloadWithHotkey(), returns: { saveSettings: () => ({ ok: false, error: '書き込めません' }) } });
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(l.byId.get('saveMsg').textContent, '書き込めません');
  assert.ok(l.byId.get('saveMsg').className.includes('ng'));
});

// ================= 「根拠なし」札の意味 =================
const CITE_PAGE = () => Object.assign(clone(PAGE), {
  blocks: [
    { id: 'c1', type: 'bullet', text: '短い', cites: [], citeSkip: true },
    { id: 'c2', type: 'bullet', text: '自分で足した行です', cites: [], citeState: 'manual' },
    { id: 'c3', type: 'bullet', text: '編集したあと照合していない行', cites: ['s1'], citeState: 'stale' },
    { id: 'c4', type: 'bullet', text: '照合できなかった行です', cites: [] },
    { id: 'c5', type: 'bullet', text: '短', cites: [] },
  ],
});
const 札 = (l, id) => { const n = ブロック(l, id).querySelector('.nocite'); return n ? { text: n.textContent, cls: n.className, title: n.title } : null; };

test('札は「照合対象外 / 手書き / 編集済み / 根拠なし」を区別する（文字数では判定しない）', async () => {
  const l = await 開いた({ pageGet: (id) => ({ page: Object.assign(CITE_PAGE(), { id }), segments: clone(STANDUP_SEGMENTS) }) });
  assert.strictEqual(札(l, 'c1'), null, '照合対象外の行に札が出ている');
  assert.strictEqual(札(l, 'c2').text, '手書き');
  assert.ok(/自分で追加/.test(札(l, 'c2').title));
  assert.ok(札(l, 'c2').cls.includes('manual'));
  assert.strictEqual(札(l, 'c3').text, '編集済み');
  assert.ok(札(l, 'c3').cls.includes('stale'));
  assert.ok(/再生成/.test(札(l, 'c3').title));
  assert.strictEqual(ブロック(l, 'c3').querySelectorAll('.cite').length, 1, '編集済みでも出典チップは残す');
  assert.strictEqual(札(l, 'c4').text, '根拠なし');
  assert.strictEqual(札(l, 'c5').text, '根拠なし', '短い行は store が citeSkip を付ける。画面の文字数で黙らせない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('要点の本文を直して blur すると、札が「編集済み」に変わる', async () => {
  const l = await 開いた({ pageGet: (id) => ({ page: Object.assign(CITE_PAGE(), { id }), segments: clone(STANDUP_SEGMENTS) }) });
  const t = ブロック(l, 'c4').querySelector('.txt');
  t.textContent = '照合できなかった行を直した';
  t.dispatchEvent({ type: 'blur' });
  await l.drain();
  assert.deepStrictEqual(l.called('blockUpdate').map((c) => c.args), [['p1', 'c4', { text: '照合できなかった行を直した' }]]);
  assert.strictEqual(札(l, 'c4').text, '編集済み');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('JS が付ける札のクラス（manual / stale）に CSS の定義がある', () => {
  const { root } = parseHTML(fs.readFileSync(APP, 'utf8'));
  const css = root.querySelectorAll('style').map((s) => s._raw).join('\n');
  const sels = simcss.parse(css).map((r) => r.sel);
  for (const c of ['.nocite.manual', '.nocite.stale']) assert.ok(sels.some((s) => s.split(',').map((x) => x.trim()).includes(c)), `${c} の定義が無い`);
});

// ================= 幽霊行 =================
test('一覧にあるのに開けないページは知らせるだけで、削除はしない（文字起こしを道連れにしない）', async () => {
  const l = await 開いた({ pageGet: (id) => (id === 'ghost' ? null : { page: Object.assign(clone(PAGE), { id }), segments: clone(STANDUP_SEGMENTS) }) });
  const searches = l.called('pagesSearch').length;
  l.fire('onPageOpen', 'ghost');
  await l.drain();
  assert.ok(/開けません/.test(l.byId.get('toast').textContent), 'toast が出ない');
  // page.json だけが壊れて transcript が無傷、という行を deletePage すると文字起こしまで消える。
  // 掃除は次回起動の reconcile に任せる。
  assert.deepStrictEqual(l.called('pageDelete'), [], '幽霊行で pageDelete を呼んだ');
  assert.ok(l.called('pagesSearch').length > searches, '一覧を取り直していない');
  assert.strictEqual(l.byId.get('pTitle').textContent, PAGE.title, '開いていたページが消えた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= 統合レビューで見つかった取りこぼし =================
test('手書きの行は本文を直しても「手書き」のまま（store と同じ規則。「編集済み」に塗り替えない）', async () => {
  const l = await 開いた({ pageGet: (id) => ({
    page: Object.assign(clone(PAGE), { id, blocks: [...clone(PAGE.blocks), { id: 'm1', type: 'bullet', text: '自分で足した要点です', cites: [], citeState: 'manual' }] }),
    segments: clone(STANDUP_SEGMENTS),
  }) });
  const el = ブロック(l, 'm1');
  assert.ok(el, '手書きの行が描かれていない');
  const t = el.querySelector('.txt');
  t.textContent = '自分で足した要点を書き直した';
  t.dispatchEvent({ type: 'blur' });
  await l.drain();
  const badge = el.querySelector('.nocite');
  assert.ok(badge && badge.textContent === '手書き', `札が「手書き」でない: ${badge && badge.textContent}`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('要約完了の page:updated が、打ち替え中のタイトルと書きかけのメモを捨てない', async () => {
  const l = await 開いた();
  l.byId.get('pTitle').textContent = '打ち替えた題';
  const ta = メモ欄(l);
  ta.value = '書きかけのメモ';
  ta.dispatchEvent({ type: 'input' });
  // blur も 500ms も来ないうちに要約が終わって届く（main は古い題・古いメモを持っている）
  l.fire('onPageUpdated', { page: Object.assign(clone(PAGE), { id: 'p1' }), segments: clone(STANDUP_SEGMENTS) });
  await l.drain();
  assert.strictEqual(l.byId.get('pTitle').textContent, '打ち替えた題', '届いたページの古い題に戻された');
  assert.deepStrictEqual(l.called('pageSetTitle').map((c) => c.args), [['p1', '打ち替えた題']], '打ち替えた題が保存されない');
  assert.deepStrictEqual(l.called('pageSetMemo').map((c) => c.args), [['p1', '書きかけのメモ']], '書きかけのメモが保存されない');
  assert.strictEqual(メモ欄(l).value, '書きかけのメモ', 'メモ欄が古い値で作り直された');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('設定したホットキーが既定で代替されているときは、「登録できていない」ではなく代替中と出す', async () => {
  const l = await load(APP, { preloadSrc: preloadWithHotkey(), returns: {
    hotkeyState: () => ({ ok: true, failed: [], fallback: { '音声入力': { wanted: 'Control+Shift+X', using: 'Control+Shift+Space' } }, message: '' }),
  } });
  const warn = (id) => l.document.getElementById(id + 'Warn');
  assert.ok(warn('hotkey') && !warn('hotkey').hidden, '代替中の注意が出ない');
  assert.ok(/代わりに既定の Control\+Shift\+Space/.test(warn('hotkey').textContent), `文言が違う: ${warn('hotkey').textContent}`);
  assert.ok(!/登録できていません/.test(warn('hotkey').textContent), '動いているキーに「登録できていない」と出ている');
  assert.ok(warn('meetingHotkey').hidden, '関係ない欄に注意が出ている');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('保存で登録できなかったキーは、main が採った値に欄と設定を戻す（失敗したキーを持ち続けない）', async () => {
  const l = await load(APP, { preloadSrc: preloadWithHotkey(), returns: {
    saveSettings: () => ({ ok: true, warning: '音声入力のホットキー Control+Shift+X は他のアプリが使用中のため登録できませんでした', applied: { hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M' } }),
  } });
  l.byId.get('hotkey').value = 'Control+Shift+X';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(l.byId.get('hotkey').value, 'Control+Shift+Space', '失敗したキーが欄に残っている');
  // 次の無関係な保存で、失敗したキーを送り直さない
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const sent = l.called('saveSettings').map((c) => c.args[0].hotkey);
  assert.deepStrictEqual(sent, ['Control+Shift+X', 'Control+Shift+Space'], `送ったキー: ${JSON.stringify(sent)}`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= 一覧のキーボード操作（#55） =================
// 一覧の行は div + onclick なので、そのままでは Tab で辿れず Enter でも開けない。
const 二件 = () => ({
  pagesSearch: () => [
    { id: 'p1', title: '一つ目', date: '9/1', durationSec: 60, hasSummary: true },
    { id: 'p2', title: '二つ目', date: '9/2', durationSec: 60, hasSummary: true },
  ],
});
const 行を開く = (l) => l.called('pageGet').map((c) => c.args[0]);

test('議事録の一覧は listbox で、行は Tab で辿れ Enter / Space で開ける（マウスは今まで通り）', async () => {
  const l = await 開いた(二件());
  const list = l.byId.get('plist');
  assert.strictEqual(list.getAttribute('role'), 'listbox', '一覧に listbox の役割が無い');
  assert.ok(list.getAttribute('aria-label'), '一覧に読み上げ用の名前が無い');
  let rows = list.querySelectorAll('.pitem');
  assert.strictEqual(rows.length, 2, '前提: 行が2つ描かれる');
  for (const r of rows) {
    assert.strictEqual(r.tabIndex, 0, `${r.textContent} が Tab で辿れない`);
    assert.strictEqual(r.getAttribute('role'), 'option', `${r.textContent} に option の役割が無い`);
  }
  assert.strictEqual(rows[0].getAttribute('aria-selected'), 'true', '開いているページが選択中と示されない');
  assert.strictEqual(rows[1].getAttribute('aria-selected'), 'false', '開いていないページが選択中になっている');
  const n0 = 行を開く(l).length;
  rows[1].dispatchEvent({ type: 'keydown', key: 'a' });
  rows[1].dispatchEvent({ type: 'keydown', key: 'Escape' });
  await l.drain();
  assert.strictEqual(行を開く(l).length, n0, '無関係なキーで開いてしまう');
  rows[1].dispatchEvent({ type: 'keydown', key: 'Enter' });
  await l.drain();
  assert.deepStrictEqual(行を開く(l).slice(n0), ['p2'], 'Enter で開かない');
  // 開き直すと行は作り直される。選択の印も移る
  rows = list.querySelectorAll('.pitem');
  assert.strictEqual(rows[1].getAttribute('aria-selected'), 'true', '開いた行に選択の印が移らない');
  assert.strictEqual(rows[0].getAttribute('aria-selected'), 'false');
  rows[0].dispatchEvent({ type: 'keydown', key: ' ' });
  await l.drain();
  assert.deepStrictEqual(行を開く(l).slice(n0), ['p2', 'p1'], 'Space で開かない');
  rows = list.querySelectorAll('.pitem');
  rows[1].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(行を開く(l).slice(n0), ['p2', 'p1', 'p2'], 'マウスで開けなくなった');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('アクション横断ビューの出典行も、Tab で辿れ Enter で元の議事録を開ける', async () => {
  const l = await 開いた({
    openActions: () => [
      { pageId: 'p1', pageTitle: '一つ目', blockId: 'b2', text: 'やること', assignee: '佐藤', date: '9/1' },
      { pageId: 'p2', pageTitle: '二つ目', blockId: 'b9', text: '別のやること', assignee: '', date: '9/2' },
    ],
    assigneeList: () => [],
  });
  l.byId.get('fltActions').dispatchEvent({ type: 'click' });
  await l.drain();
  const rows = l.byId.get('plist').querySelectorAll('.src');
  assert.strictEqual(rows.length, 2, '前提: 出典行が2つ描かれる');
  for (const r of rows) {
    assert.strictEqual(r.tabIndex, 0, '出典行が Tab で辿れない');
    assert.strictEqual(r.getAttribute('role'), 'option');
  }
  assert.strictEqual(rows[0].getAttribute('aria-selected'), 'true', '開いているページの出典行が選択中と示されない');
  assert.strictEqual(rows[1].getAttribute('aria-selected'), 'false');
  const n0 = 行を開く(l).length;
  rows[1].dispatchEvent({ type: 'keydown', key: 'Tab' });
  await l.drain();
  assert.strictEqual(行を開く(l).length, n0, '無関係なキーで開いてしまう');
  rows[1].dispatchEvent({ type: 'keydown', key: 'Enter' });
  await l.drain();
  assert.deepStrictEqual(行を開く(l).slice(n0), ['p2'], 'Enter で元の議事録が開かない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('一覧の行にキーボードのフォーカスが見える（:focus-visible の定義がある）', () => {
  const { root } = parseHTML(fs.readFileSync(APP, 'utf8'));
  const css = root.querySelectorAll('style').map((s) => s._raw).join('\n');
  const rules = simcss.parse(css);
  for (const sel of ['.pitem:focus-visible', '.actrow .src:focus-visible']) {
    const r = rules.find((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
    assert.ok(r, `${sel} の定義が無い（Tab で辿れても今どこにいるか見えない）`);
    assert.ok(r.decls && r.decls.outline && !/none/.test(r.decls.outline), `${sel} に outline が無い`);
  }
});

// ================= 検索の正規化（#53） =================
// 全角／半角・大文字小文字・句読点や空白の違いで取りこぼさない。
// main 側（cite.js の searchFold）と同じ規則で両辺を畳んでから含有を見る。
test('音声入力の履歴検索は、全角と半角・大文字小文字の違いを越えて当たる', async () => {
  const l = await load(APP, { returns: { getHistory: () => [
    { id: 'h1', text: 'ＡＩ戦略の会議', createdAt: new Date().toISOString(), durationSec: 5, chars: 7 },
    { id: 'h2', text: '昼食の相談', createdAt: new Date().toISOString(), durationSec: 5, chars: 5 },
  ] } });
  const hits = () => l.byId.get('histList').querySelectorAll('.entry').length;
  const search = (q) => { l.byId.get('histSearch').value = q; l.byId.get('histSearch').dispatchEvent({ type: 'input' }); };
  assert.strictEqual(hits(), 2, '前提: 検索前は全件');
  search('ai戦略');
  assert.strictEqual(hits(), 1, '「ＡＩ戦略」が ai戦略 で当たらない');
  search('A I 戦略');
  assert.strictEqual(hits(), 1, '空白の違いで当たらない');
  search('存在しない');
  assert.strictEqual(hits(), 0, '当たらないものまで出る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('アクション横断ビューの絞り込みは、句読点の違いを越えて当たる', async () => {
  const l = await 開いた({
    openActions: () => [
      { pageId: 'p1', pageTitle: '一つ目', blockId: 'b2', text: '予算案の、作成', assignee: '佐藤', date: '9/1' },
      { pageId: 'p1', pageTitle: '一つ目', blockId: 'b3', text: '会場の予約', assignee: '', date: '9/1' },
    ],
    assigneeList: () => [],
  });
  const rows = () => l.byId.get('plist').querySelectorAll('.actrow').map((r) => r.querySelector('.body').childNodes[0].textContent);
  // 検索欄の input は遅延（220ms）で走るので、チップを押して即時に描き直す
  l.byId.get('searchBox').value = '予算案の作成';
  l.byId.get('fltActions').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(rows(), ['予算案の、作成'], '「予算案の、作成」が 予算案の作成 で当たらない');
  l.byId.get('searchBox').value = 'さとう';
  l.byId.get('fltActions').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(rows(), [], '当たらないものまで出る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= 作成中の進捗と打ち切り（#8 / #42） =================
// 終了後の文字起こしが長いと、何分待てばよいか分からず、途中で諦める手段も無かった。
const 作成中 = (extra) => Object.assign({ active: true, finalizing: true, stopping: true, pending: 3, etaSec: 150, startedAt: Date.now() - 60000, stoppedAt: Date.now(), segments: [] }, extra);
const バー = (l, id) => l.document.getElementById(id);

test('作成中は残りの区間数と見込み時間が出て、打ち切りボタンは確認のうえ meetingSkipPending を呼ぶ', async () => {
  let st = 作成中();
  const l = await load(APP, { preloadSrc: preloadWith('meetingSkipPending', 'promptInfo'), returns: { meetingStatus: () => st } });
  l.fire('onMeetingUpdate', st);
  await l.drain();
  const eta = バー(l, 'liveEta');
  assert.ok(eta && !eta.hidden, '残りの区間数が出ない');
  assert.strictEqual(eta.textContent, '残り 3 区間（約 3 分）');
  assert.ok(eta.closest('.live'), '記録中バーの中に無い');
  const btn = バー(l, 'liveSkipBtn');
  assert.ok(btn && !btn.hidden, '打ち切りボタンが出ない');
  assert.strictEqual(btn.textContent, '文字起こしを打ち切って要約');
  assert.ok(btn.closest('.live'), '記録中バーの中に無い');
  // 確認で「いいえ」なら何もしない
  l.window.confirm = () => false;
  btn.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('meetingSkipPending'), [], '確認せずに打ち切った');
  // 「はい」で打ち切り、状態を取り直して描き直す
  l.window.confirm = () => true;
  st = 作成中({ pending: 0, etaSec: null, skipped: 3 });
  const before = l.called('meetingStatus').length;
  btn.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('meetingSkipPending').length, 1, '打ち切りが呼ばれない');
  assert.ok(l.called('meetingStatus').length > before, '打ち切り後に状態を取り直していない');
  assert.ok(バー(l, 'liveSkipBtn').hidden, '残りが無いのにボタンが残る');
  assert.ok(バー(l, 'liveEta').hidden, '残りが無いのに区間数が残る');
  const sk = バー(l, 'liveSkipped');
  assert.ok(sk && !sk.hidden, '打ち切った区間数が出ない');
  assert.strictEqual(sk.textContent, '3 区間を打ち切りました');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('見込み時間が分からなければ区間数だけ出す。記録中（終了前）は打ち切りボタンを出さない', async () => {
  const l = await load(APP, { preloadSrc: preloadWith('meetingSkipPending', 'promptInfo') });
  l.fire('onMeetingUpdate', 作成中({ pending: 2, etaSec: null }));
  await l.drain();
  assert.strictEqual(バー(l, 'liveEta').textContent, '残り 2 区間');
  assert.ok(!バー(l, 'liveSkipBtn').hidden);
  assert.ok(バー(l, 'liveSkipped').hidden, '打ち切っていないのに「打ち切りました」が出る');
  // 記録中に区間を変換している（stopping でない）ときは、まだ打ち切る対象ではない
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [], pending: 2, etaSec: 90 });
  await l.drain();
  assert.ok(バー(l, 'liveSkipBtn').hidden, '記録中に打ち切りボタンが出る');
  assert.ok(バー(l, 'liveEta').hidden);
  assert.ok(/2区間を文字起こし中/.test(バー(l, 'liveTitle').textContent), '記録中の表示が変わった');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= マイクの代替（#56） =================
test('選んだマイクが見つからず既定のマイクで録っているときは、記録中バーに赤で出す', async () => {
  const l = await load(APP);
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [], micFallback: true });
  await l.drain();
  const m = バー(l, 'liveMic');
  assert.ok(m && !m.hidden, '代替の注意が出ない');
  assert.strictEqual(m.textContent, '選んだマイクが見つからないため、既定のマイクで録音しています');
  assert.ok(m.className.split(/\s+/).includes('ng'), '赤（.ng）になっていない');
  assert.ok(m.closest('.live'), '記録中バーの中に無い');
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [], micFallback: false });
  await l.drain();
  assert.ok(バー(l, 'liveMic').hidden, '選んだマイクで録れているのに注意が残る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ================= 辞書の上限（#23） =================
// 辞書は認識ヒント（whisper のプロンプト）に載るが長さに上限があり、超えた分は黙って捨てられる。
test('辞書が認識ヒントの上限を超えていたら、辞書欄の下に何語まで効くかを出す（表示時と保存後）', async () => {
  let info = { ok: true, kept: 12, total: 20, over: true };
  const l = await load(APP, { preloadSrc: preloadWith('meetingSkipPending', 'promptInfo'), returns: { promptInfo: () => info } });
  assert.deepStrictEqual(l.errors.map(fmt), []);
  assert.ok(l.called('promptInfo').length >= 1, '設定の表示時に見ていない');
  const w = l.byId.get('dictWarn');
  assert.ok(w && !w.hidden, '上限超えの注意が出ない');
  assert.strictEqual(w.textContent, '辞書が認識ヒントの上限を超えています（先頭から 12 語まで有効。それ以降は渡されません）');
  assert.ok(w.className.split(/\s+/).includes('ng'), '赤（.ng）になっていない');
  assert.strictEqual(w.closest('.field'), l.byId.get('dictionary').closest('.field'), '辞書欄の下に無い');
  info = { ok: true, kept: 5, total: 5, over: false };
  const before = l.called('promptInfo').length;
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.ok(l.called('promptInfo').length > before, '保存後に取り直していない');
  assert.ok(w.hidden, '収まったのに注意が残る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('promptInfo の無い古い preload と組んでも、設定画面は生きて注意は出ない', async () => {
  const l = await load(APP);
  assert.deepStrictEqual(l.errors.map(fmt), []);
  assert.deepStrictEqual(l.consoleErrors, []);
  assert.ok(l.byId.get('dictWarn').hidden);
});

// ================= 記録中の設定（#57） =================
const ENGINE_FIELDS = ['language', 'segmentSec', 'localServerExe', 'localModelPath', 'localThreads', 'localPort',
  'vadModelPath', 'useVad', 'suppressNst', 'sumServerExe', 'sumModelPath', 'sumThreads', 'sumPort'];

test('記録中はエンジンの設定欄が触れなくなり理由が出る。記録が終わると戻る', async () => {
  const l = await load(APP);
  const lang = l.byId.get('language');
  assert.ok(!lang.disabled, '前提: 記録前は触れる');
  const notes = l.byId.get('tabSettings').querySelectorAll('.lockNote');
  assert.ok(notes.length >= 2, '理由の説明が無い');
  assert.ok(notes.every((n) => n.hidden), '記録前から理由が出ている');
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [] });
  await l.drain();
  for (const id of ENGINE_FIELDS) assert.strictEqual(l.byId.get(id).disabled, true, `${id} が記録中でも触れる`);
  for (const id of ['autoPaste', 'hotkey', 'dictionary', 'pillPos']) assert.ok(!l.byId.get(id).disabled, `${id} は記録中でも変えてよい`);
  assert.ok(notes.every((n) => !n.hidden), '理由の説明が出ない');
  assert.ok(notes.every((n) => /記録中はエンジンの設定を変更できません/.test(n.textContent)), '文言が違う');
  l.fire('onMeetingUpdate', { active: false });
  await l.drain();
  for (const id of ENGINE_FIELDS) assert.strictEqual(l.byId.get(id).disabled, false, `${id} が記録後も触れない`);
  assert.ok(notes.every((n) => n.hidden), '記録後も理由が残る');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('保存で main が採らなかった値は、ホットキー以外でも欄と設定に戻す（記録中のエンジン設定）', async () => {
  const l = await load(APP, { returns: { saveSettings: () => ({
    ok: true,
    warning: '記録中のため、認識言語などエンジンの設定は記録が終わるまで変わりません',
    applied: { language: 'ja', useVad: true, localThreads: 4, hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M' },
  }) } });
  l.byId.get('language').value = 'en';
  l.byId.get('useVad').checked = false;
  l.byId.get('localThreads').value = '8';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(l.byId.get('language').value, 'ja', '採られなかった値が select に残っている');
  assert.strictEqual(l.byId.get('useVad').checked, true, '採られなかった値がチェックに残っている');
  assert.strictEqual(l.byId.get('localThreads').value, '4', '採られなかった値が入力欄に残っている');
  assert.ok(/記録が終わるまで/.test(l.byId.get('toast').textContent), 'warning が toast に出ない');
  // 次の無関係な保存で、採られなかった値を送り直さない
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const sent = l.called('saveSettings').map((c) => [c.args[0].language, c.args[0].useVad]);
  assert.deepStrictEqual(sent, [['en', false], ['ja', true]], `送った値: ${JSON.stringify(sent)}`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('記録中の文字起こし面で、まだ文字起こしされていない区間は空行でなく「文字起こし中」と出る', async () => {
  const l = await load(APP);
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), pending: 1, segments: [
    { id: 's1', atMs: 0, text: 'おはようございます。' },
    { id: 's2', atMs: 75000, text: '', pending: true },
  ] });
  await l.drain();
  const rows = l.byId.get('pScript').querySelectorAll('.seg');
  assert.strictEqual(rows.length, 2);
  assert.ok(/文字起こし中/.test(rows[1].textContent), '待ちの区間が空行になっている（無音と区別できない）');
  assert.ok(rows[1].classList.contains('pending'));
  assert.ok(!/文字起こし中/.test(rows[0].textContent));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
