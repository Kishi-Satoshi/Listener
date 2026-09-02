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
