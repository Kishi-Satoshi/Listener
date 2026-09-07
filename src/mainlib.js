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
// 保存時の warning（その場の一回の失敗「登録できませんでした」）に使う。
// いまの登録状態（「登録できていません」）は hotkeyStatus が組む。
function hotkeyFailureMessage(failed, accelOf) {
  if (!failed.length) return '';
  return `${failed.map((l) => `${l}のホットキー ${accelOf[l]} `).join('と')}は他のアプリが使用中のため登録できませんでした`;
}

// 側（画面に出す名前）と設定のキー名の対応
const HOTKEY_SIDES = [['音声入力', 'hotkey'], ['議事録', 'meetingHotkey']];
const HOTKEY_KEY_OF = { 音声入力: 'hotkey', 議事録: 'meetingHotkey' };
const accelOf = (keys) => ({ 音声入力: keys.hotkey, 議事録: keys.meetingHotkey });

// 「設定（利用者が選んだキー）」と「実際に登録しているキー」の関係を、画面と
// トレイに出す形にする。設定と登録を分けて持つのは、起動時に既定へ退避しても
// 設定を書き換えないため（設定を書き換えると settings:get が既定を返して設定
// 画面に既定が出、次の無関係な保存でディスクにも漏れて利用者のキーが黙って消える）。
//   wanted: 設定のキー { hotkey, meetingHotkey }
//   active: 登録を試みたキー（退避で既定になっている側がある）
//   failed: registerHotkeys(active…) の failed ＝ いま登録できていない側
// 戻り値:
//   active: トレイに出すキー。登録できていない側は利用者のキーを名乗る
//           （既定のキーを出すと、そのキーが効くように見える）
//   state : hotkey:state で画面に返す { ok, failed, fallback, message }
//           failed   … いま登録できていない側（退避後の結果）
//           fallback … { 側: { wanted: 利用者のキー, using: 既定のキー } } 退避中の側
//           ok       … 利用者の設定どおりに全部登録できているときだけ true
//                      （退避中も false。利用者の選んだキーは効いていない）
//           message  … 画面に出す一文
//   note  : トレイの注記「（音声入力: 既定の … を使用中・Alt+M は登録できず）」
function hotkeyStatus(wanted, active, failed) {
  const act = { ...active };
  const fallback = {};
  for (const [label, key] of HOTKEY_SIDES) {
    if (failed.includes(label)) { act[key] = wanted[key]; continue; }
    if (act[key] !== wanted[key]) fallback[label] = { wanted: wanted[key], using: act[key] };
  }
  const parts = [];
  const notes = [];
  for (const [label] of HOTKEY_SIDES) {
    const f = fallback[label];
    if (!f) continue;
    parts.push(`${label}のホットキー ${f.wanted} は他のアプリが使用中のため、代わりに既定の ${f.using} を使っています`);
    notes.push(`${label}: 既定の ${f.using} を使用中`);
  }
  if (failed.length) {
    const keys = failed.map((l) => wanted[HOTKEY_KEY_OF[l]]);
    parts.push(`${failed.map((l, i) => `${l}のホットキー ${keys[i]} `).join('と')}は他のアプリが使用中のため登録できていません`);
    notes.push(`${keys.join('・')} は登録できず`);
  }
  return {
    active: act,
    state: { ok: parts.length === 0, failed: [...failed], fallback, message: parts.join('。') },
    note: notes.length ? `（${notes.join('・')}）` : '',
  };
}

// 起動時: 登録できなかった側だけ既定に落として一度だけ再試行する。
// cfg（利用者の設定）は読むだけで書き換えない。有効なキーは戻り値の active で返す
// ので、呼び出し側は settings ではなく別の変数（activeHotkeys）に持つ。
// apply(hk, mhk) は registerHotkeys の戻り値を返す（解除して両方を登録し直す）。
function resolveStartupHotkeys(cfg, defaults, apply) {
  const wanted = { hotkey: cfg.hotkey, meetingHotkey: cfg.meetingHotkey };
  const first = apply(wanted.hotkey, wanted.meetingHotkey);
  if (first.ok) return hotkeyStatus(wanted, wanted, []);

  // 設定がもともと既定なら、同じキーをもう一度試しても同じなので落とさない
  const active = { ...wanted };
  const retried = [];
  for (const l of first.failed) {
    const k = HOTKEY_KEY_OF[l];
    if (defaults[k] && defaults[k] !== wanted[k]) { active[k] = defaults[k]; retried.push(l); }
  }
  const second = retried.length ? apply(active.hotkey, active.meetingHotkey) : first;

  // failed は「いま登録できていない側」＝ 既定でも駄目だった側。既定で登録できた側は
  // fallback に載る。以前は最初の失敗をそのまま failed にしていたので、既定で動いている
  // キーの下に「登録できていません」が出ていた。
  const r = hotkeyStatus(wanted, active, second.failed);
  const alsoDefault = retried.filter((l) => second.failed.includes(l)).map((l) => defaults[HOTKEY_KEY_OF[l]]);
  if (alsoDefault.length) r.state.message += `（既定の ${alsoDefault.join('・')} も登録できませんでした）`;
  return r;
}

// 保存時: 変えた側だけ新しいキーで登録し直す。変えていない側は「いま動いているキー」
// （active。起動時に既定へ退避していればその既定）のまま。利用者のキーを再登録すると、
// 退避した理由の衝突がまだあれば再び失敗して、動いていた既定まで失う。
//   prev  : いまの設定（利用者のキー）、active: いま登録しているキー、next: 保存する設定
// 新しいキーが登録できなかった側は、設定を prev に、登録を active に戻す。
// 戻り値の applied は「設定として残ったキー」。画面はこれを欄に戻す（失敗したキーが
// 欄に残ると、以後の無関係な保存のたびに再失敗して警告が出続ける）。
// 両方とも変えていなければ null（登録し直さず、状態も触らない）。
function saveHotkeys(prev, active, next, apply) {
  const changed = HOTKEY_SIDES.filter(([, k]) => next[k] !== prev[k]).map(([l]) => l);
  if (!changed.length) return null;
  const want = { ...active };
  for (const l of changed) want[HOTKEY_KEY_OF[l]] = next[HOTKEY_KEY_OF[l]];
  let r = apply(want.hotkey, want.meetingHotkey);

  const applied = { hotkey: next.hotkey, meetingHotkey: next.meetingHotkey };
  const rejected = changed.filter((l) => r.failed.includes(l));
  let warning = '';
  if (rejected.length) {
    warning = hotkeyFailureMessage(rejected, accelOf(next));
    for (const l of rejected) {
      const k = HOTKEY_KEY_OF[l];
      applied[k] = prev[k];
      want[k] = active[k];
    }
    r = apply(want.hotkey, want.meetingHotkey);
  }
  return { applied, warning, ...hotkeyStatus(applied, want, r.failed) };
}

// ---------------------------------------------------------------- 要約の排他
// 同じ id の要約は同時に一つだけ。走行中に「要約を生成」を連打されると、同じ
// 文字起こしに対して要約が二重に走り、後から終わった方が前の結果（とその間の
// 編集）を上書きしていた。走行中なら同じ Promise を返し、終わったら（失敗でも）外す。
// run(id) は Promise を返す。
function makeSummaryRunner(run) {
  const running = new Map();
  return (id) => {
    if (running.has(id)) return running.get(id);
    let p;
    try { p = Promise.resolve(run(id)); } catch (e) { p = Promise.reject(e); }
    p = p.finally(() => running.delete(id));
    running.set(id, p);
    return p;
  };
}

// ---------------------------------------------------------------- overlay:tick の見張り
// main のタイマーから5秒ごとに呼ぶ。戻り値は判断（'send' | 'skip' | 'stop'）。
// 見張りを消す（stop）のは議事録が無くなったときだけ。一時停止は送信を飛ばす（skip）
// だけにする。一時停止で消すと、再開しても誰も起こし直さず、以後の区切りが画面の
// 間引かれるタイマー任せに戻る（1区間が9分になる元の不具合が再発する）。
function tickStep({ state, meeting }, send, stop) {
  if (state !== 'meeting' || !meeting) { stop(); return 'stop'; }
  if (meeting.paused) return 'skip';
  send();
  return 'send';
}

module.exports = {
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, hotkeyFailureMessage, hotkeyStatus, resolveStartupHotkeys, saveHotkeys,
  makeSummaryRunner, tickStep,
};
