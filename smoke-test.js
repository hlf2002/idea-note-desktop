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
const http = require('http');
const { initApp } = require('./app-core');

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
function makeMockCli() {
  const sentMessages = [];
  return {
    async isAvailable() { return { ok: true, binPath: '/mock/qz' }; },
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

      // 图片渲染：mock 的 image_url 是假七牛域名（必然加载失败）→ 应降级为占位且保留原地址
      out.hasLightbox = !!document.getElementById('image-lightbox');
      out.imgCount = document.querySelectorAll('.memo-image-thumb').length;
      const brokenImg = document.querySelector('.memo-image-missing[data-src]');
      out.brokenSrc = brokenImg ? brokenImg.getAttribute('data-src') : null;
      out.imgHasThumbParam = !!(out.brokenSrc || '').indexOf('imageView2/2/w/180') >= 0;

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

    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'screenshot.png'), image.toPNG());

    // 磁盘验证：登录态已持久化 + 缓存已写入
    const authOnDisk = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : null;
    const cacheOnDisk = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : null;
    console.log('SMOKE_AUTH_UID=' + (authOnDisk ? authOnDisk.q_uid : 'null'));
    console.log('SMOKE_CACHE_COUNT=' + (cacheOnDisk && cacheOnDisk.memos ? cacheOnDisk.memos.length : -1));

    // 磁盘验证：图片本地副本 + 映射索引
    const mediaIndexFile = path.join(tmpDir, 'media-index.json');
    const mediaIndexOnDisk = fs.existsSync(mediaIndexFile)
      ? JSON.parse(fs.readFileSync(mediaIndexFile, 'utf8')) : null;
    const uploadedName = mediaIndexOnDisk ? mediaIndexOnDisk['img_uploaded'] : null;
    const mediaFileOnDisk = !!(uploadedName && fs.existsSync(path.join(tmpDir, 'media', uploadedName)));
    const mediaFileBytes = mediaFileOnDisk ? fs.statSync(path.join(tmpDir, 'media', uploadedName)).size : -1;
    console.log('SMOKE_MEDIA=' + JSON.stringify({ uploadedName, mediaFileOnDisk, mediaFileBytes }));

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
      /^https:\/\/.+imageView2\/2\/w\/180/.test(result.brokenSrc || '') &&
      result.imgHasThumbParam &&
      result.mdOk && result.tagsOk &&
      result.listEnterOk && result.listExitOk && result.beginListOk &&
      // 图片上传链路
      !!result.upload && result.upload.imageId === 'img_uploaded' &&
      result.mediaFileName === 'img_uploaded.png' &&
      result.localThumbCount >= 1 &&
      /^file:\/\//.test(result.localThumbSrc || '') &&
      result.protocolImageLoaded === true &&
      result.lightboxOpen === true && result.lightboxClosed === true &&
      result.missingBadgeCount >= 1 &&
      mediaFileOnDisk && mediaFileBytes === SMOKE_PNG.length &&
      uploadedName === 'img_uploaded.png' &&
      authOnDisk && authOnDisk.q_uid === 'q10001' &&
      !!authOnDisk.access_token && !!authOnDisk.refresh_token &&
      cacheOnDisk && cacheOnDisk.memos.length === 2 &&
      // 标签联想交互（窗口显示后跑）
      editResult.editOpen === true &&
      editResult.suggestShownOnEnter === true &&
      editResult.suggestClosedAfterMove === true &&
      editResult.editCanceled === true &&
      !editResult.tagSuggestErr &&
      // @联系人联想 + 提及通知
      atResult.atShown1 === true &&
      atResult.atItemCount === 20 &&
      /测试联系人/.test(atResult.atFirstName || '') &&
      atResult.atFirstRelation === '朋友' &&
      atResult.atVisibleRowsOk === true &&
      atResult.atScrollable === true &&
      atResult.atClosedAfterEsc === true &&
      atResult.notifyOk === true &&
      atResult.notifySentCount === 1 &&
      atResult.notifySentName === '测试联系人' &&
      pageUrlPassedToCli === true &&
      // @ 分享页删除联动：删除含 @ 笔记时 unpublish 收到对应 id
      unpublishCalls.includes(String(atResult.mentionsCreatedId || '')) &&
      !atResult.atErr;

    console.log('SMOKE_PASS=' + pass);
    app.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('SMOKE_ERROR=' + (err && err.stack || err));
    app.exit(1);
  }
});
