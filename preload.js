/**
 * preload.js —— 通过 contextBridge 安全暴露能力给渲染进程
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ideaNote', {
  // 登录态
  auth: {
    get: () => ipcRenderer.invoke('auth:get'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    // 打开授权窗口并开始轮询（结果由主进程通过 onEvent 推送）
    start: () => ipcRenderer.invoke('auth:start'),
    cancel: () => ipcRenderer.invoke('auth:cancel'),
    probe: () => ipcRenderer.invoke('auth:probe'),
    // 旧版内部接口登录态无法迁移时的提示（只返回一次 true）
    legacyNotice: () => ipcRenderer.invoke('auth:legacyNotice'),
    // 订阅登录事件：{ type: 'success'|'error'|'expired', message? }
    onEvent: (cb) => {
      ipcRenderer.on('auth:event', (_e, payload) => cb(payload));
    }
  },
  // 灵感笔记同步
  sync: {
    pull: () => ipcRenderer.invoke('sync:pull'),
    create: (text, imageIds) => ipcRenderer.invoke('sync:create', text, imageIds),
    update: (id, text, imageIds) => ipcRenderer.invoke('sync:update', id, text, imageIds),
    remove: (id) => ipcRenderer.invoke('sync:delete', id),
    trash: () => ipcRenderer.invoke('sync:trash'),
    restore: (id) => ipcRenderer.invoke('sync:restore', id),
    cache: () => ipcRenderer.invoke('sync:cache'),
    importLegacy: () => ipcRenderer.invoke('sync:importLegacy'),
    hasLegacy: () => ipcRenderer.invoke('sync:hasLegacy')
  },
  // 图片：选图 → 上传 → 本地映射（平台只给 image_id，本机展示靠本地缓存）
  media: {
    choose: () => ipcRenderer.invoke('dialog:openImages'),
    upload: (filePath) => ipcRenderer.invoke('media:upload', filePath),
    index: () => ipcRenderer.invoke('media:index')
  },
  // 桌面小组件：推送某条笔记内容到桌面小组件
  widget: {
    push: (memo) => ipcRenderer.invoke('widget:push', memo)
  },
  // @ 提及通知：本机 qz CLI 联系人 + 发布后通知
  mentions: {
    contacts: () => ipcRenderer.invoke('mentions:contacts'),
    notify: (text, ideaId) => ipcRenderer.invoke('mentions:notify', text, ideaId)
  },
  // 应用
  app: {
    getDataPath: () => ipcRenderer.invoke('app:getDataPath'),
    openDataPath: () => ipcRenderer.invoke('app:openDataPath'),
    // 全局快捷键/托盘唤起时，聚焦输入框
    onFocusInput: (cb) => {
      ipcRenderer.on('app:focus-input', () => cb());
    }
  },
  // 自动化升级
  updater: {
    getInfo: () => ipcRenderer.invoke('updater:getInfo'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
    // 订阅升级事件：{ event, ...payload }，event ∈ checking/available/not-available/downloading/downloaded/error
    onStatus: (cb) => {
      ipcRenderer.on('updater:event', (_e, payload) => cb(payload));
    }
  }
});
