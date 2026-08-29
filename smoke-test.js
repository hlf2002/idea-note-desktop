/**
 * smoke-test.js —— Electron 集成冒烟测试（扫码登录 + 灵感笔记同步，mock API）
 * 用注入的 mock QzApi 验证完整链路：
 *   扫码创建 -> 轮询 confirmed -> 登录态持久化 -> 渲染层自动进入主视图
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

// ---- mock QzApi（模拟 Q助理服务端） ----
function makeMockApi() {
  let auth = null;
  const now = Math.floor(Date.now() / 1000);
  const store = [
    { id: 2, plain_text: '今天第一条 **重点** #生活', tags: ['生活'], create_time: now - 3600, update_time: now - 3600, image_url: '' },
    { id: 1, plain_text: '昨天旧笔记 #灵感', tags: ['灵感'], create_time: now - 86400 - 3600, update_time: now - 86400 - 3600, image_url: '' }
  ];
  let nextId = 100;
  return {
    get isAuthed() { return !!auth; },
    setAuth(a) { auth = a; },
    qrLoginCreate: async (type) => ({ scene_id: 'mock-scene-1', expires_in: 300, api_client_type: type }),
    qrLoginStatus: async (sceneId) => {
      if (sceneId === 'mock-scene-1') {
        return {
          status: 'confirmed',
          api_client_type: 3,
          login_data: { id: 1, uid: 'u10001', cid: 'c10001', nickname: '测试用户', real_name: '', avatar: '', token: 'mock-token-abc', tk: 'pc_mock_tk' }
        };
      }
      return { status: 'pending' };
    },
    getIdeaList: async ({ page }) => {
      if (page === 1) return { list: store.slice(), has_more: false };
      return { list: [], has_more: false };
    },
    saveIdea: async (payload) => {
      const item = {
        id: payload.id || nextId++,
        plain_text: payload.plain_text,
        tags: payload.tags || [],
        create_time: payload.id ? now - 86400 : now,
        update_time: now,
        image_url: ''
      };
      const idx = store.findIndex((s) => s.id === item.id);
      if (idx >= 0) store[idx] = item; else store.push(item);
      return item;
    },
    deleteIdea: async (id) => {
      const idx = store.findIndex((s) => s.id === id);
      if (idx >= 0) store.splice(idx, 1);
      return null;
    }
  };
}

app.whenReady().then(async () => {
  try {
    const authFile = path.join(tmpDir, 'auth.json');
    const cacheFile = path.join(tmpDir, 'idea-cache.json');
    const legacyFile = path.join(tmpDir, 'flomo-local.json');
    const mockApi = makeMockApi();

    initApp({ authFile, cacheFile, legacyFile, dataDir: tmpDir, apiOverride: mockApi });

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

    await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // 等待：渲染层 init -> 自动 startQr -> 3s 轮询 -> confirmed -> 主视图 -> 拉数据渲染
    await new Promise((r) => setTimeout(r, 4500));

    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      out.loginHidden = document.getElementById('login-view').classList.contains('hidden');
      out.appVisible = !document.getElementById('app-view').classList.contains('hidden');
      out.userName = document.getElementById('user-name').textContent;
      out.cardCount = document.querySelectorAll('.memo-card').length;
      out.dayTitles = Array.from(document.querySelectorAll('.day-title')).map(e => e.textContent);
      out.sidebarTagCount = document.querySelectorAll('.tag-item').length;
      out.memoCount = document.getElementById('stat-memos').textContent;

      // 登录态 API
      const auth = await window.ideaNote.auth.get();
      out.authUid = auth ? auth.uid : null;
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

      // Md / Tags 可用
      out.mdOk = window.Md.render('**b**').includes('<strong>b</strong>');
      out.tagsOk = window.Tags.extractTags('#a #b').length === 2;

      // 输入框列表逻辑（浏览器环境跑同一套纯函数）
      out.listErr = null;
      try {
        out.listEnterOk = window.MarkdownComposer.enterAt('1. a', 4).text === '1. a\\n2. ';
        out.listExitOk = window.MarkdownComposer.enterAt('- a\\n- ', 6).text === '- a\\n';
        out.beginListOk = window.MarkdownComposer.beginListAt('hello', 5, '- ').text === 'hello\\n- ';
      } catch (e) {
        out.listErr = String((e && e.message) || e);
      }
      return out;
    })()`);

    console.log('SMOKE_RESULT=' + JSON.stringify(result));

    // 截图（登录后主界面）
    win.show();
    win.focus();
    await new Promise((r) => setTimeout(r, 500));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot.png'), image.toPNG());

    // 磁盘验证：登录态已持久化 + 缓存已写入
    const authOnDisk = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : null;
    const cacheOnDisk = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
    console.log('SMOKE_AUTH_UID=' + (authOnDisk ? authOnDisk.uid : 'null'));
    console.log('SMOKE_CACHE_COUNT=' + (cacheOnDisk && cacheOnDisk.memos ? cacheOnDisk.memos.length : -1));

    const pass =
      result.loginHidden && result.appVisible &&
      result.userName === '测试用户' &&
      result.cardCount === 2 &&
      result.sidebarTagCount === 2 &&
      result.authUid === 'u10001' &&
      result.authNickname === '测试用户' &&
      !!result.createdId && JSON.stringify(result.createdTags) === JSON.stringify(['测试']) &&
      result.updatedContent === '已改 #改过' &&
      result.pullCount === 2 &&
      result.filteredCardCount === 1 &&
      result.mdOk && result.tagsOk &&
      result.listEnterOk && result.listExitOk && result.beginListOk &&
      authOnDisk && authOnDisk.uid === 'u10001' &&
      cacheOnDisk && cacheOnDisk.memos.length === 2;

    console.log('SMOKE_PASS=' + pass);
    app.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('SMOKE_ERROR=' + (err && err.stack || err));
    app.exit(1);
  }
});
