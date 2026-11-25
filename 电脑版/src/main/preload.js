'use strict'
// 给界面用的 API（contextIsolation，界面拿不到 Node）
const { contextBridge, ipcRenderer } = require('electron')

const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a)
const on = ch => fn => { const l = (_e, p) => fn(p); ipcRenderer.on(ch, l); return () => ipcRenderer.removeListener(ch, l) }

contextBridge.exposeInMainWorld('shiying', {
  init: () => inv('init'),
  clipboard: () => inv('clipboard'),
  detect: t => inv('detect', t),
  parse: t => inv('parse', t),
  cancelParse: () => inv('parse-cancel'),
  cover: (u, p, r) => inv('cover', u, p, r),
  download: (post, q) => inv('download', post, q),
  cancel: k => inv('cancel', k),
  history: () => inv('history'),
  historyRemove: k => inv('history-remove', k),
  historyClear: () => inv('history-clear'),
  openFile: f => inv('open-file', f),
  showFile: f => inv('show-file', f),
  openSaveDir: () => inv('open-save-dir'),
  chooseSaveDir: () => inv('choose-save-dir'),
  setQuality: q => inv('set-quality', q),
  setSetting: (k, v) => inv('set-setting', k, v),
  copyText: t => inv('copy-text', t),
  openUrl: u => inv('open-url', u),
  engineSetup: () => inv('engine-setup'),
  engineUpdate: () => inv('engine-update'),
  engineInfo: () => inv('engine-info'),
  openDataDir: () => inv('open-data-dir'),
  diagCopy: () => inv('diag-copy'),
  loginStatus: () => inv('login-status'),
  loginOpen: n => inv('login-open', n),
  loginLogout: n => inv('login-logout', n),
  loginLogoutAll: () => inv('login-logout-all'),
  loginImport: n => inv('login-import', n),
  notice: () => inv('notice'),
  onParseLog: on('parse-log'),
  onJob: on('job'),
  onSetup: on('setup'),
  onHistoryChanged: on('history-changed'),
  onFocus: on('focus'),
})
