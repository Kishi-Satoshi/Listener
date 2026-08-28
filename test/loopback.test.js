/*
 * loopback.test.js — 相手の声（パソコンから出ている音）を録るかどうかの判定
 *
 * ここで守りたいのは「間違えると実機で静かに壊れる」3点だけ。
 * 音が実際に混ざるかどうかは実機でしか確かめられないが、
 * 何を返すかの判断はここで固定できる。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { chooseDisplayMedia, LOOPBACK } = require('../src/loopback');

test('Windows では映像と loopback を返す', () => {
  const frame = { id: 1 };
  assert.deepStrictEqual(chooseDisplayMedia({ platform: 'win32', frame }),
    { video: frame, audio: 'loopback' });
});

test('映像を必ず返す（音声だけを要求すると必ず失敗する仕様のため）', () => {
  const r = chooseDisplayMedia({ platform: 'win32', frame: { id: 1 } });
  assert.ok(r.video, '映像を外すと getDisplayMedia が TypeError になる');
});

test('既定の再生デバイスをミュートする loopbackWithMute は使わない', () => {
  // 使うと録音中に会議相手の声が自分に聞こえなくなる
  assert.strictEqual(LOOPBACK, 'loopback');
  assert.strictEqual(chooseDisplayMedia({ platform: 'win32', frame: {} }).audio, 'loopback');
});

test('Windows 以外では取り込まない（ループバックは Windows 限定）', () => {
  for (const platform of ['darwin', 'linux', 'freebsd', '']) {
    assert.deepStrictEqual(chooseDisplayMedia({ platform, frame: {} }), {}, platform);
  }
});

test('要求元フレームが無ければ何も返さない', () => {
  assert.deepStrictEqual(chooseDisplayMedia({ platform: 'win32', frame: null }), {});
  assert.deepStrictEqual(chooseDisplayMedia({ platform: 'win32' }), {});
  assert.deepStrictEqual(chooseDisplayMedia(), {});
});

// ---------------------------------------------------------------- 実装の縛り
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const main = read('src/main.js');
const overlayHtml = read('src/renderer/overlay.html');
const appHtml = read('src/renderer/app.html');

test('音声のみのデスクトップキャプチャを書いていない', () => {
  // getUserMedia({audio:{mandatory:{chromeMediaSource:'desktop'}}}) は
  // Electron 31 では失敗ではなくレンダラープロセスの強制終了になる。
  // try/catch で捕まえられず、録音ピルごと消える。
  for (const [name, src] of [['overlay', overlayHtml], ['main', main]]) {
    assert.ok(!/chromeMediaSource/.test(src), `${name} にレガシー経路が入っている`);
  }
});

test('setDisplayMediaRequestHandler に第2引数を渡していない', () => {
  // useSystemPicker は Electron 33 以降。31 で渡すとハンドラごと無効になる。
  const at = main.indexOf('setDisplayMediaRequestHandler(');
  assert.ok(at > 0, 'ハンドラの登録が見つからない');
  // 括弧の対応を数えて呼び出しの引数部分だけを取り出す
  let depth = 0; let end = -1;
  const from = main.indexOf('(', at);
  for (let i = from; i < main.length; i++) {
    if (main[i] === '(') depth++;
    else if (main[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, '呼び出しの終わりが見つからない');
  const args = main.slice(from + 1, end);
  // useSystemPicker は Electron 33 以降。引数はコールバック1つだけであること。
  assert.ok(!/useSystemPicker/.test(args), 'useSystemPicker を渡している');
  assert.ok(args.trim().endsWith('}'), '引数がコールバック1つで終わっていない');
});

test('相手の声の取り込みは既定でオフ', () => {
  assert.match(main, /useSystemAudio:\s*false/);
  assert.ok(appHtml.includes("useSystemAudio: $('useSystemAudio').checked"));
  assert.ok(appHtml.includes("$('useSystemAudio').checked = Boolean(s.useSystemAudio)"));
});

test('音声入力の開始に systemAudio を混ぜない（常にマイクだけ）', () => {
  const dictation = main.match(/sendToOverlay\('overlay:start', \{ mode: 'dictation'[^}]*\}/);
  assert.ok(dictation, '音声入力の開始が見つからない');
  assert.ok(!dictation[0].includes('systemAudio'), '音声入力の経路に混ざっている');
});

test('マイクの解放が micStream と sysStream を止めている', () => {
  // ここを落とすと録音後もマイクが開きっぱなしになり、
  // OS のマイク使用表示が点いたままになる（利用者からは盗聴に見える）
  const rel = overlayHtml.match(/function releaseStream\(\)[\s\S]*?\n {2}\}/);
  assert.ok(rel, 'releaseStream が見つからない');
  assert.ok(rel[0].includes('micStream'), 'マイクを止めていない');
  assert.ok(rel[0].includes('sysStream'), '相手の声を止めていない');
});

test('取り込んだ映像トラックを捨てている', () => {
  // 捨てないと画面キャプチャが走り続け、CPU を食い、環境によっては枠が出る
  const open = overlayHtml.match(/async function openSystemStream\(\)[\s\S]*?\n {2}\}/);
  assert.ok(open, 'openSystemStream が見つからない');
  assert.match(open[0], /getVideoTracks\(\)[\s\S]*?\.stop\(\)/);
});

test('無音警告が相手の声も見ている', () => {
  // マイクだけで判定すると、聞き役に回っている間じゅう警告が出続け、
  // 本当にマイクが死んだときに誰も見なくなる
  const chk = overlayHtml.match(/function checkSilence\([\s\S]*?\n {2}\}/);
  assert.ok(chk, 'checkSilence が見つからない');
  assert.match(chk[0], /Math\.max\(micLevel, sysLevel/);
});

test('新しい設定キーがエンジンの再起動条件に入っていない', () => {
  // 入れると設定を保存するたびに whisper-server が再起動する
  const sig = main.match(/function engineSignature[\s\S]*?\n\}/);
  assert.ok(sig, 'engineSignature が見つからない');
  for (const key of ['useSystemAudio', 'useBuiltinTerms']) {
    assert.ok(!sig[0].includes(key), `${key} が engineSignature に入っている`);
  }
});
