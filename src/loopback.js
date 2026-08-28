/*
 * loopback.js — Web会議の相手の声（パソコンから出ている音）を録るための判定
 *
 * Electron では getDisplayMedia は session.setDisplayMediaRequestHandler を
 * 設定しない限り必ず失敗する。ここはそのハンドラが「何を返すか」だけを決める。
 * Electron を読み込まないので、エンジンも画面も起動せずに検証できる。
 *
 * 経緯として残しておきたいこと:
 *
 *  - 音声だけを要求することは仕様上できない。W3C の仕様でも Electron でも、
 *    映像を返さないと必ず失敗する。だから映像も要求し、受け取った側が
 *    即座に捨てる（overlay.html の openSystemStream）。
 *
 *  - 「音声のみのデスクトップキャプチャ」を狙って
 *      getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } } })
 *    と書いてはいけない。Electron 31（Chromium 126）ではこれは失敗ではなく、
 *    不正なIPCとみなされてレンダラープロセスが強制終了する。
 *    try/catch では捕まえられず、録音ピルごと消える。
 *    ネット上のサンプルにはこの形が多く残っているが、採ってはいけない。
 *
 *  - 'loopbackWithMute' は使わない。録音中に既定の再生デバイスを実際に
 *    ミュートするため、会議の相手の声が自分に聞こえなくなる。
 *
 *  - ループバックは Windows でのみ動く（Electron の公式ドキュメントに明記）。
 *    他のOSでは何も返さず、マイクだけで録る。
 */
'use strict';

const LOOPBACK = 'loopback';

/**
 * setDisplayMediaRequestHandler のコールバックへ渡す値を決める。
 * 空オブジェクトを返すと要求元の Promise が reject する。これは想定どおりの
 * 失敗で、呼び出し側はマイクだけの録音へ落ちる。
 *
 * @param {{platform: string, frame: any, enabled: boolean, url: string}} ctx
 * @returns {{video?: any, audio?: string}}
 */
function chooseDisplayMedia(ctx) {
  const { platform, frame, enabled, url } = ctx || {};
  if (platform !== 'win32') return {};   // Windows 以外は取り込まない
  if (!enabled) return {};               // 設定がオフなら誰にも渡さない
  if (!frame) return {};
  // 要求元が分かるなら、録音オーバーレイ以外には渡さない。
  // 分からない場合は通す（ここで固く弾くと、URLの取れない環境で
  // 機能そのものが黙って死ぬ。守りたいのは「別の画面からの要求」であって、
  // 素性の分からない要求ではない）。
  const u = String(url || '');
  if (u && !/overlay\.html/i.test(u)) return {};
  return { video: frame, audio: LOOPBACK };
}

module.exports = { chooseDisplayMedia, LOOPBACK };
