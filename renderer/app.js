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
    view: 'notes',       // 主视图状态：'notes' 全部笔记 | 'trash' 回收站
    trash: [],           // 回收站列表（含 deletedAt 删除时间）
    trashFailed: false,  // 回收站拉取失败标志（用于空态文案区分）
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
    navDaily: $('#nav-daily'),
    tagList: $('#tag-list'),
    btnTrash: $('#btn-trash'),
    appTitle: $('#app-title'),
    composerZone: $('.composer-zone'),
    btnFeedTop: $('#feed-top'),
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
    toast: $('#toast'),
    checkUpdate: $('#check-update'),
    footerVersion: $('#footer-version'),
    updateBar: $('#update-bar'),
    updateText: $('#update-text'),
    updateProgress: $('#update-progress'),
    updateAction: $('#update-action'),
    updateClose: $('#update-close')
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

    // 导航高亮：回收站视图下「全部笔记」不高亮
    el.navAll.classList.toggle('active', state.view === 'notes' && state.filter === 'all' && !state.tag && !state.day);

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
        const count = document.createElement('span');
        count.className = 'tag-count';
        count.textContent = t.count;
        btn.appendChild(hash); btn.appendChild(name); btn.appendChild(count);
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

  // ---------- 回收站 ----------
  function filteredTrash() {
    let list = state.trash;
    if (state.search.trim()) {
      const q = state.search.trim().toLowerCase();
      list = list.filter((m) => (m.content || '').toLowerCase().includes(q));
    }
    return list;
  }

  function renderTrashList() {
    const list = filteredTrash();
    el.memoList.innerHTML = '';
    if (list.length === 0) {
      el.emptyState.classList.remove('hidden');
      el.emptyState.querySelector('p').textContent = state.trashFailed
        ? '回收站加载失败，点击右上角刷新重试'
        : (state.trash.length > 0 ? '没有符合条件的笔记' : '回收站是空的');
      return;
    }
    el.emptyState.classList.add('hidden');
    const frag = document.createDocumentFragment();
    list.forEach((m) => frag.appendChild(buildTrashCard(m)));
    el.memoList.appendChild(frag);
    if (state.search.trim()) highlightSearch(el.memoList, state.search.trim());
  }

  /** 回收站卡片：头部显示删除时间，正文/图片与普通卡片一致，右上角菜单提供「恢复」 */
  function buildTrashCard(memo) {
    const card = document.createElement('article');
    card.className = 'memo-card trash-card';
    card.dataset.id = memo.id;

    const head = document.createElement('div');
    head.className = 'memo-head';
    const headLeft = document.createElement('div');
    headLeft.className = 'memo-head-left';
    const time = document.createElement('span');
    time.className = 'memo-time';
    time.textContent = '删除于 ' + formatFullTime(memo.deletedAt);
    headLeft.appendChild(time);
    head.appendChild(headLeft);

    const ellipsis = document.createElement('button');
    ellipsis.className = 'memo-ellipsis';
    ellipsis.dataset.action = 'menu';
    ellipsis.title = '更多操作';
    ellipsis.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
    head.appendChild(ellipsis);
    card.appendChild(head);

    // 正文：标签保留在原位置（#标签 原位渲染为绿色）
    const content = document.createElement('div');
    content.className = 'memo-content';
    content.innerHTML = window.Md.render(memo.content || '', { highlightTags: true });
    content.querySelectorAll('.tag-inline').forEach((s) => {
      s.dataset.tag = s.textContent.replace(/^#/, '');
    });
    card.appendChild(content);

    // 图片缩略图（与普通卡片一致，点击 lightbox 看大图）
    const rawImgs = Array.isArray(memo.images) && memo.images.length ? memo.images : [];
    const imgs = rawImgs.length
      ? rawImgs.map((img) => (typeof img === 'string'
        ? { original: img, thumbnail: img, large: img }
        : img))
      : (typeof memo.imageUrl === 'string' && /^(https?:|data:image\/)/i.test(memo.imageUrl.trim())
        ? [{ original: memo.imageUrl.trim(), thumbnail: memo.imageUrl.trim(), large: memo.imageUrl.trim() }]
        : []);
    if (imgs.length) {
      const imagesWrap = document.createElement('div');
      imagesWrap.className = 'memo-images';
      imgs.forEach((img) => {
        const imgEl = document.createElement('img');
        imgEl.className = 'memo-image-thumb';
        imgEl.loading = 'lazy';
        imgEl.alt = '';
        imgEl.src = img.thumbnail || img.original;
        imgEl.dataset.full = img.large || img.original;
        imgEl.addEventListener('click', () => openLightbox(imgEl.dataset.full));
        imagesWrap.appendChild(imgEl);
      });
      card.appendChild(imagesWrap);
    }

    // 右上角菜单：恢复
    const menu = document.createElement('div');
    menu.className = 'memo-menu';
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = '恢复';
    restoreBtn.dataset.action = 'restore';
    menu.appendChild(restoreBtn);
    card.appendChild(menu);

    return card;
  }

  /** 进入回收站视图：隐藏输入区、切换标题、拉取回收站列表 */
  async function enterTrash() {
    if (state.view === 'trash') return;
    state.view = 'trash';
    el.appTitle.textContent = '回收站';
    el.composerZone.classList.add('hidden');
    el.composerZone.classList.remove('collapsed');
    el.btnTrash.classList.add('active');
    state.search = '';
    el.searchInput.value = '';
    resetFeedTop();
    renderAll();
    state.trashFailed = false;
    try {
      const list = await window.ideaNote.sync.trash();
      state.trash = list;
    } catch (err) {
      state.trashFailed = true;
      handleSyncError(err, '加载回收站失败');
    }
    renderAll();
  }

  /** 退出回收站视图：恢复主界面，回到全部笔记 */
  function exitTrash() {
    if (state.view !== 'trash') return;
    state.view = 'notes';
    el.appTitle.textContent = '灵感笔记';
    el.composerZone.classList.remove('hidden');
    el.composerZone.classList.remove('collapsed');
    el.btnTrash.classList.remove('active');
    resetFeedTop();
    renderAll();
  }

  // ===== 图片大图查看（lightbox：按钮缩放 / 鼠标拖拽平移 / 滚轮缩放） =====
  let lightboxEl = null;
  const lbState = {
    scale: 1, tx: 0, ty: 0,
    fitScale: 1,
    needReset: true, // 打开后首次图片就绪时重置视图；用户手动操作后变为 false，避免加载事件覆盖用户缩放
    dragging: false,
    startX: 0, startY: 0, startTx: 0, startTy: 0
  };
  const LB_MIN_SCALE = 0.1;
  const LB_MAX_SCALE = 8;

  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

  function lbApplyTransform() {
    if (!lightboxEl) return;
    const img = lightboxEl.querySelector('.lightbox-img');
    img.style.transform = 'translate(' + lbState.tx + 'px, ' + lbState.ty + 'px) scale(' + lbState.scale + ')';
    const scaleLabel = lightboxEl.querySelector('.lb-scale');
    if (scaleLabel) scaleLabel.textContent = Math.round(lbState.scale * 100) + '%';
  }

  function lbComputeFit() {
    if (!lightboxEl) return 1;
    const img = lightboxEl.querySelector('.lightbox-img');
    const stage = lightboxEl.querySelector('.lightbox-stage');
    const nw = img.naturalWidth || 800;
    const nh = img.naturalHeight || 600;
    const availW = stage.clientWidth * 0.92;
    const availH = stage.clientHeight * 0.88;
    return clamp(Math.min(availW / nw, availH / nh), LB_MIN_SCALE, 1);
  }

  function lbResetView(force) {
    lbState.fitScale = lbComputeFit();
    // 图片加载事件触发时只在用户尚未手动操作过时重置视图；
    // 用户点击"适应"按钮时 force=true 强制重置
    if (force || lbState.needReset) {
      lbState.scale = lbState.fitScale;
      lbState.tx = 0;
      lbState.ty = 0;
      lbState.needReset = false;
    }
    lbApplyTransform();
  }

  // 以鼠标位置为中心缩放：保持鼠标指向的图片点不动
  function lbZoomAt(clientX, clientY, factor) {
    if (!lightboxEl) return;
    lbState.needReset = false;
    const stage = lightboxEl.querySelector('.lightbox-stage');
    const rect = stage.getBoundingClientRect();
    const mx = clientX - rect.left - rect.width / 2;
    const my = clientY - rect.top - rect.height / 2;
    const newScale = clamp(lbState.scale * factor, LB_MIN_SCALE, LB_MAX_SCALE);
    if (newScale === lbState.scale) return;
    const ratio = newScale / lbState.scale;
    lbState.tx = mx - (mx - lbState.tx) * ratio;
    lbState.ty = my - (my - lbState.ty) * ratio;
    lbState.scale = newScale;
    lbApplyTransform();
  }

  function lbZoomIn() {
    lbState.needReset = false;
    lbState.scale = clamp(lbState.scale * 1.25, LB_MIN_SCALE, LB_MAX_SCALE);
    lbApplyTransform();
  }
  function lbZoomOut() {
    lbState.needReset = false;
    lbState.scale = clamp(lbState.scale / 1.25, LB_MIN_SCALE, LB_MAX_SCALE);
    lbApplyTransform();
  }

  function ensureLightbox() {
    if (lightboxEl) return lightboxEl;
    lightboxEl = document.createElement('div');
    lightboxEl.id = 'image-lightbox';
    lightboxEl.innerHTML =
      '<div class="lightbox-backdrop"></div>' +
      '<div class="lightbox-stage">' +
        '<img class="lightbox-img" alt="" draggable="false" />' +
      '</div>' +
      '<div class="lightbox-toolbar">' +
        '<button type="button" class="lb-btn" data-action="zoom-out" title="缩小"><i class="fa-solid fa-magnifying-glass-minus"></i></button>' +
        '<span class="lb-scale">100%</span>' +
        '<button type="button" class="lb-btn" data-action="zoom-in" title="放大"><i class="fa-solid fa-magnifying-glass-plus"></i></button>' +
        '<button type="button" class="lb-btn" data-action="reset" title="适应窗口">适应</button>' +
        '<button type="button" class="lb-btn lb-close" data-action="close" title="关闭"><i class="fa-solid fa-xmark"></i></button>' +
      '</div>';
    document.body.appendChild(lightboxEl);

    const stage = lightboxEl.querySelector('.lightbox-stage');
    const img = lightboxEl.querySelector('.lightbox-img');

    // 点击遮罩关闭（点击图片/舞台不关闭）
    lightboxEl.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);

    // 工具栏按钮：逐个直接绑定（不用事件委托，避免 e.target 边界问题）
    const bindLbBtn = (action, handler) => {
      const btn = lightboxEl.querySelector('.lightbox-toolbar [data-action="' + action + '"]');
      if (btn) btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        handler();
      });
    };
    bindLbBtn('zoom-in', lbZoomIn);
    bindLbBtn('zoom-out', lbZoomOut);
    bindLbBtn('reset', () => lbResetView(true));
    bindLbBtn('close', closeLightbox);

    // 鼠标滚轮缩放（以鼠标位置为中心）
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      lbZoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    // 鼠标拖拽平移
    stage.addEventListener('mousedown', (e) => {
      lbState.dragging = true;
      lbState.startX = e.clientX;
      lbState.startY = e.clientY;
      lbState.startTx = lbState.tx;
      lbState.startTy = lbState.ty;
      stage.classList.add('dragging');
    });
    document.addEventListener('mousemove', (e) => {
      if (!lbState.dragging) return;
      lbState.needReset = false;
      lbState.tx = lbState.startTx + (e.clientX - lbState.startX);
      lbState.ty = lbState.startTy + (e.clientY - lbState.startY);
      lbApplyTransform();
    });
    document.addEventListener('mouseup', () => {
      if (lbState.dragging) {
        lbState.dragging = false;
        stage.classList.remove('dragging');
      }
    });

    // 图片加载完成 / 失败后计算适应比例（在 openLightbox 里按 once 绑定，避免后续加载重置用户缩放）

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightboxEl && lightboxEl.classList.contains('open')) closeLightbox();
    });

    return lightboxEl;
  }

  function openLightbox(src) {
    const box = ensureLightbox();
    const img = box.querySelector('.lightbox-img');
    // 重置状态
    lbState.scale = 1; lbState.tx = 0; lbState.ty = 0; lbState.fitScale = 1;
    lbState.needReset = true;
    lbApplyTransform();
    // 每次打开时绑定一次 load/error：图片就绪后计算适应比例，触发后自动移除，
    // 避免后续加载事件把用户的手动缩放/平移重置掉
    img.addEventListener('load', lbResetView, { once: true });
    img.addEventListener('error', lbResetView, { once: true });
    img.src = src || '';
    box.classList.add('open');
    // 图片已缓存时立即计算适应比例
    if (img.complete && img.naturalWidth > 0) lbResetView();
  }

  function closeLightbox() {
    if (lightboxEl) lightboxEl.classList.remove('open');
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

    // 图片：卡片内只展示七牛小缩略图，点击打开 lightbox 看大图
    // 兼容三种数据形态：新格式对象数组 / 旧格式字符串数组 / 更老的 imageUrl 单图
    const rawImgs = Array.isArray(memo.images) && memo.images.length ? memo.images : [];
    const imgs = rawImgs.length
      ? rawImgs.map((img) => (typeof img === 'string'
        ? { original: img, thumbnail: img, large: img }
        : img))
      : (typeof memo.imageUrl === 'string' && /^(https?:|data:image\/)/i.test(memo.imageUrl.trim())
        ? [{ original: memo.imageUrl.trim(), thumbnail: memo.imageUrl.trim(), large: memo.imageUrl.trim() }]
        : []);
    if (imgs.length) {
      const imagesWrap = document.createElement('div');
      imagesWrap.className = 'memo-images';
      imgs.forEach((img) => {
        const el = document.createElement('img');
        el.className = 'memo-image-thumb';
        el.loading = 'lazy';
        el.alt = '';
        el.src = img.thumbnail || img.original;
        el.dataset.full = img.large || img.original;
        el.addEventListener('click', () => openLightbox(el.dataset.full));
        imagesWrap.appendChild(el);
      });
      card.appendChild(imagesWrap);
    }

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
    const widgetBtn = document.createElement('button');
    widgetBtn.textContent = '展示到桌面';
    widgetBtn.dataset.action = 'widget';
    widgetBtn.title = '推送到桌面小组件展示';
    const delBtn = document.createElement('button');
    delBtn.textContent = state.pendingDeleteId === String(memo.id) ? '确认删除？' : '删除';
    delBtn.dataset.action = 'delete';
    delBtn.classList.add('danger');
    menu.appendChild(editBtn); menu.appendChild(widgetBtn); menu.appendChild(delBtn);
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
    // 标签联想：与顶部输入框同一套交互
    const detachSuggester = window.TagSuggester.attach(composer, {
      getTags: () => window.Tags.countByMemos(state.memos).map((t) => t.name)
    });

    async function saveEdit(val) {
      if (!val || !val.trim()) return;
      try {
        const updated = await window.ideaNote.sync.update(memo.id, val);
        detachSuggester();
        state.editingId = null;
        upsertLocal(updated);
      } catch (err) {
        handleSyncError(err, '保存失败');
      }
    }
    function cancelEdit() {
      detachSuggester();
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

  // ---------- 自动更新 ----------
  // 更新状态：getInfo 快照 + 实时事件（updater:event）
  const updaterInfo = { enabled: false, currentVersion: '', autoDownload: true };
  let updateDismissedVersion = null;  // 用户忽略的版本号（不再重复提示）
  let updateShownVersion = null;      // 更新条当前展示的版本
  let updateActionMode = null;        // 'download' | 'restart'

  function showUpdateBar(text, mode) {
    el.updateBar.classList.remove('hidden');
    el.updateText.textContent = text;
    if (mode) {
      updateActionMode = mode;
      el.updateAction.classList.remove('hidden');
      el.updateAction.textContent = (mode === 'restart') ? '重启并安装' : '下载更新';
    } else {
      updateActionMode = null;
      el.updateAction.classList.add('hidden');
    }
  }

  function hideUpdateBar() {
    el.updateBar.classList.add('hidden');
    el.updateProgress.classList.add('hidden');
    el.updateAction.classList.add('hidden');
    updateActionMode = null;
  }

  function handleUpdateEvent(payload) {
    const ev = payload && payload.event;
    if (ev === 'checking') {
      if (payload.manual) showToast('正在检查更新…');
    } else if (ev === 'available') {
      if (payload.version && payload.version === updateDismissedVersion) return;
      if (payload.version && payload.version === updaterInfo.currentVersion) return; // 防御：版本未变
      updateShownVersion = payload.version;
      showUpdateBar('发现新版本 v' + payload.version,
        updaterInfo.autoDownload ? null : 'download');
    } else if (ev === 'downloading') {
      el.updateBar.classList.remove('hidden');
      el.updateText.textContent = '正在下载更新…';
      el.updateAction.classList.add('hidden');
      el.updateProgress.classList.remove('hidden');
      el.updateProgress.textContent = (payload.percent || 0) + '%';
    } else if (ev === 'downloaded') {
      updateShownVersion = payload.version;
      el.updateBar.classList.remove('hidden');
      el.updateText.textContent = '新版本 v' + (payload.version || '') + ' 已就绪';
      el.updateProgress.classList.add('hidden');
      showUpdateBar('新版本已就绪，重启后生效', 'restart');
    } else if (ev === 'not-available') {
      if (payload.manual) showToast('已是最新版本');
    } else if (ev === 'error') {
      hideUpdateBar();
      showToast('更新失败：' + (payload.message || '网络异常，请稍后再试'));
    }
  }

  async function initUpdaterUi() {
    try {
      const info = await window.ideaNote.updater.getInfo();
      updaterInfo.enabled = !!info.enabled;
      updaterInfo.currentVersion = info.currentVersion || '';
      updaterInfo.autoDownload = info.autoDownload !== false;
      el.footerVersion.textContent = 'v' + updaterInfo.currentVersion;
    } catch (e) { /* 老版本 preload 无 updater 接口时静默降级 */ }
    window.ideaNote.updater.onStatus(handleUpdateEvent);
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

  // ---------- 同步失败处理：只提示 + 自动重试，绝不自动登出 ----------
  // Electron IPC 序列化错误时自定义属性会丢失，鉴权类错误统一带 [AUTH] 前缀标记
  function isAuthError(err) {
    if (!err) return false;
    if (err.code === 401) return true;
    const msg = err.message || '';
    return msg.indexOf('[AUTH]') >= 0 || msg.indexOf('登录凭证已失效') >= 0;
  }

  let authRetryTimer = null;
  let authRetryAttempt = 0;
  // 连续收到「凭证已失效」的次数：qz 层已自愈可恢复的 401（重换 H5 token 重试一次），
  // 能到渲染层的 [AUTH] 登录凭证已失效 = 扩展端凭证被服务端判死，自动重试不可能成功，
  // 连续确认 2 次（防网关偶发 5xx 误判）后引导用户重新扫码登录，而不是无限静默重试。
  let authExpiredStreak = 0;
  const AUTH_RETRY_DELAYS_MS = [30000, 120000, 300000]; // 30s / 2min / 5min

  function cancelAuthRetry() {
    if (authRetryTimer) {
      clearTimeout(authRetryTimer);
      authRetryTimer = null;
    }
    authRetryAttempt = 0;
    authExpiredStreak = 0;
  }

  /** 服务端明确判死扩展端凭证（换取 H5 token 被拒）——必须重新扫码登录才能恢复 */
  function isAuthExpired(err) {
    if (!err) return false;
    return (err.message || '').indexOf('登录凭证已失效') >= 0;
  }

  /** 鉴权类失败：静默排队自动重试，恢复后自动回到在线状态 */
  function scheduleAuthRetry() {
    if (!state.authed) return;
    const delay = AUTH_RETRY_DELAYS_MS[Math.min(authRetryAttempt, AUTH_RETRY_DELAYS_MS.length - 1)];
    authRetryAttempt += 1;
    clearTimeout(authRetryTimer);
    authRetryTimer = setTimeout(async () => {
      authRetryTimer = null;
      authRetryAttempt = 0;
      try {
        await loadData(false);
      } catch (e) { /* loadData 内部已处理 */ }
    }, delay);
  }

  /** 服务类异常（网络失败/超时/网关 5xx）：凭证未失效，静默重试等恢复即可 */
  function isRetryableServiceError(err) {
    if (!err || isAuthError(err)) return false;
    const msg = err.message || '';
    if (msg.indexOf('网络请求失败') >= 0 || msg.indexOf('超时') >= 0 || msg.indexOf('HTTP 5') >= 0) return true;
    return typeof err.code === 'number' && (err.code < 0 || err.code >= 500);
  }

  function handleSyncError(err, fallback) {
    if (isAuthError(err)) {
      if (isAuthExpired(err)) {
        authExpiredStreak += 1;
        // 连续 2 次确认凭证已失效：重试无意义，引导重新扫码登录
        if (authExpiredStreak >= 2) {
          cancelAuthRetry();
          showToast('登录状态已失效，请重新扫码登录');
          showLogin();
          startQr();
          return;
        }
        showToast('同步暂时中断，正在自动恢复…');
        scheduleAuthRetry();
        return;
      }
      // 只在首次失败时提示一次；后续自动重试保持静默
      if (authRetryAttempt === 0) showToast('同步暂时中断，正在自动恢复…');
      scheduleAuthRetry();
    } else if (isRetryableServiceError(err)) {
      // 服务端瞬时故障（5xx/超时/断网）：自动重试，恢复后自动回到在线状态
      if (authRetryAttempt === 0) showToast('同步暂时中断，正在自动恢复…');
      scheduleAuthRetry();
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
      cancelAuthRetry(); // 同步成功：清除自动重试
      return true;
    } catch (err) {
      handleSyncError(err, '同步失败，正在展示本地缓存');
      return false;
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
    if (state.view === 'trash') renderTrashList();
    else renderList();
    // 内容渲染完成后刷新滚动条定位与尺寸
    positionFeedScrollbar();
    updateFeedScrollbar();
    // 渲染可能导致 scrollTop 重置（筛选/搜索等），同步输入区压缩态
    updateComposerCollapsed();
  }

  // ---------- 事件 ----------
  function bindEvents() {
    // 所见即所得 Markdown 输入框（ideaNote 风格，保留源标记）
    state.composer = window.MarkdownComposer(el.composer, {
      render: (text) => window.Md.renderWysiwyg(text),
      onCommit: async () => { await saveMemo(); }
    });
    // 标签联想：输入 # 或点击工具栏 # 后弹出待选标签，输入字符实时筛选
    window.TagSuggester.attach(state.composer, {
      getTags: () => window.Tags.countByMemos(state.memos).map((t) => t.name)
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
        // 回收站卡片上的标签：退出回收站并筛选该标签
        exitTrash();
        state.filter = 'tag';
        state.tag = tagBtn.dataset.tag;
        resetFeedTop();
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
      } else if (action === 'widget') {
        // 展示到桌面：把这条笔记推送到桌面小组件
        const memo = state.memos.find((m) => String(m.id) === String(id));
        if (memo) {
          closeMenus();
          try {
            await window.ideaNote.widget.push(memo);
            showToast('已推送到桌面小组件');
          } catch (err) {
            console.error('widget push failed', err);
            showToast('推送失败');
          }
        }
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
      } else if (action === 'restore') {
        // 回收站：恢复笔记（可逆操作，直接执行）
        try {
          await window.ideaNote.sync.restore(id);
          state.trash = state.trash.filter((m) => String(m.id) !== String(id));
          showToast('已恢复到全部笔记');
          renderAll();
          // 刷新主列表与本地缓存：恢复后笔记按原排序位置回归（串行等待，避免并发刷新互相覆盖）
          await loadData(false);
        } catch (err) {
          handleSyncError(err, '恢复失败');
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
      exitTrash(); // 标签筛选只作用于全部笔记
      if (state.filter === 'tag' && state.tag === btn.dataset.tag) {
        state.filter = 'all';
        state.tag = null;
      } else {
        state.filter = 'tag';
        state.tag = btn.dataset.tag;
      }
      resetFeedTop();
      renderAll();
    });

    // 导航
    el.navAll.addEventListener('click', () => {
      exitTrash();
      state.filter = 'all'; state.tag = null; state.day = null; state.search = '';
      el.searchInput.value = '';
      resetFeedTop();
      renderAll();
    });
    el.navDaily.addEventListener('click', () => {
      exitTrash();
      openRoam();
    });

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
      exitTrash(); // 按天筛选只作用于全部笔记
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
        resetFeedTop();
        renderAll();
      }, 200);
    });
    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        el.searchInput.value = '';
        state.search = '';
        resetFeedTop();
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

    // 刷新同步：全部笔记视图拉主列表；回收站视图重新拉回收站
    el.syncRefresh.addEventListener('click', async () => {
      el.syncRefresh.classList.add('spinning');
      try {
        if (state.view === 'trash') {
          state.trashFailed = false;
          try {
            const list = await window.ideaNote.sync.trash();
            state.trash = list;
            showToast('已同步');
          } catch (err) {
            state.trashFailed = true;
            handleSyncError(err, '加载回收站失败');
          }
          renderAll();
        } else {
          const ok = await loadData(false);
          if (ok) showToast('已同步');
        }
      } catch (e) { /* 错误已由 handleSyncError 提示 */ }
      setTimeout(() => el.syncRefresh.classList.remove('spinning'), 600);
    });

    // 筛选按钮 → 聚焦搜索
    el.btnFilter.addEventListener('click', () => {
      el.searchInput.focus();
      el.searchInput.select();
    });

    // 回收站：进入/退出回收站视图
    el.btnTrash.addEventListener('click', () => {
      if (state.view === 'trash') exitTrash();
      else enterTrash();
    });

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

    // 检查更新（手动）
    el.checkUpdate.addEventListener('click', async () => {
      try {
        const r = await window.ideaNote.updater.check();
        if (!r || !r.ok) showToast((r && r.message) || '检查更新失败');
        else if (r.message) showToast(r.message);
      } catch (e) {
        showToast('检查更新失败');
      }
    });
    // 更新条操作：下载更新 / 重启并安装
    el.updateAction.addEventListener('click', async () => {
      try {
        const r = updateActionMode === 'restart'
          ? await window.ideaNote.updater.install()
          : await window.ideaNote.updater.download();
        if (!r || !r.ok) showToast((r && r.message) || '操作失败，请重试');
      } catch (e) {
        showToast('操作失败，请重试');
      }
    });
    // 忽略本次更新
    el.updateClose.addEventListener('click', () => {
      if (updateShownVersion) updateDismissedVersion = updateShownVersion;
      hideUpdateBar();
    });

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
    sbFeed.addEventListener('scroll', function () {
      updateFeedScrollbar();
      updateComposerCollapsed();
      updateFeedTopBtn();
    }, { passive: true });
    window.addEventListener('resize', function () { positionFeedScrollbar(); updateFeedScrollbar(); });
    positionFeedScrollbar();
    updateFeedScrollbar();
    lastFeedTop = sbFeed.getBoundingClientRect().top;

    // 回到顶部：向下滚动超过阈值显示按钮，点击平滑回顶
    var btnFeedTop = el.btnFeedTop;
    if (btnFeedTop) {
      btnFeedTop.addEventListener('click', function () {
        if (sbFeed) sbFeed.scrollTo({ top: 0, behavior: 'smooth' });
      });
      updateFeedTopBtn();
    }

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

  // ---------- 导航/筛选切换时右侧列表回到顶部 ----------
  // 点击「全部笔记」、标签、inline 标签或搜索时，内容重排前先把滚动位置归零；
  // scroll 事件会自动同步输入框压缩态（恢复原样）与回到顶部按钮（隐藏）
  function resetFeedTop() {
    const feed = document.querySelector('.feed');
    if (feed) feed.scrollTop = 0;
  }

  // ---------- 回到顶部浮动按钮显隐 ----------
  // 向下滚动超过 280px 显示（避开输入区压缩阈值 100px，避免刚压缩就闪现）；回到顶部附近隐藏
  function updateFeedTopBtn() {
    var btn = el.btnFeedTop;
    if (!btn || !sbFeed) return;
    btn.classList.toggle('show', sbFeed.scrollTop > 280);
  }

  // ---------- 顶部输入区滚动联动压缩（第二屏离开顶部压缩、回到顶部恢复） ----------
  // 输入区高度变化会移动 feed 视口位置（flex 布局联动）；ResizeObserver 感知尺寸变化后
  // 反向补偿 scrollTop，让视口内内容保持在屏幕原位（配合 CSS overflow-anchor:none），
  // 滚动时页面不抖动。压缩态下：输入框空 → 一行 + 工具栏；非空 → 内容行数 + 工具栏。
  var composerZone = document.querySelector('.composer-zone');
  var lastFeedTop = null;

  function updateComposerCollapsed() {
    if (!sbFeed || !composerZone) return;
    if (composerZone.classList.contains('collapsed')) {
      // 已压缩：只有真正滚回顶部（scrollTop <= 0）才恢复。
      // 阈值带滞后（压缩 2px / 恢复 0px），避免向上微滚时输入框反复回弹。
      if (sbFeed.scrollTop <= 0) {
        composerZone.classList.remove('collapsed');
        // 输入区高度变化后 feed 尺寸变化，刷新自绘滚动条定位与尺寸
        positionFeedScrollbar();
        updateFeedScrollbar();
      }
    } else if (sbFeed.scrollTop > 100) {
      // 未压缩：离开顶部足够远才压缩。阈值（100px）大于输入区压缩高度差（约 94px），
      // 保证压缩动画期间 ResizeObserver 补偿不会把 scrollTop 拉回 0（否则立即触发恢复，
      // 造成「压缩→补偿归零→恢复」的抖动循环）；同时顶部附近微滚不触发压缩，
      // 上滑一点点（未真正回顶）输入框保持压缩不回弹。
      composerZone.classList.add('collapsed');
      positionFeedScrollbar();
      updateFeedScrollbar();
    }
  }

  if (composerZone && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () {
      if (!sbFeed) return;
      var top = sbFeed.getBoundingClientRect().top;
      if (lastFeedTop !== null && composerZone.classList.contains('collapsed')) {
        var d = top - lastFeedTop;   // 视口移动量（压缩上移为负，输入增高下移为正）
        if (d !== 0 && sbFeed.scrollTop > 0) {
          // 反向补偿：视口移动 d 时 scrollTop 同步移动 d，内容保持在屏幕原位。
          // 补偿后若 <= 0（滚动位置不足时压缩），放弃本次补偿，避免触发恢复误判造成抖动
          var ns = sbFeed.scrollTop + d;
          if (ns > 0) sbFeed.scrollTop = ns;
        }
      }
      lastFeedTop = top;
    }).observe(composerZone);
  }

  async function saveMemo() {
    if (state.view === 'trash') return; // 回收站视图下输入区已隐藏，防御
    const val = state.composer.value();
    if (!val.trim()) return;
    try {
      const memo = await window.ideaNote.sync.create(val);
      state.composer.clear();
      upsertLocal(memo);
      // 标签视图下发无标签（或不含当前标签）的笔记：该笔记在当前视图被过滤不可见，
      // 自动跳回「全部笔记」并定位到新笔记（新笔记按时间排序恒为列表第一条 → 回到顶部即可）
      if (state.filter === 'tag' && state.tag && !(memo.tags || []).includes(state.tag)) {
        state.filter = 'all';
        state.tag = null;
        state.day = null;
        renderAll();
        sbFeed.scrollTop = 0;
        positionFeedScrollbar();
        updateFeedScrollbar();
      }
      state.composer.focus();
    } catch (err) {
      handleSyncError(err, '保存失败');
    }
  }

  // ---------- 启动 ----------
  async function init() {
    bindEvents();
    initUpdaterUi();
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

  // ---------- 即时 tooltip（替代原生 title，hover 立即显示，无系统延迟） ----------
  (function () {
    var tipEl = document.createElement('div');
    tipEl.className = 'ui-tooltip';
    document.body.appendChild(tipEl);
    var cur = null;

    function showTip(el) {
      var text = el.getAttribute('data-tip') || '';
      if (!text) return;
      tipEl.textContent = text;
      tipEl.classList.add('show');
      var r = el.getBoundingClientRect();
      var tr = tipEl.getBoundingClientRect();
      var left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      var top = r.top - tr.height - 8;
      if (top < 8) top = r.bottom + 8; // 上方放不下时移到下方
      tipEl.style.left = left + 'px';
      tipEl.style.top = top + 'px';
    }

    function hideTip() {
      tipEl.classList.remove('show');
      cur = null;
    }

    // 事件委托：进入/切换 data-tip 元素立即显示；进入普通区域隐藏
    document.addEventListener('mouseover', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) {
        if (t !== cur) { cur = t; showTip(t); }
      } else if (cur) {
        hideTip();
      }
    });
    // 移出窗口隐藏（mouseover 已覆盖元素间切换，这里兜底 relatedTarget 为 null）
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget && cur) hideTip();
    });
    window.addEventListener('resize', hideTip);
    window.addEventListener('scroll', hideTip, true);
  })();
})();
