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

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('store: read failed', file, e.message);
  }
  return fallback;
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

function init(userDataPath) {
  ROOT = path.join(userDataPath, 'data');
  const d = dirs();
  fs.mkdirSync(d.pages, { recursive: true });
  fs.mkdirSync(d.transcripts, { recursive: true });
  index = readJson(d.indexFile, { version: 2, pages: [] });
  if (!index || !Array.isArray(index.pages)) index = { version: 2, pages: [] };
  return ROOT;
}

// ---------------------------------------------------------------- インデックス
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
  return page;
}

function getTranscript(id) {
  const t = readJson(transcriptFile(id), null);
  return t && Array.isArray(t.segments) ? t.segments : [];
}

function savePage(page) {
  page.updatedAt = new Date().toISOString();
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
    date: date || now.slice(0, 10),
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

function deletePage(id) {
  for (const f of [pageFile(id), transcriptFile(id)]) {
    try { fs.unlinkSync(f); } catch (_) { /* noop */ }
  }
  index.pages = index.pages.filter((p) => p.id !== id);
  writeJson(dirs().indexFile, index);
  return index.pages;
}

// ---------------------------------------------------------------- ブロック編集
function updateBlock(pageId, blockId, patch) {
  const page = getPage(pageId);
  if (!page) return null;
  const b = page.blocks.find((x) => x.id === blockId);
  if (!b) return null;
  if (typeof patch.text === 'string') b.text = patch.text;
  if (typeof patch.checked === 'boolean') b.checked = patch.checked;
  if (typeof patch.type === 'string') b.type = patch.type;
  return savePage(page);
}

function insertBlock(pageId, afterBlockId, type) {
  const page = getPage(pageId);
  if (!page) return null;
  const block = { id: newId('b'), type: type || 'bullet', text: '', cites: [] };
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
// 一覧（タイトル・要約プレビュー）の絞り込みは同期・即時
function searchIndex(query) {
  const q = query.trim();
  if (!q) return index.pages;
  return index.pages.filter(
    (p) => p.title.includes(q) || (p.preview && p.preview.includes(q)),
  );
}

// 全文検索は文字起こしファイルを走査する（件数が増えると重いので呼び出し側で明示実行）
function searchFullText(query, limit) {
  const q = query.trim();
  if (!q) return [];
  const hits = [];
  for (const entry of index.pages) {
    if (hits.length >= (limit || 50)) break;
    const page = getPage(entry.id);
    if (!page) continue;
    const inBlocks = page.blocks.filter((b) => b.text && b.text.includes(q));
    const segments = getTranscript(entry.id);
    const inSegments = segments.filter((s) => s.text && s.text.includes(q));
    if (inBlocks.length === 0 && inSegments.length === 0) continue;
    hits.push({
      ...entry,
      blockHits: inBlocks.length,
      segmentHits: inSegments.length,
      snippet: (inBlocks[0] && inBlocks[0].text) || (inSegments[0] && inSegments[0].text) || '',
    });
  }
  return hits;
}

// 全ページ横断の未完了アクションアイテム
function openActions() {
  const out = [];
  for (const entry of index.pages) {
    if (!entry.actionCount) continue;
    const page = getPage(entry.id);
    if (!page) continue;
    for (const b of page.blocks) {
      if (b.type === 'todo' && !b.checked && b.text) {
        out.push({
          pageId: page.id, blockId: b.id, pageTitle: page.title, date: page.date,
          text: b.text, assignee: b.assignee || '', due: b.due || '',
          dueRaw: b.dueRaw || '', dueApprox: Boolean(b.dueApprox),
        });
      }
    }
  }
  // 期限が近い順。期限なしは末尾へ回す（無期限を先頭に出しても行動につながらない）
  out.sort((a, b) => {
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return String(b.date).localeCompare(String(a.date));
  });
  return out;
}

// 未完了アクションに登場する担当者の一覧（絞り込み用）
function assigneeList() {
  const counts = new Map();
  for (const a of openActions()) {
    if (!a.assignee) continue;
    counts.set(a.assignee, (counts.get(a.assignee) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count);
}

// ---------------------------------------------------------------- 進行中ドラフト
const readDraft = () => readJson(dirs().draftFile, null);
const writeDraft = (d) => writeJson(dirs().draftFile, d);
function clearDraft() {
  try { fs.unlinkSync(dirs().draftFile); } catch (_) { /* noop */ }
}

module.exports = {
  init, newId,
  listPages, getPage, getTranscript, savePage, saveTranscript,
  createPage, deletePage,
  updateBlock, insertBlock, removeBlock, moveBlock, setTitle,
  searchIndex, searchFullText, openActions, assigneeList,
  readDraft, writeDraft, clearDraft,
};
