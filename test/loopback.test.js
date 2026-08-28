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

const OK = { platform: 'win32', enabled: true, url: 'file:///c/app/src/renderer/overlay.html' };

test('Windows では映像と loopback を返す', () => {
  const frame = { id: 1 };
  assert.deepStrictEqual(chooseDisplayMedia({ ...OK, frame }), { video: frame, audio: 'loopback' });
});

test('映像を必ず返す（音声だけを要求すると必ず失敗する仕様のため）', () => {
  const r = chooseDisplayMedia({ ...OK, frame: { id: 1 } });
  assert.ok(r.video, '映像を外すと getDisplayMedia が TypeError になる');
});

test('既定の再生デバイスをミュートする loopbackWithMute は使わない', () => {
  // 使うと録音中に会議相手の声が自分に聞こえなくなる
  assert.strictEqual(LOOPBACK, 'loopback');
  assert.strictEqual(chooseDisplayMedia({ ...OK, frame: {} }).audio, 'loopback');
});

test('Windows 以外では取り込まない（ループバックは Windows 限定）', () => {
  for (const platform of ['darwin', 'linux', 'freebsd', '']) {
    assert.deepStrictEqual(chooseDisplayMedia({ ...OK, platform, frame: {} }), {}, platform);
  }
});

test('設定がオフなら誰にも渡さない', () => {
  assert.deepStrictEqual(chooseDisplayMedia({ ...OK, enabled: false, frame: {} }), {});
  assert.deepStrictEqual(chooseDisplayMedia({ platform: 'win32', frame: {} }), {});
});

test('録音オーバーレイ以外の画面からの要求は断る', () => {
  // メイン画面から無警告でシステム音声を取れてはいけない
  assert.deepStrictEqual(
    chooseDisplayMedia({ ...OK, frame: {}, url: 'file:///c/app/src/renderer/app.html' }), {});
  // 素性が分からない場合は通す。ここで固く弾くと、URLの取れない環境で
  // 機能そのものが黙って死ぬ。
  assert.ok(chooseDisplayMedia({ ...OK, frame: {}, url: '' }).audio);
});

test('要求元フレームが無ければ何も返さない', () => {
  assert.deepStrictEqual(chooseDisplayMedia({ ...OK, frame: null }), {});
  assert.deepStrictEqual(chooseDisplayMedia({ ...OK }), {});
  assert.deepStrictEqual(chooseDisplayMedia(), {});
});

// ---------------------------------------------------------------- 実装の縛り
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const main = read('src/main.js');
const overlayHtml = read('src/renderer/overlay.html');
const appHtml = read('src/renderer/app.html');

// ソースを正規表現で検査するテストは、コメントに一致して素通りしやすい。
// 「テストが通っているのに実装が無い」が一番危ないので、常にコメントを落としてから見る。
const code = (s) => String(s).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (src, re) => { const m = String(src).match(re); return m ? code(m[0]) : ''; };

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
  const rel = fn(overlayHtml, /function releaseStream\(\)[\s\S]*?\n {2}\}/);
  assert.ok(rel, 'releaseStream が見つからない');
  assert.match(rel, /\[micStream, sysStream, mediaStream\]/);
  assert.match(rel, /\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
});

test('取り込んだ映像トラックを1行で捨てている', () => {
  // 捨てないと画面キャプチャが走り続け、CPU を食い、環境によっては枠が出る。
  // 行をまたいだ一致だと、2行下の無関係な .stop() を拾って素通りする。
  const open = fn(overlayHtml, /async function openSystemStream\(\)[\s\S]*?\n {2}\}/);
  assert.ok(open, 'openSystemStream が見つからない');
  assert.match(open, /for \(const t of s\.getVideoTracks\(\)\) \{[^\n]*t\.stop\(\)/);
});

test('無音警告が相手の声も見ている', () => {
  // マイクだけで判定すると、聞き役に回っている間じゅう警告が出続け、
  // 本当にマイクが死んだときに誰も見なくなる
  const chk = fn(overlayHtml, /function checkSilence\([\s\S]*?\n {2}\}/);
  assert.ok(chk, 'checkSilence が見つからない');
  assert.match(chk, /Math\.max\(micLevel, sysLevel/);
});

test('警告の文言が毎フレーム入れ替わらない', () => {
  // 二つの見張りが同じフラグを取り合うと、相手が喋っている間じゅう
  // 警告と通常表示が 60Hz で入れ替わり、ピルの上ではただのチラつきになる。
  // 出すべき文言を毎フレーム決め、変わったときだけ書き換えること。
  const chk = fn(overlayHtml, /function checkSilence\([\s\S]*?\n {2}\}/);
  assert.match(chk, /if \(label !== shownLabel\)/);
  assert.ok(!/silentWarned/.test(overlayHtml), '取り合うフラグが残っている');
});

test('新しい設定キーがエンジンの再起動条件に入っていない', () => {
  // 入れると設定を保存するたびに whisper-server が再起動する
  const sig = main.match(/function engineSignature[\s\S]*?\n\}/);
  assert.ok(sig, 'engineSignature が見つからない');
  for (const key of ['useSystemAudio', 'useBuiltinTerms']) {
    assert.ok(!sig[0].includes(key), `${key} が engineSignature に入っている`);
  }
});

test('openStream の待ちが明けたら、押された停止・破棄を見ている', () => {
  // 見ないと、押したあともマイクと画面キャプチャを掴んだまま録り続ける
  const st = overlayHtml.match(/async function start\(\)[\s\S]*?\n {2}\}/);
  assert.ok(st, 'start が見つからない');
  const after = st[0].slice(st[0].indexOf('await openStream()'));
  assert.match(after, /if \(cancelled\)/);
  assert.match(after, /if \(stopping\)/);
});

test('相手の声が途中で切れたら main へ報告し直す', () => {
  // しないと、マイクしか録れていないのに「相手の声も」と表示し続ける
  const open = overlayHtml.match(/async function openStream\(\)[\s\S]*?\n {2}\}/);
  assert.ok(open, 'openStream が見つからない');
  const ended = open[0].slice(open[0].indexOf("addEventListener('ended'"));
  assert.match(ended, /reportSource\(false, true\)/);
});

test('マイクだけが死んだ状態を相手の声でマスクしない', () => {
  const chk = overlayHtml.match(/function checkSilence\([\s\S]*?\n {2}\}/);
  assert.ok(chk, 'checkSilence が見つからない');
  assert.match(chk[0], /micSilentSince/);
  assert.match(chk[0], /sysOn/);
});

test('二重起動よけは表示の状態で判定しない', () => {
  // pill のマークアップは data-phase="recording" で始まる。表示で判定すると
  // 起動後の1回目が必ず弾かれ、音声入力も議事録も開始できなくなる。
  assert.match(overlayHtml, /if \(starting \|\| active\) return;/);
  assert.ok(!/dataset\.phase === 'recording'\) return;/.test(overlayHtml),
    '表示の状態を起動条件に使っている');
});

test('二重起動よけが解除される（次の録音を塞がない）', () => {
  // 音声入力の正常終了は cleanup を通らず releaseStream だけを通る。
  // ここで倒し忘れると、以後アプリを再起動するまで録音できない。
  const rel = fn(overlayHtml, /function releaseStream\(\)[\s\S]*?\n {2}\}/);
  assert.match(rel, /starting = false/);
  assert.match(rel, /active = false/);
  const cl = fn(overlayHtml, /function cleanup\(\)[\s\S]*?\n {2}\}/);
  assert.match(cl, /releaseStream\(\)/, 'cleanup が releaseStream を通っていない');
});

test('openStream の待ち明けに、押された停止・破棄を踏み越えて表示を戻さない', () => {
  // 戻すと、押した後なのに録音中に見えるうえ、以後の起動判定も狂う
  const open = fn(overlayHtml, /async function openStream\(\)[\s\S]*?\n {2}\}\n/);
  assert.ok(open, 'openStream が見つからない');
  const tail = open.slice(open.lastIndexOf('showRecording') - 200);
  assert.match(tail, /if \(cancelled \|\| stopping\) return;/);
});

test('要約の後処理と文字起こしの設定が main.js に結線されている', () => {
  const m = code(main);
  assert.match(m, /dropRedundantEmpty\(markdownToBlocks\(md\)\)/, '「特になし」の後処理が通っていない');
  assert.match(m, /form\.append\('carry_initial_prompt', 'true'\)/, '語彙のヒントが区間全体に効かない');
  assert.match(m, /const autoType = mtype\.detectType\(/, '自動判定を常に走らせていない');
  assert.match(m, /saved\.autoType = page\.autoType/, '自動判定の結果を保存していない');
});

test('日本語以外では既定語彙を渡さない', () => {
  // 英語や自動判定で日本語の語を渡すと、その語が出力に漏れ、
  // 言語の推定も日本語へ引っぱられる
  const bp = main.match(/function buildPrompt\([\s\S]*?\n\}/);
  assert.ok(bp, 'buildPrompt が見つからない');
  assert.match(bp[0], /const ja = settings\.language === 'ja'/);
  assert.match(bp[0], /if \(ja && settings\.useBuiltinTerms !== false\)/);
});

test('ユーザー辞書は予算で切らない', () => {
  // 辞書を育ててきた利用者の認識精度が黙って落ちるのを防ぐ
  const bp = main.match(/function buildPrompt\([\s\S]*?\n\}/)[0];
  const userLoop = bp.slice(bp.indexOf('settings.dictionary'), bp.indexOf('if (ja &&'));
  assert.ok(!userLoop.includes('budget'), 'ユーザー辞書に予算を掛けている');
  assert.ok(!/break;/.test(bp), '長い語ひとつで後続を捨てている');
});
