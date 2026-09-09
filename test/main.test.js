/*
 * main.test.js — main.js から切り出した純関数を実際に実行して検査する
 *
 * main.js は Electron を require するので直接は読み込めない。判断だけを
 * src/mainlib.js / src/settings.js に置き、ここで動かす。結線（main.js が
 * それらを本当に呼んでいるか）は repo.test.js の文字列検査で固定する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');
const {
  saveIfExists, meetingDurationSec, promptTail, registerHotkeys,
  hotkeyFailureMessage, hotkeyStatus, resolveStartupHotkeys, saveHotkeys,
  makeSummaryRunner, tickStep,
  pasterScript, copyCommand,
  engineFileIssue, engineIssueMessage, portInUseError, guardEngineSettings, keptDifferent, closeConfirm,
  truncationMessage, extractNotes, buildPromptParts,
  publicSegments, settledSegments, pendingDurationMs, recoverSegments, staleSegbufDirs,
  nextSegmentMs,
} = require('../src/mainlib');
const { normalizeSettings } = require('../src/settings');

// ---------------------------------------------------------------- #46 削除した議事録の復活
let dir;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-main-'));
  store.init(dir);
});
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ } });

test('要約中に削除したページは、要約完了時に書き戻さない（復活しない）', () => {
  // runSummary は入口で page を読み、数分後の完了時に書き戻す。その間に
  // 利用者がページを削除していると、以前の「getPage(id) || page」は
  // 手元の古い page を保存して削除済みの議事録を復活させていた。
  const page = store.createPage({ title: '削除される議事録', segments: [{ id: 's1', atMs: 0, text: '発言' }] });
  store.deletePage(page.id);
  assert.strictEqual(store.getPage(page.id), null);

  const saved = saveIfExists(store, page.id, (p) => { p.blocks = [{ id: 'b1', type: 'p', text: '要点' }]; });
  assert.strictEqual(saved, null, '削除済みなのに保存された');
  assert.strictEqual(store.getPage(page.id), null, '削除した議事録が復活した');
  assert.ok(!store.listPages().some((p) => p.id === page.id), '一覧に復活した');
});

test('ページが残っていれば、最新のページに生成物だけを載せて保存する', () => {
  const page = store.createPage({ title: '元の題', segments: [] });
  store.setTitle(page.id, '要約中に変えた題');   // 要約の途中で編集された想定
  const saved = saveIfExists(store, page.id, (p) => { p.summaryError = 'x'; });
  assert.ok(saved);
  assert.strictEqual(saved.title, '要約中に変えた題', '古いページで上書きしている');
  assert.strictEqual(store.getPage(page.id).summaryError, 'x');
});

// ---------------------------------------------------------------- #14 所要時間
test('meetingDurationSec: 一時停止したまま停止しても負にならず、待ち時間も混ざらない', () => {
  const m = { startedAt: 1000, paused: true, pausedAt: 61000, pausedMs: 0 };
  // 60秒話して一時停止、その 30秒後に停止。停止後の文字起こし待ち（endAt より後）は関係ない
  assert.strictEqual(meetingDurationSec(m, 91000), 60);
  assert.ok(meetingDurationSec({ startedAt: 1000, paused: true, pausedAt: 1000, pausedMs: 0 }, 1000) >= 0);
  // 途中で 20秒止めて再開した分は引く
  assert.strictEqual(meetingDurationSec({ startedAt: 0, paused: false, pausedAt: 0, pausedMs: 20000 }, 80000), 60);
});

test('meetingDurationSec: 一時停止の履歴が壊れていても負にならない', () => {
  assert.strictEqual(meetingDurationSec({ startedAt: 0, paused: false, pausedAt: 0, pausedMs: 999999 }, 10000), 0);
  assert.strictEqual(meetingDurationSec({ startedAt: 0, paused: true, pausedAt: 5000 }, 10000), 5);
});

// ---------------------------------------------------------------- #15 初期プロンプトの尻尾
test('promptTail: 末尾が失敗区間なら、その前の成功区間の末尾を使う', () => {
  const segs = [
    { id: 's1', text: '一つ目の発言。' },
    { id: 's2', text: '（この区間の認識に失敗: エンジンエラー (500)）', failed: true },
  ];
  assert.strictEqual(promptTail(segs), '一つ目の発言。');
  assert.strictEqual(promptTail([{ id: 's1', text: '発言' }]), '発言');
  assert.strictEqual(promptTail([]), '');
});

test('promptTail: 2件とも失敗なら空（3件以上は遡らない）', () => {
  const segs = [
    { id: 's1', text: '成功' },
    { id: 's2', text: '失敗1', failed: true },
    { id: 's3', text: '失敗2', failed: true },
  ];
  assert.strictEqual(promptTail(segs), '');
});

test('promptTail: 末尾100文字に切る', () => {
  const long = 'あ'.repeat(300);
  assert.strictEqual(promptTail([{ text: long }]).length, 100);
});

test('promptTail: 文字起こし待ち（pending）の区間は飛ばし、その手前の成功区間から取る', () => {
  // 区間は音声が届いた時点で本文が空のまま控えられる（#8/#42）。末尾の 2 件が待ちだと
  // 何も返せず、直前の発言の文脈が毎回途切れる
  const segs = [
    { id: 's1', text: '一つ目の発言。' },
    { id: 's2', text: '', pending: true },
    { id: 's3', text: '', pending: true },
  ];
  assert.strictEqual(promptTail(segs), '一つ目の発言。');
  assert.strictEqual(promptTail([{ id: 's1', text: '', pending: true }]), '');
  // 待ちを除いたうえで、2 件しか遡らない
  assert.strictEqual(promptTail([{ text: '成功' }, { text: '失敗1', failed: true }, { text: '失敗2', failed: true }, { text: '', pending: true }]), '');
});

// ---------------------------------------------------------------- #35/#49 ホットキー
const fakeRegister = (bad) => {
  const registered = [];
  const register = (accel) => {
    if (bad.includes(accel)) return false;
    registered.push(accel);
    return true;
  };
  return { register, registered };
};
const entries = (hk, mhk) => [
  { label: '音声入力', accel: hk, handler: () => {} },
  { label: '議事録', accel: mhk, handler: () => {} },
];

test('registerHotkeys: 片方が失敗しても、成功した側は登録されたまま', () => {
  const { register, registered } = fakeRegister(['Alt+M']);
  const r = registerHotkeys(entries('Control+Shift+Space', 'Alt+M'), register);
  assert.deepStrictEqual(r, { ok: false, failed: ['議事録'] });
  assert.deepStrictEqual(registered, ['Control+Shift+Space']);
});

test('registerHotkeys: 先の方が失敗しても、後の方は登録する', () => {
  const { register, registered } = fakeRegister(['Control+Shift+Space']);
  const r = registerHotkeys(entries('Control+Shift+Space', 'Alt+M'), register);
  assert.deepStrictEqual(r, { ok: false, failed: ['音声入力'] });
  assert.deepStrictEqual(registered, ['Alt+M']);
});

test('registerHotkeys: 両方成功なら ok、失敗の一覧は空', () => {
  const { register } = fakeRegister([]);
  assert.deepStrictEqual(registerHotkeys(entries('A', 'B'), register), { ok: true, failed: [] });
});

test('registerHotkeys: 未設定（空）のキーは失敗扱いにしない／登録が例外を投げても失敗として数える', () => {
  const { register, registered } = fakeRegister([]);
  assert.deepStrictEqual(registerHotkeys(entries('A', ''), register), { ok: true, failed: [] });
  assert.deepStrictEqual(registered, ['A']);
  const throwing = (accel) => { if (accel === 'Bad+') throw new Error('invalid accelerator'); return true; };
  assert.deepStrictEqual(registerHotkeys(entries('Bad+', 'B'), throwing), { ok: false, failed: ['音声入力'] });
});

test('hotkeyFailureMessage: 失敗した側のキーを名指しで伝える', () => {
  const msg = hotkeyFailureMessage(['議事録'], { 音声入力: 'Control+Shift+Space', 議事録: 'Alt+M' });
  assert.strictEqual(msg, '議事録のホットキー Alt+M は他のアプリが使用中のため登録できませんでした');
  assert.strictEqual(hotkeyFailureMessage([], { 音声入力: 'A', 議事録: 'B' }), '');
  assert.match(hotkeyFailureMessage(['音声入力', '議事録'], { 音声入力: 'A', 議事録: 'B' }), /音声入力のホットキー A と議事録のホットキー B は/);
});

// bad: 登録できないキーの一覧。apply は main.js の applyHotkeys と同じ形（unregisterAll → 両方登録）で、
// 呼び出しを記録する
const fakeApply = (bad) => {
  const calls = [];
  const apply = (hk, mhk) => {
    calls.push([hk, mhk]);
    return registerHotkeys(entries(hk, mhk), fakeRegister(bad).register);
  };
  return { apply, calls };
};

test('hotkeyStatus: 既定で代替している側は fallback に、登録できていない側は failed に載る', () => {
  // hotkey:state の形。failed は「いま登録できていない側」、fallback は「利用者のキーの
  // 代わりに既定で動いている側」。ok は利用者の設定どおりに全部登録できているときだけ
  const wanted = { hotkey: 'Control+Shift+X', meetingHotkey: 'Alt+M' };
  const r = hotkeyStatus(wanted, { hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M' }, []);
  assert.deepStrictEqual(r.state, {
    ok: false,
    failed: [],
    fallback: { 音声入力: { wanted: 'Control+Shift+X', using: 'Control+Shift+Space' } },
    message: '音声入力のホットキー Control+Shift+X は他のアプリが使用中のため、代わりに既定の Control+Shift+Space を使っています',
  });
  assert.strictEqual(r.note, '（音声入力: 既定の Control+Shift+Space を使用中）');
  assert.deepStrictEqual(r.active, { hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M' });

  const f = hotkeyStatus(wanted, wanted, ['議事録']);
  assert.deepStrictEqual(f.state, {
    ok: false, failed: ['議事録'], fallback: {},
    message: '議事録のホットキー Alt+M は他のアプリが使用中のため登録できていません',
  });
  assert.strictEqual(f.note, '（Alt+M は登録できず）');

  const ok = hotkeyStatus(wanted, wanted, []);
  assert.deepStrictEqual(ok.state, { ok: true, failed: [], fallback: {}, message: '' });
  assert.strictEqual(ok.note, '');
});

test('hotkeyStatus: 両方に問題があれば一つの文に、トレイの注記も一つにまとめる', () => {
  const wanted = { hotkey: 'A', meetingHotkey: 'B' };
  const r = hotkeyStatus(wanted, { hotkey: 'X', meetingHotkey: 'B' }, ['議事録']);
  assert.strictEqual(r.state.message,
    '音声入力のホットキー A は他のアプリが使用中のため、代わりに既定の X を使っています。議事録のホットキー B は他のアプリが使用中のため登録できていません');
  assert.strictEqual(r.note, '（音声入力: 既定の X を使用中・B は登録できず）');
  const both = hotkeyStatus(wanted, wanted, ['音声入力', '議事録']);
  assert.strictEqual(both.state.message, '音声入力のホットキー A と議事録のホットキー B は他のアプリが使用中のため登録できていません');
  assert.strictEqual(both.note, '（A・B は登録できず）');
});

test('hotkeyStatus: 登録できていない側は、トレイ用の active に利用者のキーを名乗る', () => {
  // 既定に落として既定も駄目だったとき、active に既定を残すとトレイに「既定のキー: 音声入力」と
  // 出て、そのキーが効くように見える。効いていないのは利用者のキーなので、そちらを出す
  const wanted = { hotkey: 'A', meetingHotkey: 'B' };
  const r = hotkeyStatus(wanted, { hotkey: 'X', meetingHotkey: 'B' }, ['音声入力']);
  assert.deepStrictEqual(r.active, { hotkey: 'A', meetingHotkey: 'B' });
  assert.deepStrictEqual(r.state.fallback, {}, '登録できていない側を fallback にも載せている');
});

test('resolveStartupHotkeys: 失敗した側だけ既定に落とし、成功した側はそのまま。設定は書き換えない', () => {
  const { apply, calls } = fakeApply(['Alt+M']);
  const cfg = { hotkey: 'Control+Space', meetingHotkey: 'Alt+M', theme: 'dark' };
  const snapshot = JSON.stringify(cfg);
  const r = resolveStartupHotkeys(cfg, { hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+Shift+M' }, apply);
  assert.deepStrictEqual(r.active, { hotkey: 'Control+Space', meetingHotkey: 'Alt+Shift+M' }, '成功した側まで既定に戻した');
  assert.deepStrictEqual(calls, [['Control+Space', 'Alt+M'], ['Control+Space', 'Alt+Shift+M']]);
  // (a) 利用者の設定は読むだけ。ここを書き換えると settings:get が既定を返して設定画面に既定が出、
  //     次の無関係な保存（自動起動の切り替えなど）でディスクにも漏れて、利用者のキーが黙って消える
  assert.strictEqual(JSON.stringify(cfg), snapshot, '設定オブジェクトを書き換えている');
  assert.ok(!('hotkey' in r) && !('meetingHotkey' in r), '設定に書き戻せる形（hotkey/meetingHotkey）で返している');
  // (b) 既定で登録できた側は「登録できていない」ではなく「代替中」
  assert.deepStrictEqual(r.state.failed, [], '既定で登録できたのに failed に残っている');
  assert.deepStrictEqual(r.state.fallback, { 議事録: { wanted: 'Alt+M', using: 'Alt+Shift+M' } });
  assert.strictEqual(r.state.ok, false);
  assert.strictEqual(r.state.message, '議事録のホットキー Alt+M は他のアプリが使用中のため、代わりに既定の Alt+Shift+M を使っています');
  assert.strictEqual(r.note, '（議事録: 既定の Alt+Shift+M を使用中）');
});

test('resolveStartupHotkeys: 全部登録できれば ok で、再試行しない', () => {
  let n = 0;
  const apply = () => { n++; return { ok: true, failed: [] }; };
  const r = resolveStartupHotkeys({ hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'X', meetingHotkey: 'Y' }, apply);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(r.state, { ok: true, failed: [], fallback: {}, message: '' });
  assert.strictEqual(r.note, '');
  assert.deepStrictEqual(r.active, { hotkey: 'A', meetingHotkey: 'B' });
});

test('resolveStartupHotkeys: 既定でも登録できないときは failed に残し、既定も駄目だったと伝える', () => {
  const { apply, calls } = fakeApply(['A', 'X']);
  const r = resolveStartupHotkeys({ hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'X', meetingHotkey: 'Y' }, apply);
  assert.deepStrictEqual(calls, [['A', 'B'], ['X', 'B']]);
  assert.deepStrictEqual(r.state.failed, ['音声入力']);
  assert.deepStrictEqual(r.state.fallback, {});
  assert.strictEqual(r.state.ok, false);
  assert.match(r.state.message, /^音声入力のホットキー A は他のアプリが使用中のため登録できていません/);
  assert.match(r.state.message, /既定の X も登録できませんでした/);
  assert.deepStrictEqual(r.active, { hotkey: 'A', meetingHotkey: 'B' });
  assert.strictEqual(r.note, '（A は登録できず）');
});

test('resolveStartupHotkeys: 設定がもともと既定なら、同じキーで再試行しない', () => {
  const { apply, calls } = fakeApply(['X']);
  const r = resolveStartupHotkeys({ hotkey: 'X', meetingHotkey: 'B' }, { hotkey: 'X', meetingHotkey: 'Y' }, apply);
  assert.deepStrictEqual(calls, [['X', 'B']], '同じキーをもう一度試している');
  assert.deepStrictEqual(r.state.failed, ['音声入力']);
  assert.strictEqual(r.state.message, '音声入力のホットキー X は他のアプリが使用中のため登録できていません');
});

// ---------------------------------------------------------------- 保存時のホットキー
test('saveHotkeys: 両方とも変えていなければ何もしない（登録し直さず、状態も触らない）', () => {
  const { apply, calls } = fakeApply([]);
  const prev = { hotkey: 'A', meetingHotkey: 'B' };
  // 起動時に既定へ退避している状態で、無関係な項目だけ保存しても再登録・再警告しない
  const r = saveHotkeys(prev, { hotkey: 'X', meetingHotkey: 'B' }, { ...prev, autoLaunch: true }, apply);
  assert.strictEqual(r, null);
  assert.deepStrictEqual(calls, []);
});

test('saveHotkeys: 新しいキーが失敗した側だけ前の値に戻し、戻した値を applied で返す', () => {
  // (c) 画面は applied を欄に戻す。失敗したキーが欄に残ると、以後の無関係な保存のたびに
  //     再失敗して警告が出続ける
  const { apply, calls } = fakeApply(['Alt+Q']);
  const prev = { hotkey: 'Control+Space', meetingHotkey: 'Alt+M' };
  const r = saveHotkeys(prev, { ...prev }, { hotkey: 'Control+Shift+Y', meetingHotkey: 'Alt+Q' }, apply);
  assert.deepStrictEqual(r.applied, { hotkey: 'Control+Shift+Y', meetingHotkey: 'Alt+M' });
  assert.deepStrictEqual(r.active, { hotkey: 'Control+Shift+Y', meetingHotkey: 'Alt+M' });
  assert.strictEqual(r.warning, '議事録のホットキー Alt+Q は他のアプリが使用中のため登録できませんでした');
  assert.deepStrictEqual(calls, [['Control+Shift+Y', 'Alt+Q'], ['Control+Shift+Y', 'Alt+M']]);
  // 戻した後は前のキーが登録されているので、登録状態としては問題なし（警告は保存の戻り値で伝える）
  assert.deepStrictEqual(r.state, { ok: true, failed: [], fallback: {}, message: '' });
  assert.strictEqual(r.note, '');
});

test('saveHotkeys: 成功すれば applied は新しいキーで、warning は空', () => {
  const { apply, calls } = fakeApply([]);
  const r = saveHotkeys({ hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'C', meetingHotkey: 'B' }, apply);
  assert.deepStrictEqual(calls, [['C', 'B']]);
  assert.deepStrictEqual(r.applied, { hotkey: 'C', meetingHotkey: 'B' });
  assert.deepStrictEqual(r.active, { hotkey: 'C', meetingHotkey: 'B' });
  assert.strictEqual(r.warning, '');
  assert.deepStrictEqual(r.state, { ok: true, failed: [], fallback: {}, message: '' });
});

test('saveHotkeys: 変えていない側は「いま動いているキー」のまま登録し直す（起動時の既定退避を壊さない）', () => {
  // 起動時に 議事録 が Alt+M → 既定 Alt+Shift+M に退避している状態で、音声入力だけ変える。
  // 利用者のキー Alt+M を再登録すると、衝突がまだあれば再び失敗して、動いていた既定まで失う
  const { apply, calls } = fakeApply(['Alt+M']);
  const prev = { hotkey: 'A', meetingHotkey: 'Alt+M' };
  const active = { hotkey: 'A', meetingHotkey: 'Alt+Shift+M' };
  const r = saveHotkeys(prev, active, { hotkey: 'C', meetingHotkey: 'Alt+M' }, apply);
  assert.deepStrictEqual(calls, [['C', 'Alt+Shift+M']]);
  assert.deepStrictEqual(r.applied, { hotkey: 'C', meetingHotkey: 'Alt+M' });
  assert.deepStrictEqual(r.active, { hotkey: 'C', meetingHotkey: 'Alt+Shift+M' });
  assert.strictEqual(r.warning, '');
  assert.deepStrictEqual(r.state.failed, []);
  assert.deepStrictEqual(r.state.fallback, { 議事録: { wanted: 'Alt+M', using: 'Alt+Shift+M' } });
});

test('saveHotkeys: 退避中の側を変えて失敗したら、前の設定と前の（既定の）登録に戻す', () => {
  const { apply, calls } = fakeApply(['Alt+M', 'Alt+Q']);
  const prev = { hotkey: 'A', meetingHotkey: 'Alt+M' };
  const active = { hotkey: 'A', meetingHotkey: 'Alt+Shift+M' };
  const r = saveHotkeys(prev, active, { hotkey: 'A', meetingHotkey: 'Alt+Q' }, apply);
  assert.deepStrictEqual(calls, [['A', 'Alt+Q'], ['A', 'Alt+Shift+M']]);
  assert.deepStrictEqual(r.applied, prev);
  assert.deepStrictEqual(r.active, active);
  assert.match(r.warning, /Alt\+Q/);
  assert.deepStrictEqual(r.state.fallback, { 議事録: { wanted: 'Alt+M', using: 'Alt+Shift+M' } });
});

test('saveHotkeys: 戻した先も登録できなければ failed に残る（状態は実際の登録結果を写す）', () => {
  // 前のキーが他のアプリに取られていた（起動後に別のアプリが同じキーを登録した）場合
  const { apply } = fakeApply(['A', 'Z']);
  const r = saveHotkeys({ hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'Z', meetingHotkey: 'B' }, apply);
  assert.deepStrictEqual(r.applied, { hotkey: 'A', meetingHotkey: 'B' });
  assert.deepStrictEqual(r.state.failed, ['音声入力']);
  assert.match(r.warning, /Z は他のアプリが使用中のため登録できませんでした/);
});

test('saveHotkeys: 設定（prev / next）を書き換えない', () => {
  const { apply } = fakeApply(['Z']);
  const prev = { hotkey: 'A', meetingHotkey: 'B' };
  const next = { hotkey: 'Z', meetingHotkey: 'B' };
  saveHotkeys(prev, { ...prev }, next, apply);
  assert.deepStrictEqual(prev, { hotkey: 'A', meetingHotkey: 'B' });
  assert.deepStrictEqual(next, { hotkey: 'Z', meetingHotkey: 'B' });
});

// ---------------------------------------------------------------- #10 要約の排他
test('makeSummaryRunner: 走行中の同じ id は同じ Promise を返し、run は一度しか呼ばない', async () => {
  // 走行中に「要約を生成」を連打されると、同じ文字起こしに対して要約が二重に走り、
  // 後から終わった方が前の結果（とその間の編集）を上書きしていた
  const started = [];
  const pending = new Map();
  const run = (id) => new Promise((res) => { started.push(id); pending.set(id, res); });
  const runSummary = makeSummaryRunner(run);
  const p1 = runSummary('p1');
  const p2 = runSummary('p1');
  assert.strictEqual(p1, p2, '走行中なのに別の Promise を返した（要約が二重に走る）');
  assert.deepStrictEqual(started, ['p1']);
  // 別のページは独立して走る
  const q1 = runSummary('p2');
  assert.deepStrictEqual(started, ['p1', 'p2']);
  // 完了したら外れる → 次の呼び出しは新しく走る
  pending.get('p1')('done');
  assert.strictEqual(await p1, 'done');
  const p3 = runSummary('p1');
  assert.notStrictEqual(p3, p1, '完了したのに古い Promise を返している');
  assert.deepStrictEqual(started, ['p1', 'p2', 'p1']);
  pending.get('p1')(); pending.get('p2')();
  await Promise.all([p3, q1]);
});

test('makeSummaryRunner: 失敗しても外れる（失敗した id が永久に「走行中」にならない）', async () => {
  let n = 0;
  const runSummary = makeSummaryRunner(async () => { n++; throw new Error('summarize failed'); });
  await assert.rejects(runSummary('p1'), /summarize failed/);
  await assert.rejects(runSummary('p1'), /summarize failed/);
  assert.strictEqual(n, 2);
});

// ---------------------------------------------------------------- #12 overlay:tick の見張り
test('tickStep: 議事録中は合図を送り、一時停止中は送らないだけで見張りは消さない', () => {
  // 一時停止で見張りを消すと、再開しても誰も起こし直さず、以後の区切りが画面の
  // 間引かれるタイマー任せに戻る（1区間が9分になる元の不具合が再発する）
  const log = [];
  const send = () => log.push('send');
  const stop = () => log.push('stop');
  assert.strictEqual(tickStep({ state: 'meeting', meeting: { paused: false } }, send, stop), 'send');
  assert.strictEqual(tickStep({ state: 'meeting', meeting: { paused: true } }, send, stop), 'skip');
  assert.deepStrictEqual(log, ['send'], '一時停止で見張りを消した／合図を送った');
});

test('tickStep: 議事録が無くなったときだけ見張りを消す', () => {
  const log = [];
  const send = () => log.push('send');
  const stop = () => log.push('stop');
  assert.strictEqual(tickStep({ state: 'idle', meeting: null }, send, stop), 'stop');
  assert.strictEqual(tickStep({ state: 'meeting-finalizing', meeting: { paused: false } }, send, stop), 'stop');
  assert.strictEqual(tickStep({ state: 'meeting', meeting: null }, send, stop), 'stop');
  assert.deepStrictEqual(log, ['stop', 'stop', 'stop']);
});

// ---------------------------------------------------------------- #26 設定の正規化
const DEF = { localPort: 8990, sumPort: 8991, localThreads: 8, sumThreads: 8, segmentSec: 75 };

test('normalizeSettings: ポート・スレッド・区間長を範囲に収め、壊れた値は既定に戻す', () => {
  const s = normalizeSettings({ localPort: 'abc', sumPort: 70000, localThreads: 0, sumThreads: '300', segmentSec: 5 }, DEF);
  assert.strictEqual(s.localPort, 8990);
  assert.strictEqual(s.sumPort, 65535);
  assert.strictEqual(s.localThreads, 8, '0 は打ち間違いなので既定に戻す');
  assert.strictEqual(s.sumThreads, 64);
  assert.strictEqual(s.segmentSec, 20);
  // 文字列の数字は数に直す（保存した JSON から '8990' で戻ることがある）
  assert.strictEqual(normalizeSettings({ ...DEF, localPort: '8080' }, DEF).localPort, 8080);
});

test('normalizeSettings: 辞書は文字列の配列に揃え、空要素を落とす／他のキーは触らない', () => {
  const s = normalizeSettings({ ...DEF, dictionary: [' 見積 ', '', 42, null], theme: 'dark' }, DEF);
  assert.deepStrictEqual(s.dictionary, ['見積', '42']);
  assert.strictEqual(s.theme, 'dark');
  assert.deepStrictEqual(normalizeSettings({ ...DEF, dictionary: 'x' }, DEF).dictionary, []);
});

test('normalizeSettings: 入力を書き換えない', () => {
  const raw = { ...DEF, localPort: 'abc' };
  normalizeSettings(raw, DEF);
  assert.strictEqual(raw.localPort, 'abc');
});

// ---------------------------------------------------------------- #51 議事録の日付
const { localDateISO } = require('../src/dates');

test('localDateISO: ローカルの暦日で YYYY-MM-DD を作る（UTC の toISOString で日付を作らない）', () => {
  // 日本時間の朝（08:30 JST = 前日 23:30 UTC）に始めた会議が、UTC に直すと前日の日付で保存されていた
  const prevTZ = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    assert.strictEqual(localDateISO(new Date(2026, 8, 6, 23, 30)), '2026-09-06');
    const morning = new Date(2026, 8, 6, 8, 30);
    assert.strictEqual(localDateISO(morning), '2026-09-06');
    assert.strictEqual(morning.toISOString().slice(0, 10), '2026-09-05', 'この検査は UTC との差を捕まえていない');
    assert.strictEqual(localDateISO(new Date(2026, 0, 1, 0, 0)), '2026-01-01', '月日を 2 桁に揃えていない');
  } finally {
    if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ;
  }
});

// ---------------------------------------------------------------- #27 クリップボードの除外書式
test('pasterScript: 履歴・クラウド同期から除外する書式を付け、PS5.1 で動く書き方で、失敗しても本文を残す', () => {
  const s = pasterScript();
  // 3 つの除外書式（Windows のクリップボード履歴 Win+V と、他の PC への同期）
  for (const f of ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']) {
    assert.ok(s.includes(`'${f}'`), `除外書式 ${f} が無い`);
  }
  // 値は DWORD 0（4 バイト）。byte[] を直接渡すと .NET のシリアライズ形式で包まれるので MemoryStream
  assert.ok(s.includes('[byte[]](0,0,0,0)'), 'DWORD 0 を渡していない');
  assert.ok(s.includes('MemoryStream'), 'byte[] を直接渡している（DWORD として読まれない）');
  assert.ok(s.includes('FromBase64String'), '本文を base64 で受けていない');
  assert.ok(s.includes('SetDataObject($d, $true)'), 'クリップボードへ置いていない');
  assert.ok(s.includes("-eq 'paste'"), '従来の貼り付け命令が消えている');
  // PS5.1: switch / [ValidateSet] を使わず if/elseif で分ける
  assert.ok(!/\bswitch\b/.test(s) && !/ValidateSet/.test(s), 'PS5.1 で動かない書き方がある');
  assert.ok(s.includes('elseif'), 'if/elseif で分けていない');
  // 置き直しに失敗しても、Electron が先に書いた本文は残す
  assert.match(s, /try \{[\s\S]*SetDataObject[\s\S]*\} catch \{\}/, 'try で包んでいない');
});

test('copyCommand: 1 行の命令に base64 で本文を載せ、改行を含む本文でも 1 行に収まる', () => {
  const text = '会議の発言。\n2行目';
  const cmd = copyCommand(text);
  assert.match(cmd, /^copy [A-Za-z0-9+/=]+$/);
  assert.ok(!cmd.includes('\n'));
  assert.strictEqual(Buffer.from(cmd.slice(5), 'base64').toString('utf8'), text);
  assert.strictEqual(copyCommand(null), 'copy ', 'null は空文字として扱う');
});

// ---------------------------------------------------------------- #32 エンジンのファイル検査
const statOf = (table) => (f) => { if (!(f in table)) throw new Error('ENOENT'); return table[f]; };

test('engineFileIssue: 無い・切れている・実体が無い・正常 を見分ける', () => {
  const stat = statOf({
    ok: { size: 500_000_000, blocks: 976563 },
    short: { size: 120_000_000, blocks: 234375 },
    // OneDrive のオンデマンド: 大きさはあるが割り当てブロックが 0
    cloud: { size: 500_000_000, blocks: 0 },
    empty: { size: 0, blocks: 0 },
  });
  assert.strictEqual(engineFileIssue('ok', 300_000_000, stat), 'ok');
  assert.strictEqual(engineFileIssue('short', 300_000_000, stat), 'truncated');
  assert.strictEqual(engineFileIssue('cloud', 300_000_000, stat), 'placeholder');
  assert.strictEqual(engineFileIssue('none', 300_000_000, stat), 'missing', 'stat が投げたら missing');
  assert.strictEqual(engineFileIssue('empty', 300_000_000, stat), 'truncated', '0 バイトはプレースホルダではなく切れている');
});

test('engineFileIssue: blocks が取れない環境では実体の有無を判定しない（誤って使えなくしない）', () => {
  const stat = statOf({ f: { size: 500_000_000 } });
  assert.strictEqual(engineFileIssue('f', 300_000_000, stat), 'ok');
  assert.strictEqual(engineFileIssue('f', 600_000_000, stat), 'truncated');
});

test('engineIssueMessage: 原因を名指しし、切れているときは大きさと直し方を添える', () => {
  assert.strictEqual(engineIssueMessage('placeholder', 'model', 500_000_000),
    'モデルの実体がこの PC にありません（OneDrive などのプレースホルダの可能性）');
  assert.strictEqual(engineIssueMessage('truncated', 'model', 120_000_000),
    'モデルファイルが途中で切れています（114MB）。setup-*.ps1 を再実行してください');
  assert.strictEqual(engineIssueMessage('missing', 'model'), 'モデルファイルが見つかりません');
  assert.strictEqual(engineIssueMessage('placeholder', 'exe', 1_000_000),
    '実行ファイルの実体がこの PC にありません（OneDrive などのプレースホルダの可能性）');
  assert.match(engineIssueMessage('truncated', 'exe', 40_000), /^実行ファイルが途中で切れています（0\.0MB）/);
  assert.strictEqual(engineIssueMessage('missing', 'exe'), '実行ファイルが見つかりません');
  assert.strictEqual(engineIssueMessage('ok', 'model', 1), '');
});

// ---------------------------------------------------------------- #28/#31 ポートの衝突
test('portInUseError: ポート番号を名指しし、変えるか止めるかを案内する', () => {
  assert.strictEqual(portInUseError(8990),
    'ポート 8990 は他のプロセスが使用中です。設定でポートを変えるか、そのプロセスを終了してください');
});

// ---------------------------------------------------------------- #57 記録中のエンジン設定
const PREV = {
  language: 'ja', localThreads: 8, sumThreads: 8, useVad: true, suppressNst: true,
  localServerExe: 'C:/e/whisper-server.exe', localModelPath: 'C:/m/ggml-small.bin', vadModelPath: '',
  sumServerExe: 'C:/e/llama-server.exe', sumModelPath: 'C:/m/q.gguf', localPort: 8990, sumPort: 8991,
  segmentSec: 75, theme: 'system', autoPaste: true, dictionary: ['見積'],
};

test('guardEngineSettings: 記録中はエンジンに関わる設定を前の値に留め、他は通し、警告で名指しする', () => {
  const next = { ...PREV, localPort: 9000, language: 'en', segmentSec: 120, theme: 'dark', dictionary: ['見積', '検収'] };
  const r = guardEngineSettings(PREV, next, true);
  assert.strictEqual(r.settings.localPort, 8990);
  assert.strictEqual(r.settings.language, 'ja');
  assert.strictEqual(r.settings.segmentSec, 75);
  assert.strictEqual(r.settings.theme, 'dark', 'エンジンに関わらない設定まで止めている');
  assert.deepStrictEqual(r.settings.dictionary, ['見積', '検収'], '辞書は記録中でも保存できる');
  assert.deepStrictEqual(r.kept, ['language', 'localPort', 'segmentSec']);
  assert.match(r.warning, /^記録中のため、エンジンに関わる設定（.+）は変更できません。記録を終えてから変更してください$/);
  assert.ok(r.warning.includes('言語') && r.warning.includes('ポート') && r.warning.includes('区間'), '止めた設定を名指ししていない');
  // 入力は書き換えない
  assert.strictEqual(next.localPort, 9000);
  assert.strictEqual(PREV.localPort, 8990);
});

test('guardEngineSettings: 記録中でなければそのまま通す／記録中でも変えていなければ警告しない', () => {
  const next = { ...PREV, localPort: 9000 };
  const r = guardEngineSettings(PREV, next, false);
  assert.strictEqual(r.settings.localPort, 9000);
  assert.deepStrictEqual(r.kept, []);
  assert.strictEqual(r.warning, '');
  const same = guardEngineSettings(PREV, { ...PREV, theme: 'dark' }, true);
  assert.deepStrictEqual(same.kept, []);
  assert.strictEqual(same.warning, '');
  assert.strictEqual(same.settings.theme, 'dark');
});

test('keptDifferent: 画面が送った値と違う値で残ったキーだけを返す（画面はこれを欄に戻す）', () => {
  const sent = { hotkey: 'Alt+Q', localPort: '8990', dictionary: [' 見積 ', ''], theme: 'dark' };
  const saved = { hotkey: 'Alt+M', localPort: 8990, dictionary: ['見積'], theme: 'dark', other: 1 };
  assert.deepStrictEqual(keptDifferent(sent, saved), { hotkey: 'Alt+M', localPort: 8990, dictionary: ['見積'] });
  assert.deepStrictEqual(keptDifferent(null, saved), {});
  assert.deepStrictEqual(keptDifferent({ theme: 'dark' }, saved), {});
});

// ---------------------------------------------------------------- #52 要約中は「忙しい」
test('makeSummaryRunner: 走っている id を running() で引け、増減のたびに onChange が件数で呼ばれる', async () => {
  const counts = [];
  const pending = new Map();
  const run = (id) => new Promise((res) => pending.set(id, res));
  const runSummary = makeSummaryRunner(run, (n) => counts.push(n));
  assert.deepStrictEqual(runSummary.running(), []);
  const p1 = runSummary('p1');
  runSummary('p1');   // 同じ id は数えない
  const p2 = runSummary('p2');
  assert.deepStrictEqual(runSummary.running(), ['p1', 'p2']);
  assert.deepStrictEqual(counts, [1, 2]);
  pending.get('p1')();
  await p1;
  assert.deepStrictEqual(runSummary.running(), ['p2']);
  pending.get('p2')();
  await p2;
  assert.deepStrictEqual(runSummary.running(), []);
  assert.deepStrictEqual(counts, [1, 2, 1, 0]);
});

test('makeSummaryRunner: onChange が無くても・投げても動く', async () => {
  const a = makeSummaryRunner(async () => 'x');
  assert.strictEqual(await a('p'), 'x');
  const b = makeSummaryRunner(async () => 'y', () => { throw new Error('boom'); });
  assert.strictEqual(await b('p'), 'y');
  assert.deepStrictEqual(b.running(), []);
});

test('closeConfirm: 記録中・要約中・両方 で終了確認の文を組み、どちらでもなければ null', () => {
  assert.strictEqual(closeConfirm(false, false), null);
  const rec = closeConfirm(true, false);
  assert.strictEqual(rec.message, '議事録を記録中です');
  assert.match(rec.detail, /次回起動時に復旧できます/);
  assert.ok(!rec.detail.includes('要約'));
  const sum = closeConfirm(false, true);
  assert.strictEqual(sum.message, '要約を作成中です。終了すると要約は失われます');
  assert.match(sum.detail, /「要約を生成」/);
  const both = closeConfirm(true, true);
  assert.strictEqual(both.message, '議事録を記録中です');
  assert.ok(both.detail.includes('要約を作成中です。終了すると要約は失われます'), '両方のときに要約の分が抜けている');
});

// ---------------------------------------------------------------- #16 分割要約の打ち切り
test('truncationMessage: 切れたパートを名指しし、最終統合だけが切れたときは末尾の文言のまま', () => {
  assert.strictEqual(truncationMessage([], false), '');
  assert.strictEqual(truncationMessage([], true),
    '要約が長さの上限で打ち切られた可能性があります。末尾の議題が欠けていないか確認してください。');
  assert.strictEqual(truncationMessage([2], false),
    '要約の材料（パート 2）が長さの上限で切れました。中盤の議題が欠けていないか確認してください。');
  assert.match(truncationMessage([1, 3], false), /パート 1・3/);
  const both = truncationMessage([2], true);
  assert.ok(both.includes('パート 2') && both.includes('末尾の議題'), '両方切れたときに片方しか伝えていない');
});

test('extractNotes: 切れたら半分に割って両方をやり直し、収まればその結果を使う', async () => {
  // 上限で切れた要点メモは中盤の議題が黙って欠ける。長い塊は半分にすれば収まることが多い
  const calls = [];
  const extract = async (t) => { calls.push(t); return { text: `[${t}]`, truncated: t.length > 4 }; };
  const r = await extractNotes(extract, 'abcdefgh');
  assert.deepStrictEqual(calls, ['abcdefgh', 'abcd', 'efgh']);
  assert.strictEqual(r.text, '[abcd]\n[efgh]');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.retried, true);
});

test('extractNotes: 収まっていればそのまま／半分でも切れたら本文は残して truncated を立てる（やり直しは一度だけ）', async () => {
  const ok = await extractNotes(async (t) => ({ text: t, truncated: false }), 'short');
  assert.deepStrictEqual(ok, { text: 'short', truncated: false, retried: false });
  let n = 0;
  const still = await extractNotes(async (t) => { n++; return { text: t, truncated: true }; }, 'abcdefgh');
  assert.strictEqual(n, 3, '二度目以降も割り続けている');
  assert.strictEqual(still.text, 'abcd\nefgh', '切れても本文を捨てている');
  assert.strictEqual(still.truncated, true);
});

// ---------------------------------------------------------------- #23 初期プロンプトの予算
const SAMPLE = 'お疲れさまです。よろしくお願いします。';
const BUILTIN = ['不具合', '改修', '受注', '発注'];
const bytes = (s) => Buffer.byteLength(s, 'utf8');

test('buildPromptParts: 辞書が予算を超えたら先頭行から収まる分だけ残し、文例は必ず残す', () => {
  // 5 文字 × 3 バイト + 読点 で 1 語 18 バイト。40 語 = 720 バイトは 600 バイトに収まらない
  const words = Array.from({ length: 40 }, (_, i) => `専門用語${String.fromCharCode(0x3042 + i)}`);
  const r = buildPromptParts({ ja: true, dictionary: words, useBuiltinTerms: true, tail: '', limitBytes: 600, builtinTerms: BUILTIN, sample: SAMPLE });
  assert.strictEqual(r.total, 40);
  assert.ok(r.kept > 0 && r.kept < 40, `収まる分だけ残していない (kept=${r.kept})`);
  assert.strictEqual(r.over, true);
  assert.ok(r.prompt.startsWith(SAMPLE), '文例を落としている');
  assert.ok(bytes(r.prompt) <= 600, `予算を超えている (${bytes(r.prompt)} bytes)`);
  // 残るのは先頭から kept 語。既定語彙は辞書より先に落ちる
  for (let i = 0; i < r.kept; i++) assert.ok(r.prompt.includes(words[i]), `先頭の語 ${words[i]} が落ちている`);
  assert.ok(!r.prompt.includes(words[r.kept]), '予算外の語が残っている');
  for (const w of BUILTIN) assert.ok(!r.prompt.includes(w), '辞書より先に既定語彙を落としていない');
});

test('buildPromptParts: 収まるなら 文例 → 辞書 → 既定語彙 → 尻尾 の順で全部入る', () => {
  const r = buildPromptParts({ ja: true, dictionary: ['見積', ' 検収 ', '見積', ''], useBuiltinTerms: true, tail: '前の発言の末尾', limitBytes: 600, builtinTerms: BUILTIN, sample: SAMPLE });
  assert.strictEqual(r.prompt, `${SAMPLE} 見積、検収、不具合、改修、受注、発注。 前の発言の末尾`);
  assert.deepStrictEqual([r.kept, r.total, r.over], [2, 2, false]);
});

test('buildPromptParts: 予算は UTF-8 のバイト数（文字数ではない）', () => {
  // 英数字の語は 1 文字 1 バイト。文字数で数えると 3 倍に見積もられて不当に切られる。
  // 4 文字の語 70 個 = 350 文字（読点込み）は 200 文字を超えるが、
  // バイト数では 70×4 + 69×3（読点）+ 3（句点）= 490 で 600 に収まる
  const many = Array.from({ length: 70 }, (_, i) => `w${String(i).padStart(3, '0')}`);
  const r = buildPromptParts({ ja: false, dictionary: many, useBuiltinTerms: true, tail: '', limitBytes: 600, builtinTerms: BUILTIN, sample: SAMPLE });
  assert.ok(r.prompt.length > 200, `文字数では ${r.prompt.length} 文字（200 を超えるはず）`);
  assert.strictEqual(bytes(r.prompt), 490);
  assert.strictEqual(r.over, false, 'バイト数で収まるのに切っている');
  assert.deepStrictEqual([r.kept, r.total], [70, 70]);
});

test('buildPromptParts: 尻尾は語より先に、先頭から削る／日本語以外では文例も既定語彙も付けない', () => {
  // 辞書だけで予算いっぱい → 尻尾は入る余地の分だけ末尾側を残す
  const words = Array.from({ length: 30 }, (_, i) => `専門用語${String.fromCharCode(0x3042 + i)}`);
  const full = buildPromptParts({ ja: true, dictionary: words, useBuiltinTerms: false, tail: '', limitBytes: 600, builtinTerms: BUILTIN, sample: SAMPLE });
  const withTail = buildPromptParts({ ja: true, dictionary: words, useBuiltinTerms: false, tail: 'あいうえおかきくけこ', limitBytes: 600, builtinTerms: BUILTIN, sample: SAMPLE });
  assert.strictEqual(withTail.kept, full.kept, '尻尾のために辞書を削っている');
  assert.ok(bytes(withTail.prompt) <= 600);
  assert.ok(!withTail.prompt.includes('あいうえお') || withTail.prompt.endsWith('けこ'), '尻尾を末尾側から削っている');
  const en = buildPromptParts({ ja: false, dictionary: ['Kubernetes'], useBuiltinTerms: true, tail: 'tail', limitBytes: 600, builtinTerms: BUILTIN, sample: SAMPLE });
  assert.strictEqual(en.prompt, 'Kubernetes。 tail');
  const noBuiltin = buildPromptParts({ ja: true, dictionary: [], useBuiltinTerms: false, tail: '', limitBytes: 600, builtinTerms: BUILTIN, sample: SAMPLE });
  assert.strictEqual(noBuiltin.prompt, SAMPLE);
  assert.deepStrictEqual([noBuiltin.kept, noBuiltin.total, noBuiltin.over], [0, 0, false]);
});

// ---------------------------------------------------------------- #8/#42 音声の退避と「文字起こし待ち」の区間
test('publicSegments / settledSegments: 画面と保存にファイルのパスを漏らさず、保存には待ちの区間を入れない', () => {
  const segs = [
    { id: 's1', atMs: 0, text: '発言', durationMs: 75000 },
    { id: 's2', atMs: 75000, text: '', pending: true, wav: 'C:/x/segbuf/1/2.wav', durationMs: 75000 },
  ];
  const pub = publicSegments(segs);
  assert.strictEqual(pub.length, 2, '画面には待ちの区間も出す（進捗が見える）');
  assert.ok(pub.every((s) => !('wav' in s)), 'パスが漏れている');
  assert.strictEqual(pub[1].pending, true);
  assert.ok('wav' in segs[1], '入力を書き換えている');
  assert.deepStrictEqual(settledSegments(segs), [{ id: 's1', atMs: 0, text: '発言', durationMs: 75000 }]);
  assert.deepStrictEqual(publicSegments(undefined), []);
});

test('pendingDurationMs: 文字起こし待ちの区間の長さの合計（残り時間の見積もりの材料）', () => {
  assert.strictEqual(pendingDurationMs([{ pending: true, durationMs: 75000 }, { text: 'x', durationMs: 75000 }, { pending: true, durationMs: 30000 }]), 105000);
  assert.strictEqual(pendingDurationMs([]), 0);
  assert.strictEqual(pendingDurationMs([{ pending: true }]), 0);
});

test('recoverSegments: 待ちの区間は失敗扱いで「復旧中」にし、wav が残っていれば todo に載せる。パスはページに載せない', () => {
  const segs = [
    { id: 's1', atMs: 0, text: '発言' },
    { id: 's2', atMs: 75000, text: '', pending: true, wav: '/b/2.wav', durationMs: 75000 },
    { id: 's3', atMs: 150000, text: '', pending: true, wav: '/b/3.wav', durationMs: 30000 },
    { id: 's4', atMs: 180000, text: '（この区間の認識に失敗: x）', failed: true },
  ];
  const r = recoverSegments(segs, (f) => f === '/b/2.wav');
  assert.deepStrictEqual(r.segments, [
    { id: 's1', atMs: 0, text: '発言' },
    { id: 's2', atMs: 75000, text: '（復旧中: 文字起こし待ち）', failed: true, durationMs: 75000 },
    { id: 's3', atMs: 150000, text: '（この区間の認識に失敗: 音声が残っていません）', failed: true, durationMs: 30000 },
    { id: 's4', atMs: 180000, text: '（この区間の認識に失敗: x）', failed: true },
  ]);
  assert.deepStrictEqual(r.todo, [{ id: 's2', wav: '/b/2.wav', durationMs: 75000 }]);
  assert.strictEqual(segs[1].pending, true, '入力を書き換えている');
  assert.deepStrictEqual(recoverSegments([null, 'x'], () => true), { segments: [], todo: [] }, '壊れた要素で落ちる');
});

test('staleSegbufDirs: 7 日より古い退避フォルダだけを選ぶ（名前が開始時刻ならそれで、違えば更新時刻で）', () => {
  // 復旧されずに残った孤児だけを消す。今日の分や復旧中の分を消すと、復旧の材料そのものを失う
  const now = 1_800_000_000_000;
  const day = 86400000;
  const entries = [
    { name: String(now - 8 * day), mtimeMs: now },            // 名前は 8 日前（更新時刻が新しくても名前が真実）
    { name: String(now - 2 * day), mtimeMs: now - 30 * day }, // 名前は 2 日前 → 残す
    { name: 'junk', mtimeMs: now - 10 * day },                // 数字でない → 更新時刻で判断 → 古い
    { name: 'recent', mtimeMs: now - day },                   // 残す
  ];
  assert.deepStrictEqual(staleSegbufDirs(entries, now), [String(now - 8 * day), 'junk']);
  assert.deepStrictEqual(staleSegbufDirs([], now), []);
  // ちょうど 7 日は残す（境目で今日の分を消さない）
  assert.deepStrictEqual(staleSegbufDirs([{ name: String(now - 7 * day), mtimeMs: 0 }], now), []);
});

// ---------------------------------------------------------------- #42 背圧（区間の長さ）
test('nextSegmentMs: 待ちが 3 を超えたら区間を倍に（上限 300 秒）、1 以下に戻ったら設定の長さへ', () => {
  // 短い区間を積み上げ続けると待ちがどこまでも伸び、終了後の待ち時間になる
  assert.strictEqual(nextSegmentMs(4, 75000, 75000, 1), 150000);
  assert.strictEqual(nextSegmentMs(5, 150000, 75000, 1), 300000);
  assert.strictEqual(nextSegmentMs(6, 300000, 75000, 1), 300000, '上限を超えている');
  // 2〜3 のあいだは変えない（行ったり来たりでオーバーレイに何度も送らない）
  assert.strictEqual(nextSegmentMs(3, 150000, 75000, 1), 150000);
  assert.strictEqual(nextSegmentMs(2, 150000, 75000, -1), 150000);
  // 減った側では倍にしない（5→4 で倍にすると一気に上限へ張り付く）
  assert.strictEqual(nextSegmentMs(4, 150000, 75000, -1), 150000);
  assert.strictEqual(nextSegmentMs(1, 300000, 75000, -1), 75000);
  assert.strictEqual(nextSegmentMs(0, 300000, 75000, -1), 75000);
  // 現在の長さが無ければ設定の長さから数える
  assert.strictEqual(nextSegmentMs(4, 0, 75000, 1), 150000);
});
