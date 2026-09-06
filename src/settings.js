/*
 * settings.js — 設定値の正規化
 *
 * 以前は settings:save のときだけ範囲に収めていたので、ディスク上の settings.json を
 * 手で壊した（ポートが文字列・範囲外）ときに、起動直後の値だけが正規化を
 * すり抜け、エンジンの起動待ちが TypeError で静かに失敗していた。
 * 読み込みと保存の両方がここを通る。Electron に依存しないので単体で検査できる。
 */
'use strict';

// 整数に直して範囲に収める。数にならない値と 0 は既定へ（0 は打ち間違い）
function clampInt(v, min, max, fallback) {
  return Math.max(min, Math.min(max, parseInt(v, 10) || fallback));
}

// raw: 既定値を重ねた後の設定。defaults: 壊れた値を戻す先（DEFAULT_SETTINGS）。
// 入力は書き換えず、新しいオブジェクトを返す。
function normalizeSettings(raw, defaults) {
  const s = { ...raw };
  const d = defaults || {};
  s.dictionary = Array.isArray(s.dictionary)
    ? s.dictionary.map((w) => String(w ?? '').trim()).filter(Boolean) : [];
  s.localPort = clampInt(s.localPort, 1024, 65535, d.localPort || 8990);
  s.sumPort = clampInt(s.sumPort, 1024, 65535, d.sumPort || 8991);
  s.localThreads = clampInt(s.localThreads, 1, 64, d.localThreads || 4);
  s.sumThreads = clampInt(s.sumThreads, 1, 64, d.sumThreads || 4);
  s.segmentSec = clampInt(s.segmentSec, 20, 300, d.segmentSec || 75);
  return s;
}

module.exports = { normalizeSettings };
