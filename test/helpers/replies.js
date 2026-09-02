'use strict';
// 画面を走らせるときに preload API が返す既定値。
// 実データの形は test/fixtures.js から借りるので、描画経路（.blk/.seg など動的生成）も実際に走る。
const F = require('../fixtures.js');

const HISTORY = [{ id: 'h1', text: 'これはテスト', at: new Date().toISOString(), durationSec: 12 }];

const PAGE = {
  id: 'p1', title: 'デイリースタンドアップ', type: 'standup', createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), memo: 'メモ', durationSec: 900,
  segments: F.STANDUP_SEGMENTS,
  summary: F.STANDUP_SUMMARY_MD,
  blocks: [
    { id: 'b1', type: 'h2', text: '決定事項' },
    { id: 'b2', type: 'li', text: '週次の締めを金曜にする', cite: [0], assignee: '佐藤', due: '2026-09-05' },
    { id: 'b3', type: 'p', text: '本文の段落' },
  ],
};

module.exports = {
  getSettings: {
    hotkey: 'Control+Shift+Space', meetingHotkey: 'Control+Shift+M', theme: 'system',
    localServerExe: 'C:\\x\\whisper.exe', localModelPath: 'C:\\x\\m.bin', vadModelPath: '',
    sumServerExe: '', sumModelPath: '', localThreads: 4, useSystemAudio: false, micId: '',
    stayInTray: false, pillPos: 'bottom', autoSummarize: true, sumCtx: 4096, sumGpuLayers: 0,
  },
  saveSettings: { ok: true },
  testApi: { ok: true, message: 'ok' },
  testSum: { ok: true, message: 'ok' },
  vadStatus: { ready: true, message: '' },
  pickFile: 'C:\\x\\picked.bin',
  appVersion: '0.10.4',
  updateCheck: { ok: true, available: false, version: '0.10.4', url: '' },
  updateApply: { ok: true },
  getHistory: HISTORY, deleteHistory: HISTORY, clearHistory: [],
  pagesSearch: [{ id: 'p1', title: 'デイリースタンドアップ', type: 'standup', updatedAt: new Date().toISOString(), durationSec: 900, hasSummary: true }],
  pagesSearchFull: [{ id: 'p1', title: 'デイリースタンドアップ', type: 'standup', updatedAt: new Date().toISOString(), durationSec: 900, hasSummary: true, hit: '本文' }],
  openActions: [{ pageId: 'p1', pageTitle: 'スタンドアップ', blockId: 'b2', text: 'やること', assignee: '佐藤', due: '2026-09-05' }],
  assigneeList: ['佐藤', '田中'],
  meetingTypes: [{ id: 'standup', label: 'スタンドアップ' }, { id: 'general', label: '一般' }],
  meetingStatus: { active: false, paused: false, startedAt: null, segments: 0 },
  pageGet: { page: PAGE, segments: F.STANDUP_SEGMENTS },
  pageSummarize: { ok: true, page: PAGE },
  pageSetType: PAGE, pageSetTitle: PAGE, pageSetMemo: PAGE, pageDelete: { ok: true },
  blockUpdate: PAGE, blockInsert: PAGE, blockRemove: PAGE, blockMove: PAGE,
  segmentUpdate: { page: PAGE, segments: F.STANDUP_SEGMENTS },
  blockSetAction: { ok: true },
  copy: { ok: true }, toggleRecording: { ok: true }, meetingToggle: { ok: true }, meetingDiscard: { ok: true },
  openDataDir: { ok: true }, openSoundSettings: { ok: true }, openReleases: { ok: true }, restart: { ok: true },
  PAGE, HISTORY,
};
