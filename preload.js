// ============================================================
// preload.js — 安全桥接主进程能力给渲染层
// ============================================================
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  onState: (cb) => ipcRenderer.on('pet:state', (_e, st) => cb(st)),
  onConfigUpdated: (cb) => ipcRenderer.on('pet:config', (_e, cfg) => cb(cfg)),
  getPos: () => ipcRenderer.invoke('pet:getpos'),
  moveTo: (x, y) => ipcRenderer.send('pet:move', { x, y }),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', { ignore }),
  showMenu: (info) => ipcRenderer.send('pet:contextmenu', info),
  setTheme: (theme) => ipcRenderer.send('pet:set-theme', theme),
  getConfig: () => ipcRenderer.invoke('pet:getconfig'),
  // B 方向：最近活动时间线
  getTimeline: () => ipcRenderer.invoke('pet:timeline'),
  // C 方向：提醒
  addReminder: (minutes, text) => ipcRenderer.invoke('pet:remind-add', { minutes, text }),
  listReminders: () => ipcRenderer.invoke('pet:remind-list'),
  cancelReminder: (id) => ipcRenderer.invoke('pet:remind-cancel', id),
  clearReminders: () => ipcRenderer.invoke('pet:remind-clear'),
  onReminder: (cb) => ipcRenderer.on('pet:reminder', (_e, r) => cb(r)),
  onReminderToast: (cb) => ipcRenderer.on('pet:reminder-toast', (_e, t) => cb(t)),
  onAskReminder: (cb) => ipcRenderer.on('pet:askreminder', () => cb()),
  onOpenPanel: (cb) => ipcRenderer.on('pet:openpanel', () => cb()),
  setPanelOpen: (open) => ipcRenderer.send('pet:panel-set', open)
});
