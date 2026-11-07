/**
 * app-core.js —— 应用核心装配（Q助理开放平台版）
 *
 *  - AuthStore / QzOpenApi / IdeaSync 实例化
 *  - 注册全部 IPC（登录态、扫码授权、灵感笔记同步、图片上传）
 * 供 main.js（真实运行）与 smoke-test.js（集成测试）复用
 *
 * 登录链路：
 *   auth:start → 中转服务 /oauth/start 拿 state + 授权地址 → 内嵌窗口打开授权页
 *              → 用户用 Q助理 App 扫码确认 → 平台回调中转服务 → 主进程轮询 /oauth/poll
 *              → 拿到 access_token / refresh_token → 落盘 → 通知渲染层
 * 永续登录：refresh_token 90 天滚动，运行期每 30 分钟检查，快过期就换新并立即落盘。
 */
'use strict';

const { ipcMain, shell, dialog, BrowserWindow, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { AuthStore } = require('./qz/auth');
const { QzOpenApi } = require('./qz/openapi');
const { IdeaSync } = require('./qz/sync');
const { MediaStore, validateImage } = require('./qz/media');
const { QzCli } = require('./qz/cli');
const { publishNotePage } = require('./qz/notes-page');
const {
  RELAY_BASE_URL,
  QZ_APP_KEY,
  RELAY_CLIENT_PIN,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_POLL_TIMEOUT_MS,
  IMAGE_MAX_COUNT
} = require('./qz/config');

/** 已知数据目录名：flomo-local → idea-note-local → 灵感笔记（应用改名/打包导致 userData 路径变化） */
const KNOWN_DIR_NAMES = ['flomo-local', 'idea-note-local', '灵感笔记'];

function initApp({ authFile, cacheFile, legacyFile, dataDir, apiOverride, qzCliOverride, notesPageOverride }) {
  const authStore = new AuthStore(authFile);
  const loaded = authStore.load();
  let legacyNotice = false;

  if (loaded && loaded.legacy) {
    // 旧版内部接口登录态无法续期到开放平台：备份后要求重新扫码一次
    legacyNotice = true;
    try { fs.renameSync(authFile, authFile + '.legacy-' + Date.now()); } catch (e) { /* noop */ }
  }

  /** 登录态落盘 + 镜像到其它已知数据目录（保证任何入口打开都不用重新登录） */
  function persistAuth(auth) {
    const saved = authStore.save(auth);
    mirrorAuthFile(authFile);
    return saved;
  }

  /** 把 auth.json 镜像到所有已知数据目录 */
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

  const api = apiOverride || new QzOpenApi({
    relayUrl: RELAY_BASE_URL,
    appKey: QZ_APP_KEY,
    clientPin: RELAY_CLIENT_PIN,
    // token 轮换必须立即落盘：否则旧 refresh_token 已失效，会导致掉登录
    onTokens: (auth) => persistAuth(auth)
  });
  if (loaded && !loaded.legacy && loaded.access_token) api.setAuth(loaded);

  const sync = new IdeaSync({ api, cacheFile });
  // 本地图片缓存：平台只给 image_id，不给 URL，本机展示靠这份副本
  const baseDir = dataDir || path.dirname(cacheFile);
  const mediaStore = new MediaStore({
    dir: path.join(baseDir, 'media'),
    indexFile: path.join(baseDir, 'media-index.json')
  });
  // 本机 qz CLI（@ 提及通知用；spawn 子进程，不可用时不阻塞发布）
  // appPath 用于探测应用捆绑的 qzhuliCLI（asar 内 dist/cmd.js，ELECTRON_RUN_AS_NODE 运行）；
  // 开发态（npm start / smoke）app.getAppPath() 即项目根，node --test 不加载本模块。
  const cli = qzCliOverride || new QzCli({
    appPath: (app && typeof app.getAppPath === 'function') ? app.getAppPath() : process.cwd()
  });

  // ---------- 登录态 ----------
  ipcMain.handle('auth:get', () => {
    // 不把 token 回传渲染层；只返回展示信息
    const a = authStore.auth;
    if (!a) return null;
    return {
      q_uid: a.q_uid,
      nickname: a.nickname,
      avatar: a.avatar,
      authorized_at: a.authorized_at
    };
  });
  ipcMain.handle('auth:legacyNotice', () => {
    const v = legacyNotice;
    legacyNotice = false; // 只提示一次
    return v;
  });
  ipcMain.handle('auth:logout', async () => {
    cancelLogin();
    authStore.clear();
    api.setAuth(null);
    if (api.stopKeepAlive) api.stopKeepAlive();
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
    if (err && (err.code === 401 || err.authExpired)) {
      return new Error('[AUTH] ' + (err.message || '登录状态异常'));
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

  // ---------- 扫码授权（内嵌窗口 + 主进程轮询） ----------
  let loginSession = null;
  let authWin = null;

  function notifyAuthEvent(getWindow, payload) {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('auth:event', payload);
  }

  function cancelLogin() {
    if (loginSession && loginSession.timer) clearInterval(loginSession.timer);
    loginSession = null;
    if (authWin && !authWin.isDestroyed()) authWin.destroy();
    authWin = null;
  }

  /** 开始登录：拿 state + 授权地址 → 打开内嵌授权窗口 → 轮询结果 */
  async function startLogin(getWindow) {
    cancelLogin();
    const { state, authorizeUrl } = await api.startLogin();

    const parent = getWindow ? getWindow() : undefined;
    authWin = new BrowserWindow({
      width: 430,
      height: 640,
      title: '使用 Q助理 扫码登录',
      autoHideMenuBar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      parent: parent || undefined,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    authWin.once('ready-to-show', () => { if (authWin) authWin.show(); });
    authWin.loadURL(authorizeUrl);

    const session = { state, timer: null, startedAt: Date.now() };
    loginSession = session;

    session.timer = setInterval(async () => {
      if (!loginSession || loginSession.state !== state) return;
      if (Date.now() - session.startedAt > LOGIN_POLL_TIMEOUT_MS) {
        cancelLogin();
        notifyAuthEvent(getWindow, { type: 'expired', message: '授权超时，请重新发起登录' });
        return;
      }
      try {
        const res = await api.pollLogin(state);
        if (!loginSession || loginSession.state !== state) return;
        if (res.status === 'pending') return;
        if (res.status === 'ok') {
          const savedAuth = await api.acceptLoginResult(res);
          // onTokens 已在真实 api 里落盘；这里用返回值再兜一次，保证注入 mock api 时同样持久化
          if (savedAuth) persistAuth(savedAuth);
          else if (api.auth) persistAuth(api.auth);
          cancelLogin();
          notifyAuthEvent(getWindow, { type: 'success' });
        } else if (res.status === 'error') {
          cancelLogin();
          notifyAuthEvent(getWindow, {
            type: 'error',
            message: res.error === 'access_denied' ? '你已取消授权' : '授权失败，请重试'
          });
        } else {
          cancelLogin();
          notifyAuthEvent(getWindow, { type: 'expired', message: '授权会话已过期，请重新发起登录' });
        }
      } catch (err) {
        // 单次轮询失败不致命（网络抖动），继续等下一次
        console.warn('[auth] 轮询失败: ' + (err && err.message));
      }
    }, LOGIN_POLL_INTERVAL_MS);
    if (session.timer.unref) session.timer.unref();

    return { state };
  }

  /** 注册登录相关 IPC（需要主窗口句柄） */
  function registerAuthIpc(getWindow) {
    ipcMain.handle('auth:start', () => guard(() => startLogin(getWindow)));
    ipcMain.handle('auth:cancel', () => { cancelLogin(); return true; });
  }

  // ---------- 灵感笔记同步（需登录） ----------
  function requireAuth() {
    if (!api.isAuthed) {
      const err = new Error('未登录');
      err.code = 401;
      throw err;
    }
  }
  ipcMain.handle('sync:pull', () => guard(() => { requireAuth(); return sync.pullAll(); }));
  ipcMain.handle('sync:create', (_e, text, imageIds) => guard(() => { requireAuth(); return sync.createFromText(text, imageIds); }));
  ipcMain.handle('sync:update', (_e, id, text, imageIds) => guard(() => { requireAuth(); return sync.update(id, text, imageIds); }));
  ipcMain.handle('sync:delete', (_e, id) => guard(() => { requireAuth(); return sync.remove(id); }));
  ipcMain.handle('sync:trash', () => guard(() => { requireAuth(); return sync.pullTrash(); }));
  ipcMain.handle('sync:restore', (_e, id) => guard(() => { requireAuth(); return sync.restore(id); }));
  ipcMain.handle('sync:cache', () => sync.loadCache());

  // 旧本地数据一次性导入（登录后可用）
  ipcMain.handle('sync:importLegacy', () => guard(async () => {
    requireAuth();
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
    if (!legacyFile || !fs.existsSync(legacyFile)) return false;
    try {
      const memos = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      return Array.isArray(memos) && memos.length > 0;
    } catch (e) {
      return false;
    }
  });

  // ---------- 图片上传（申请凭证 → 客户端直传七牛 → 拿 image_id） ----------
  // 多选：返回文件绝对路径数组；用户取消返回空数组
  ipcMain.handle('dialog:openImages', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
    });
    if (result.canceled || !Array.isArray(result.filePaths)) return [];
    return result.filePaths.slice(0, IMAGE_MAX_COUNT);
  });

  // 单张上传：校验 → 申请凭证 → 直传七牛 → 本地缓存原图（供本机展示）
  ipcMain.handle('media:upload', (_e, filePath) => guard(async () => {
    requireAuth();
    if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
      throw new Error('图片文件不存在或已被移动');
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('请选择图片文件');
    const { mime, ext } = validateImage(filePath, stat.size);

    // 1. 申请上传凭证（返回 image_id，是后续写入笔记的唯一凭据）
    const ticket = await api.requestUpload({ mime_type: mime, size: stat.size });
    if (!ticket || !ticket.upload_url || !ticket.token || !ticket.image_id) {
      throw new Error('获取图片上传凭证失败');
    }

    // 2. 直传七牛（不要传 key，也不要手动设置 Content-Type）
    const form = new FormData();
    form.append('token', ticket.token);
    form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    let res;
    try {
      res = await fetch(ticket.upload_url, { method: 'POST', body: form });
    } catch (err) {
      throw new Error('图片上传网络失败，请检查网络后重试');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.image_id !== ticket.image_id) {
      throw new Error('图片上传失败' + (data && data.error ? ': ' + data.error : ''));
    }

    // 3. 本机留一份原图：平台不返回图片 URL，桌面端要靠这份副本展示
    let fileName = '';
    let url = '';
    try {
      fileName = mediaStore.save(ticket.image_id, filePath, ext);
      const saved = mediaStore.filePath(fileName);
      if (saved) url = pathToFileURL(saved).toString();
    } catch (err) {
      // 缓存失败不影响笔记写入（服务端已收到图片），只是本机看不到缩略图
      console.warn('[media] 本地缓存失败: ' + ((err && err.message) || err));
    }
    return { imageId: ticket.image_id, fileName, url };
  }));

  // 本地图片映射：image_id -> file:// 绝对地址（渲染层直接给 <img src>）
  // 平台不返回图片 URL，本机副本是唯一可展示来源；文件被清理时 img 会 onerror 降级为占位
  ipcMain.handle('media:index', () => {
    const map = mediaStore.map();
    const out = {};
    for (const id of Object.keys(map)) {
      const p = mediaStore.filePath(map[id]);
      if (p) out[id] = pathToFileURL(p).toString();
    }
    return out;
  });

  // ---------- 其它 ----------
  ipcMain.handle('app:getDataPath', () => path.join(dataDir, 'idea-cache.json'));
  ipcMain.handle('app:openDataPath', () => shell.openPath(dataDir));

  // 桌面小组件：把某条笔记推送到桌面小组件（写入 widget.json，原生宿主 App 监听后刷新 WidgetKit）
  ipcMain.handle('widget:push', (_e, memo) => {
    const widgetFile = path.join(dataDir, 'widget.json');
    const payload = {
      updatedAt: Date.now(),
      memo: {
        id: String((memo && memo.id) || ''),
        content: String((memo && memo.content) || ''),
        createdAt: String((memo && memo.createdAt) || ''),
        tags: Array.isArray(memo && memo.tags) ? memo.tags.map(String) : []
      }
    };
    fs.writeFileSync(widgetFile, JSON.stringify(payload, null, 2), 'utf-8');
    return { ok: true, path: widgetFile };
  });

  // ---------- @ 提及通知（本机 qz CLI；不可用/失败不阻塞发布） ----------
  // 联系人列表：@ 联想下拉的数据源（qz friend list）
  ipcMain.handle('mentions:contacts', () => guard(async () => {
    const av = await cli.isAvailable();
    if (!av.ok) return { ok: false, error: av.message || 'qz CLI 不可用' };
    return { ok: true, contacts: await cli.listContacts() };
  }));
  // 发布后通知 @ 的联系人：解析正文 @昵称 → 匹配联系人 → 逐人发私信
  // 通知内容附上网站分享页链接（先生成分享页；失败则降级为不带链接的普通通知）
  ipcMain.handle('mentions:notify', (_e, text) => guard(async () => {
    const sender = (authStore.auth && authStore.auth.nickname) || '';
    const avatar = (authStore.auth && authStore.auth.avatar) || '';
    let pageUrl = '';
    try {
      // 测试可注入 notesPageOverride 拦截真实发布；默认走 qz/notes-page.js
      const pub = notesPageOverride || publishNotePage;
      pageUrl = await pub({ text, author: sender, avatar }) || '';
    } catch (err) {
      console.warn('[mentions] 生成分享页失败，本次通知不带链接: ' + ((err && err.message) || err));
    }
    return cli.notifyMentions(text, sender, pageUrl);
  }));

  // 后台保鲜：每 30 分钟检查，access_token 快过期或 refresh_token 需滚动时自动续期
  if (typeof api.startKeepAlive === 'function') api.startKeepAlive();
  // 启动即尝试续期一次（失败不影响使用，界面按缓存展示，绝不因此登出）
  if (api.isAuthed && typeof api.ensureFresh === 'function') {
    api.ensureFresh().catch((err) => console.warn('[auth] 启动续期失败: ' + (err && err.message)));
  }

  return { authStore, api, sync, registerAuthIpc, cancelLogin };
}

module.exports = { initApp };
