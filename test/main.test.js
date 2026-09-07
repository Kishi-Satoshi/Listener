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
