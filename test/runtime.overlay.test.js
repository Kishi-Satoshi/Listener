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
  // #13 以降、切られた区間の変換中も次の区間が録っている。一時停止はその次の区間を
  // 締めるので、届く順は「切られた区間（途中）→ 一時停止で締めた区間（最後）」。
  // 守るべきことは変わらない: 最後の印は1回だけ、切られた区間の音声は捨てない。
  assert.deepStrictEqual(segs.map((c) => c.args[2]), [false, true],
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

/*
 * #13 区間の境目の空白。切られた区間は onstop → WAV 変換 → 送信 → 次の区間、の順で
 * 動いていたので、変換の間（実機で数百ms〜数秒）は誰も録っていなかった。
 * 空白のぶん atMs も会議が進むほど手前へずれる。次の区間は切った瞬間に始め、
 * 変換は裏で続ける。送る順は区間の番号で守る（短い後の区間が先に変換し終えても
 * 先に届かない。main は届いた順に atMs を積む）。
 */
/** overlay の Date.now() をテストが進める時計に差し替える（with(window) 経由で引かれる） */
function 時計(log, t0 = 1_700_000_000_000) {
  let t = t0;
  log.window.Date = { now: () => t };
  return { now: () => t, 進める(ms) { t += ms; return t; } };
}
/** WAV 変換を呼ばれた順に個別に止める。戻り値の配列の要素を呼ぶと、その変換だけ進む */
function 変換を個別に待たせる(log) {
  const gates = [];
  log.window.AudioContext.prototype.decodeAudioData = () => new Promise((r) => {
    gates.push(() => r({ duration: 0.01, sampleRate: 48000, numberOfChannels: 1, length: 480 }));
  });
  return gates;
}
const FIRST_SEG = 20000, GRACE = 2000;   // overlay.html の FIRST_SEG_MS と cutSegmentIfOverdue の猶予

async function 議事録を開始(opt = {}) {
  const log = await load(OVL, opt.load || {});
  非同期onstopに(log);
  if (opt.setup) opt.setup(log);
  const clock = 時計(log);
  log.fire('onStart', Object.assign({ mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false }, opt.start || {}));
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  assert.strictEqual(log.recorders.length, 1, '最初の区間の recorder が始まっていない（検査が空振り）');
  return { log, clock };
}

test('区切りの見張りで区間を切ると、変換を待たずに次の区間が始まる', async () => {
  let 変換を進める;
  const { log, clock } = await 議事録を開始({ setup: (l) => { 変換を進める = 変換を待たせる(l); } });
  clock.進める(FIRST_SEG + GRACE + 1);
  log.fire('onTick');                       // 区切りの見張り（main からの overlay:tick）
  assert.strictEqual(log.recorders.length, 2, '切った瞬間に次の区間が始まっていない（変換の間の録音が空白になる）');
  assert.strictEqual(log.recorders[0].state, 'inactive', '前の区間が止まっていない');
  assert.strictEqual(log.recorders[1].state, 'recording', '次の区間が録っていない');
  await log.drain();
  assert.strictEqual(log.called('sendSegment').length, 0, '変換が終わる前に区間が送られている（検査が空振り）');
  assert.strictEqual(log.recorders.length, 2, '変換待ちの間に区間が余計に始まっている（録音が2本走る）');
  変換を進める();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  const segs = log.called('sendSegment');
  assert.strictEqual(segs.length, 1, '切った区間が届かない／二重に届く');
  assert.strictEqual(segs[0].args[2], false, '途中の区間が最後の印で届いている');
  assert.strictEqual(segs[0].args[1], FIRST_SEG + GRACE + 1, '区間の長さが録った長さと違う');
  assert.strictEqual(log.recorders.length, 2, '変換後にもう一度次の区間を始めている（録音が2本走る）');
});

test('上限で止まった区間の onstop でも、変換を待たずに次の区間が始まる', async () => {
  let 変換を進める;
  const { log } = await 議事録を開始({ setup: (l) => { 変換を進める = 変換を待たせる(l); } });
  log.recorders[0].stop();                  // 上限時間の打ち切り（recorder.stop() を直に呼ぶ経路）
  await log.drain();                        // onstop が走り、変換待ちで止まる
  assert.strictEqual(log.called('sendSegment').length, 0, '変換が終わる前に区間が送られている（検査が空振り）');
  assert.strictEqual(log.recorders.length, 2, 'onstop が変換を待ってから次の区間を始めている（その間の録音が空白になる）');
  assert.strictEqual(log.recorders[1].state, 'recording', '次の区間が録っていない');
  変換を進める();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false], '切った区間が届かない／二重に届く');
  assert.strictEqual(log.recorders.length, 2, '変換後にもう一度次の区間を始めている（録音が2本走る）');
});

test('先に切った区間の変換が後から終わっても、区間は切った順に届き、長さに変換の時間を含めない', async () => {
  let gates;
  const { log, clock } = await 議事録を開始({ setup: (l) => { gates = 変換を個別に待たせる(l); } });
  const durA = FIRST_SEG + GRACE + 1;
  clock.進める(durA);
  log.fire('onTick');                       // A を切る → B が始まる
  await log.drain();
  const durB = 75000 + GRACE + 1;
  clock.進める(durB);
  log.fire('onTick');                       // B を切る → C が始まる
  await log.drain();
  assert.strictEqual(log.recorders.length, 3, '区間が3つ目まで進んでいない（検査が空振り）');
  assert.strictEqual(gates.length, 2, '2つの区間が変換待ちになっていない（検査が空振り）');
  gates[1]();                               // 後の区間（B）の変換が先に終わる
  await log.drain();
  assert.strictEqual(log.called('sendSegment').length, 0, '前の区間より先に後の区間が届いている（main の atMs がずれ、文脈の並びも狂う）');
  clock.進める(50000);                      // A の変換に時間がかかった。これは区間の長さに入れない
  gates[0]();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[1]), [durA, durB],
    '区間が切った順に届いていない／長さに変換の時間が混ざっている');
  log.fire('onStop');                       // C を最後として締める
  await log.drain();
  assert.strictEqual(gates.length, 3, '最後の区間が変換に入っていない（検査が空振り）');
  gates[2]();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false, false, true], '最後の印が最後の区間だけに1回付いていない');
});

/*
 * preload はこの作業木ではまだ reportMic / onSegmentMs を公開していない。
 * simrun の偽 IPC は preload から名前を読むので、契約どおりの行を足した preload を渡す
 * （runtime.app.test.js の preloadWithHotkey と同じ手）。preload が追いついたらそのまま通る。
 */
const PRELOAD_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
function 拡張preload() {
  let s = PRELOAD_SRC;
  const head = "exposeInMainWorld('koeOverlay', {";
  assert.ok(s.includes(head), 'preload の koeOverlay が見つからない');
  if (!/^\s{2}reportMic:/m.test(s)) s = s.replace(head, `${head}\n  reportMic: (info) => ipcRenderer.send('overlay:mic', info),`);
  if (!/^\s{2}onSegmentMs:/m.test(s)) s = s.replace(head, `${head}\n  onSegmentMs: (cb) => ipcRenderer.on('overlay:segment-ms', (_e, ms) => cb(ms)),`);
  return s;
}

/*
 * #56 選んだマイクが無い。deviceId: { ideal } なので、選んだ機器が抜けていると Chromium は
 * 黙って既定のマイクで録る。開いたトラックの deviceId を見て、違えば代替中と扱い、
 * main（overlay:mic）とピルに出す。機器名（ラベル）は送らない。
 */
function マイクを(deviceId) {
  return (log) => {
    log.window.navigator.mediaDevices.getUserMedia = () => {
      const s = 偽ストリーム();
      s.track.getSettings = () => ({ deviceId, channelCount: 1 });
      return Promise.resolve(s);
    };
  };
}

test('選んだマイクが無く既定のマイクで開いたときは、代替中を main とピルに伝える', async () => {
  const { log } = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: マイクを('other'), start: { micId: 'chosen' } });
  assert.deepStrictEqual(log.called('reportMic').map((c) => c.args[0]), [{ requested: true, matched: false }],
    '選んだマイクと違うマイクで開いたことが main に伝わっていない（機器名を送ってもいけない）');
  const label = log.byId.get('status').textContent;
  assert.ok(/既定のマイク/.test(label), `ピルに代替中と出ない: ${label}`);
  assert.ok(label.length <= 15, `ピルの文言が長すぎる（全角15文字ほどが限度）: ${label}`);
  // 開き直すたびに1回。一時停止→再開でマイクを開き直したら、また報告する
  log.byId.get('pauseBtn').click();
  await log.drain();
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '一時停止・再開で例外');
  assert.strictEqual(log.called('reportMic').length, 2, 'マイクを開き直したのに報告し直していない');
  assert.ok(/既定のマイク/.test(log.byId.get('status').textContent), '再開後のピルに代替中と出ない');
});

test('選んだマイクで開けたとき・マイクを選んでいないときは、合っていると伝え、ピルは通常の文言', async () => {
  const 合致 = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: マイクを('chosen'), start: { micId: 'chosen' } });
  assert.deepStrictEqual(合致.log.called('reportMic').map((c) => c.args[0]), [{ requested: true, matched: true }]);
  assert.ok(!/既定のマイク/.test(合致.log.byId.get('status').textContent), '合っているのに代替中と出る');
  const 未選択 = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: マイクを('default'), start: { micId: '' } });
  assert.deepStrictEqual(未選択.log.called('reportMic').map((c) => c.args[0]), [{ requested: false, matched: true }]);
  assert.ok(!/既定のマイク/.test(未選択.log.byId.get('status').textContent), '選んでいないのに代替中と出る');
  // getSettings が無い／deviceId を返さない実装では判定できないので、合っていると扱う（誤警告を出さない）
  const 不明 = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: (l) => { マイクを数える(l); }, start: { micId: 'chosen' } });
  assert.deepStrictEqual(不明.log.called('reportMic').map((c) => c.args[0]), [{ requested: true, matched: true }]);
  assert.ok(!/既定のマイク/.test(不明.log.byId.get('status').textContent), '判定できないのに代替中と出る');
});

test('preload に reportMic が無くても、録音は例外なく始まり、ピルの代替表示は出る', async () => {
  const { log } = await 議事録を開始({ setup: マイクを('other'), start: { micId: 'chosen' } });
  assert.deepStrictEqual(log.errors.map(fmt), []);
  assert.ok(/既定のマイク/.test(log.byId.get('status').textContent), 'ピルの代替表示は preload に依らず出る');
});

/*
 * #8/#42 背圧。文字起こしが追いつかないとき main が区間を長く（または短く）できるよう、
 * overlay:segment-ms を受ける。効くのは次の区間から。今の区間を切ると、
 * 受けた瞬間に短い区間ができて文字起こしの文脈が細切れになる。
 */
test('main から区間長を変えると、次の区間から効き、今の区間は切らない', async () => {
  const { log, clock } = await 議事録を開始({ load: { preloadSrc: 拡張preload() } });
  assert.strictEqual(log.fire('onSegmentMs', 150000), 1, 'onSegmentMs が結線されていない');
  clock.進める(10000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 1, '区間長を受けた瞬間に今の区間を切っている');
  clock.進める(FIRST_SEG + GRACE + 1 - 10000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 2, '今の区間が元の長さで切られていない');
  await log.drain();
  clock.進める(75000 + GRACE + 1);          // 既定の 75 秒なら切られる時刻
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 2, '次の区間が新しい区間長（150秒）ではなく元の 75 秒で切られている');
  clock.進める(150000 - 75000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 3, '新しい区間長（150秒）で切られない');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

test('区間長は 20〜300 秒に丸め、数でないものは無視する', async () => {
  const { log, clock } = await 議事録を開始({ load: { preloadSrc: 拡張preload() } });
  log.fire('onSegmentMs', 5000);            // 短すぎ → 20 秒
  clock.進める(FIRST_SEG + GRACE + 1);
  log.fire('onTick');                       // 最初の区間を切る → 2つ目（20 秒）
  await log.drain();
  clock.進める(20000 + GRACE + 1);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 3, '下限 20 秒に丸められていない');
  await log.drain();
  log.fire('onSegmentMs', 'abc');           // 数でない → 無視（直前の 20 秒のまま）
  log.fire('onSegmentMs', 999999);          // 長すぎ → 300 秒
  clock.進める(20000 + GRACE + 1);
  log.fire('onTick');                       // 3つ目（20 秒）を切る → 4つ目（300 秒）
  assert.strictEqual(log.recorders.length, 4, '数でない値で区間長が壊れた');
  await log.drain();
  clock.進める(299000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 4, '上限 300 秒より前に切られている');
  clock.進める(1000 + GRACE + 1);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 5, '上限 300 秒で切られない');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});
