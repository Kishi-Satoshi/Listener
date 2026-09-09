/*
 * dates.js — ローカル日付の文字列化
 *
 * 議事録の日付（page.date）はローカルの暦日で持つ。toISOString().slice(0, 10) は
 * UTC の日付なので、日本時間の 23:30 に始めた会議が前日の日付で保存されていた
 * （#51）。actions.js の toISO と同じ計算をここに置き、main.js から使う。
 * Electron に依存しないので test/main.test.js で直接検査できる。
 */
'use strict';

const pad = (n) => String(n).padStart(2, '0');

// ローカルの YYYY-MM-DD
function localDateISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = { localDateISO };
