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
// 文字起こし待ち（pending。本文がまだ無い）は飛ばす（#8/#42）。飛ばさないと、末尾に
// 待ちが並んでいるあいだ毎回空になり、直前の発言の文脈が途切れる。
function promptTail(segments) {
  const done = (segments || []).filter((s) => s && !s.pending);
  const n = done.length;
  for (let i = n - 1; i >= Math.max(0, n - 2); i--) {
    const s = done[i];
    if (!s.failed) return String(s.text || '').slice(-100);
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
// run(id) は Promise を返す。onChange(件数) は走っている数が変わるたびに呼ばれる
// （要約中はアプリを「忙しい」として扱うため。#52）。戻り値の runner.running() は
// 走っている id の一覧（終了時に「中断された」と書く先）。
function makeSummaryRunner(run, onChange) {
  const running = new Map();
  const notify = () => { if (onChange) { try { onChange(running.size); } catch (_) { /* noop */ } } };
  const runner = (id) => {
    if (running.has(id)) return running.get(id);
    let p;
    try { p = Promise.resolve(run(id)); } catch (e) { p = Promise.reject(e); }
    p = p.finally(() => { running.delete(id); notify(); });
    running.set(id, p);
    notify();
    return p;
  };
  runner.running = () => [...running.keys()];
  return runner;
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

// ---------------------------------------------------------------- クリップボード（Windows）
// 常駐 PowerShell に流す 1 行スクリプト。標準入力の 1 行が 1 命令。
//   paste          … Ctrl+V を送る（従来どおり）
//   copy <base64>  … クリップボードを「除外書式付き」で置き直す（#27）
// 置き直すのは、Windows のクリップボード履歴（Win+V）とクラウド同期（他の PC への
// 同期）から外すため。会議の発言や議事録が履歴に残り他の PC へ同期されるのは、
// オフラインで完結するという前提を裏口から破る。
//   ExcludeClipboardContentFromMonitorProcessing … 監視するアプリ全般に「見るな」
//   CanIncludeInClipboardHistory / CanUploadToCloudClipboard … DWORD 0 で「入れない・上げない」
// 値は 4 バイトの MemoryStream で渡す。byte[] を直接 SetData すると .NET の
// シリアライズ形式（ヘッダ付き）で包まれ、Windows が DWORD として読めない。
// 本文は base64 で 1 行に載せる（改行や引用符を含んでも命令の境界が壊れない）。
// PS5.1 で動く書き方にする（switch / [ValidateSet] は使わない）。失敗しても
// Electron が先に書いた本文は残る（try で包み、除外だけが効かない状態に留める）。
function pasterScript() {
  return "$ErrorActionPreference='SilentlyContinue';"
    + 'Add-Type -AssemblyName System.Windows.Forms;'
    + 'while($true){ $l=[Console]::In.ReadLine(); if($null -eq $l){break};'
    + " if($l -eq 'paste'){ [System.Windows.Forms.SendKeys]::SendWait('^v') }"
    + " elseif($l.StartsWith('copy ')){ try {"
    + ' $t=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l.Substring(5)));'
    + ' $d=New-Object System.Windows.Forms.DataObject; $d.SetText($t);'
    + ' $z={ [System.IO.MemoryStream]::new([byte[]](0,0,0,0)) };'
    + " $d.SetData('ExcludeClipboardContentFromMonitorProcessing',(& $z));"
    + " $d.SetData('CanIncludeInClipboardHistory',(& $z));"
    + " $d.SetData('CanUploadToCloudClipboard',(& $z));"
    + ' [System.Windows.Forms.Clipboard]::SetDataObject($d, $true) } catch {} } }';
}

// 自動貼り付けのあとに元のクリップボードを戻すか。戻すのは短い1行の文字列だけ。
// 複数行・長文は、書式付きのコピー（Word・ブラウザ）の文字部分であることが多く、文字だけで
// 戻すと元より劣るものに置き換わる。貼り付けた本文と同じなら戻す意味が無い
const RESTORE_MAX_CHARS = 200;
function restoreAfterPaste(prev, text) {
  const p = String(prev ?? '');
  if (!p || p === String(text ?? '')) return false;
  if (/[\r\n]/.test(p)) return false;
  return p.length <= RESTORE_MAX_CHARS;
}

// 常駐 PowerShell へ流す「置き直し」命令（改行なし。呼び出し側が '\n' を足す）
function copyCommand(text) {
  return `copy ${Buffer.from(String(text ?? ''), 'utf8').toString('base64')}`;
}

// ---------------------------------------------------------------- エンジンのファイル検査（#32）
// statFn(path) は fs.statSync 相当（無ければ投げる）。戻り値:
//   'missing'     … 無い／読めない
//   'placeholder' … 大きさはあるが割り当てブロックが 0。OneDrive の「ファイル オンデマンド」
//                   のように、一覧には見えるが実体がこの PC に無い（存在確認は通ってしまう）
//   'truncated'   … minBytes 未満。ダウンロードが途中で切れた・0 バイト
//   'ok'
// blocks が取れない環境（undefined）では実体の有無を判定しない。誤って「実体が無い」と
// 断じると、正常な環境でエンジンが使えなくなり、その方が害が大きい。
function engineFileIssue(file, minBytes, statFn) {
  let st;
  try { st = statFn(file); } catch (_) { return 'missing'; }
  if (!st) return 'missing';
  const size = Number(st.size) || 0;
  if (size > 0 && st.blocks === 0) return 'placeholder';
  if (size < minBytes) return 'truncated';
  return 'ok';
}

// 検査結果を、原因を名指しする一文にする。kind: 'exe' | 'model'。size は truncated のときの大きさ。
// 「見つかりません」だけでは、あるように見えるファイルを前に利用者が何もできない。
function engineIssueMessage(issue, kind, size) {
  const entity = kind === 'exe' ? '実行ファイル' : 'モデル';
  const file = kind === 'exe' ? '実行ファイル' : 'モデルファイル';
  if (issue === 'placeholder') return `${entity}の実体がこの PC にありません（OneDrive などのプレースホルダの可能性）`;
  if (issue === 'truncated') {
    const mb = (Number(size) || 0) / 1048576;
    return `${file}が途中で切れています（${mb >= 10 ? Math.round(mb) : mb.toFixed(1)}MB）。setup-*.ps1 を再実行してください`;
  }
  if (issue === 'missing') return `${file}が見つかりません`;
  return '';
}

// ---------------------------------------------------------------- ポートの衝突（#28/#31）
// 塞がっているポートで起動すると、エンジンはモデルを読み終えてから bind に失敗して落ちる。
// それまで「起動中」に見えるので、起動前に見て、塞がっていればこの文で止める。
function portInUseError(port) {
  return `ポート ${port} は他のプロセスが使用中です。設定でポートを変えるか、そのプロセスを終了してください`;
}

// ---------------------------------------------------------------- 記録中のエンジン設定（#57）
// これらを変えるとエンジンの再起動（engineSignature）や区間の切り方が変わる。記録中に
// 再起動すると、文字起こし中の区間が失われる。記録中は前の値に留め、他の設定は保存する。
const ENGINE_SETTING_LABELS = {
  language: '言語', localThreads: '文字起こしのスレッド数', sumThreads: '要約のスレッド数',
  useVad: 'VAD', suppressNst: '非発話トークンの抑制',
  localServerExe: '文字起こしエンジンの実行ファイル', localModelPath: '文字起こしのモデル', vadModelPath: 'VAD のモデル',
  sumServerExe: '要約エンジンの実行ファイル', sumModelPath: '要約のモデル',
  localPort: '文字起こしのポート', sumPort: '要約のポート', segmentSec: '区間の長さ',
};
const ENGINE_SETTING_KEYS = Object.keys(ENGINE_SETTING_LABELS);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

//   prev: いまの設定、next: 保存しようとする設定（正規化済み）、recording: 議事録を記録中か
// 戻り値 { settings: 保存する設定, kept: 留めたキー, warning: 画面に出す一文（無ければ ''） }
// 入力は書き換えない。
function guardEngineSettings(prev, next, recording) {
  if (!recording) return { settings: next, kept: [], warning: '' };
  const settings = { ...next };
  const kept = [];
  for (const k of ENGINE_SETTING_KEYS) {
    if (sameValue(prev[k], next[k])) continue;
    settings[k] = prev[k];
    kept.push(k);
  }
  const warning = kept.length
    ? `記録中のため、エンジンに関わる設定（${kept.map((k) => ENGINE_SETTING_LABELS[k]).join('・')}）は変更できません。記録を終えてから変更してください`
    : '';
  return { settings, kept, warning };
}

// 画面が送った値（sent）と保存された値（saved）が違うキーだけを返す。画面はこれを欄に
// 戻す（ホットキーの登録失敗・記録中に留めたエンジン設定・正規化で丸められた値）。
// 欄に古い値が残ると、以後の無関係な保存のたびに同じ失敗と警告を繰り返す。
function keptDifferent(sent, saved) {
  const out = {};
  if (!sent || typeof sent !== 'object') return out;
  for (const k of Object.keys(sent)) {
    if (!sameValue(sent[k], saved[k])) out[k] = saved[k];
  }
  return out;
}

// ---------------------------------------------------------------- 終了の確認（#52）
// recording: 議事録を記録中、summarizing: 要約を作成中。どちらでもなければ null。
// 要約は数分かかり、途中で終了すると結果は残らない。記録中と同じく一度は確認を挟む。
function closeConfirm(recording, summarizing) {
  if (!recording && !summarizing) return null;
  const sumLine = '要約を作成中です。終了すると要約は失われます';
  if (recording) {
    let detail = '終了すると録音が止まります。ここまでの文字起こしは、次回起動時に復旧できます。';
    if (summarizing) detail += `\n${sumLine}。`;
    return { message: '議事録を記録中です', detail };
  }
  return { message: sumLine, detail: '「要約を生成」で後から作り直せます。' };
}

// ---------------------------------------------------------------- 分割要約の打ち切り（#16）
// extract(text) は { text, truncated } を返す（要点の抽出）。長さの上限で切れたら、その塊を
// 半分に割って両方をやり直す（一度だけ）。切れたままだと中盤の議題が黙って欠ける。
// 半分でも切れたら本文は残して truncated を立てる（呼び出し側が注記し、パートを名指しする）。
async function extractNotes(extract, text) {
  const first = await extract(text);
  if (!first.truncated) return { text: first.text, truncated: false, retried: false };
  const half = Math.ceil(text.length / 2);
  const a = await extract(text.slice(0, half));
  const b = await extract(text.slice(half));
  return { text: `${a.text}\n${b.text}`, truncated: Boolean(a.truncated || b.truncated), retried: true };
}

// summaryError に書く一文。parts: 半分にしても切れたパート番号（1 始まり）、
// finalTruncated: 最終の統合が切れたか。どちらも無ければ ''。
// パートが切れた＝中盤の議題が欠けうる、最終が切れた＝末尾の議題が欠けうる、で文を分ける。
function truncationMessage(parts, finalTruncated) {
  const ps = (Array.isArray(parts) ? parts : []).filter((n) => Number.isInteger(n) && n > 0);
  const out = [];
  if (ps.length) out.push(`要約の材料（パート ${ps.join('・')}）が長さの上限で切れました。中盤の議題が欠けていないか確認してください。`);
  if (finalTruncated) out.push('要約が長さの上限で打ち切られた可能性があります。末尾の議題が欠けていないか確認してください。');
  return out.join('');
}

// ---------------------------------------------------------------- 初期プロンプトの予算（#23）
// whisper.cpp の初期プロンプトは n_text_ctx/2（既定 224 トークン）で切られる。どちら側から
// 切られるかはビルドで変わりうるので、そもそも溢れさせない。
// 予算の単位は UTF-8 のバイト数。日本語は 1 文字 ≒ 1 トークン ≒ 3 バイト、英数字は数文字で
// 1 トークン ≒ 3〜4 バイトなので、文字数より「バイト数 ÷ 3」の方が両方の文字種でトークン数に
// 近い（文字数で数えると英数字の語が実際の 3 倍に見積もられ、辞書が不当に切られる）。
// 上限は PROMPT_MAX_CHARS × 3 バイト（日本語だけなら従来どおり 200 文字）。
// 優先順は 文例 → 辞書（先頭行から）→ 既定語彙 → 直前の発言の尻尾。予算を超えたら後ろから
// 落とす（尻尾は先頭から削る・既定語彙、辞書の順に末尾の語から外す）。文例だけは落とさない。
// 以前は辞書を無制限に渡していたが、溢れた分は黙って効かなくなっていた。切るなら切ったと
// 伝える（kept/total を prompt:info で画面へ返す）。
//   戻り値 { prompt, kept: 辞書のうち収まった語数, total: 辞書の語数, over: kept < total }
function buildPromptParts({ ja, dictionary, useBuiltinTerms, tail, limitBytes, builtinTerms, sample }) {
  const uniq = (list) => {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      const w = String(raw ?? '').trim();
      if (w && !out.includes(w)) out.push(w);
    }
    return out;
  };
  const words = uniq(dictionary);
  // 既定語彙は日本語のときだけ。英語や自動判定で日本語の語を渡すと、その語が出力に漏れ、
  // 言語の推定も日本語へ引っぱられる。辞書と重なる語は足さない。
  const builtin = (ja && useBuiltinTerms !== false) ? uniq(builtinTerms).filter((w) => !words.includes(w)) : [];
  const head = ja ? String(sample || '') : '';
  const limit = Number(limitBytes) > 0 ? Number(limitBytes) : Infinity;
  let tailChars = Array.from(String(tail || ''));   // サロゲートペアを割らないよう文字単位
  let nWords = words.length;
  let nBuiltin = builtin.length;
  const assemble = () => {
    const parts = [];
    if (head) parts.push(head);
    const terms = words.slice(0, nWords).concat(builtin.slice(0, nBuiltin));
    if (terms.length) parts.push(`${terms.join('、')}。`);
    if (tailChars.length) parts.push(tailChars.join(''));
    return parts.join(' ');
  };
  let prompt = assemble();
  while (Buffer.byteLength(prompt, 'utf8') > limit) {
    if (tailChars.length) tailChars = tailChars.slice(1);
    else if (nBuiltin > 0) nBuiltin--;
    else if (nWords > 0) nWords--;
    else break;   // 文例だけになったらそれ以上は落とさない
    prompt = assemble();
  }
  return { prompt, kept: nWords, total: words.length, over: nWords < words.length };
}

// ---------------------------------------------------------------- 音声の退避と「文字起こし待ち」の区間（#8/#42）
// 区間は音声が届いた時点で { id, atMs, durationMs, pending: true, wav, text: '' } として
// meeting.segments と draft.json に控え、文字起こしが終わったら同じ要素を結果で置き換える。
// 以前は文字起こしが終わるまで draft に載らず、その間にアプリが落ちると音声ごと消えていた。

// 画面へ返す形。wav（ファイルのパス）は外す。画面に出す理由が無く、状態をそのまま
// ログや不具合報告に貼られるとパスが漏れる。待ちの区間は残す（進捗が見える）
function publicSegments(segments) {
  return (segments || []).map(({ wav, ...s }) => s);
}
// ページに保存する形。待ちの区間（本文が無い）は入れない。wav も外す
function settledSegments(segments) {
  return publicSegments((segments || []).filter((s) => s && !s.pending));
}
// 文字起こし待ちの区間の長さの合計（残り時間の見積もりの材料）
function pendingDurationMs(segments) {
  let sum = 0;
  for (const s of (segments || [])) if (s && s.pending) sum += Number(s.durationMs) || 0;
  return sum;
}
// draft.json の区間を復旧ページ用に直す。exists(path) は fs.existsSync 相当。
// pending は失敗扱いにして本文を「復旧中」にし、wav が残っていれば todo に載せる（起動後に
// 文字起こしして store.updateSegment で差し替える）。wav が無ければ失敗として残す。
// wav（パス）はページに載せない。入力は書き換えない。
function recoverSegments(segments, exists) {
  const out = [];
  const todo = [];
  for (const raw of (segments || [])) {
    if (!raw || typeof raw !== 'object') continue;
    const { wav, pending, ...s } = raw;
    if (pending) {
      s.failed = true;
      if (wav && exists(wav)) {
        s.text = '（復旧中: 文字起こし待ち）';
        todo.push({ id: s.id, wav, durationMs: Number(s.durationMs) || 0 });
      } else {
        s.text = '（この区間の認識に失敗: 音声が残っていません）';
      }
    } else if (s.failed && wav && exists(wav)) {
      // 認識に失敗した区間（wav は残してある）もやり直す。失敗の文は残し、成功したら差し替わる
      todo.push({ id: s.id, wav, durationMs: Number(s.durationMs) || 0 });
    }
    out.push(s);
  }
  return { segments: out, todo };
}
// 退避フォルダのうち 7 日より古いもの（復旧されずに残った孤児）。フォルダ名は開始時刻（ms）
// なのでそれで判断し、数字でなければ更新時刻で判断する。ちょうど 7 日は残す（境目で今日の
// 分を消さない）。entries: [{ name, mtimeMs }]、戻り値は消してよい name の配列。
// ---------------------------------------------------------------- 背圧: 区間の長さ（#42）
// 文字起こしが録音に追いつかないとき（待ちが 3 区間を超える）は、次の区間の長さを倍にして
// 送る回数を減らす（75→150→300 秒。上限 300 秒）。追いついたら（待ち 1 以下）設定の長さへ
// 戻す。短い区間を積み上げ続けると、待ちがどこまでも伸びて終了後の待ち時間になる。
//   pending: いまの待ち件数、currentMs: いまの区間の長さ、baseMs: 設定の長さ、
//   delta: 待ちが増えた(+1)のか減った(-1)のか。減った側では倍にしない（5→4 で倍にすると
//   一気に上限へ張り付く）。2〜3 のあいだは変えない（行ったり来たりで何度も送らない）。
const SEGMENT_MS_CAP = 300000;
function nextSegmentMs(pending, currentMs, baseMs, delta) {
  const base = Math.max(1000, Number(baseMs) || 75000);
  const cur = Number(currentMs) > 0 ? Number(currentMs) : base;
  if (pending <= 1) return base;
  if (pending > 3 && delta > 0) return Math.min(SEGMENT_MS_CAP, cur * 2);
  return cur;
}

// ---------------------------------------------------------------- 残り時間の見積もり（#42）
// 区間ごとの「処理時間 ÷ 音声の長さ」を指数移動平均（EMA）で持ち、残りの待ち（文字起こし
// 待ちの区間の長さの合計）に掛けて秒で返す。材料が無いうちは null（0 を出すと「もう終わる」
// に見える）。進行中の区間で既に経過した分は引く。成功した区間だけで学習する（失敗は時間の
// 目安にならない）。アプリの起動中は持ち越す（次の会議の最初の区間から見積もれる）。
class EtaTracker {
  constructor(alpha) { this.alpha = alpha || 0.3; this.ratio = null; }
  record(procMs, durationMs) {
    if (!(durationMs > 0) || !(procMs >= 0)) return;
    const r = procMs / durationMs;
    this.ratio = this.ratio === null ? r : this.ratio + this.alpha * (r - this.ratio);
  }
  etaSec(remainingMs, elapsedMs) {
    if (this.ratio === null) return null;
    const remain = Math.max(0, Number(remainingMs) || 0);
    const elapsed = Math.max(0, Number(elapsedMs) || 0);
    // ms で丸めてから秒に切り上げる（浮動小数の誤差で 39.0000…01 秒が 40 秒にならないように）
    return Math.max(0, Math.ceil(Math.round(this.ratio * remain - elapsed) / 1000));
  }
}

// ---------------------------------------------------------------- 打ち切り（#42）
// 文字起こし待ちの区間を全部「打ち切り」にする（meeting:skipPending）。失敗扱いにして本文を
// 「（文字起こしを打ち切り）」に置き、pending/wav を外す（id/atMs はそのまま）。黙って消さず
// 失敗の行として残すのは、何が欠けたかが議事録から分かるようにするため。
// 戻り値は { count: 打ち切った数, wavs: 消すべき wav のパス }。配列の要素は書き換える。
function skipPendingSegments(segments) {
  const wavs = [];
  let count = 0;
  for (const s of (segments || [])) {
    if (!s || !s.pending) continue;
    count++;
    if (s.wav) wavs.push(s.wav);
    delete s.pending; delete s.wav;
    s.text = '（文字起こしを打ち切り）';
    s.failed = true;
  }
  return { count, wavs };
}

const SEGBUF_MAX_AGE_MS = 7 * 86400000;
function staleSegbufDirs(entries, nowMs, maxAgeMs = SEGBUF_MAX_AGE_MS) {
  const out = [];
  for (const e of (entries || [])) {
    if (!e || typeof e.name !== 'string') continue;
    const byName = /^\d{10,}$/.test(e.name) ? Number(e.name) : NaN;
    const at = Number.isFinite(byName) ? byName : (Number(e.mtimeMs) || 0);
    if (nowMs - at > maxAgeMs) out.push(e.name);
  }
  return out;
}

module.exports = {
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, hotkeyFailureMessage, hotkeyStatus, resolveStartupHotkeys, saveHotkeys,
  makeSummaryRunner, tickStep,
  pasterScript, copyCommand, restoreAfterPaste,
  engineFileIssue, engineIssueMessage, portInUseError,
  ENGINE_SETTING_KEYS, guardEngineSettings, keptDifferent, closeConfirm,
  extractNotes, truncationMessage, buildPromptParts,
  publicSegments, settledSegments, pendingDurationMs, recoverSegments, staleSegbufDirs,
  nextSegmentMs, EtaTracker, skipPendingSegments,
};
