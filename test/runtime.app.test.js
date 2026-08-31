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
