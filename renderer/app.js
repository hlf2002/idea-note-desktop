/**
 * app.js —— 渲染层逻辑（ideaNote 风格 · Q助理灵感笔记桌面客户端）
 * 依赖：window.ideaNote（preload）、window.Tags、window.Md
 *
 * 视图状态机：
 *  未登录 -> 登录视图（扫码 + 轮询）
 *  已登录 -> 主视图（侧边栏统计/热力图/标签 + 主区笔记流，数据源 Q助理灵感笔记）
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const QR_POLL_MS = 3000;

  const state = {
    authed: false,
    user: null,
    memos: [],
    filter: 'all',
    tag: null,
    day: null,           // 按天筛选：'YYYY-MM-DD'，点击热力图格子设置
    search: '',
    editingId: null,
    pendingDeleteId: null,
    roamStack: [],
    pollTimer: null,
    pollSceneId: null,
    composer: null
  };

  const el = {
    loginView: $('#login-view'),
    appView: $('#app-view'),
    qrImage: $('#qr-image'),
    qrLoading: $('#qr-loading'),
    qrStatus: $('#qr-status'),
    qrExpire: $('#qr-expire'),
    qrRefresh: $('#qr-refresh'),
    userAvatar: $('#user-avatar'),
    userName: $('#user-name'),
    syncRefresh: $('#sync-refresh'),
    userMenu: $('#user-menu'),
    userMenuBtn: $('#user-menu-btn'),
    userMenuBackdrop: $('#user-menu-backdrop'),
    userDropdownLogout: $('#user-dropdown-logout'),
    statMemos: $('#stat-memos'),
    statTags: $('#stat-tags'),
    statDays: $('#stat-days'),
    hmMonths: $('#hm-months'),
    heatmapGrid: $('#heatmap-grid'),
    heatmapTip: $('#heatmap-tip'),
    navAll: $('#nav-all'),
    navWechat: $('#nav-wechat'),
    navDaily: $('#nav-daily'),
    tagList: $('#tag-list'),
    btnTrash: $('#btn-trash'),
    openDataPath: $('#open-data-path'),
    searchInput: $('#search-input'),
    btnFilter: $('#btn-filter'),
    composer: $('#composer'),
    composerSend: $('#composer-send'),
    tbTag: $('#tb-tag'),
    tbImage: $('#tb-image'),
    tbFont: $('#tb-font'),
    tbUl: $('#tb-ul'),
    tbOl: $('#tb-ol'),
    tbAt: $('#tb-at'),
    memoList: $('#memo-list'),
    emptyState: $('#empty-state'),
    legacyBar: $('#legacy-bar'),
    legacyImport: $('#legacy-import'),
    roamMask: $('#roam-mask'),
    roamDate: $('#roam-date'),
    roamContent: $('#roam-content'),
    roamNext: $('#roam-next'),
    toast: $('#toast')
  };

  // ---------- 工具 ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** ideaNote 风格完整时间：2026-08-20 13:51:06 */
  function formatFullTime(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + week[d.getDay()];
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let toastTimer = null;
  function showToast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms || 2600);
  }

  // ---------- 视图切换 ----------
  function showLogin() {
    state.authed = false;
    el.appView.classList.add('hidden');
    el.loginView.classList.remove('hidden');
  }

  function showApp(user) {
    state.authed = true;
    state.user = user;
    el.loginView.classList.add('hidden');
    el.appView.classList.remove('hidden');
    el.userName.textContent = user.nickname || '用户';
    if (user.avatar) el.userAvatar.src = user.avatar;
    else el.userAvatar.removeAttribute('src');
  }

  // ---------- 扫码登录 ----------
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollSceneId = null;
  }

  async function startQr() {
    stopPolling();
    el.qrImage.style.display = 'none';
    el.qrLoading.classList.remove('hidden');
    el.qrStatus.textContent = '正在生成二维码…';
    el.qrStatus.className = 'qr-status';
    el.qrExpire.textContent = '';
    try {
      const qr = await window.ideaNote.qr.create();
      el.qrImage.src = qr.qrDataUrl;
      el.qrImage.style.display = 'block';
      el.qrLoading.classList.add('hidden');
      el.qrStatus.textContent = '等待扫码…';
      el.qrExpire.textContent = '二维码 ' + Math.round(qr.expiresIn / 60) + ' 分钟内有效';
      state.pollSceneId = qr.sceneId;
      state.pollTimer = setInterval(() => pollOnce(qr.sceneId), QR_POLL_MS);
    } catch (err) {
      el.qrLoading.classList.add('hidden');
      el.qrStatus.textContent = '二维码生成失败，请点击刷新';
      el.qrStatus.className = 'qr-status error';
    }
  }

  async function pollOnce(sceneId) {
    if (state.pollSceneId !== sceneId) return; // 已被刷新/停止
    try {
      const res = await window.ideaNote.qr.status(sceneId);
      if (state.pollSceneId !== sceneId) return;
      if (res.status === 'pending') {
        el.qrStatus.textContent = '等待扫码…';
        el.qrStatus.className = 'qr-status';
      } else if (res.status === 'scanned') {
        el.qrStatus.textContent = '已扫码，请在手机上确认登录';
        el.qrStatus.className = 'qr-status';
      } else if (res.status === 'confirmed') {
        stopPolling();
        el.qrStatus.textContent = '登录成功！';
        el.qrStatus.className = 'qr-status success';
        const user = await window.ideaNote.auth.get();
        if (user) {
          showApp(user);
          showToast('登录成功，正在同步灵感笔记…');
          await loadData(true);
          checkLegacy();
        }
      } else if (res.status === 'used') {
        stopPolling();
        el.qrStatus.textContent = '登录已完成';
        el.qrStatus.className = 'qr-status success';
      } else if (res.status === 'expired') {
        stopPolling();
        el.qrStatus.textContent = '二维码已过期，请刷新';
        el.qrStatus.className = 'qr-status error';
      }
    } catch (err) {
      // 单次轮询失败不中断，继续尝试（网络抖动）
      if (err && err.code === 401) {
        stopPolling();
        el.qrStatus.textContent = '会话失效，请刷新二维码';
        el.qrStatus.className = 'qr-status error';
      }
    }
  }

  // ---------- 数据 ----------
  function filteredMemos() {
    let list = state.memos;
    if (state.filter === 'tag' && state.tag) {
      list = list.filter((m) => (m.tags || []).includes(state.tag));
    }
    if (state.day) {
      list = list.filter((m) => dayKey(m.createdAt) === state.day);
    }
    if (state.search.trim()) {
      const q = state.search.trim().toLowerCase();
      list = list.filter((m) => (m.content || '').toLowerCase().includes(q));
    }
    return list;
  }

  // ---------- 侧边栏渲染 ----------
  function renderSidebar() {
    // 统计：笔记 / 标签 / 有记录的天数
    el.statMemos.textContent = state.memos.length;
    const counts = window.Tags.countByMemos(state.memos);
    el.statTags.textContent = counts.length;
    const days = new Set(state.memos.map((m) => dayKey(m.createdAt)));
    el.statDays.textContent = days.size;

    // 打卡热力图（最近 3 个自然月，GitHub 风格）
    renderHeatmap();

    // 导航高亮
    el.navAll.classList.toggle('active', state.filter === 'all' && !state.tag && !state.day);

    // 标签列表
    el.tagList.innerHTML = '';
    if (counts.length === 0) {
      const li = document.createElement('li');
      li.textContent = '暂无标签';
      li.style.cssText = 'padding:7px 12px;font-size:12.5px;color:#a08a70;';
      el.tagList.appendChild(li);
    } else {
      counts.forEach((t) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'tag-item' + (state.filter === 'tag' && state.tag === t.name ? ' active' : '');
        btn.dataset.tag = t.name;
        const hash = document.createElement('span');
        hash.className = 'tag-hash';
        hash.textContent = '#';
        const name = document.createElement('span');
        name.textContent = t.name;
        btn.appendChild(hash); btn.appendChild(name);
        li.appendChild(btn);
        el.tagList.appendChild(li);
      });
    }
  }

  /** 打卡热力图：固定 12 列（最近 12 周），周一起点，与设计稿一致 */
  function renderHeatmap() {
    const now = new Date();

    const byDay = {};
    state.memos.forEach((m) => {
      const d = new Date(m.createdAt);
      const k = dayKey(d.getTime());
      byDay[k] = (byDay[k] || 0) + 1;
    });

    // 固定 12 列：以「今天所在周的周日」为终点，往前推 11 周（77 天）得到起点
    const weekEnd = new Date(now);
    const dowToday = (weekEnd.getDay() + 6) % 7; // 周一=0
    weekEnd.setDate(weekEnd.getDate() - dowToday + 6); // 本周日
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekStart.getDate() - 77); // 11 周前
    const cols = [];
    const cur = new Date(weekStart);
    for (let w = 0; w < 12; w++) {
      const col = [];
      for (let i = 0; i < 7; i++) {
        const k = dayKey(cur.getTime());
        col.push({ key: k, count: byDay[k] || 0 });
        cur.setDate(cur.getDate() + 1);
      }
      cols.push(col);
    }

    const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

    // 月份标签：顶部横排，出现的月份均匀分布（与设计稿 justify-between 一致）
    const monthSet = [];
    cols.forEach((col) => {
      const m = parseInt(col[0].key.split('-')[1], 10) - 1;
      if (!monthSet.includes(m)) monthSet.push(m);
    });
    el.hmMonths.innerHTML = monthSet.map((m) =>
      '<span>' + monthNames[m] + '</span>').join('');

    // 网格：12 列 × 7 行
    el.heatmapGrid.innerHTML = '';
    cols.forEach((col) => {
      const colWrap = document.createElement('div');
      colWrap.className = 'heatmap-col';
      col.forEach((cell) => {
        const cellEl = document.createElement('div');
        let cls = 'heatmap-cell';
        if (cell.count > 0) {
          // 1~4 条逐级加深，≥5 条用 lv5（primary 色）
          const lv = Math.min(5, cell.count);
          cls += ' lv' + lv;
          cls += ' has-data';
          cellEl.dataset.key = cell.key;
          cellEl.dataset.count = String(cell.count);
          if (state.day === cell.key) cls += ' active';
          cellEl.title = cell.key + '：' + cell.count + ' 条';
        }
        cellEl.className = cls;
        colWrap.appendChild(cellEl);
      });
      el.heatmapGrid.appendChild(colWrap);
    });
  }

  // ---------- 笔记列表渲染 ----------
  function renderList() {
    const list = filteredMemos();
    el.memoList.innerHTML = '';

    if (list.length === 0) {
      el.emptyState.classList.remove('hidden');
      el.emptyState.querySelector('p').textContent = state.memos.length > 0
        ? '没有符合条件的笔记'
        : '写下第一条想法吧';
      return;
    }
    el.emptyState.classList.add('hidden');

    const frag = document.createDocumentFragment();
    list.forEach((m) => frag.appendChild(buildCard(m)));
    el.memoList.appendChild(frag);

    if (state.search.trim()) highlightSearch(el.memoList, state.search.trim());
  }

  function buildCard(memo) {
    const card = document.createElement('article');
    card.className = 'memo-card';
    card.dataset.id = memo.id;

    // dataset.id 为字符串，memo.id 为数字，统一按字符串比较
    if (state.editingId === String(memo.id)) {
      card.classList.add('editing');
      card.appendChild(buildEditor(memo));
      return card;
    }

    // 头部：置顶 + 时间 + ellipsis 菜单按钮
    const head = document.createElement('div');
    head.className = 'memo-head';
    const headLeft = document.createElement('div');
    headLeft.className = 'memo-head-left';
    if (memo.pinned) {
      const pin = document.createElement('span');
      pin.className = 'memo-pin';
      pin.textContent = '置顶';
      headLeft.appendChild(pin);
    }
    const time = document.createElement('span');
    time.className = 'memo-time';
    time.textContent = formatFullTime(memo.createdAt);
    headLeft.appendChild(time);
    head.appendChild(headLeft);

    const ellipsis = document.createElement('button');
    ellipsis.className = 'memo-ellipsis';
    ellipsis.dataset.action = 'menu';
    ellipsis.title = '更多操作';
    ellipsis.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    head.appendChild(ellipsis);
    card.appendChild(head);

    // 正文：标签保留在内容原位置（#标签 原位渲染为绿色，不单独放置）
    const content = document.createElement('div');
    content.className = 'memo-content';
    const text = memo.content || '';
    content.innerHTML = window.Md.render(text, { highlightTags: true });
    // 给 inline 标签补 dataset，支持点击筛选
    content.querySelectorAll('.tag-inline').forEach((s) => {
      s.dataset.tag = s.textContent.replace(/^#/, '');
    });
    card.appendChild(content);

    // 引用块（关联其他笔记）
    if (memo.refText) {
      const ref = document.createElement('div');
      ref.className = 'memo-ref';
      ref.innerHTML = '<i class="fa-solid fa-link"></i><span class="memo-ref-text"></span>';
      ref.querySelector('.memo-ref-text').textContent = memo.refText;
      card.appendChild(ref);
    }

    // 操作浮层菜单
    const menu = document.createElement('div');
    menu.className = 'memo-menu';
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑';
    editBtn.dataset.action = 'edit';
    const delBtn = document.createElement('button');
    delBtn.textContent = state.pendingDeleteId === String(memo.id) ? '确认删除？' : '删除';
    delBtn.dataset.action = 'delete';
    delBtn.classList.add('danger');
    menu.appendChild(editBtn); menu.appendChild(delBtn);
    card.appendChild(menu);

    return card;
  }

  function buildEditor(memo) {
    const wrap = document.createElement('div');
    wrap.style.width = '100%';

    // 完全复用顶部输入框结构：composer-inner > composer-card > composer + composer-toolbar
    const inner = document.createElement('div');
    inner.className = 'composer-inner';
    inner.style.width = '100%';
    inner.style.maxWidth = 'none';

    const card = document.createElement('div');
    card.className = 'composer-card memo-edit-card';

    const editEl = document.createElement('div');
    editEl.className = 'composer';
    editEl.contentEditable = 'true';
    editEl.spellcheck = false;
    editEl.dataset.placeholder = '编辑内容…';

    // 工具栏与顶部完全一致；右侧在发送按钮旁新增「取消」
    const tb = document.createElement('div');
    tb.className = 'composer-toolbar';
    tb.innerHTML =
      '<div class="toolbar-left">' +
        '<button type="button" class="tool-btn" data-edit-tool="tag" title="标签"><i class="fa-solid fa-hashtag"></i></button>' +
        '<button type="button" class="tool-btn" data-edit-tool="image" title="图片"><i class="fa-regular fa-image"></i></button>' +
        '<div class="tool-divider"></div>' +
        '<button type="button" class="tool-btn font-btn" data-edit-tool="font" title="字体">Aa</button>' +
        '<button type="button" class="tool-btn" data-edit-tool="ul" title="无序列表"><i class="fa-solid fa-list"></i></button>' +
        '<button type="button" class="tool-btn" data-edit-tool="ol" title="有序列表"><i class="fa-solid fa-list-ol"></i></button>' +
        '<div class="tool-divider"></div>' +
        '<button type="button" class="tool-btn" data-edit-tool="at" title="@"><i class="fa-solid fa-at"></i></button>' +
      '</div>' +
      '<div class="toolbar-right">' +
        '<button type="button" class="composer-cancel" data-edit-tool="cancel" title="取消">取消</button>' +
        '<button type="button" class="composer-send" data-edit-tool="save" title="保存"><i class="fa-solid fa-paper-plane"></i></button>' +
      '</div>';

    card.appendChild(editEl);
    card.appendChild(tb);
    inner.appendChild(card);
    wrap.appendChild(inner);

    // 初始化 composer（与顶部同一套：所见即所得、⌘/⇧+Enter 提交）
    const composer = window.MarkdownComposer(editEl, {
      render: (text) => window.Md.renderWysiwyg(text),
      onCommit: (text) => { saveEdit(text); }
    });
    composer.setValue(memo.content);

    async function saveEdit(val) {
      if (!val || !val.trim()) return;
      try {
        const updated = await window.ideaNote.sync.update(memo.id, val);
        state.editingId = null;
        upsertLocal(updated);
      } catch (err) {
        handleSyncError(err, '保存失败');
      }
    }
    function cancelEdit() {
      state.editingId = null;
      renderList();
    }

    // 工具栏：行为与顶部输入框完全一致
    tb.querySelector('[data-edit-tool="tag"]').addEventListener('click', () => composer.insertText(' #'));
    tb.querySelector('[data-edit-tool="image"]').addEventListener('click', () => showToast('图片上传 · 敬请期待'));
    tb.querySelector('[data-edit-tool="font"]').addEventListener('click', () => showToast('支持 Markdown 语法：**加粗**、*斜体*、`代码`'));
    tb.querySelector('[data-edit-tool="ul"]').addEventListener('click', () => composer.insertText('- '));
    tb.querySelector('[data-edit-tool="ol"]').addEventListener('click', () => composer.insertText('1. '));
    tb.querySelector('[data-edit-tool="at"]').addEventListener('click', () => showToast('提及 · 敬请期待'));
    tb.querySelector('[data-edit-tool="save"]').addEventListener('click', () => saveEdit(composer.value()));
    tb.querySelector('[data-edit-tool="cancel"]').addEventListener('click', cancelEdit);
    // Esc 取消（composer 只处理 Enter，这里兜底）
    editEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });

    return wrap;
  }

  function highlightSearch(container, keyword) {
    const re = new RegExp(escapeRegExp(keyword), 'gi');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const text = node.nodeValue;
      if (!text) return;
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement('mark');
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  // ---------- 漫游 / 每日回顾 ----------
  function openRoam() {
    if (state.memos.length === 0) { showToast('还没有可回顾的内容'); return; }
    el.roamMask.classList.remove('hidden');
    showRoam();
  }
  function showRoam() {
    const total = state.memos.length;
    let idx;
    do {
      idx = Math.floor(Math.random() * total);
    } while (state.roamStack.length && state.roamStack[state.roamStack.length - 1] === idx && total > 1);
    state.roamStack.push(idx);
    if (state.roamStack.length > 20) state.roamStack.shift();
    const memo = state.memos[idx];
    el.roamDate.textContent = formatFullTime(memo.createdAt);
    el.roamContent.innerHTML = window.Md.render(memo.content || '');
  }
  function closeRoam() {
    el.roamMask.classList.add('hidden');
  }

  // ---------- 同步操作 ----------
  function upsertLocal(memo) {
    const idx = state.memos.findIndex((m) => m.id === memo.id);
    if (idx >= 0) state.memos[idx] = memo;
    else state.memos.push(memo);
    state.memos.sort((a, b) => b.createdAt - a.createdAt);
    renderAll();
  }

  function removeLocal(id) {
    // id 可能为字符串（来自 dataset.id），与数字 memo.id 统一比较
    state.memos = state.memos.filter((m) => String(m.id) !== id);
    renderAll();
  }

  function handleSyncError(err, fallback) {
    if (err && err.code === 401) {
      showToast('登录已失效，请重新登录');
      setTimeout(() => { window.ideaNote.auth.logout().then(() => { showLogin(); startQr(); }); }, 800);
    } else {
      showToast((err && err.message) || fallback);
    }
  }

  async function loadData(showProgress) {
    // 先展示本地缓存（离线/快速启动），再拉服务端刷新
    try {
      const cached = await window.ideaNote.sync.cache();
      if (cached && cached.length) {
        state.memos = cached;
        renderAll();
      }
    } catch (e) { /* 缓存失败忽略 */ }

    try {
      const memos = await window.ideaNote.sync.pull();
      state.memos = memos;
      renderAll();
    } catch (err) {
      handleSyncError(err, '同步失败，正在展示本地缓存');
    }
  }

  // ---------- 旧数据导入 ----------
  async function checkLegacy() {
    try {
      const has = await window.ideaNote.sync.hasLegacy();
      if (has) el.legacyBar.classList.remove('hidden');
    } catch (e) { /* noop */ }
  }

  // ---------- 渲染入口 ----------
  function renderAll() {
    renderSidebar();
    renderList();
    // 内容渲染完成后刷新滚动条定位与尺寸
    positionFeedScrollbar();
    updateFeedScrollbar();
  }

  // ---------- 事件 ----------
  function bindEvents() {
    // 所见即所得 Markdown 输入框（ideaNote 风格，保留源标记）
    state.composer = window.MarkdownComposer(el.composer, {
      render: (text) => window.Md.renderWysiwyg(text),
      onCommit: async () => { await saveMemo(); }
    });
    el.composer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        state.composer.clear();
      }
    });
    el.composerSend.addEventListener('click', async () => { await saveMemo(); });

    el.memoList.addEventListener('click', async (e) => {
      const tagBtn = e.target.closest('.tag-inline, .memo-tag');
      if (tagBtn) {
        state.filter = 'tag';
        state.tag = tagBtn.dataset.tag;
        renderAll();
        return;
      }
      const menuBtn = e.target.closest('.memo-ellipsis');
      if (menuBtn) {
        const card = menuBtn.closest('.memo-card');
        const menu = card.querySelector('.memo-menu');
        const isOpen = menu.classList.contains('open');
        closeMenus();
        if (!isOpen) {
          menu.classList.add('open');
          menuBtn.classList.add('open');
        }
        return;
      }
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;
      const card = actionBtn.closest('.memo-card');
      const id = card.dataset.id;
      const action = actionBtn.dataset.action;
      if (action === 'edit') {
        closeMenus();
        state.editingId = id;
        renderList();
      } else if (action === 'delete') {
        if (state.pendingDeleteId === id) {
          // 二次确认：真正删除
          try {
            await window.ideaNote.sync.remove(id);
            state.pendingDeleteId = null;
            closeMenus();
            removeLocal(id);
          } catch (err) {
            handleSyncError(err, '删除失败');
          }
        } else {
          // 第一次点击：进入确认态。保持菜单打开，按钮直接变为「确认删除？」，用户再点一次即删除
          state.pendingDeleteId = id;
          actionBtn.textContent = '确认删除？';
          setTimeout(() => {
            if (state.pendingDeleteId === id) {
              state.pendingDeleteId = null;
              if (actionBtn.isConnected) actionBtn.textContent = '删除';
            }
          }, 2500);
        }
      }
    });
    // 点击外部关闭菜单
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.memo-ellipsis') && !e.target.closest('.memo-menu')) closeMenus();
    });

    function closeMenus() {
      el.memoList.querySelectorAll('.memo-menu.open').forEach((m) => m.classList.remove('open'));
      el.memoList.querySelectorAll('.memo-ellipsis.open').forEach((b) => b.classList.remove('open'));
    }

    el.tagList.addEventListener('click', (e) => {
      const btn = e.target.closest('.tag-item');
      if (!btn) return;
      if (state.filter === 'tag' && state.tag === btn.dataset.tag) {
        state.filter = 'all';
        state.tag = null;
      } else {
        state.filter = 'tag';
        state.tag = btn.dataset.tag;
      }
      renderAll();
    });

    // 导航
    el.navAll.addEventListener('click', () => {
      state.filter = 'all'; state.tag = null; state.day = null; state.search = '';
      el.searchInput.value = '';
      renderAll();
    });
    el.navWechat.addEventListener('click', () => showToast('微信输入 · 敬请期待'));
    el.navDaily.addEventListener('click', openRoam);

    // 热力图：hover 提示（日期 + 条数）+ 点击按天筛选
    el.heatmapGrid.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('.heatmap-cell.has-data');
      if (!cell) return;
      const tip = el.heatmapTip;
      tip.innerHTML = '<b>' + cell.dataset.key + '</b><br>' + cell.dataset.count + ' 条笔记';
      tip.classList.remove('hidden');
      const r = cell.getBoundingClientRect();
      const pad = 10;
      let left = r.right + pad;
      if (left + tip.offsetWidth > window.innerWidth - 4) {
        left = r.left - pad - tip.offsetWidth; // 靠右时移到格子左侧
      }
      let top = r.top + (r.height - tip.offsetHeight) / 2;
      top = Math.max(4, Math.min(top, window.innerHeight - tip.offsetHeight - 4));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    });
    el.heatmapGrid.addEventListener('mouseout', (e) => {
      if (e.target.closest('.heatmap-cell.has-data')) el.heatmapTip.classList.add('hidden');
    });
    el.heatmapGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.heatmap-cell.has-data');
      if (!cell) return;
      const key = cell.dataset.key;
      // 再次点击同一天：取消筛选
      state.day = (state.day === key) ? null : key;
      const feed = document.querySelector('.feed');
      if (feed) feed.scrollTop = 0;
      renderAll();
    });

    // 搜索（顶部，⌘K 聚焦）
    let debounceTimer = null;
    el.searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.search = el.searchInput.value;
        if (state.search.trim()) {
          state.filter = 'all';
          state.tag = null;
        }
        renderAll();
      }, 200);
    });
    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        el.searchInput.value = '';
        state.search = '';
        renderAll();
      }
    });
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        el.searchInput.focus();
        el.searchInput.select();
      }
    });

    // 漫游遮罩
    el.roamMask.addEventListener('click', (e) => {
      if (e.target === el.roamMask || e.target.classList.contains('roam-close')) closeRoam();
    });
    el.roamNext.addEventListener('click', (e) => {
      e.stopPropagation();
      showRoam();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.roamMask.classList.contains('hidden')) closeRoam();
    });

    // 登录视图
    el.qrRefresh.addEventListener('click', startQr);

    // 用户菜单（头像 + 昵称下拉）：点外部关闭，退出项登出
    // openMenu/closeMenu 同步切换 documentElement.menu-open：
    // 菜单打开时临时禁用顶栏拖拽区（titlebar/main-header），否则真实鼠标点击拖拽区会被原生窗口逻辑吞掉、JS 收不到
    function openMenu() {
      el.userMenu.classList.add('open');
      document.documentElement.classList.add('menu-open');
    }
    function closeMenu() {
      el.userMenu.classList.remove('open');
      document.documentElement.classList.remove('menu-open');
    }
    el.userMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.userMenu.classList.contains('open')) closeMenu();
      else openMenu();
    });
    // 全屏遮罩：打开时铺满窗口，点击任何位置（含拖拽区/不冒泡元素）先命中遮罩收起
    el.userMenuBackdrop.addEventListener('click', closeMenu);
    // mousedown 捕获阶段兜底：先于目标元素任何 stopPropagation 触发
    document.addEventListener('mousedown', (e) => {
      if (!el.userMenu.contains(e.target)) closeMenu();
    }, true);
    // click 兜底：覆盖 mousedown 被系统/拖拽区等拦截但仍产生 click 的路径
    document.addEventListener('click', (e) => {
      if (!el.userMenu.contains(e.target)) closeMenu();
    });
    el.userDropdownLogout.addEventListener('click', async () => {
      closeMenu();
      try { await window.ideaNote.auth.logout(); } catch (e) { /* noop */ }
      state.memos = [];
      renderAll();
      showLogin();
      startQr();
    });

    // 刷新同步
    el.syncRefresh.addEventListener('click', async () => {
      el.syncRefresh.classList.add('spinning');
      try {
        await loadData(false);
        showToast('已同步');
      } catch (e) { /* loadData 已处理错误 */ }
      setTimeout(() => el.syncRefresh.classList.remove('spinning'), 600);
    });

    // 筛选按钮 → 聚焦搜索
    el.btnFilter.addEventListener('click', () => {
      el.searchInput.focus();
      el.searchInput.select();
    });

    // 回收站
    el.btnTrash.addEventListener('click', () => showToast('回收站 · 敬请期待'));

    // 输入工具条：插入 markdown 语法；列表按钮按"行首起列表"语义插入
    el.tbTag.addEventListener('click', () => state.composer.insertText(' #'));
    el.tbUl.addEventListener('click', () => state.composer.beginList('- '));
    el.tbOl.addEventListener('click', () => state.composer.beginList('1. '));
    el.tbImage.addEventListener('click', () => showToast('图片上传 · 敬请期待'));
    el.tbFont.addEventListener('click', () => showToast('支持 Markdown 语法：**加粗**、*斜体*、`代码`'));
    el.tbAt.addEventListener('click', () => showToast('提及 · 敬请期待'));

    // 旧数据导入
    el.legacyImport.addEventListener('click', async () => {
      el.legacyImport.disabled = true;
      el.legacyImport.textContent = '导入中…';
      try {
        const r = await window.ideaNote.sync.importLegacy();
        el.legacyBar.classList.add('hidden');
        showToast('已导入 ' + (r && r.imported || 0) + ' 条记录');
        await loadData(false);
      } catch (err) {
        handleSyncError(err, '导入失败');
      } finally {
        el.legacyImport.disabled = false;
        el.legacyImport.textContent = '立即导入';
      }
    });

    // 数据目录
    el.openDataPath.addEventListener('click', () => window.ideaNote.app.openDataPath());

    // 全局快捷键/托盘唤起
    window.ideaNote.app.onFocusInput(() => {
      if (!document.hidden && state.authed) {
        state.composer.focus();
      }
    });

    // 自绘 overlay 滚动条：hover 显示、随滚动同步位置，不占内容宽度
    initFeedScrollbar();
  }

  // ---------- 自绘 overlay 滚动条（模块级，内容渲染后可随时刷新）----------
  var sbFeed = null, sbBar = null, sbThumb = null;
  function positionFeedScrollbar() {
    if (!sbFeed || !sbBar) return;
    const main = document.querySelector('.main');
    if (!main) return;
    const feedRect = sbFeed.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    sbBar.style.top = (feedRect.top - mainRect.top + 24) + 'px';
    sbBar.style.height = (feedRect.height - 48) + 'px';
  }
  function updateFeedScrollbar() {
    if (!sbFeed || !sbBar || !sbThumb) return;
    const sh = sbFeed.scrollHeight, ch = sbFeed.clientHeight;
    if (sh <= ch + 1) { sbThumb.style.height = '0'; return; }
    const trackH = sbBar.clientHeight;
    const thH = Math.max(24, (ch / sh) * trackH);
    sbThumb.style.height = thH + 'px';
    const maxTop = Math.max(0, trackH - thH);
    const top = (sbFeed.scrollTop / (sh - ch)) * maxTop;
    sbThumb.style.top = top + 'px';
  }
  function initFeedScrollbar() {
    sbFeed = document.querySelector('.feed');
    sbBar = document.getElementById('feed-scrollbar');
    sbThumb = sbBar && sbBar.querySelector('.feed-scrollbar-thumb');
    if (!sbFeed || !sbBar || !sbThumb) return;
    sbFeed.addEventListener('mouseenter', function () { sbFeed.classList.add('scroll-hover'); updateFeedScrollbar(); });
    sbFeed.addEventListener('mouseleave', function () { sbFeed.classList.remove('scroll-hover'); });
    sbFeed.addEventListener('scroll', updateFeedScrollbar, { passive: true });
    window.addEventListener('resize', function () { positionFeedScrollbar(); updateFeedScrollbar(); });
    positionFeedScrollbar();
    updateFeedScrollbar();

    // 拖拽滚动条滚动内容
    var dragging = false, dragStartY = 0, dragStartScroll = 0;
    sbThumb.addEventListener('mousedown', function (e) {
      e.preventDefault();
      dragging = true;
      dragStartY = e.clientY;
      dragStartScroll = sbFeed.scrollTop;
      document.body.style.userSelect = 'none';
      sbFeed.classList.add('scroll-hover');
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const sh = sbFeed.scrollHeight, ch = sbFeed.clientHeight;
      if (sh <= ch + 1) return;
      const trackH = sbBar.clientHeight;
      const thH = parseFloat(sbThumb.style.height) || 24;
      const maxTop = Math.max(0, trackH - thH);
      if (maxTop <= 0) return;
      const dY = e.clientY - dragStartY;
      sbFeed.scrollTop = dragStartScroll + (dY / maxTop) * (sh - ch);
    });
    window.addEventListener('mouseup', function () {
      if (dragging) { dragging = false; document.body.style.userSelect = ''; }
    });
  }

  async function saveMemo() {
    const val = state.composer.value();
    if (!val.trim()) return;
    try {
      const memo = await window.ideaNote.sync.create(val);
      state.composer.clear();
      upsertLocal(memo);
      state.composer.focus();
    } catch (err) {
      handleSyncError(err, '保存失败');
    }
  }

  // ---------- 启动 ----------
  async function init() {
    bindEvents();
    let user = null;
    try {
      user = await window.ideaNote.auth.get();
    } catch (e) { /* noop */ }

    if (user) {
      showApp(user);
      await loadData(true);
      checkLegacy();
    } else {
      showLogin();
      startQr();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
