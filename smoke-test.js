/**
 * smoke-test.js —— Electron 集成冒烟测试（Q助理开放平台登录 + 灵感笔记同步，mock API）
 * 用注入的 mock QzOpenApi 验证完整链路：
 *   开始授权 -> 轮询 ok -> 登录态持久化 -> 渲染层自动进入主视图
 *   -> 拉取灵感笔记 -> 渲染卡片 -> 增删改查
 * 运行：npx electron smoke-test.js
 * 退出码：0 = 通过，1 = 失败
 * 产物：screenshot.png（登录后界面预览）
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { initApp } = require('./app-core');
const { registerWindowControls } = require('./window-controls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-note-smoke-'));
app.setPath('userData', tmpDir); // 独立数据目录，不污染真实数据

// 1x1 透明 PNG：冒烟用的真实图片文件（走真实的 FormData 上传链路）
const SMOKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const smokeImagePath = path.join(tmpDir, 'smoke-upload.png');
fs.writeFileSync(smokeImagePath, SMOKE_PNG);

// 本地假七牛：接收 FormData 上传，回显 image_id（与 requestUpload 的凭证一致）
const uploadServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ image_id: 'img_uploaded', key: 'idea_note/smoke.png' }));
  });
});
let uploadPort = 0;

// ---- mock QzOpenApi（模拟开放平台 + 中转服务） ----
function makeMockApi() {
  let auth = null;
  const now = Math.floor(Date.now() / 1000);
  const store = [
    { id: 2, plain_text: '今天第一条 **重点** #生活', tags: ['生活'], create_time: now - 3600, update_time: now - 3600, images: [], image_url: '' },
    { id: 1, plain_text: '昨天旧笔记 #灵感', tags: ['灵感'], create_time: now - 86400 - 3600, update_time: now - 86400 - 3600, images: ['img_mock_1', 'img_mock_no_url'], image_url: 'https://res.qzhuli.com/test/note-1.jpg' }
  ];
  let nextId = 100;
  return {
    get isAuthed() { return !!auth; },
    setAuth(a) { auth = a; },
    async startLogin() { return { state: 'st_smoke_1234567890', authorizeUrl: 'about:blank' }; },
    async pollLogin() {
      return {
        status: 'ok',
        q_uid: 'q10001',
        nickname: '测试用户',
        avatar: '',
        access_token: 'ou_smoke',
        refresh_token: 'or_smoke',
        expires_in: 7200,
        refresh_expires_in: 7776000
      };
    },
    async acceptLoginResult(r) {
      auth = {
        q_uid: r.q_uid,
        nickname: r.nickname,
        avatar: r.avatar || '',
        access_token: r.access_token,
        refresh_token: r.refresh_token,
        expires_at: Date.now() + 7200 * 1000,
        refresh_expires_at: Date.now() + 7776000 * 1000,
        authorized_at: Date.now()
      };
      return auth;
    },
    async ensureFresh() { return auth; },
    async probeAuth() { return { ok: !!auth }; },
    startKeepAlive() {},
    stopKeepAlive() {},
    async listNotes({ page }) {
      if (page === 1) return { list: store.slice(), has_more: false };
      return { list: [], has_more: false };
    },
    async getNote(id) {
      const item = store.find((s) => String(s.id) === String(id));
      return item || null;
    },
    async createNote({ content_json, images }) {
      const item = {
        id: nextId++,
        plain_text: (content_json && content_json.__plain) || '新增 #测试',
        tags: ['测试'],
        create_time: now,
        update_time: now,
        images: Array.isArray(images) ? images : [],
        image_url: ''
      };
      store.push(item);
      return item;
    },
    async updateNote({ id, content_json, images }) {
      const idx = store.findIndex((s) => String(s.id) === String(id));
      const item = {
        id: Number(id),
        plain_text: (content_json && content_json.__plain) || '已改 #改过',
        tags: ['改过'],
        create_time: idx >= 0 ? store[idx].create_time : now,
        update_time: now,
        images: Array.isArray(images) ? images : [],
        image_url: ''
      };
      if (idx >= 0) store[idx] = item; else store.push(item);
      return item;
    },
    async deleteNote(id) {
      const idx = store.findIndex((s) => String(s.id) === String(id));
      if (idx >= 0) store.splice(idx, 1);
      return [];
    },
    async requestUpload() {
      return {
        image_id: 'img_uploaded',
        upload_url: 'http://127.0.0.1:' + uploadPort + '/upload',
        token: 'tk',
        max_size: 10485760,
        mime_type: 'image/png'
      };
    }
  };
}

// ---- mock QzCli（@ 提及通知：不真发消息，验证链路与渲染） ----
// 额外覆盖：noteImageUrls（远端图片地址补齐）、startQrLogin（未登录时应用自动调起扫码登录）
const cliState = {
  imageUrlCalls: [],
  qrLoginStarts: 0,
  qrLoginCancels: 0,
  qrLoginHandlers: null,
  contactsAuthFailed: false,
  // qz CLI「已登录」后内部接口才给得出第二张图的 CDN 地址：
  // 用来验证「扫码成功后无需重启应用就自动补齐图片」
  afterQzLogin: false,
  authCacheResets: 0
};
function makeMockCli() {
  const sentMessages = [];
  return {
    async isAvailable() {
      if (cliState.contactsAuthFailed) {
        return { ok: false, reason: 'AUTH_FAILED', message: "运行 'qz auth login' 登录。" };
      }
      return { ok: true, binPath: '/mock/qz' };
    },
    async listContacts() {
      const extra = Array.from({ length: 23 }, (_, i) => ({
        uid: 'u_smoke_extra_' + i,
        nickname: '测试联系' + (i + 3), // 共 25 个联系人，验证下拉项上限 20 / 可见高度 10 行
        remark: '',
        linkType: 1,
        avatar: ''
      }));
      return [
        { uid: 'u_smoke_1', nickname: '测试联系人', remark: '备注甲', linkType: 2, avatar: '' },
        { uid: 'u_smoke_2', nickname: 'Pitt', remark: '', linkType: 5, avatar: '' },
        ...extra
      ];
    },
    // 远端图片地址：笔记 1 的 img_mock_1 有 CDN 地址；img_mock_no_url 只有「已登录」后才给地址
    async noteImageUrls(noteId) {
      cliState.imageUrlCalls.push(String(noteId));
      if (String(noteId) === '1') {
        const urls = ['https://res.qzhuli.com/open_platform/user_media/img_mock_1.png'];
        if (cliState.afterQzLogin) {
          urls.push('https://res.qzhuli.com/open_platform/user_media/img_mock_no_url.png');
        }
        return urls;
      }
      return [];
    },
    // qz CLI 扫码成功 → 主进程重置进程内登录缓存（联系人不按旧 uid 过滤）
    resetAuthCache() {
      cliState.authCacheResets += 1;
      return this;
    },
    // 扫码登录：保存 onEvent 供主进程手动推事件（不真起 qz 子进程）
    startQrLogin({ onEvent }) {
      cliState.qrLoginStarts += 1;
      cliState.qrLoginHandlers = onEvent;
      return { cancel() { cliState.qrLoginCancels += 1; } };
    },
    async notifyMentions(text, senderName, pageUrl) {
      sentMessages.push({ text, senderName, pageUrl });
      return {
        ok: true,
        sent: [
          { name: '测试联系人', nickname: '测试联系人', uid: 'u_smoke_1', ok: true, error: null, conversationId: 'c_smoke_1' }
        ]
      };
    },
    sentMessages
  };
}

app.whenReady().then(async () => {
  try {
    // 假七牛上传服务先起来（media.upload 会真实 POST 到这里）
    await new Promise((resolve, reject) => {
      uploadServer.once('error', reject);
      uploadServer.listen(0, '127.0.0.1', () => {
        uploadPort = uploadServer.address().port;
        resolve();
      });
    });


    const authFile = path.join(tmpDir, 'auth.json');
    const cacheFile = path.join(tmpDir, 'idea-cache.json');
    const legacyFile = path.join(tmpDir, 'flomo-local.json');
    const mockApi = makeMockApi();
    const mockCli = makeMockCli();
    // @ 分享页：smoke 不真发 HTTP，注入固定 URL 验证「生成→传入 cli」链路
    const mockNotesPage = async () => 'https://ideanote.7373.com.cn/notes/smoke_abc123';
    // @ 分享页删除：记录调用，验证「删除笔记 → 联动删分享页」链路（不真发 HTTP）
    const unpublishCalls = [];
    const mockNotesUnpublish = async ({ ideaId }) => {
      unpublishCalls.push(String(ideaId));
      return { ok: true, removed: 1 };
    };

    const core = initApp({ authFile, cacheFile, legacyFile, dataDir: tmpDir, apiOverride: mockApi, qzCliOverride: mockCli, notesPageOverride: mockNotesPage, notesUnpublishOverride: mockNotesUnpublish });

    const win = new BrowserWindow({
      // x/y 固定靠左上：右侧边缘拖拽断言要求窗口右缘离屏幕边缘足够远，
      // 否则小屏（1512 逻辑宽）上 +60 拖动会被系统夹紧到 +45，出现假失败
      x: 40,
      y: 120,
      width: 1040,
      height: 720,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    // 登录 IPC 必须在渲染层加载前注册（渲染层 init 会立刻调 auth:start）
    core.registerAuthIpc(() => win);

    // 窗口操作 IPC（自绘三按钮 + 边缘拖拽缩放）：用与 main.js 同一模块，才能真实验证 setBounds 生效。
    // 只在 Windows 专属模式下有意义（macOS 上自绘按钮/热区不显示），但注册本身无副作用。
    registerWindowControls({
      getWindow: () => win,
      onResizeEnd: () => {},
      minSize: { width: 760, height: 520 }
    });

    win.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer]', level, message);
    });
    win.webContents.on('preload-error', (_e, p, err) => {
      console.log('[preload-error]', p, err && err.message);
    });

    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // 把测试图片路径注入渲染层（media.upload 需要真实文件绝对路径）
    await win.webContents.executeJavaScript(
      'window.__smokeImagePath = ' + JSON.stringify(smokeImagePath) + ';'
    );

    // 等待：渲染层 init -> 自动 startQr -> 2s 轮询 -> ok -> 主视图 -> 拉数据渲染
    await new Promise((r) => setTimeout(r, 4500));

    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      try {
      out.loginStatus = (document.getElementById('qr-status')||{}).textContent;
      out.loginLoading = (document.getElementById('qr-loading')||{}).textContent;
      out.loginHidden = document.getElementById('login-view').classList.contains('hidden');
      out.appVisible = !document.getElementById('app-view').classList.contains('hidden');
      out.userName = document.getElementById('user-name').textContent;
      out.cardCount = document.querySelectorAll('.memo-card').length;
      out.sidebarTagCount = document.querySelectorAll('.tag-item').length;
      out.memoCount = document.getElementById('stat-memos').textContent;

      // 无边框窗口三按钮（Windows 自绘；macOS 隐藏、走原生红黄绿）
      // 关键约定：容器必须挂在 drag 容器（.main-header / #login-view）内部，
      // body 顶层的 no-drag 会被上层拖拽区覆盖（Windows 非最大化时按钮点不动）
      const wcs = Array.prototype.slice.call(document.querySelectorAll('.win-controls'));
      out.winCtlBoxCount = wcs.length;
      out.winCtlCounts = wcs.map((b) => b.querySelectorAll('.win-ctl').length);
      out.winCtlInDragParent = wcs.map((b) => !!b.closest('.main-header, #login-view'));
      out.winCtlSelfShown = wcs.map((b) => !b.classList.contains('hidden'));
      out.platformWinClass = document.body.classList.contains('platform-win');
      out.winCtlBoxRects = wcs.map((b) => {
        const r = b.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      });
      out.winCtlRectMax = out.winCtlBoxRects.reduce((m, r) => Math.max(m, r[0]), 0);
      out.winCtlSizes = wcs.map((b) => {
        const btn = b.querySelector('.win-ctl');
        if (!btn) return '';
        const rect = btn.getBoundingClientRect();
        return Math.round(rect.width) + 'x' + Math.round(rect.height);
      });
      out.winCtlRegions = wcs.map((b) => {
        const btn = b.querySelector('.win-ctl');
        if (!btn) return '';
        const st = getComputedStyle(btn);
        return st.getPropertyValue('-webkit-app-region') || st.getPropertyValue('app-region') || '';
      });
      out.winCtlRightGap = wcs.length
        ? Math.round(window.innerWidth - Math.max.apply(null, wcs.map((b) => b.getBoundingClientRect().right)))
        : -1;
      // 可见容器的按钮必须是 36x30；祖先隐藏（登录视图在 app 态下 hidden）测不出尺寸，跳过
      out.winCtlSizeOk = wcs.every((b) => {
        const btn = b.querySelector('.win-ctl');
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return true;
        return Math.round(r.width) === 36 && Math.round(r.height) === 30;
      });
      out.winCtlIcons = wcs.length
        ? Array.prototype.map.call(
          wcs[0].querySelectorAll('.win-ctl svg'),
          (s) => (s.classList.contains('hidden') ? 'hidden:' : '') + (s.classList.contains('ico-max') ? 'max' : s.classList.contains('ico-restore') ? 'restore' : 'plain')
        ).join('|')
        : '';

      // 边缘拖拽缩放热区（8 条：四边 + 四角）
      const grips = document.getElementById('win-resize-grips');
      out.gripsExists = !!grips;
      out.gripCount = grips ? grips.querySelectorAll('.win-grip').length : 0;
      out.gripEdges = grips ? Array.prototype.map.call(grips.querySelectorAll('.win-grip'), (g) => g.getAttribute('data-edge')).join('|') : '';
      out.gripCursors = grips ? Array.prototype.map.call(grips.querySelectorAll('.win-grip'), (g) => getComputedStyle(g).cursor).join('|') : '';
      out.gripRegion = grips && grips.querySelector('.win-grip')
        ? (getComputedStyle(grips.querySelector('.win-grip')).getPropertyValue('-webkit-app-region') || '') : '';
      out.gripContainerPE = grips ? getComputedStyle(grips).pointerEvents : '';
      out.gripDisplay = grips ? getComputedStyle(grips).display : '';
      out.winCtlModeText = !!(window.ideaNote.windowControls && window.ideaNote.windowControls.resizeStart) ? 'resize-api' : 'none';

      // 图片渲染：mock 的 image_url 是假七牛域名（必然加载失败）→ 应降级为占位且保留原地址
      out.hasLightbox = !!document.getElementById('image-lightbox');
      out.imgCount = document.querySelectorAll('.memo-image-thumb').length;
      const brokenImg = document.querySelector('.memo-image-missing[data-src]');
      out.brokenSrc = brokenImg ? brokenImg.getAttribute('data-src') : null;
      const bs = out.brokenSrc || '';
      out.imgHasThumbParam = bs.indexOf('imageView2/2/w/180') >= 0 || bs.indexOf('imageView2/2/w/360') >= 0;

      // 登录态 API（开放平台字段 q_uid）
      const auth = await window.ideaNote.auth.get();
      out.authUid = auth ? auth.q_uid : null;
      out.authNickname = auth ? auth.nickname : null;

      // 同步 CRUD 全链路
      const created = await window.ideaNote.sync.create('新增 #测试');
      out.createdId = created.id;
      out.createdTags = created.tags;
      const updated = await window.ideaNote.sync.update(created.id, '已改 #改过');
      out.updatedContent = updated.content;
      await window.ideaNote.sync.remove(created.id);
      const after = await window.ideaNote.sync.pull();
      out.pullCount = after.length;

      // 标签筛选交互
      const tagBtn = document.querySelector('.tag-item[data-tag="生活"]');
      if (tagBtn) { tagBtn.click(); await wait(120); }
      out.filteredCardCount = document.querySelectorAll('.memo-card').length;

      // 回收站：开放平台首版无接口 -> 空列表 + 说明文案
      document.getElementById('nav-all').click();
      await wait(100);
      document.getElementById('btn-trash').click();
      await wait(400);
      out.trashCardCount = document.querySelectorAll('.trash-card').length;
      out.trashTitle = document.getElementById('app-title').textContent;
      const es = document.getElementById('empty-state');
      out.trashEmptyText = es ? es.querySelector('p').textContent : '';
      document.getElementById('nav-all').click();
      await wait(200);
      out.cardCountAfterBack = document.querySelectorAll('.memo-card').length;

      // Md / Tags 可用
      out.mdOk = window.Md.render('**b**').includes('<strong>b</strong>');
      out.tagsOk = window.Tags.extractTags('#a #b').length === 2;

      // 输入框列表逻辑
      out.listErr = null;
      try {
        const NL = String.fromCharCode(10);
        out.listEnterOk = window.MarkdownComposer.enterAt('1. a', 4).text === '1. a' + NL + '2. ';
        out.listExitOk = window.MarkdownComposer.enterAt('- a' + NL + '- ', 6).text === '- a' + NL;
        out.beginListOk = window.MarkdownComposer.beginListAt('hello', 5, '- ').text === 'hello' + NL + '- ';
      } catch (e) {
        out.listErr = String((e && e.message) || e);
      }

      // ---- 图片上传链路：真实 FormData 上传到本地假七牛 → 本地缓存 → 卡片缩略图 ----
      out.upload = null;
      try {
        out.upload = await window.ideaNote.media.upload(window.__smokeImagePath);
      } catch (e) { out.uploadError = String((e && e.message) || e); }

      if (out.upload && out.upload.imageId) {
        out.mediaFileName = out.upload.fileName;
        const withImg = await window.ideaNote.sync.create('带图 #图片', [out.upload.imageId]);
        out.withImgId = withImg.id;
        // 同步刷新：loadData → refreshMediaIndex → 卡片显示本地缩略图
        document.getElementById('sync-refresh').click();
        await wait(1200);
        const thumbs = Array.prototype.slice.call(document.querySelectorAll('.memo-image-thumb'));
        const localThumbs = thumbs.filter((t) => (t.getAttribute('src') || '').indexOf('file://') === 0);
        out.localThumbCount = localThumbs.length;
        out.localThumbSrc = localThumbs.length ? localThumbs[0].getAttribute('src') : null;
        // 远端兜底：img_mock_1 本机无副本，但 qz CLI 给了 CDN 地址 → 必须出现带该地址的缩略图/占位
        const missBadges = Array.prototype.slice.call(document.querySelectorAll('.memo-image-missing'));
        const remoteBadge = missBadges.find((b) => (b.getAttribute('data-src') || '').indexOf('img_mock_1') !== -1);
        out.remoteThumbSrc = remoteBadge ? remoteBadge.getAttribute('data-src') : null;
        out.remoteHasThumbParam = (out.remoteThumbSrc || '').indexOf('imageView2/2/w/360') >= 0;
        out.remoteIndexCount = Object.keys(await window.ideaNote.media.remote()).length;
        out.imageUrlCallsSeen = true; // 实际调用次数由主进程断言
        out.missingBadgeCount = document.querySelectorAll('.memo-image-missing').length;
        // lightbox：点击真实本地缩略图能打开/关闭
        if (localThumbs.length) {
          localThumbs[0].click();
          await wait(300);
          const lbEl = document.getElementById('image-lightbox');
          out.lightboxOpen = !!(lbEl && lbEl.classList.contains('open'));
          const closeBtn = document.querySelector('#image-lightbox [data-action="close"]');
          if (closeBtn) closeBtn.click();
          out.lightboxClosed = !!(lbEl && !lbEl.classList.contains('open'));
        }

        // 链路验证：用 Image 探针真实加载本机副本（不受 lazy 与窗口隐藏影响）
        const probeSrc = out.upload.url;
        out.localImageSrc = probeSrc;
        out.protocolProbe = await new Promise((resolve) => {
          const probe = new Image();
          const info = { events: [] };
          const onViolation = (ev) => info.events.push('csp:' + ev.violatedDirective + '|' + ev.blockedURI);
          document.addEventListener('securitypolicyviolation', onViolation);
          const timer = setTimeout(() => { document.removeEventListener('securitypolicyviolation', onViolation); info.result = 'timeout'; resolve(info); }, 2500);
          probe.onload = () => { clearTimeout(timer); document.removeEventListener('securitypolicyviolation', onViolation); info.result = 'load:' + probe.naturalWidth; resolve(info); };
          probe.onerror = () => { clearTimeout(timer); document.removeEventListener('securitypolicyviolation', onViolation); info.result = 'error'; resolve(info); };
          probe.src = probeSrc;
        });
        out.protocolImageLoaded = /^load:[1-9]/.test(out.protocolProbe.result || '');
        // 清理：删除带图笔记，保持数据基线
        await window.ideaNote.sync.remove(withImg.id);
      }
      } catch (e) { return { __smokeError: String((e && e.stack) || e), __partial: out }; }
      return out;
    })()`);

    console.log('SMOKE_RESULT=' + JSON.stringify(result));
    if (result.__smokeError) console.log('SMOKE_JS_ERROR=' + result.__smokeError);

    // 截图（登录后主界面）
    win.show();
    win.focus();
    await new Promise((r) => setTimeout(r, 500));

    // ---- 边缘拖拽缩放（Windows 专属交互；force 模式在 macOS 上验证 pointer → IPC → setBounds 全链路）----
    let resizeResult = { skipped: true };
    if (process.env.IDEA_NOTE_FORCE_WIN_CONTROLS === '1') {
      const resizeIpc = [];
      ipcMain.on('window:resize-start', (_e, p) => resizeIpc.push(['start', p]));
      ipcMain.on('window:resize-move', (_e, p) => resizeIpc.push(['move', p]));
      ipcMain.on('window:resize-end', () => resizeIpc.push(['end']));
      const startSize = win.getSize();
      const fsResize = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const out = {};
        try {
          const grip = document.querySelector('.win-grip[data-edge="right"]');
          out.gripFound = !!grip;
          if (!grip) return out;
          const sx = Math.round(window.screenX + window.outerWidth - 4);
          const sy = Math.round(window.screenY + 300);
          out.before = [window.screenX, window.screenY, window.outerWidth, window.outerHeight];
          out.seen = [];
          ['pointerdown', 'pointermove', 'pointerup'].forEach((t) => {
            document.addEventListener(t, (ev) => out.seen.push(t + ':' + ((ev.target && (ev.target.className || ev.target.nodeName)) || '?')), true);
          });
          grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true, screenX: sx, screenY: sy }));
          await wait(50);
          document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, screenX: sx + 60, screenY: sy }));
          await wait(80);
          document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, screenX: sx + 60, screenY: sy }));
          await wait(80);
          out.after = [window.screenX, window.screenY, window.outerWidth, window.outerHeight];
        } catch (e) { out.err = String((e && e.stack) || e); }
        return out;
      })()`);
      await new Promise((r) => setTimeout(r, 250));
      const endSize = win.getSize();
      resizeResult = {
        skipped: false,
        gripFound: fsResize.gripFound,
        err: fsResize.err || null,
        ipc: resizeIpc,
        rendererBefore: fsResize.before || null,
        rendererAfter: fsResize.after || null,
        startSize,
        endSize,
        grewRight: (endSize[0] - startSize[0]) >= 55 && endSize[1] === startSize[1]
      };
    }
    console.log('SMOKE_RESIZE=' + JSON.stringify(resizeResult));

    // ---- qz CLI 未登录：应用自动调起扫码登录（用户不需要知道 qz CLI / 命令行）----
    // 场景：用户输入 @ 拉联系人 → CLI 未登录 → 应用直接发起 `qz auth login` 并把二维码显示在应用内
    cliState.contactsAuthFailed = true;
    const qzLoginTrigger = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      try {
        const composerEl = document.getElementById('composer');
        composerEl.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composerEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, ' @');
        await wait(900); // loadContacts IPC → 未登录 → 自动发起扫码登录
        const modal = document.getElementById('qz-login-modal');
        out.modalShown = !!(modal && !modal.classList.contains('hidden'));
        // 界面上绝不出现「运行 qz auth login」这类命令行提示
        out.commandHintInUi = /qz auth login|qz auto login/.test(document.body.textContent || '');
        out.status = (document.getElementById('qz-login-status') || {}).textContent || '';
        out.qrEmptyBeforeEvent = ((document.getElementById('qz-login-qr') || {}).textContent || '') === '';
        composerEl.innerHTML = '';
        composerEl.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) { out.err = String((e && e.message) || e); }
      return out;
    })()`);
    console.log('SMOKE_QZ_LOGIN_TRIGGER=' + JSON.stringify(qzLoginTrigger));

    // 主进程手动推二维码（mock CLI 的回调）：渲染层必须渲染成精确 SVG（逐模块绘制，手机可扫）。
    // 样本取自真实 `qz auth login` 输出（33×33 模块），不是构造的假数据。
const QR_SAMPLE = [
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '█ ▄▄▄▄▄ █▄▀ ▀ █▄█  █▄▀ ▄ ▄█ ▄▄▄▄▄ █',
  '█ █   █ █   █▀ ▀▄▀▀██▄█▄█▄█ █   █ █',
  '█ █▄▄▄█ █▄█▀ ▄ ██  █ ▀▄ ███ █▄▄▄█ █',
  '█▄▄▄▄▄▄▄█▄█ █ █▄█ ▀ █ █ ▀▄█▄▄▄▄▄▄▄█',
  '█ ▄▄▄▀▀▄▀ █ ▄ █ █▀▄▀▀▄ █   ▀▀▄  █ █',
  '█ ▄▀  ▄▄ █  ▄▄▀▄▀███████▄█ ▄ ▀▀█▄ █',
  '█▀█ ▀ █▄█▀▄▄▀ ▄ ▀▀▄▄▀██▄██▄█ ▄█▀███',
  '█ ▄ ▀ █▄██▀▄ █▄ ▀▀█ ▄█ ▄█▄▄▀▄▄▀ ▀▀█',
  '█ ▀▄▀▄▄▄█▄▄▀█▄ ▄▀█████▄█ ▀█ ▄  ▄█ █',
  '██▀▀█  ▄▀ █▄▀█▄▀▄▄ ▄█▄▄▀▀▀▀ ▄▄▄▄▄██',
  '█▀▄▄ ▀▄▄▄▀ ███▀▀▄ ▄  ▄▄ ▀  ▀▀█ █▄▀█',
  '██▀▀▀██▄   ▄▀▀ ▄██▄▀▀▄██  ███▄▀▄█ █',
  '█▄█▄▄▄▄▄█▀▀▄ █▄█▀▀ ▀  █▄█ ▄▄▄ ▀▀▀▄█',
  '█ ▄▄▄▄▄ ██▀▀█ █▀███▀ ▄ ▄▄ █▄█  ▀▀▀█',
  '█ █   █ █▀▄█▄▀▄▀▀█▀▄██▄█▄▄▄▄ ▄ ▄▀▄█',
  '█ █▄▄▄█ █  ▄▄ █▄  ▀ █▄▄ █▀▀ ▄▀▀▄▄▀█',
  '█▄▄▄▄▄▄▄█▄██▄█▄█▄██▄▄▄▄▄██▄▄█▄█▄███'
].join(String.fromCharCode(10));
    await win.webContents.executeJavaScript('window.__smokeQrSample = ' + JSON.stringify(QR_SAMPLE) + ';');
    if (cliState.qrLoginHandlers) cliState.qrLoginHandlers({ phase: 'qr', text: QR_SAMPLE });
    await new Promise((r) => setTimeout(r, 400));
    const qzQrView = await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('qz-login-qr');
      const modal = document.getElementById('qz-login-modal');
      const svg = box ? box.querySelector('svg') : null;
      const parse = (window.QrCode && window.QrCode.parseTerminalQr) || null;
      const sample = window.__smokeQrSample || '';
      return {
        modalShown: !!(modal && !modal.classList.contains('hidden')),
        hasSvg: !!svg,
        isSvgClass: !!(box && box.classList.contains('is-svg')),
        width: svg ? Number(svg.getAttribute('width')) : 0,
        height: svg ? Number(svg.getAttribute('height')) : 0,
        viewBox: svg ? svg.getAttribute('viewBox') : '',
        rects: svg ? svg.querySelectorAll('rect').length : 0,
        matrixSize: parse && parse(sample) ? parse(sample).length : 0,
        hasWhiteBg: !!svg && !!svg.querySelector('rect[fill="#ffffff"]'),
        crisp: !!svg && svg.getAttribute('shape-rendering') === 'crispEdges',
        status: (document.getElementById('qz-login-status') || {}).textContent || ''
      };
    })()`);
    console.log('SMOKE_QZ_LOGIN_QR=' + JSON.stringify(qzQrView));

    // 「以后再说」：关闭浮层并取消子进程；再次发起后收到 success → 浮层关闭 + 提示已登录
    const qzCancelResult = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.getElementById('qz-login-cancel');
      if (btn) btn.click();
      await wait(200);
      const modal = document.getElementById('qz-login-modal');
      return { hidden: !!(modal && modal.classList.contains('hidden')) };
    })()`);
    const qzRestart = await win.webContents.executeJavaScript('window.ideaNote.qzLogin.start()');
    await new Promise((r) => setTimeout(r, 200));
    if (cliState.qrLoginHandlers) cliState.qrLoginHandlers({ phase: 'success' });
    await new Promise((r) => setTimeout(r, 300));
    const qzSuccessView = await win.webContents.executeJavaScript(`(() => {
      const modal = document.getElementById('qz-login-modal');
      const toast = document.getElementById('toast');
      return {
        modalHidden: !!(modal && modal.classList.contains('hidden')),
        toastVisible: !!(toast && !toast.classList.contains('hidden')),
        toastText: toast ? toast.textContent : ''
      };
    })()`);
    console.log('SMOKE_QZ_LOGIN_DONE=' + JSON.stringify({
      cancel: qzCancelResult, restartOk: !!(qzRestart && qzRestart.ok), view: qzSuccessView,
      starts: cliState.qrLoginStarts, cancels: cliState.qrLoginCancels
    }));
    // ---- 场景：qz CLI 扫码成功后，联系人与图片要立即刷新，不需重启应用（2026-11-28 用户报）----
    cliState.contactsAuthFailed = true;
    const reloginBefore = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      try {
        const composerEl = document.getElementById('composer');
        composerEl.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composerEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, ' @');
        await wait(900); // 未登录 → 空态
        const box = document.querySelector('.at-suggest');
        out.shown = !!(box && !box.classList.contains('hidden'));
        out.items = box ? box.querySelectorAll('.tag-suggest-item').length : 0;
        out.placeholder = document.querySelectorAll('.memo-image-missing').length;
      } catch (e) { out.err = String((e && e.message) || e); }
      return out;
    })()`);
    // 模拟扫码完成：CLI 变已登录 → 推 success 事件（渲染层应立刻失效联系人缓存 + 重补图片）
    cliState.contactsAuthFailed = false;
    cliState.afterQzLogin = true;
    if (cliState.qrLoginHandlers) cliState.qrLoginHandlers({ phase: 'success' });
    // 联系人重拉是异步的（IPC + 渲染），轮询等待最多 3s，避免时序抖动造成假失败
    let reloginAfter = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      reloginAfter = await win.webContents.executeJavaScript(`(() => {
        const box = document.querySelector('.at-suggest');
        const badges = Array.from(document.querySelectorAll('.memo-image-missing'));
        return {
          shown: !!(box && !box.classList.contains('hidden')),
          items: box ? box.querySelectorAll('.tag-suggest-item').length : 0,
          placeholder: badges.length,
          // 加载失败降级时原始地址留在 data-src：用它证明渲染层已拿到登录后才有的新地址
          badgeSrcs: badges.map((b) => b.getAttribute('data-src') || ''),
          remoteSrc: Array.from(document.querySelectorAll('img.memo-image-thumb')).map((i) => i.getAttribute('src') || '')
        };
      })()`);
      if (reloginAfter.items > 0) break;
    }
    const reloginRemoteMap = fs.existsSync(path.join(tmpDir, 'media-remote.json'))
      ? JSON.parse(fs.readFileSync(path.join(tmpDir, 'media-remote.json'), 'utf8')) : {};
    console.log('SMOKE_QZ_RELOGIN=' + JSON.stringify({
      before: reloginBefore, after: reloginAfter, cacheResets: cliState.authCacheResets,
      remoteKey: !!reloginRemoteMap.img_mock_no_url
    }));

    // ---- 场景：点图片占位 → 补齐失败且 qz CLI 未登录 → 直接拉起扫码登录（2026-11-28 用户要求）----
    await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('composer');
      if (el) { el.innerHTML = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`);
    cliState.contactsAuthFailed = true; // qz:status 回 ok:false
    cliState.afterQzLogin = false;      // 该图地址已给不出来 → 占位重现
    {
      const mrFile = path.join(tmpDir, 'media-remote.json');
      const cur = fs.existsSync(mrFile) ? JSON.parse(fs.readFileSync(mrFile, 'utf8')) : {};
      delete cur.img_mock_no_url;
      fs.writeFileSync(mrFile, JSON.stringify(cur, null, 2), 'utf8');
    }
    await win.webContents.executeJavaScript("document.getElementById('sync-refresh').click(); true");
    await new Promise((r) => setTimeout(r, 1600));
    const missingInfo = await win.webContents.executeJavaScript(`(() => {
      const badges = Array.from(document.querySelectorAll('.memo-image-missing'));
      return {
        count: badges.length,
        clickable: badges.filter((b) => b.classList.contains('is-clickable')).length,
        texts: badges.map((b) => (b.textContent || '').trim())
      };
    })()`);
    const startsBeforeClick = cliState.qrLoginStarts;
    await win.webContents.executeJavaScript(`(async () => {
      const badge = document.querySelector('.memo-image-missing.is-clickable');
      if (badge) badge.click();
      await new Promise(r => setTimeout(r, 1200));
      return true;
    })()`);
    const missingClick = await win.webContents.executeJavaScript(`(() => {
      const m = document.getElementById('qz-login-modal');
      return {
        modalShown: !!(m && !m.classList.contains('hidden')),
        status: (document.getElementById('qz-login-status') || {}).textContent || ''
      };
    })()`);
    console.log('SMOKE_MISSING_CLICK=' + JSON.stringify({
      missingInfo, startsBeforeClick, starts: cliState.qrLoginStarts, click: missingClick
    }));
    await win.webContents.executeJavaScript("(() => { const b = document.getElementById('qz-login-cancel'); if (b) b.click(); return true; })()");
    await new Promise((r) => setTimeout(r, 200));

    cliState.contactsAuthFailed = false; // 恢复，后续步骤按已登录预期

    // 标签联想（窗口显示后 selection/focus 才正常，隐藏窗口 addRange 不生效）：
    // 编辑卡片时内容末尾带标签 → 光标进入后下拉弹出；
    // 光标移到普通文字（非标签输入态）→ 下拉应自动关闭，不再“跟着光标永不消失”
    const editResult = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      try {
        const editBtn = document.querySelector('.memo-card [data-action="edit"]');
        if (editBtn) {
          editBtn.click();
          await wait(200);
          const editEl = document.querySelector('.memo-edit-card .composer');
          const boxes = document.querySelectorAll('.tag-suggest');
          const box = boxes.length ? boxes[boxes.length - 1] : null;
          out.editOpen = !!editEl;
          out.suggestShownOnEnter = !!(box && !box.classList.contains('hidden'));
          if (editEl) {
            // 用 Range 把光标移到第一个文本节点第 1 个字符后（普通文字，非标签输入态）
            const walker = document.createTreeWalker(editEl, NodeFilter.SHOW_TEXT);
            const firstText = walker.nextNode();
            if (firstText) {
              const sel = window.getSelection();
              const range = document.createRange();
              range.setStart(firstText, Math.min(1, firstText.nodeValue.length));
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
              await wait(100); // rAF 一帧 + selectionchange 派发
              out.suggestClosedAfterMove = !!(box && box.classList.contains('hidden'));
            }
            const card = editEl.closest('.memo-edit-card');
            // 编辑卡片工具栏 @ 按钮：与顶部输入框一致——插入 ' @' 并弹出联系人联想
            // （旧版是占位 toast「提及 · 敬请期待」，编辑态根本没法 @ 人）
            const atBtn = card ? card.querySelector('[data-edit-tool="at"]') : null;
            out.editAtBtnFound = !!atBtn;
            if (atBtn) {
              editEl.focus();
              atBtn.click();
              await wait(400); // 插入后 input 事件 → loadContacts IPC → 浮层渲染
              out.editAtInserted = (editEl.textContent || '').indexOf('@') !== -1;
              const atBoxes = document.querySelectorAll('.tag-suggest.at-suggest');
              const atBox = atBoxes.length ? atBoxes[atBoxes.length - 1] : null;
              out.editAtShown = !!(atBox && !atBox.classList.contains('hidden'));
              out.editAtItems = atBox ? atBox.querySelectorAll('.tag-suggest-item').length : 0;
            }
            const cancelBtn = card ? card.querySelector('[data-edit-tool="cancel"]') : null;
            if (cancelBtn) cancelBtn.click();
            await wait(150);
            out.editCanceled = !document.querySelector('.memo-edit-card');
          }
        }
      } catch (e) { out.tagSuggestErr = String((e && e.message) || e); }
      return out;
    })()`);
    console.log('SMOKE_EDIT_RESULT=' + JSON.stringify(editResult));

    // @联系人联想 + 提及通知（窗口显示后 selection 才可用）：
    // 顶部输入框输入 @ → 下拉弹出联系人（mock qz CLI）→ Esc 关闭；
    // 发布含 @ 的笔记 → mentions:notify 返回已通知的联系人
    const atResult = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      try {
        const composerEl = document.getElementById('composer');
        composerEl.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composerEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, ' @');
        await wait(400); // loadContacts IPC + 浮层渲染
        out.composerTextAfter = composerEl.textContent;
        out.atModuleOk = typeof window.AtSuggester === 'object' && typeof window.AtSuggester.detectAtQuery === 'function';
        out.detectAfter = window.AtSuggester && window.AtSuggester.detectAtQuery
          ? JSON.stringify(window.AtSuggester.detectAtQuery(composerEl.textContent || '', (composerEl.textContent || '').length))
          : null;
        try {
          const c = await window.ideaNote.mentions.contacts();
          out.contactsIpc = JSON.stringify(c);
        } catch (e) { out.contactsIpcErr = String((e && e.message) || e); }
        let atBox = document.querySelector('.tag-suggest.at-suggest');
        out.atBoxExists1 = !!atBox;
        out.atShown1 = !!(atBox && !atBox.classList.contains('hidden'));
        // 对照：手动派发 input 事件（绕过 execCommand 事件链）
        composerEl.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(300);
        atBox = document.querySelector('.tag-suggest.at-suggest');
        out.atBoxExists2 = !!atBox;
        out.atShown2 = !!(atBox && !atBox.classList.contains('hidden'));
        out.atItemCount = atBox ? atBox.querySelectorAll('.tag-suggest-item').length : 0;
        const firstName = atBox ? atBox.querySelector('.tag-suggest-item') : null;
        out.atFirstName = firstName ? firstName.textContent : null;
        out.atFirstRelation = firstName ? (firstName.querySelector('.at-relation') || {}).textContent : null;
        // 可见高度不超过 10 行：clientHeight ≤ 10 × 行高 + 浮层上下 padding 12px
        if (atBox && firstName) {
          const rowH = firstName.offsetHeight;
          out.atRowHeight = rowH;
          out.atClientHeight = atBox.clientHeight;
          out.atVisibleRowsOk = atBox.clientHeight <= 10 * rowH + 12 + 1; // +1 容忍取整
          out.atScrollable = atBox.scrollHeight > atBox.clientHeight; // 20 项 > 10 行可见 → 应可滚动
        }
        if (atBox) {
          // Esc 关闭：onKeydown 监听在 composer.el（捕获阶段），必须 dispatch 到输入框
          composerEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await wait(120);
          out.atClosedAfterEsc = atBox.classList.contains('hidden');
        }
        // 清空输入框，避免影响后续
        composerEl.innerHTML = '';

        // 提及通知链路：创建含 @ 的笔记 → notify → 断言 mock 已通知
        const val = '测试 @测试联系人 的想法';
        const created2 = await window.ideaNote.sync.create(val, []);
        out.mentionsCreatedId = created2.id;
        const notify = await window.ideaNote.mentions.notify(val);
        out.notifyOk = !!(notify && notify.ok === true);
        out.notifySentCount = notify && Array.isArray(notify.sent) ? notify.sent.length : 0;
        out.notifySentName = notify && notify.sent[0] ? notify.sent[0].name : null;
        await window.ideaNote.sync.remove(created2.id);
      } catch (e) { out.atErr = String((e && e.message) || e); }
      return out;
    })()`);
    console.log('SMOKE_AT_RESULT=' + JSON.stringify(atResult));

    // @ 分享页删除联动：删除含 @ 的笔记后，unpublish 必须收到该笔记 id
    console.log('SMOKE_UNPUBLISH=' + JSON.stringify({ calls: unpublishCalls, deletedId: atResult.mentionsCreatedId || '' }));

    // @ 分享页链路：mock 生成的 URL 必须传入 cli.notifyMentions 的第三参
    const cliMessages = mockCli.sentMessages || [];
    const lastMsg = cliMessages[cliMessages.length - 1] || {};
    const pageUrlPassedToCli = /^https:\/\/ideanote\.7373\.com\.cn\/notes\/smoke_abc123$/.test(lastMsg.pageUrl || '');
    console.log('SMOKE_PAGEURL=' + JSON.stringify({ sentCount: cliMessages.length, pageUrl: lastMsg.pageUrl || '', pageUrlPassedToCli }));

    // @ 联想空态要带出失败原因：用户只看到「暂无联系人」时无法判断是打包问题还是 qz CLI 未登录。
    // 直接对一份新的 AtSuggester 挂载验证 emptyText 选项（主输入框那次已缓存联系人，无法复现失败态）
    const atEmptyHint = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      const fake = document.createElement('div');
      fake.contentEditable = 'true';
      fake.textContent = '@';
      document.body.appendChild(fake);
      const composerLike = {
        el: fake,
        value: () => fake.textContent,
        rawValue: () => fake.textContent,
        caretOffset: () => fake.textContent.length,
        replaceText: () => {},
        focus: () => {},
        clear: () => {}
      };
      try {
        let attempts = 0;
        const detach = window.AtSuggester.attach(composerLike, {
          loadContacts: () => {
            attempts++;
            return Promise.resolve(attempts === 1 ? [] : [{ uid: 'u1', nickname: '张三', linkType: 2 }]);
          },
          emptyText: () => '暂无联系人（qz CLI 未登录）'
        });
        await wait(200);
        const boxes = document.querySelectorAll('.tag-suggest.at-suggest');
        const box = boxes.length ? boxes[boxes.length - 1] : null;
        out.shown = !!(box && !box.classList.contains('hidden'));
        out.text = box ? (box.querySelector('.tag-suggest-empty') || {}).textContent || '' : '';
        // 空结果不缓存：越过 1.5s 冷却后再触发一次，必须重新拉取并渲染出联系人
        await wait(1700);
        fake.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(400);
        out.retryItems = box ? box.querySelectorAll('.tag-suggest-item').length : 0;
        out.retryFirstName = box && box.querySelector('.tag-suggest-item') ? box.querySelector('.tag-suggest-item').textContent : null;
        detach();
      } catch (e) {
        out.err = String((e && e.message) || e);
      } finally {
        if (fake.parentNode) fake.parentNode.removeChild(fake);
      }
      return out;
    })()`);
    console.log('SMOKE_AT_EMPTY_HINT=' + JSON.stringify(atEmptyHint));

    // 静默更新检查失败不应弹 toast（2026-11-26 用户报：Windows 冷启动弹「更新失败：<一长串错误码>」）
    await win.webContents.executeJavaScript("document.getElementById('toast').classList.add('hidden'); true");
    win.webContents.send('updater:event', { event: 'error', message: '更新服务器暂未提供更新清单，请稍后再试', manual: false });
    await new Promise((r) => setTimeout(r, 300));
    const silentErrorToast = await win.webContents.executeJavaScript(`(() => {
      const t = document.getElementById('toast');
      return { visible: !!t && !t.classList.contains('hidden'), text: t ? t.textContent : '' };
    })()`);
    console.log('SMOKE_UPDATER_SILENT=' + JSON.stringify(silentErrorToast));

    // 下载完成 → 顶部常驻提示「重要更新已安装(win: 已下载)」+ 按钮「启用新版」（用户 2026-11-27 要求：
    // 一直显示、可手动关闭）。verifies：后续 available/downloading/error 事件不得覆盖或隐藏它；
    // 用户按 × 后同版本不再重弹，换新版本仍会弹。
    const expectReadyText = (process.env.IDEA_NOTE_FORCE_WIN_CONTROLS === '1' || process.platform === 'win32')
      ? '重要更新已下载' : '重要更新已安装';
    const readBar = () => win.webContents.executeJavaScript(`(() => {
      const bar = document.getElementById('update-bar');
      const btn = document.getElementById('update-action');
      const txt = document.getElementById('update-text');
      return {
        visible: !!bar && !bar.classList.contains('hidden'),
        text: txt ? txt.textContent : '',
        actionText: btn ? btn.textContent : '',
        actionVisible: !!btn && !btn.classList.contains('hidden'),
        iconHidden: !btn || btn.classList.contains('hidden')
      };
    })()`);
    win.webContents.send('updater:event', { event: 'downloaded', version: '9.9.9' });
    await new Promise((r) => setTimeout(r, 300));
    const readyBar1 = await readBar();
    // 干扰事件：后续检查/进度/错误都不能把常驻提示顶掉
    win.webContents.send('updater:event', { event: 'available', version: '9.9.9' });
    win.webContents.send('updater:event', { event: 'downloading', percent: 40 });
    win.webContents.send('updater:event', { event: 'error', message: '某错误', manual: false });
    await new Promise((r) => setTimeout(r, 300));
    const readyBar2 = await readBar();
    // 手动关闭：点 × 后隐藏
    await win.webContents.executeJavaScript("document.getElementById('update-close').click(); true");
    await new Promise((r) => setTimeout(r, 200));
    const readyBarClosed = await readBar();
    // 同版本不再重弹
    win.webContents.send('updater:event', { event: 'downloaded', version: '9.9.9' });
    await new Promise((r) => setTimeout(r, 200));
    const readyBarRepeat = await readBar();
    // 新版本仍会弹（也用于截图呈现）
    win.webContents.send('updater:event', { event: 'downloaded', version: '9.9.10' });
    await new Promise((r) => setTimeout(r, 200));
    const readyBarNext = await readBar();
    console.log('SMOKE_UPDATER_READY=' + JSON.stringify({
      expectReadyText, readyBar1, readyBar2, readyBarClosed, readyBarRepeat, readyBarNext
    }));

    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot.png'), image.toPNG());

    // 磁盘验证：登录态已持久化 + 缓存已写入
    const authOnDisk = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : null;
    const cacheOnDisk = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
    console.log('SMOKE_AUTH_UID=' + (authOnDisk ? authOnDisk.q_uid : 'null'));
    console.log('SMOKE_CACHE_COUNT=' + (cacheOnDisk && cacheOnDisk.memos ? cacheOnDisk.memos.length : -1));

    // 磁盘验证：图片本地副本 + 映射索引
    const mediaRemoteFile = path.join(tmpDir, 'media-remote.json');
    console.log('SMOKE_MEDIA_REMOTE_FILE=' + JSON.stringify({
      exists: fs.existsSync(mediaRemoteFile),
      content: fs.existsSync(mediaRemoteFile) ? fs.readFileSync(mediaRemoteFile, 'utf8') : '',
      calls: cliState.imageUrlCalls
    }));

    const mediaIndexFile = path.join(tmpDir, 'media-index.json');
    const mediaIndexOnDisk = fs.existsSync(mediaIndexFile)
      ? JSON.parse(fs.readFileSync(mediaIndexFile, 'utf8')) : null;
    const uploadedName = mediaIndexOnDisk ? mediaIndexOnDisk['img_uploaded'] : null;
    const mediaFileOnDisk = !!(uploadedName && fs.existsSync(path.join(tmpDir, 'media', uploadedName)));
    const mediaFileBytes = mediaFileOnDisk ? fs.statSync(path.join(tmpDir, 'media', uploadedName)).size : -1;
    console.log('SMOKE_MEDIA=' + JSON.stringify({ uploadedName, mediaFileOnDisk, mediaFileBytes }));

    // 逐条断言（失败时打印具体项，便于定位；以前一条大表达式只看得到 SMOKE_PASS=false）
    const checks = {
      c01: result.loginHidden,
      c02: result.appVisible,
      c03: result.winCtlBoxCount === 2,
      c04: JSON.stringify(result.winCtlCounts) === JSON.stringify([3, 3]),
      c05: JSON.stringify(result.winCtlInDragParent) === JSON.stringify([true, true]),
      c06: result.gripsExists === true,
      c07: result.gripCount === 8,
      c08: result.gripEdges === 'top|bottom|left|right|top-left|top-right|bottom-left|bottom-right',
      c09: result.gripRegion === 'no-drag',
      c10: result.gripContainerPE === 'none',
      c11: result.winCtlModeText === 'resize-api',
      c12: (process.env.IDEA_NOTE_FORCE_WIN_CONTROLS === '1'
        ? (resizeResult.skipped === false && resizeResult.grewRight === true)
        : resizeResult.skipped === true),
      c13: (result.platformWinClass === true
        ? (JSON.stringify(result.winCtlSelfShown) === JSON.stringify([true, true])
           && result.winCtlRectMax > 0
           && result.winCtlSizeOk === true
           && JSON.stringify(result.winCtlRegions) === JSON.stringify(['no-drag', 'no-drag'])
           && typeof result.winCtlRightGap === 'number' && result.winCtlRightGap >= 0 && result.winCtlRightGap <= 60
           && result.gripDisplay === 'block')
        : (JSON.stringify(result.winCtlSelfShown) === JSON.stringify([false, false])
           && result.winCtlRectMax === 0
           && result.gripDisplay === 'none')),
      c14: result.userName === '测试用户',
      c15: result.cardCount === 2,
      c16: result.sidebarTagCount === 2,
      c17: result.authUid === 'q10001',
      c18: result.authNickname === '测试用户',
      c19: !!result.createdId,
      c20: JSON.stringify(result.createdTags) === JSON.stringify(['测试']),
      c21: result.updatedContent === '已改 #改过',
      c22: result.pullCount === 2,
      c23: result.filteredCardCount === 1,
      c24: result.trashCardCount === 0,
      c25: result.trashTitle === '回收站',
      c26: /暂未开放回收站/.test(result.trashEmptyText),
      c27: result.cardCountAfterBack === 2,
      c28: /^https:\/\//.test(result.brokenSrc || ''),  // 占位徽标保留了原始 https 地址（可排查）
      c29: result.imgHasThumbParam,
      c30: result.mdOk,
      c31: result.tagsOk,
      c32: result.listEnterOk,
      c33: result.listExitOk,
      c34: result.beginListOk,
      c35: // 图片上传链路
      !!result.upload,
      c36: result.upload.imageId === 'img_uploaded',
      c37: result.mediaFileName === 'img_uploaded.png',
      c38: result.localThumbCount >= 1,
      c39: /^file:\/\//.test(result.localThumbSrc || ''),
      c40: result.protocolImageLoaded === true,
      c41: result.lightboxOpen === true,
      c42: result.lightboxClosed === true,
      c43: result.missingBadgeCount >= 1,
      c44: // 远端地址兜底：本机无副本的 image_id 由 qz CLI 给出的 CDN 地址渲染（不再只能看占位）
      result.remoteIndexCount >= 1,
      c45: !!result.remoteThumbSrc,
      c46: result.remoteHasThumbParam === true,
      c47: cliState.imageUrlCalls.includes('1'),
      c48: // qz CLI 未登录：应用自动调起扫码登录（界面不出现命令行提示）
      qzLoginTrigger.modalShown === true,
      c49: qzLoginTrigger.commandHintInUi === false,
      c50: !qzLoginTrigger.err,
      c51: qzQrView.modalShown === true,
      c52: qzQrView.hasSvg === true && qzQrView.isSvgClass === true,
      c53: qzQrView.matrixSize === 33,  // 真实样本解析成 33×33 模块
      c54: qzQrView.width === 328 && qzQrView.height === 328,  // (33+4*2)*8
      c55: qzQrView.viewBox === '0 0 328 328' && qzQrView.rects > 1,
      c56: qzQrView.hasWhiteBg === true && qzQrView.crisp === true,
      c57: qzCancelResult.hidden === true,
      c58: cliState.qrLoginCancels >= 1,
      c59: cliState.qrLoginStarts >= 2,
      c60: qzSuccessView.modalHidden === true,
      c61: qzSuccessView.toastVisible === true,
      c62: /已登录/.test(qzSuccessView.toastText || ''),
      c63: mediaFileOnDisk,
      c64: mediaFileBytes === SMOKE_PNG.length,
      c65: uploadedName === 'img_uploaded.png',
      c66: authOnDisk,
      c67: authOnDisk.q_uid === 'q10001',
      c68: !!authOnDisk.access_token,
      c69: !!authOnDisk.refresh_token,
      c70: cacheOnDisk,
      c71: cacheOnDisk.memos.length === 2,
      c72: // 标签联想交互（窗口显示后跑）
      editResult.editOpen === true,
      c73: editResult.suggestShownOnEnter === true,
      c74: editResult.suggestClosedAfterMove === true,
      c75: editResult.editCanceled === true,
      c76: // 编辑卡片工具栏 @：插入 ' @' 且弹出联系人联想（此前是占位 toast）
      editResult.editAtBtnFound === true,
      c77: editResult.editAtInserted === true,
      c78: editResult.editAtShown === true,
      c79: editResult.editAtItems > 0,
      c80: !editResult.tagSuggestErr,
      c81: // @联系人联想 + 提及通知
      atResult.atShown1 === true,
      c82: atResult.atItemCount === 20,
      c83: /测试联系人/.test(atResult.atFirstName || ''),
      c84: atResult.atFirstRelation === '朋友',
      c85: atResult.atVisibleRowsOk === true,
      c86: atResult.atScrollable === true,
      c87: atResult.atClosedAfterEsc === true,
      c88: atResult.notifyOk === true,
      c89: atResult.notifySentCount === 1,
      c90: atResult.notifySentName === '测试联系人',
      c91: pageUrlPassedToCli === true,
      c92: // 空态提示带原因（避免只看到「暂无联系人」无法定位）+ 空结果不缓存（下次触发重试）
      atEmptyHint.shown === true,
      c93: /qz CLI 未登录/.test(atEmptyHint.text || ''),
      c94: atEmptyHint.retryItems === 1,
      c95: // @ 分享页删除联动：删除含 @ 笔记时 unpublish 收到对应 id
      unpublishCalls.includes(String(atResult.mentionsCreatedId || '')),
      c96: // 静默更新检查失败不弹 toast（2026-11-26 用户报 Windows 冷启动「更新失败 + 长错误码」）
      silentErrorToast.visible === false,
      c97: !atResult.atErr,
      // 下载完成后的常驻「启用新版」提示（2026-11-27 用户要求）
      c98: readyBar1.visible === true,
      c99: readyBar1.text === expectReadyText,
      c100: readyBar1.actionText === '启用新版' && readyBar1.actionVisible === true,
      c101: readyBar2.visible === true && readyBar2.text === expectReadyText, // 后续事件不覆盖
      c102: readyBarClosed.visible === false,                                 // 可手动关闭
      c103: readyBarRepeat.visible === false,                                 // 同版本不重弹
      c104: readyBarNext.visible === true && readyBarNext.text === expectReadyText,
      // qz CLI 扫码成功后无需重启：联系人立即重拉、图片立即补齐（2026-11-28 用户报）
      c105: reloginBefore.items === 0 && reloginBefore.placeholder >= 1,
      c106: reloginAfter.items > 0,
      c107: reloginAfter.badgeSrcs.some((s) => s.indexOf('img_mock_no_url') !== -1) && !!reloginRemoteMap.img_mock_no_url,
      c108: cliState.authCacheResets >= 1,
      // 点图片占位：可点击 → 补不出来且未登录 → 直接拉起扫码登录
      c109: missingInfo.count >= 1 && missingInfo.clickable === missingInfo.count,
      c110: cliState.qrLoginStarts > startsBeforeClick,
      c111: missingClick.modalShown === true,
    };
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    if (failed.length) console.log('SMOKE_FAILED=' + JSON.stringify(failed));
    const pass = failed.length === 0;
    console.log('SMOKE_PASS=' + pass);
    app.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('SMOKE_ERROR=' + (err && err.stack || err));
    app.exit(1);
  }
});
