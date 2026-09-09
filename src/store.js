/*
 * store.js — Listener のストレージ層
 *
 * Notion のブロックモデルを踏襲しつつ、ネイティブ依存なしで実装する。
 *   index.json            一覧用の軽量インデックス（起動時にこれだけ読む）
 *   pages/<id>.json       ページ本体（プロパティ + ブロック配列）
 *   transcripts/<id>.json 文字起こしセグメント（重いので分離）
 *
 * 要約ブロックは cites: [segmentId] で文字起こしの該当発言を参照する。
 * これが「要約の根拠をワンクリックで確認できる」機能の土台になる。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isCitable, searchFold } = require('./cite');

let ROOT = '';
let index = { version: 2, pages: [] };

// ---------------------------------------------------------------- 基盤
function dirs() {
  return {
    root: ROOT,
    pages: path.join(ROOT, 'pages'),
    transcripts: path.join(ROOT, 'transcripts'),
    indexFile: path.join(ROOT, 'index.json'),
    draftFile: path.join(ROOT, 'draft.json'),
  };
}

// 「ファイルが無い」と「読めたが壊れている」を分ける。壊れていたら退避してから
// fallback を返す（main.js の loadJson と同じ扱い）。退避しないと、次の保存で
// 壊れたファイルが既定値で上書きされ、人手でも復旧できなくなる。
// 時刻はファイル名に使えるよう ':' '.' を落とす（Windows は ':' を許さない）。
function readJson(file, fallback) {
  let raw;
  try {
    if (!fs.existsSync(file)) return fallback;
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error('store: read failed', file, e.message);
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('store: broken json', file, e.message);
    try {
      const broken = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(file, broken);
      console.error('store: 壊れたファイルを退避しました:', broken);
    } catch (e2) { console.error('store: 退避に失敗', file, e2.message); }
    return fallback;
  }
}

// 書き込み中の電源断でファイルが壊れないよう、一時ファイル経由で置換する
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ローカルの暦日 YYYY-MM-DD。toISOString() は UTC なので、日本では朝 9 時前に
// 始めた会議が前日の日付で保存され、一覧の並びと日付の表示が食い違う。
function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// データフォルダを開く。dataRoot（省略可）が空でない文字列なら、userData/data の
// 代わりにそこを使う（#29 データ保存先の設定。main が設定値を渡す）。root() は
// 常に絶対パスを返すので、相対指定や末尾の区切りはここで正規化する。
function init(userDataPath, dataRoot) {
  ROOT = (typeof dataRoot === 'string' && dataRoot !== '')
    ? path.resolve(dataRoot)
    : path.join(userDataPath, 'data');
  const d = dirs();
  fs.mkdirSync(d.pages, { recursive: true });
  fs.mkdirSync(d.transcripts, { recursive: true });
  index = readJson(d.indexFile, { version: 2, pages: [] });
  if (!index || !Array.isArray(index.pages)) index = { version: 2, pages: [] };
  if (reconcile()) writeJson(d.indexFile, index);
  return ROOT;
}

// いま使っているデータフォルダの絶対パス（設定画面の表示・フォルダを開く用）
const root = () => ROOT;

// 索引と pages/ の食い違いを直す。真実は常に pages/ 側（索引は一覧用の写しに過ぎない）。
//   (a) 索引に無い page.json → summarize して復帰。索引が壊れて空になった場合の
//       「全議事録が消えたまま」もこれで直る（全ページが (a) になる＝再構築）。
//   (b) 索引にあって page.json が無い行 → 幽霊行なので除く。
//   (c) 古い世代の索引には searchText が無く、検索が本文に当たらない → 作り直す。
//       v0.11.0 より前の索引には memoText が無く（メモは searchText の末尾に連結され、
//       4000 字で切られていた）、メモと長い要約の後半に検索が当たらない → 同じく作り直す。
// 起動のたびに全ページを読むのは避けたいので、(a)(c) に該当する行だけ読む。
// 変更があったときだけ true を返し、呼び出し側が索引を書く。
function reconcile() {
  let onDisk;
  try {
    onDisk = new Set(fs.readdirSync(dirs().pages)
      .filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)));
  } catch (e) {
    console.error('store: pages/ を読めない', e.message);
    return false;
  }
  let changed = false;
  const seen = new Set();
  const kept = [];
  for (let i = 0; i < index.pages.length; i++) {
    const entry = index.pages[i];
    if (!entry || typeof entry.id !== 'string' || !onDisk.has(entry.id) || seen.has(entry.id)) {
      changed = true;
      continue;
    }
    seen.add(entry.id);
    if (typeof index.pages[i].searchText === 'string'
      && typeof index.pages[i].memoText === 'string') { kept.push(entry); continue; }
    const page = getPage(entry.id);
    if (page) { kept.push(summarize(page)); changed = true; } else kept.push(entry);
  }
  for (const id of onDisk) {
    if (seen.has(id)) continue;
    const page = getPage(id);
    if (!page || page.id !== id) continue;   // 壊れた page.json は getPage が退避済み
    kept.push(summarize(page));
    changed = true;
  }
  if (!changed) return false;
  index.pages = kept;
  index.pages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return true;
}

// ---------------------------------------------------------------- インデックス
// 索引が持つ検索用本文の上限。要約は長い会議で 1 万字を超えることがあり、4000 字で
// 切ると後半の要点が検索に出ない（#44）。メモは短い前提だが、無制限に持つと
// 索引（起動時に丸ごと読む）が肥大するので別に上限を置く。
const SEARCH_TEXT_MAX = 20000;
const MEMO_TEXT_MAX = 2000;

function summarize(page) {
  const todos = page.blocks.filter((b) => b.type === 'todo');
  const open = todos.filter((b) => !b.checked);
  const firstBullet = page.blocks.find((b) => b.type === 'bullet' && b.text);
  const dues = open.map((b) => b.due).filter(Boolean).sort();
  return {
    id: page.id,
    title: page.title || '(無題の議事録)',
    date: page.date,
    durationSec: page.durationSec || 0,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    meetingType: page.meetingType || 'general',
    hasSummary: page.blocks.some((b) => b.type === 'heading'),
    actionCount: todos.length,
    openActionCount: open.length,
    nextDue: dues[0] || '',
    assignees: [...new Set(open.map((b) => b.assignee).filter(Boolean))],
    preview: firstBullet ? firstBullet.text.slice(0, 120) : '',
    // 「すべて」の検索が見る本文。これが無いと検索はタイトルと最初の
    // 1行しか当たらず、要約の中身を探せない（実機で「検索が全部壊れて
    // いる」と報告された）。文字起こしは searchFullText が受け持つ。
    // メモは別のキーに持つ（#44）。要約に連結して切ると、長い会議ではメモが
    // 上限の外へ押し出され、メモには他の検索経路が無いので二度と探せない。
    searchText: page.blocks.map((b) => b.text).filter(Boolean).join(' ').slice(0, SEARCH_TEXT_MAX),
    memoText: String(page.memo || '').slice(0, MEMO_TEXT_MAX),
    recovered: Boolean(page.recovered),
  };
}

function reindexPage(page) {
  const entry = summarize(page);
  const i = index.pages.findIndex((p) => p.id === page.id);
  if (i >= 0) index.pages[i] = entry;
  else index.pages.unshift(entry);
  index.pages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  writeJson(dirs().indexFile, index);
}

const listPages = () => index.pages;

// ---------------------------------------------------------------- ページ
const pageFile = (id) => path.join(dirs().pages, `${id}.json`);
const transcriptFile = (id) => path.join(dirs().transcripts, `${id}.json`);

function getPage(id) {
  const page = readJson(pageFile(id), null);
  if (!page) return null;
  if (!Array.isArray(page.blocks)) page.blocks = [];
  markShortBlocks(page.blocks);
  return page;
}

// 短すぎて出典の照合対象にならない行に citeSkip を付ける。
// v0.10.8 より前に要約したページには citeSkip が無く、そのままだと画面が
// 「根拠なし」の札を出し、保存のたびに分母へ数えてしまう（「出典 1/1」が「1/2」になる）。
// 読むたびに補うので、古いページも次の保存で正しい形になる。
function markShortBlocks(blocks) {
  for (const b of blocks) {
    if (b.type !== 'bullet' && b.type !== 'todo') continue;
    if (b.citeState === 'manual') continue;
    if (!b.citeSkip && !isCitable(b.text)) b.citeSkip = true;
  }
}

function getTranscript(id) {
  const t = readJson(transcriptFile(id), null);
  return t && Array.isArray(t.segments) ? t.segments : [];
}

// 出典の被覆率「🔗 出典 x/y」。要約直後の値を持ち越すと、人が行を足したり書き換えたり
// したあとに数が合わなくなるので、保存のたびにブロックから数え直す。
//   分母: bullet/todo のうち、短すぎて対象外（citeSkip: cite.js が付ける）でも
//         人が足した行（manual）でもないもの
//   分子: そのうち出典があり、人が書き換えていない（stale ではない）もの
// citeStat に他のキーがあっても消さない（表示側が知らないキーを持ち越せるように）。
function citeStatOf(blocks) {
  let total = 0;
  let linked = 0;
  for (const b of blocks) {
    if (b.type !== 'bullet' && b.type !== 'todo') continue;
    if (b.citeSkip || b.citeState === 'manual' || !isCitable(b.text)) continue;
    total++;
    if (Array.isArray(b.cites) && b.cites.length && b.citeState !== 'stale') linked++;
  }
  return { linked, total };
}

function savePage(page) {
  page.updatedAt = new Date().toISOString();
  page.citeStat = { ...(page.citeStat || {}), ...citeStatOf(page.blocks || []) };
  writeJson(pageFile(page.id), page);
  reindexPage(page);
  return page;
}

function saveTranscript(id, segments) {
  writeJson(transcriptFile(id), { id, segments });
}

function createPage({ title, date, durationSec, memo, blocks, segments, createdAt, recovered }) {
  const id = newId('p');
  const now = new Date().toISOString();
  const page = {
    id,
    title: title || '',
    date: date || localDate(new Date()),
    durationSec: durationSec || 0,
    memo: memo || '',
    blocks: blocks || [],
    createdAt: createdAt || now,
    updatedAt: now,
    recovered: Boolean(recovered),
    summaryError: '',
  };
  writeJson(pageFile(id), page);
  saveTranscript(id, segments || []);
  reindexPage(page);
  return page;
}

// 索引から外して書く → transcript → page の順。途中で落ちても、索引に「本体の無い行」
// （開くと空になる幽霊行）は残らない。逆に page.json が残れば次回起動の reconcile が
// 索引へ戻す（真実はファイル側）ので、消し損ねが黙って失われることもない。
function deletePage(id) {
  index.pages = index.pages.filter((p) => p.id !== id);
  writeJson(dirs().indexFile, index);
  for (const f of [transcriptFile(id), pageFile(id)]) {
    try { fs.unlinkSync(f); } catch (_) { /* noop */ }
  }
  return index.pages;
}

// ---------------------------------------------------------------- ブロック編集
function updateBlock(pageId, blockId, patch) {
  const page = getPage(pageId);
  if (!page) return null;
  const b = page.blocks.find((x) => x.id === blockId);
  if (!b) return null;
  if (typeof patch.text === 'string' && patch.text !== b.text) {
    // 人が書き換えた要点は、出典がまだ元の文に対応しているか分からない。
    // cites は残す（根拠を辿れる方が有用）が、被覆率の分子からは外す（stale）。
    // 人が足した行（manual）はもともと出典の対象外なので、そのまま。
    if (b.citeState !== 'manual') b.citeState = 'stale';
    // 書き換えで長さが変わりうる。短くなれば対象外、長くなれば対象に戻す
    if (isCitable(patch.text)) delete b.citeSkip; else b.citeSkip = true;
    b.text = patch.text;
  }
  if (typeof patch.checked === 'boolean') b.checked = patch.checked;
  if (typeof patch.type === 'string') b.type = patch.type;
  return savePage(page);
}

// 文字起こし1区間の本文を直す。id と atMs は変えない（出典チップと時刻表示が id で引くため）。
// ページ本体（page.json）と出典は触らない。出典の引き直しとページ保存は main 側が1回だけ行う。
function updateSegment(pageId, segId, patch) {
  const segments = getTranscript(pageId);
  const s = segments.find((x) => x.id === segId);
  if (!s) return null;
  if (typeof patch.text === 'string') {
    s.text = patch.text;
    delete s.failed;   // 「認識に失敗」の行を人が書き直したら、要約の材料に戻す
  }
  saveTranscript(pageId, segments);
  return segments;
}

function insertBlock(pageId, afterBlockId, type) {
  const page = getPage(pageId);
  if (!page) return null;
  // 人が足した行。LLM の要約ではないので出典の対象外（被覆率の分母に入れない）
  const block = { id: newId('b'), type: type || 'bullet', text: '', cites: [], citeState: 'manual' };
  const i = page.blocks.findIndex((x) => x.id === afterBlockId);
  if (i >= 0) page.blocks.splice(i + 1, 0, block);
  else page.blocks.push(block);
  savePage(page);
  return { page, blockId: block.id };
}

// ブロックの並べ替え。toIndex は「動かす行を抜いたあとの」挿入位置。
// 画面側もドラッグ中の行を除いた並びで位置を数えるので、そのまま挿せる。
function moveBlock(pageId, blockId, toIndex) {
  const page = getPage(pageId);
  if (!page) return null;
  const from = page.blocks.findIndex((x) => x.id === blockId);
  if (from < 0) return null;
  const [b] = page.blocks.splice(from, 1);
  const to = Math.max(0, Math.min(Math.trunc(Number(toIndex) || 0), page.blocks.length));
  page.blocks.splice(to, 0, b);
  savePage(page);
  return page;
}

function removeBlock(pageId, blockId) {
  const page = getPage(pageId);
  if (!page) return null;
  page.blocks = page.blocks.filter((x) => x.id !== blockId);
  return savePage(page);
}

function setTitle(pageId, title) {
  const page = getPage(pageId);
  if (!page) return null;
  page.title = title;
  return savePage(page);
}

// ---------------------------------------------------------------- 検索
// 検索は畳み込んだ文字列どうしで当てる（#53）。文字起こしは「では、予算案の、作成を」の
// ように読点が挟まり、要約は「ＡＩ」と「AI」が混ざるので、原文どうしの includes では
// 言ったはずの語が見つからない。畳み込みは cite.searchFold（normalize とは別物）。

// 本文を畳み込み、畳み込み後の各文字が元の本文のどの範囲から来たかも返す。
// 一致は畳んだ文字列で探すが、抜粋は元の本文から切りたい（句読点や全角のまま見せる）。
// 文字ごとに畳むと NFKC が「ｶ」+「ﾞ」→「ガ」のように結合できないので、
// 結合記号は直前の文字と同じ塊にして畳み、塊の出力を塊の元範囲に対応付ける。
const JOIN_MARK = /[\u0300-\u036f\u3099-\u309c\uff9e\uff9f\u200d\ufe0f]/;
function foldWithMap(text) {
  const s = String(text || '');
  let folded = '';
  const from = [];   // folded[i] → 元の塊の開始位置
  const to = [];     // folded[i] → 元の塊の終了位置（排他）
  let start = 0;
  while (start < s.length) {
    let end = start + (s.codePointAt(start) > 0xffff ? 2 : 1);
    while (end < s.length && JOIN_MARK.test(s[end])) end++;
    const f = searchFold(s.slice(start, end));
    for (let k = 0; k < f.length; k++) { from.push(start); to.push(end); }
    folded += f;
    start = end;
  }
  return { folded, from, to };
}

// 畳んだ検索語 q が当たった箇所を、元の本文 text から切り出す（前後を少し添える）。
// 呼ぶ側が「当たる」ことを確かめてから呼ぶ（外れた本文に文字単位の位置対応を作らない）。
function snippetOf(text, q) {
  const { folded, from, to } = foldWithMap(text);
  const at = folded.indexOf(q);
  // 元の本文の範囲に戻す。結合の仕方の差で位置が取れない稀な場合は先頭から見せる
  const s = at >= 0 ? from[at] : 0;
  const e = at >= 0 ? to[at + q.length - 1] : Math.min(text.length, q.length);
  const head = Math.max(0, s - 20);
  return (head > 0 ? '…' : '') + text.slice(head, e + 40);
}

// 一覧（タイトル・要約本文・メモ）の絞り込みは同期・即時。
// タイトル → 要約本文（searchText）→ メモ（memoText）の順に当て、抜粋は当たった方の
// 原文から切る。打鍵のたびに全ページを走るので、まず丸ごと畳んで当たりだけ見る。
function searchIndex(query) {
  const q = searchFold(query);
  if (!q) return index.pages;
  const out = [];
  for (const p of index.pages) {
    if (searchFold(p.title).includes(q)) { out.push(p); continue; }
    const text = p.searchText || p.preview || '';
    if (searchFold(text).includes(q)) { out.push({ ...p, snippet: snippetOf(text, q) }); continue; }
    const memo = p.memoText || '';
    if (searchFold(memo).includes(q)) out.push({ ...p, snippet: snippetOf(memo, q) });
  }
  return out;
}

// 全文検索は文字起こしファイルを走査する（件数が増えると重いので呼び出し側で明示実行）
// 文字起こし（トランスクリプト）だけを対象に検索する。
// 要約は編集や言い換えを経ているので、「言ったかどうか」を探す用途では
// 原文の方が信頼できる。要約やタイトルは通常の検索（searchIndex）が受け持つ。
// 抜粋は当たった区間の原文そのもの（畳んだ文字列は見せない）。
//
// 戻り値は { hits, total, truncated }（#43）。以前は limit 件たまった時点で走査を
// 止め、打ち切ったことが戻り値にも画面にも出なかった（「全件見た」と誤解させる）。
// 全ページを走査して当たったページ数を total に数え、hits は先頭 limit 件（索引の
// 並び＝新しい順）、truncated は「見せていない当たりがある」印。
const FULL_TEXT_LIMIT = 60;
function searchFullText(query, limit) {
  const q = searchFold(query);
  if (!q) return { hits: [], total: 0, truncated: false };
  const max = Number(limit) > 0 ? Math.trunc(Number(limit)) : FULL_TEXT_LIMIT;
  const hit = (s) => s.text && searchFold(s.text).includes(q);
  const hits = [];
  let total = 0;
  for (const entry of index.pages) {
    const segments = getTranscript(entry.id);
    // hits が埋まったあとは数えるだけ（当たりが1つあれば足りる）
    if (hits.length >= max) { if (segments.some(hit)) total++; continue; }
    const inSegments = segments.filter(hit);
    if (inSegments.length === 0) continue;
    total++;
    hits.push({
      ...entry,
      segmentHits: inSegments.length,
      snippet: inSegments[0].text,
    });
  }
  return { hits, total, truncated: total > hits.length };
}

// ---------------------------------------------------------------- 未完了アクション
// アクションタブの1行。page.json の todo ブロックから画面に要る分だけ写す
function actionRow(page, b) {
  return {
    pageId: page.id, blockId: b.id, pageTitle: page.title, date: page.date,
    text: b.text, assignee: b.assignee || '', due: b.due || '',
    dueRaw: b.dueRaw || '', dueApprox: Boolean(b.dueApprox),
  };
}

// 期限が近い順。期限なしは末尾へ回す（無期限を先頭に出しても行動につながらない）
function byDue(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return String(b.date).localeCompare(String(a.date));
}

// アクションタブの1画面分を1回の走査で作る（#45）。
// 以前は1打鍵ごとに openActions()（全 todo 持ちページを読む）と assigneeList()
// （その中でもう一度 openActions()）の IPC 2本を呼び、500 ページで同期ディスク読み
// 1000 回になっていた。ここでは
//   - 索引の openActionCount が 0 のページ（完了だけ・todo 無し）は読まない
//   - 行（actions）・担当者の一覧（people）・件数（total）を1度に返す
// people の count と total は q / assignee で絞る前の未完了件数（絞ってもチップの
// 数字が変わらない）。q は searchFold で畳んで本文・議事録名・担当に当て、assignee は
// 完全一致（チップで選ぶ名前なので部分一致は要らない）。
function actionView({ q, assignee } = {}) {
  const fq = searchFold(q);
  const who = String(assignee || '');
  const counts = new Map();
  const actions = [];
  let total = 0;
  for (const entry of index.pages) {
    if (!entry.openActionCount) continue;
    const page = getPage(entry.id);
    if (!page) continue;
    for (const b of page.blocks) {
      if (b.type !== 'todo' || b.checked || !b.text) continue;
      const row = actionRow(page, b);
      total++;
      if (row.assignee) counts.set(row.assignee, (counts.get(row.assignee) || 0) + 1);
      if (who && row.assignee !== who) continue;
      if (fq && ![row.text, row.pageTitle, row.assignee].some((s) => searchFold(s).includes(fq))) continue;
      actions.push(row);
    }
  }
  actions.sort(byDue);
  const people = [...counts.entries()].map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count);
  return { actions, people, total };
}

// 全ページ横断の未完了アクションアイテム（actionView の行だけ）
function openActions() {
  return actionView().actions;
}

// 未完了アクションに登場する担当者の一覧（絞り込み用。actionView の people だけ）
function assigneeList() {
  return actionView().people;
}

// ---------------------------------------------------------------- 進行中ドラフト
const readDraft = () => readJson(dirs().draftFile, null);
const writeDraft = (d) => writeJson(dirs().draftFile, d);
function clearDraft() {
  try { fs.unlinkSync(dirs().draftFile); } catch (_) { /* noop */ }
}

module.exports = {
  init, root, newId,
  listPages, getPage, getTranscript, savePage, saveTranscript,
  createPage, deletePage,
  updateBlock, updateSegment, insertBlock, removeBlock, moveBlock, setTitle,
  searchIndex, searchFullText, actionView, openActions, assigneeList,
  readDraft, writeDraft, clearDraft,
};
