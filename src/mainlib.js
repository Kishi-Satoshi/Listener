/*
 * mainlib.js — main.js から切り出した判断（Electron に依存しない部分）
 *
 * main.js は Electron を require するので、テストから直接は読み込めない。
 * 実機で踏んだ不具合の「判断」だけをここに置き、test/main.test.js で実行して
 * 固定する。main.js がこれらを本当に呼んでいるかは repo.test.js で見る。
 */
'use strict';

// ---------------------------------------------------------------- 要約の書き戻し
// 要約は数分かかる。その間に利用者がページを削除していることがある。
// 入口で読んだ page をそのまま保存すると、削除した議事録が復活する
// （「消したはずの議事録が戻ってくる」）。必ずいまディスクにある
// ページを読み直し、無ければ何も書かずに null を返す。
// apply(page) は、生成物だけを最新のページに載せる（タイトルやメモは
// 要約中に編集されているかもしれないので、古いコピーで上書きしない）。
function saveIfExists(store, pageId, apply) {
  const saved = store.getPage(pageId);
  if (!saved) return null;
  apply(saved);
  return store.savePage(saved);
}

// ---------------------------------------------------------------- 会議の長さ
// endAt は停止時刻（stoppedAt）。以降の文字起こし待ちを混ぜると 4分の会議が
// 12分になる。一時停止したまま停止した場合、pausedAt から endAt までを
// 一時停止として引く（Date.now() で引くと待ち時間の分だけ短く、負にもなる）。
function meetingDurationSec(m, endAt) {
  const end = endAt || Date.now();
  const pausedTotal = (m.pausedMs || 0) + (m.paused ? Math.max(0, end - m.pausedAt) : 0);
  return Math.max(0, Math.round((end - m.startedAt - pausedTotal) / 1000));
}

// ---------------------------------------------------------------- 初期プロンプトの尻尾
// 次の区間の初期プロンプトには直前の発言の末尾を渡す。失敗区間の text は
// 「（この区間の認識に失敗: …）」というエラー文なので、渡すと次の区間が
// エラー文を「文例」として真似る。直近の成功区間から取り、最大2件だけ遡る
// （それ以上前の発言は文脈として古い）。
function promptTail(segments) {
  const n = segments.length;
  for (let i = n - 1; i >= Math.max(0, n - 2); i--) {
    const s = segments[i];
    if (s && !s.failed) return String(s.text || '').slice(-100);
  }
  return '';
}

// ---------------------------------------------------------------- ホットキー
// entries: [{ label, accel, handler }]。register(accel, handler) は成功で true。
// 片方が他アプリと衝突していても、もう片方は使えるままにする（以前は
// 片方の失敗で両方を解除し、音声入力まで効かなくなっていた）。
// accel が空なら「未設定」で、失敗には数えない。
function registerHotkeys(entries, register) {
  const failed = [];
  for (const e of entries) {
    if (!e.accel) continue;
    let ok = false;
    try { ok = Boolean(register(e.accel, e.handler)); } catch (_) { ok = false; }
    if (!ok) failed.push(e.label);
  }
  return { ok: failed.length === 0, failed };
}

// failed: registerHotkeys の failed。accelOf: { 音声入力: 'Control+…', 議事録: 'Alt+M' }
function hotkeyFailureMessage(failed, accelOf) {
  if (!failed.length) return '';
  return `${failed.map((l) => `${l}のホットキー ${accelOf[l]} `).join('と')}は他のアプリが使用中のため登録できませんでした`;
}

// 起動時: 登録できなかった側だけ既定に落として一度だけ再試行する。
// 戻り値の hotkey / meetingHotkey はメモリ上の値。呼び出し側はこれを
// ディスクへ書かない（利用者の設定を黙って既定に上書きしない）。
// apply(hk, mhk) は registerHotkeys の戻り値を返す。
function resolveStartupHotkeys(cfg, defaults, apply) {
  const out = { hotkey: cfg.hotkey, meetingHotkey: cfg.meetingHotkey };
  const first = apply(out.hotkey, out.meetingHotkey);
  if (first.ok) return { ...out, state: { ok: true, failed: [], message: '' }, note: '' };

  const keyOf = { 音声入力: 'hotkey', 議事録: 'meetingHotkey' };
  const tried = { 音声入力: cfg.hotkey, 議事録: cfg.meetingHotkey };
  for (const l of first.failed) out[keyOf[l]] = defaults[keyOf[l]];
  const second = apply(out.hotkey, out.meetingHotkey);

  const parts = first.failed.map((l) => {
    const def = defaults[keyOf[l]];
    return second.failed.includes(l)
      ? `${l}のホットキー ${tried[l]} は登録できず、既定の ${def} も登録できませんでした`
      : `${l}のホットキー ${tried[l]} は登録できませんでした。代わりに既定の ${def} を使います`;
  });
  return {
    ...out,
    state: { ok: false, failed: first.failed, message: `${parts.join('。')}（他のアプリが使用中の可能性）` },
    note: `（${first.failed.map((l) => tried[l]).join('・')} は登録できず）`,
  };
}

module.exports = {
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, hotkeyFailureMessage, resolveStartupHotkeys,
};
