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

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { initApp } = require('./app-core');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-note-smoke-'));
app.setPath('userData', tmpDir); // 独立数据目录，不污染真实数据

// ---- mock QzOpenApi（模拟开放平台 + 中转服务） ----
function makeMockApi() {
  let auth = null;
  const now = Math.floor(Date.now() / 1000);
  const store = [
    { id: 2, plain_text: '今天第一条 **重点** #生活', tags: ['生活'], create_time: now - 3600, update_time: now - 3600, images: [], image_url: '' },
    { id: 1, plain_text: '昨天旧笔记 #灵感', tags: ['灵感'], create_time: now - 86400 - 3600, update_time: now - 86400 - 3600, images: ['img_mock_1'], image_url: 'https://res.qzhuli.com/test/note-1.jpg' }
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
      return { image_id: 'img_uploaded', upload_url: 'https://upload.qiniup.com/', token: 'tk', max_size: 10485760, mime_type: 'image/png' };
    }
  };
}

app.whenReady().then(async () => {
  try {
    const authFile = path.join(tmpDir, 'auth.json');
    const cacheFile = path.join(tmpDir, 'idea-cache.json');
    const legacyFile = path.join(tmpDir, 'flomo-local.json');
    const mockApi = makeMockApi();

    const core = initApp({ authFile, cacheFile, legacyFile, dataDir: tmpDir, apiOverride: mockApi });

    const win = new BrowserWindow({
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

    win.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer]', level, message);
    });
    win.webContents.on('preload-error', (_e, p, err) => {
      console.log('[preload-error]', p, err && err.message);
    });

    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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

      // 图片渲染：旧数据带 image_url 的仍应渲染缩略图（开放平台新数据只有 image_id，暂不展示）
      out.hasLightbox = !!document.getElementById('image-lightbox');
      out.imgCount = document.querySelectorAll('.memo-image-thumb').length;
      const firstImg = document.querySelector('.memo-image-thumb');
      out.firstImgSrc = firstImg ? firstImg.getAttribute('src') : null;
      out.imgHasThumbParam = !!(firstImg && firstImg.getAttribute('src').indexOf('imageView2/2/w/180') >= 0);

      if (firstImg) {
        firstImg.click();
        await wait(200);
      }
      const lbEl = document.getElementById('image-lightbox');
      if (lbEl) {
        out.lightboxOpen = lbEl.classList.contains('open');
        const closeBtn = document.querySelector('#image-lightbox [data-action="close"]');
        if (closeBtn) closeBtn.click();
        out.lightboxClosed = !lbEl.classList.contains('open');
      } else {
        out.lightboxOpen = false;
        out.lightboxClosed = false;
      }

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
      } catch (e) { return { __smokeError: String((e && e.stack) || e), __partial: out }; }
      return out;
    })()`);

    console.log('SMOKE_RESULT=' + JSON.stringify(result));
    if (result.__smokeError) console.log('SMOKE_JS_ERROR=' + result.__smokeError);

    // 截图（登录后主界面）
    win.show();
    win.focus();
    await new Promise((r) => setTimeout(r, 500));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot.png'), image.toPNG());

    // 磁盘验证：登录态已持久化 + 缓存已写入
    const authOnDisk = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : null;
    const cacheOnDisk = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
    console.log('SMOKE_AUTH_UID=' + (authOnDisk ? authOnDisk.q_uid : 'null'));
    console.log('SMOKE_CACHE_COUNT=' + (cacheOnDisk && cacheOnDisk.memos ? cacheOnDisk.memos.length : -1));

    const pass =
      result.loginHidden && result.appVisible &&
      result.userName === '测试用户' &&
      result.cardCount === 2 &&
      result.sidebarTagCount === 2 &&
      result.authUid === 'q10001' &&
      result.authNickname === '测试用户' &&
      !!result.createdId && JSON.stringify(result.createdTags) === JSON.stringify(['测试']) &&
      result.updatedContent === '已改 #改过' &&
      result.pullCount === 2 &&
      result.filteredCardCount === 1 &&
      result.trashCardCount === 0 &&
      result.trashTitle === '回收站' &&
      /暂未开放回收站/.test(result.trashEmptyText) &&
      result.cardCountAfterBack === 2 &&
      result.imgCount === 1 &&
      result.imgHasThumbParam &&
      result.lightboxOpen && result.lightboxClosed &&
      result.mdOk && result.tagsOk &&
      result.listEnterOk && result.listExitOk && result.beginListOk &&
      authOnDisk && authOnDisk.q_uid === 'q10001' &&
      !!authOnDisk.access_token && !!authOnDisk.refresh_token &&
      cacheOnDisk && cacheOnDisk.memos.length === 2;

    console.log('SMOKE_PASS=' + pass);
    app.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('SMOKE_ERROR=' + (err && err.stack || err));
    app.exit(1);
  }
});
