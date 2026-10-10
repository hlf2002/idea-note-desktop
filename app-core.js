/**
 * app-core.js —— 应用核心装配
 *  - AuthStore / QzApi / IdeaSync 实例化
 *  - 注册全部 IPC（登录态、扫码、灵感笔记同步）
 * 供 main.js（真实运行）与 smoke-test.js（集成测试）复用
 */
'use strict';

const { ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

  // 已知数据目录名：flomo-local → idea-note-local → 灵感笔记（应用改名/打包导致 userData 路径变化）
  const KNOWN_DIR_NAMES = ['flomo-local', 'idea-note-local', '灵感笔记'];

  /** 登录成功后把 auth.json 镜像到所有已知数据目录，保证任何入口打开都不需要重新登录 */
  function mirrorAuthFile(authFilePath) {
    const base = path.dirname(authFilePath);
    // 仅当当前数据目录是已知目录名时才镜像（临时测试目录等不处理）
    if (!KNOWN_DIR_NAMES.includes(path.basename(base))) return;
    const appData = path.dirname(base); // .../Application Support
    for (const name of KNOWN_DIR_NAMES) {
      const d = path.join(appData, name);
      if (d === base) continue;
      try {
        fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(authFilePath, path.join(d, 'auth.json'));
        console.log('[idea-note-local] 登录态已镜像: ' + d);
      } catch (e) {
        console.warn('[idea-note-local] 登录态镜像失败 (' + d + '): ' + e.message);
      }
    }
  }

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
    api.stopH5KeepAlive && api.stopH5KeepAlive();
    return true;
  });
  // 鉴权探测：判断当前持久化登录态是否还能通过服务端校验（不破坏登录态）
  ipcMain.handle('auth:probe', async () => {
    if (typeof api.probeAuth !== 'function') return { ok: !!api.isAuthed, reason: 'unsupported' };
    return api.probeAuth();
  });

  // ---------- IPC 错误透传 ----------
  // Electron IPC 序列化错误时只保留 message（自定义 code 属性会丢失），
  // 因此鉴权类错误统一用 [AUTH] 前缀标记，渲染层据此识别而不会误判/强制登出。
  function toRendererError(err) {
    if (err && err.code === 401) {
      const e = new Error('[AUTH] ' + (err.message || '登录状态异常'));
      e.code = undefined;
      return e;
    }
    return err;
  }
  async function guard(fn) {
    try {
      return await fn();
    } catch (err) {
      throw toRendererError(err);
    }
  }

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
      // 登录成功后把登录态镜像到其它已知数据目录，避免换应用入口（打包版/开发版）后要求重新登录
      mirrorAuthFile(authFile);
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
  ipcMain.handle('sync:pull', () => guard(() => { requireAuth(); return sync.pullAll(); }));
  ipcMain.handle('sync:create', (_e, text) => guard(() => { requireAuth(); return sync.createFromText(text); }));
  ipcMain.handle('sync:update', (_e, id, text) => guard(() => { requireAuth(); return sync.update(id, text); }));
  ipcMain.handle('sync:delete', (_e, id) => guard(() => { requireAuth(); return sync.remove(id); }));
  ipcMain.handle('sync:cache', () => sync.loadCache());

  // 旧本地数据一次性导入（登录后可用）
  ipcMain.handle('sync:importLegacy', () => guard(async () => {
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
  }));
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

  // ---------- 七牛图片上传 ----------
  ipcMain.handle('dialog:openImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('qiniu:upload', (_e, filePath) => guard(async () => {
    requireAuth();
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('文件不存在');
    }
    // 1. 获取七牛上传凭证
    const cred = await api.getQiniuUploadToken();
    if (!cred || !cred.token) throw new Error('获取七牛上传凭证失败');

    // 2. 生成 key：idea_note/YYYY_MM_DD/random20.ext
    const ext = (path.extname(filePath) || '.jpg').toLowerCase();
    const now = new Date();
    const dateStr = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}_${String(now.getDate()).padStart(2, '0')}`;
    const random = crypto.randomBytes(10).toString('hex');
    const key = `idea_note/${dateStr}/${random}${ext}`;

    // 3. 表单上传到七牛（华东 bucket qzhuli）
    const form = new FormData();
    form.append('token', cred.token);
    form.append('key', key);
    const fileBuffer = fs.readFileSync(filePath);
    form.append('file', new Blob([fileBuffer]), path.basename(filePath));

    const res = await fetch('https://upload.qiniup.com', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || !data.key) {
      throw new Error('七牛上传失败: ' + (data && data.error ? data.error : JSON.stringify(data)));
    }

    const domain = cred.domain.endsWith('/') ? cred.domain : cred.domain + '/';
    return { url: domain + data.key, key: data.key, domain: cred.domain };
  }));

  // ---------- 其它 ----------
  ipcMain.handle('app:getDataPath', () => path.join(dataDir, 'idea-cache.json'));
  ipcMain.handle('app:openDataPath', () => shell.openPath(dataDir));

  // 后台保鲜：应用运行期间每 12h 主动刷新一次 Vue H5 token，保持同步随时可用
  if (typeof api.startH5KeepAlive === 'function') {
    api.startH5KeepAlive();
  }

  return { authStore, api, sync };
}

module.exports = { initApp };
