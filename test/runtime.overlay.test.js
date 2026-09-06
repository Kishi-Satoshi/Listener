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
async function 議事録を一時停止まで(opt = {}) {
  const log = await load(OVL);
  const MR = log.window.MediaRecorder;
  MR.prototype.stop = function () {
    this.state = 'inactive';
    setImmediate(() => { if (this.onstop) this.onstop(); });   // 実機と同じく後で発火
  };
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
