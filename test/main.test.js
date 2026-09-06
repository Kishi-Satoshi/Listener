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
  hotkeyFailureMessage, resolveStartupHotkeys,
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

test('resolveStartupHotkeys: 失敗した側だけ既定に落とし、成功した側の設定は触らない', () => {
  const calls = [];
  const apply = (hk, mhk) => {
    calls.push([hk, mhk]);
    return registerHotkeys(entries(hk, mhk), fakeRegister(['Alt+M']).register);
  };
  const r = resolveStartupHotkeys({ hotkey: 'Control+Space', meetingHotkey: 'Alt+M' },
    { hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+Shift+M' }, apply);
  assert.strictEqual(r.hotkey, 'Control+Space', '成功した側まで既定に戻した');
  assert.strictEqual(r.meetingHotkey, 'Alt+Shift+M');
  assert.deepStrictEqual(calls, [['Control+Space', 'Alt+M'], ['Control+Space', 'Alt+Shift+M']]);
  assert.strictEqual(r.state.ok, false);
  assert.deepStrictEqual(r.state.failed, ['議事録']);
  assert.match(r.state.message, /Alt\+M/);
  assert.match(r.state.message, /Alt\+Shift\+M/, '代わりに使うキーを伝えていない');
  assert.strictEqual(r.note, '（Alt+M は登録できず）');
});

test('resolveStartupHotkeys: 全部登録できれば ok で、再試行しない', () => {
  let n = 0;
  const apply = () => { n++; return { ok: true, failed: [] }; };
  const r = resolveStartupHotkeys({ hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'X', meetingHotkey: 'Y' }, apply);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(r.state, { ok: true, failed: [], message: '' });
  assert.strictEqual(r.note, '');
  assert.strictEqual(r.hotkey, 'A');
});

test('resolveStartupHotkeys: 既定でも登録できないときは、その旨を伝える', () => {
  const apply = () => ({ ok: false, failed: ['音声入力'] });
  const r = resolveStartupHotkeys({ hotkey: 'A', meetingHotkey: 'B' }, { hotkey: 'X', meetingHotkey: 'Y' }, apply);
  assert.strictEqual(r.state.ok, false);
  assert.match(r.state.message, /X も登録できませんでした/);
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
