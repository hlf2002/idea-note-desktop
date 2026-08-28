/**
 * app-core.js —— 应用核心装配
 *  - AuthStore / QzApi / IdeaSync 实例化
 *  - 注册全部 IPC（登录态、扫码、灵感笔记同步）
 * 供 main.js（真实运行）与 smoke-test.js（集成测试）复用
 */
'use strict';

const { ipcMain, shell } = require('electron');
const path = require('path');
const QRCode = require('qrcode');
const { AuthStore } = require('./qz/auth');
const { QzApi } = require('./qz/api');
const { IdeaSync } = require('./qz/sync');
const { API_CLIENT_TYPE_PC } = require('./qz/config');

function initApp({ authFile, cacheFile, legacyFile, dataDir, apiOverride }) {
  const authStore = new AuthStore(authFile);
  const auth = authStore.load();

  const api = apiOverride || new QzApi();
  if (auth) api.setAuth(auth);

  const sync = new IdeaSync({ api, cacheFile });

  // ---------- 登录态 ----------
  ipcMain.handle('auth:get', () => {
    // 不把 token 完整回传（避免渲染层冗余）；返回展示信息 + 是否已登录
    const a = authStore.auth;
    if (!a) return null;
    return { uid: a.uid, nickname: a.nickname, avatar: a.avatar, cid: a.cid, id: a.id };
  });
  ipcMain.handle('auth:logout', () => {
    authStore.clear();
    api.setAuth(null);
    return true;
  });

  // ---------- 扫码登录 ----------
  ipcMain.handle('qr:create', async () => {
    const data = await api.qrLoginCreate(API_CLIENT_TYPE_PC);
    // 关键：二维码内容必须是登录创建响应的完整 JSON（Q助理 app 扫一扫解析 JSON 提取 scene_id）
    // 参考 q-flow 实现：qr_str = JSON.stringify(data)，而非纯 scene_id
    const qrContent = JSON.stringify(data);
    const qrDataUrl = await QRCode.toDataURL(qrContent, { width: 240, margin: 1 });
    console.log('[qr] 会话创建 scene_id=' + data.scene_id + ' expires=' + data.expires_in + ' 二维码内容=' + qrContent);
    return { sceneId: data.scene_id, qrDataUrl, expiresIn: data.expires_in, qrContent };
  });
  ipcMain.handle('qr:status', async (_e, sceneId) => {
    const data = await api.qrLoginStatus(sceneId);
    console.log('[qr] 轮询 scene_id=' + sceneId + ' -> status=' + (data && data.status));
    if (data && data.status === 'confirmed' && data.login_data) {
      // 仅一次：直接持久化登录态
      const login = data.login_data;
      console.log('[qr] 登录确认 uid=' + login.uid + ' nickname=' + (login.nickname || ''));
      const saved = authStore.save({
        id: login.id,
        uid: login.uid,
        cid: login.cid,
        nickname: login.nickname || '',
        realName: login.real_name || '',
        avatar: login.avatar || '',
        token: login.token,
        tk: login.tk || ''
      });
      api.setAuth(saved);
    }
    return data;
  });

  // ---------- 灵感笔记同步（需登录） ----------
  function requireAuth() {
    if (!api.isAuthed) {
      const err = new Error('未登录');
      err.code = 401;
      throw err;
    }
  }
  ipcMain.handle('sync:pull', async () => {
    requireAuth();
    return sync.pullAll();
  });
  ipcMain.handle('sync:create', async (_e, text) => {
    requireAuth();
    return sync.createFromText(text);
  });
  ipcMain.handle('sync:update', async (_e, id, text) => {
    requireAuth();
    return sync.update(id, text);
  });
  ipcMain.handle('sync:delete', async (_e, id) => {
    requireAuth();
    return sync.remove(id);
  });
  ipcMain.handle('sync:cache', () => sync.loadCache());

  // 旧本地数据一次性导入（登录后可用）
  ipcMain.handle('sync:importLegacy', async () => {
    requireAuth();
    const fs = require('fs');
    if (!legacyFile || !fs.existsSync(legacyFile)) return { imported: 0, skipped: true };
    const raw = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
    const memos = Array.isArray(raw) ? raw : [];
    let imported = 0;
    for (const m of memos) {
      if (!m || typeof m.content !== 'string' || !m.content.trim()) continue;
      await sync.createFromText(m.content);
      imported++;
    }
    if (imported > 0) {
      // 备份旧文件，避免重复导入
      fs.renameSync(legacyFile, legacyFile + '.imported-' + Date.now());
    }
    return { imported };
  });
  ipcMain.handle('sync:hasLegacy', () => {
    const fs = require('fs');
    if (!legacyFile || !fs.existsSync(legacyFile)) return false;
    try {
      const memos = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      return Array.isArray(memos) && memos.length > 0;
    } catch (e) {
      return false;
    }
  });

  // ---------- 其它 ----------
  ipcMain.handle('app:getDataPath', () => path.join(dataDir, 'idea-cache.json'));
  ipcMain.handle('app:openDataPath', () => shell.openPath(dataDir));

  return { authStore, api, sync };
}

module.exports = { initApp };
