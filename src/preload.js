'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// オーバーレイ（録音ピル）
contextBridge.exposeInMainWorld('koeOverlay', {
  onStart: (cb) => ipcRenderer.on('overlay:start', (_e, p) => cb(p)),
  onStop: (cb) => ipcRenderer.on('overlay:stop', (_e, p) => cb(p)),
  onCancel: (cb) => ipcRenderer.on('overlay:cancel', (_e, p) => cb(p)),
  onPhase: (cb) => ipcRenderer.on('overlay:phase', (_e, p) => cb(p)),
  sendAudio: (buffer, mimeType, durationMs) => ipcRenderer.send('audio:done', { buffer, mimeType, durationMs }),
  sendSegment: (buffer, durationMs, final) => ipcRenderer.send('audio:segment', { buffer, durationMs, final }),
  sendError: (message) => ipcRenderer.send('audio:error', { message }),
  confirmStop: () => ipcRenderer.send('overlay:confirm'),
  requestCancel: () => ipcRenderer.send('overlay:cancel-request'),
  requestHide: () => ipcRenderer.send('overlay:hidden-request'),
});

// メインウィンドウ（ノート）
contextBridge.exposeInMainWorld('koeApp', {
  // 設定
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  testApi: () => ipcRenderer.invoke('app:test'),
  testSum: () => ipcRenderer.invoke('app:test-sum'),
  vadStatus: () => ipcRenderer.invoke('app:vad-status'),
  pickFile: (kind) => ipcRenderer.invoke('dialog:pick', kind),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  openReleases: () => ipcRenderer.invoke('app:open-releases'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: (url) => ipcRenderer.invoke('update:apply', url),
  restart: () => ipcRenderer.invoke('app:restart'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, r) => cb(r)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),

  // 音声入力
  getHistory: () => ipcRenderer.invoke('history:get'),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  toggleRecording: () => ipcRenderer.invoke('app:toggle-recording'),

  // ページ（議事録）
  pagesList: () => ipcRenderer.invoke('pages:list'),
  pagesSearch: (q) => ipcRenderer.invoke('pages:search', q),
  pagesSearchFull: (q) => ipcRenderer.invoke('pages:searchFull', q),
  openActions: () => ipcRenderer.invoke('pages:openActions'),
  assigneeList: () => ipcRenderer.invoke('pages:assignees'),
  meetingTypes: () => ipcRenderer.invoke('meta:types'),
  pageSetType: (id, type) => ipcRenderer.invoke('page:setType', { id, type }),
  blockSetAction: (pageId, blockId, assignee, dueRaw) => ipcRenderer.invoke('block:setAction', { pageId, blockId, assignee, dueRaw }),
  pageGet: (id) => ipcRenderer.invoke('page:get', id),
  pageDelete: (id) => ipcRenderer.invoke('page:delete', id),
  pageSetTitle: (id, title) => ipcRenderer.invoke('page:setTitle', { id, title }),
  pageSetMemo: (id, memo) => ipcRenderer.invoke('page:setMemo', { id, memo }),
  pageSummarize: (id) => ipcRenderer.invoke('page:summarize', id),
  pageExport: (id) => ipcRenderer.invoke('page:export', id),
  blockUpdate: (pageId, blockId, patch) => ipcRenderer.invoke('block:update', { pageId, blockId, patch }),
  blockInsert: (pageId, afterBlockId, type) => ipcRenderer.invoke('block:insert', { pageId, afterBlockId, type }),
  blockRemove: (pageId, blockId) => ipcRenderer.invoke('block:remove', { pageId, blockId }),

  // 議事録セッション
  meetingToggle: () => ipcRenderer.invoke('meeting:toggle'),
  meetingDiscard: () => ipcRenderer.invoke('meeting:discard'),
  meetingStatus: () => ipcRenderer.invoke('meeting:status'),
  meetingSetMemo: (memo) => ipcRenderer.invoke('meeting:set-memo', memo),

  // イベント
  onHistoryUpdated: (cb) => ipcRenderer.on('history:updated', (_e, h) => cb(h)),
  onNotice: (cb) => ipcRenderer.on('app:notice', (_e, m) => cb(m)),
  onMeetingUpdate: (cb) => ipcRenderer.on('meeting:update', (_e, s) => cb(s)),
  onMeetingProgress: (cb) => ipcRenderer.on('meeting:progress', (_e, p) => cb(p)),
  onPagesUpdated: (cb) => ipcRenderer.on('pages:updated', (_e, p) => cb(p)),
  onPageOpen: (cb) => ipcRenderer.on('page:open', (_e, id) => cb(id)),
  onPageUpdated: (cb) => ipcRenderer.on('page:updated', (_e, p) => cb(p)),
});
