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
// 0 を有効な値として受ける版（engineIdleMin の 0 = 「止めない」）。数にならない値だけ既定へ
function clampIntOrZero(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.max(min, Math.min(max, n));
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
  // 第3段（v0.11.0）で足した 3 つ。古い settings.json には無いので既定で埋める
  s.sumCtx = clampInt(s.sumCtx, 4096, 131072, d.sumCtx || 32768);              // 要約の文脈長（#41）
  s.engineIdleMin = clampIntOrZero(s.engineIdleMin, 0, 120, d.engineIdleMin ?? 10);   // 使われないエンジンを止めるまでの分（#58）
  s.dataDir = typeof s.dataDir === 'string' ? s.dataDir.trim() : '';           // データ保存先（'' = 既定の場所。#29）
  return s;
}

module.exports = { normalizeSettings };
