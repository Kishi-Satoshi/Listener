/*
 * runtime.overlay.test.js — 録音バー（overlay.html）を最小DOM上で実際に走らせて検査する
 *
 * overlay.html は $ ヘルパを使わず document.getElementById を直に呼ぶため、
 * repo.test.js の「$('id') で参照する要素が存在する」検査はこのファイルに
 * 一度も当たっていなかった（ループ本体が0回で通っていた）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { parseHTML } = require('./helpers/simdom.js');
const { load } = require('./helpers/simrun.js');
const C = require('./helpers/simcss.js');

const OVL = path.join(__dirname, '..', 'src', 'renderer', 'overlay.html');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;

let 起動, 録音;

test.before(async () => {
  起動 = await load(OVL);
  録音 = await load(OVL);
  録音.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: true });
  await 録音.drain();
});

test('HTMLが木として整合している', () => {
  const { root, errors } = parseHTML(fs.readFileSync(OVL, 'utf8'));
  assert.deepStrictEqual(errors.map((e) => `${e.line}行 ${e.msg}`), []);
  assert.ok(root._walk([]).length > 10, '木が空。パーサが空振りしている');
});

test('初期化が例外なく完走し、録音の受け口が結線される', () => {
  assert.deepStrictEqual(起動.errors.map(fmt), [], '初期化で例外');
  for (const ev of ['onStart', 'onStop', 'onCancel', 'onPhase', 'onTick']) {
    assert.strictEqual(起動.called(ev).length, 1, `${ev} が結線されていない（録音が始まらない／止まらない）`);
  }
  assert.strictEqual(typeof 起動.window.__koeStart, 'function', 'window.__koeStart が公開されていない');
});

test('参照した id が全部ある', () => {
  const 未解決 = [...new Set([...起動.missingIds, ...録音.missingIds])].filter((i) => !起動.createdIds.has(i));
  assert.deepStrictEqual(未解決, [], 'HTMLに無い id を参照している');
  assert.ok(起動.lookups.size >= 5, `id の参照が ${起動.lookups.size} 件しかない。検査が空振りしている`);
});

test('開始の合図で実際に録音まで進み、停止で音声が渡る', async () => {
  assert.deepStrictEqual(録音.errors.map(fmt), [], '録音開始で例外');
  assert.ok(録音.byId.get('pill').classList.contains('visible'), 'ピルが表示状態にならない');
  assert.ok(録音.called('reportSource').length >= 1, '録音の開始がメインに伝わっていない');
  録音.fire('onStop');
  await 録音.drain();
  assert.deepStrictEqual(録音.errors.map(fmt), [], '録音停止で例外');
  assert.ok(録音.called('sendAudio').length + 録音.called('sendSegment').length >= 1,
    '停止しても音声がメインに渡らない（録音が成立していない）');
});

test('実際に描いた色は、ピルの地の上で見える', () => {
  const css = 録音.root.querySelectorAll('style').map((s) => s._raw).join('\n');
  const bg = C.firstColor(C.declsFor(C.parse(css), '.pill', { at: '' }).background);
  assert.ok(bg, '.pill の背景色が読めない');
  assert.ok(録音.paints.length > 0, '波形が一度も描かれていない（描画ループが回っていない）');
  for (const p of 録音.paints) {
    const c = C.parseColor(p);
    assert.ok(c, `描画色が読めない: ${p}`);
    const r = C.contrast(C.over(c, bg), bg);
    assert.ok(r >= 2.0, `描画色 ${p} がピルの地 rgb(${bg.slice(0, 3).join(',')}) に埋もれる（コントラスト比 ${r.toFixed(2)}）`);
  }
});

/*
 * 一時停止まわり。実機の MediaRecorder.stop() は onstop を非同期に呼ぶ
 * （sim の FakeMediaRecorder は同期）。一時停止で recorder を先に捨てると、
 * あとから走る onstop が捨てた recorder を読んで落ち、最大75秒の発言が消える。
 */
/**
 * 実機と同じく stop() の後で onstop を非同期に呼ぶ。
 * 始まった recorder は log.recorders に溜める。sim の setTimeout は発火しないので、
 * 75秒の打ち切り（autoStopId: recorder.stop() を直に呼ぶ）はテストがここから起こす。
 */
function 非同期onstopに(log) {
  const MR = log.window.MediaRecorder;
  log.recorders = [];
  const start = MR.prototype.start;
  MR.prototype.start = function () { log.recorders.push(this); start.call(this); };
  MR.prototype.stop = function () {
    this.state = 'inactive';
    setImmediate(() => { if (this.onstop) this.onstop(); });   // 実機と同じく後で発火
  };
}

/** simrun の fakeStream と同じ形で、トラックの stop() 回数を数える（マイクを手放したかの観測） */
function 偽ストリーム() {
  const track = { stops: 0, stop() { this.stops++; }, kind: 'audio', enabled: true, addEventListener() {}, onended: null };
  return { track, getTracks: () => [track], getAudioTracks: () => [track], addTrack() {}, active: true };
}

/** getUserMedia を差し替え、開いたストリームを返す配列を渡す */
function マイクを数える(log) {
  const streams = [];
  log.window.navigator.mediaDevices.getUserMedia = () => { const s = 偽ストリーム(); streams.push(s); return Promise.resolve(s); };
  return streams;
}

/** WAV 変換（decodeAudioData）をテストが進めるまで止める。戻り値を呼ぶと進む */
function 変換を待たせる(log) {
  let release;
  const gate = new Promise((r) => { release = r; });
  log.window.AudioContext.prototype.decodeAudioData = () => gate.then(() => ({ duration: 0.01, sampleRate: 48000, numberOfChannels: 1, length: 480 }));
  return release;
}

/** WAV 変換を必ず失敗させる（実機では壊れた webm や codec 差で起きる） */
function 変換を失敗させる(log) {
  log.window.AudioContext.prototype.decodeAudioData = () => Promise.reject(new Error('decode に失敗'));
}

async function 議事録を一時停止まで(opt = {}) {
  const log = await load(OVL);
  非同期onstopに(log);
  if (opt.setup) opt.setup(log);   // 録音を始める前に差し替えたいもの（getUserMedia など）
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  log.byId.get('pauseBtn').click();
  if (!opt.noDrain) await log.drain();
  return log;
}

test('一時停止で締めた区間は、onstop が非同期でも届く', async () => {
  const log = await 議事録を一時停止まで();
  assert.deepStrictEqual(log.errors.map(fmt), [], '一時停止で例外');
  assert.strictEqual(log.called('sendSegment').length, 1, '一時停止で締めた区間がメインに渡らない');
  assert.strictEqual(log.called('sendSegment')[0].args[2], false, '一時停止の区間が最後の区間として送られている');
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true], 'main へ一時停止が伝わっていない');
});

test('一時停止中に終了すると、締めた区間の後に空の最後の区間が届く', async () => {
  const log = await 議事録を一時停止まで();
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [false, true], '区間の並びが違う（締めた区間 → 最後の区間 の順で1回ずつ）');
});

test('区間を締めている最中に終了しても、最後の区間は1回だけ届く', async () => {
  const log = await 議事録を一時停止まで({ noDrain: true });   // onstop がまだ走っていない
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [true], '最後の区間が二重に届く／届かない');
  assert.ok(log.called('sendSegment')[0].args[0].length > 0, '締めた区間の音声が捨てられている');
});

test('再開すると次の区間が始まり、終了で最後の区間が届く', async () => {
  const log = await 議事録を一時停止まで();
  log.byId.get('pauseBtn').click();   // 再開
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '再開で例外');
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true, false]);
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [false, true], '再開後の区間が最後の区間として届かない');
});

/*
 * 上限時間（75秒）で切られた区間は、onstop が WAV 変換を待っている間 recorder が
 * 「止まっている」ように見える。その間に一時停止→終了と押されると、一時停止側は
 * 締める区間が無いと思ってマイクを手放し、終了側は待つものが無いと思って
 * 空の最後の区間を先に送る。変換が終わって届く本物の区間は最後の印の後になり、
 * main に捨てられる（最大75秒の発言が消える）。
 */
test('上限時間で切られた区間の変換中に一時停止→終了しても、その区間が最後として1回だけ届く', async () => {
  const log = await load(OVL);
  非同期onstopに(log);
  const streams = マイクを数える(log);
  const 変換を進める = 変換を待たせる(log);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  assert.strictEqual(log.recorders.length, 1, '最初の区間の recorder が始まっていない（検査が空振り）');
  log.recorders[0].stop();          // 上限時間の打ち切り（autoStopId と同じく recorder.stop() を直に呼ぶ）
  await log.drain();                // onstop が走り、変換待ちで止まる
  assert.strictEqual(log.called('sendSegment').length, 0, '変換が終わる前に区間が送られている（検査が空振り）');
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true], 'main へ一時停止が伝わっていない');
  log.fire('onStop');
  await log.drain();
  変換を進める();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  const segs = log.called('sendSegment');
  assert.deepStrictEqual(segs.map((c) => c.args[2]), [true],
    '最後の区間が二重に届く／届かない（本物の区間が空の最後の後に届き、main に捨てられる）');
  assert.ok(segs[0].args[0].length > 0, '切られた区間の音声が捨てられている');
  assert.ok(streams[0].track.stops >= 1, '終了後もマイクが開いたまま');
});

test('一時停止で区間を送り終えると、マイクを手放す', async () => {
  let streams;
  const log = await 議事録を一時停止まで({ setup: (l) => { streams = マイクを数える(l); } });
  assert.deepStrictEqual(log.errors.map(fmt), [], '一時停止で例外');
  assert.strictEqual(streams.length, 1, 'マイクが開かれていない（検査が空振り）');
  assert.strictEqual(log.called('sendSegment').length, 1, '一時停止で締めた区間が届かない');
  assert.ok(streams[0].track.stops >= 1, '一時停止してもマイクが開いたまま（OS のマイク使用表示が点きっぱなしになる）');
});

test('再開でマイクを開き直している間に終了しても、最後の区間が1回だけ届く', async () => {
  const log = await 議事録を一時停止まで();
  let マイクが開く = null;
  const opened = 偽ストリーム();
  log.window.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { マイクが開く = r; });
  log.byId.get('pauseBtn').click();   // 再開 → getUserMedia 待ちで止まる
  await log.drain();
  assert.ok(マイクが開く, '再開がマイクを開きに行っていない（検査が空振り）');
  log.fire('onStop');
  await log.drain();
  マイクが開く(opened);
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [false, true], '最後の区間が届かない（main が待ち続ける）／二重に届く');
  assert.ok(opened.track.stops >= 1, '終了したのに開き直したマイクが開いたまま');
});

test('最後の区間の WAV 変換に失敗しても、空の最後の区間で main を閉じる', async () => {
  const log = await load(OVL);
  変換を失敗させる(log);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment');
  assert.strictEqual(segs.length, 1, '最後の区間が届かない（main が待ち続ける）／二重に届く');
  assert.strictEqual(segs[0].args[0].length, 0, '変換に失敗した区間の中身が送られている');
  assert.strictEqual(segs[0].args[2], true, '最後の区間の印が付いていない');
});

test('音声入力の WAV 変換に失敗すると、エラーを1回だけ伝える', async () => {
  const log = await load(OVL);
  変換を失敗させる(log);
  log.fire('onStart', { mode: 'dictation', sound: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  assert.strictEqual(log.called('sendAudio').length, 0, '変換に失敗したのに音声が送られている');
  assert.deepStrictEqual(log.called('sendError').map((c) => c.args[0]), ['音声の変換に失敗しました']);
});
