/**
 * preload.js —— 通过 contextBridge 安全暴露能力给渲染进程
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flomo', {
  // 登录态
  auth: {
    get: () => ipcRenderer.invoke('auth:get'),
    logout: () => ipcRenderer.invoke('auth:logout')
  },
  // 扫码登录
  qr: {
    create: () => ipcRenderer.invoke('qr:create'),
    status: (sceneId) => ipcRenderer.invoke('qr:status', sceneId)
  },
  // 灵感笔记同步
  sync: {
    pull: () => ipcRenderer.invoke('sync:pull'),
    create: (text) => ipcRenderer.invoke('sync:create', text),
    update: (id, text) => ipcRenderer.invoke('sync:update', id, text),
    remove: (id) => ipcRenderer.invoke('sync:delete', id),
    cache: () => ipcRenderer.invoke('sync:cache'),
    importLegacy: () => ipcRenderer.invoke('sync:importLegacy'),
    hasLegacy: () => ipcRenderer.invoke('sync:hasLegacy')
  },
  // 应用
  app: {
    getDataPath: () => ipcRenderer.invoke('app:getDataPath'),
    openDataPath: () => ipcRenderer.invoke('app:openDataPath'),
    // 全局快捷键/托盘唤起时，聚焦输入框
    onFocusInput: (cb) => {
      ipcRenderer.on('app:focus-input', () => cb());
    }
  }
});
