/**
 * atsuggest.js —— 灵感笔记 @联系人联想下拉（UMD，可在 Node 与浏览器中复用）
 *
 * 与 tagsuggest.js 同一套交互范式：
 *  - 输入 @ 或点击工具栏 @ 按钮后，在输入框下方弹出下拉，展示 Q助理联系人
 *  - 继续输入字符时按昵称/备注子串筛选（不区分大小写）
 *  - ↑/↓ 选择、Enter 确认（替换已输入的 @query 为 @昵称 ）、Esc 关闭、点击选择、点击外部关闭
 *
 * 与 # 标签联想共存：触发符不同（@ vs #），同一光标位置只会命中一种输入态，
 * 两个联想各自检查自己的浮层可见性，不会互相抢占键盘事件。
 *
 * 用法（浏览器）：
 *   var detach = AtSuggester.attach(composer, {
 *     loadContacts: function () { return Promise.resolve([{ uid, nickname, remark, avatar }]); }
 *   });
 *   // detach() 在输入框销毁时调用，释放浮层与监听
 *
 * 纯函数（Node require 使用）：
 *   detectAtQuery(text, offset) -> { query, start } | null
 *   filterContacts(contacts, query) -> contact[]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AtSuggester = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** @ 输入态的边界字符：空白 / @ / #（# 留给标签）+ 常见中文标点（输入态在标点处中断） */
  var BOUND_RE = /[\s@#，。！？、；：""''()【】《》]/;

  /** @ 下拉限制：菜单项最多 20 条；浮层可见高度最多 10 行（超出滚动） */
  var MAX_ITEMS = 20;
  var MAX_VISIBLE_ROWS = 10;
  /** 量不到首行高度时的兜底行高（padding 7px*2 + 13.5px 字号行高） */
  var ROW_HEIGHT_FALLBACK = 33;

  /**
   * 检测光标是否处于「@ 输入态」：光标前最近的 @ 与光标之间只有非边界字符，
   * 且 @ 前是行首 / 空白 / 标点（避免把 a@b 邮箱误判为提及）。
   * @param {string} text 原始逻辑文本（未 cleanText，偏移与光标一致）
   * @param {number} offset 光标偏移
   * @returns {{query: string, start: number} | null} query=已输入的昵称片段（可为空串），start=@ 的位置
   */
  function detectAtQuery(text, offset) {
    if (typeof text !== 'string' || typeof offset !== 'number' || offset <= 0) return null;
    var i = offset - 1;
    // 从光标往前扫过昵称字符（非边界）
    while (i >= 0 && !BOUND_RE.test(text.charAt(i))) i--;
    if (i < 0 || text.charAt(i) !== '@') return null;
    // @ 前紧贴非边界字符（如 a@b 的邮箱）不算提及
    if (i > 0 && !BOUND_RE.test(text.charAt(i - 1))) return null;
    var query = text.slice(i + 1, offset);
    return { query: query, start: i };
  }

  /**
   * 按昵称/备注子串筛选联系人（不区分大小写）；query 为空返回全部。
   * @param {object[]} contacts [{ uid, nickname, remark, avatar }]
   * @param {string} query
   * @returns {object[]}
   */
  function filterContacts(contacts, query) {
    if (!Array.isArray(contacts)) return [];
    var q = String(query == null ? '' : query).toLowerCase();
    if (!q) return contacts.slice();
    return contacts.filter(function (c) {
      if (!c) return false;
      if (String(c.nickname || '').toLowerCase().indexOf(q) !== -1) return true;
      if (String(c.remark || '').toLowerCase().indexOf(q) !== -1) return true;
      return false;
    });
  }

  /**
   * 截断联系人列表：@ 下拉菜单项最多 20 条（超出截断，不滚动出更多）。
   * @param {object[]} contacts
   * @param {number} [max] 上限，默认 20
   * @returns {object[]}
   */
  function limitContacts(contacts, max) {
    if (!Array.isArray(contacts)) return [];
    var n = typeof max === 'number' && max >= 0 ? max : MAX_ITEMS;
    return contacts.slice(0, n);
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** link_type → 关系文案（qz friend list 字段，与 qzhuli-cli relation type 一致） */
  var LINK_TYPE_LABELS = { 0: '陌生人', 1: '家人', 2: '朋友', 3: '前同事', 4: '同学', 5: '在职同事' };
  function linkTypeLabel(linkType) {
    return LINK_TYPE_LABELS[linkType] || '';
  }

  /**
   * 给 MarkdownComposer 实例挂载 @联系人联想。
   * composer 需具备：el / value() / rawValue() / caretOffset() / replaceText(start,end,text) / focus()
   * @param {object} composer
   * @param {{loadContacts?: function(): Promise<object[]>}} opts
   * @returns {function} detach —— 卸载浮层与全部监听
   */
  function attach(composer, opts) {
    opts = opts || {};
    var loadContacts = opts.loadContacts || function () { return Promise.resolve([]); };

    var box = null;        // 浮层元素（fixed 定位，挂在 body，独立于编辑器 DOM，reflow 不破坏）
    var queryState = null; // 当前 { query, start }
    var activeIndex = 0;
    var contacts = null;   // 已加载的联系人缓存（首次成功后缓存，避免每次输入都拉 IPC）
    var loading = false;
    var detached = false;

    function ensureBox() {
      if (box) return box;
      box = document.createElement('div');
      box.className = 'tag-suggest at-suggest hidden';
      box.setAttribute('role', 'listbox');
      document.body.appendChild(box);
      // 阻止 mousedown 默认行为，避免点击浮层时输入框失焦导致 blur 抢先关闭
      box.addEventListener('mousedown', function (e) { e.preventDefault(); });
      box.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.tag-suggest-item') : null;
        if (!item || item.classList.contains('disabled')) return;
        activeIndex = Array.prototype.indexOf.call(box.querySelectorAll('.tag-suggest-item'), item);
        pick();
      });
      return box;
    }

    /** 光标（插入符）的视口矩形；无选区或选区不在输入框内时返回 null */
    function caretRect() {
      var sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      var range = sel.getRangeAt(0);
      if (!composer.el.contains(range.startContainer)) return null;
      var r = range.getBoundingClientRect();
      if (!r || (r.left === 0 && r.top === 0 && r.width === 0 && r.height === 0)) return null;
      return r;
    }

    /** 浮层定位：显示在输入光标正下方；光标矩形不可用时回退到输入框底部 */
    function position() {
      if (!box) return;
      var r = caretRect();
      if (!r) {
        r = composer.el.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) return;
      }
      var left = Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8));
      var top = (r.bottom || r.top) + 4;
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      // 可见高度最多 10 行（量首行 item 高度 + 浮层上下 padding 12px），且不超出视口
      var first = box.querySelector('.tag-suggest-item');
      var rowH = first && first.offsetHeight ? first.offsetHeight : ROW_HEIGHT_FALLBACK;
      var tenRows = rowH * MAX_VISIBLE_ROWS + 12;
      var viewportMax = window.innerHeight - top - 12;
      box.style.maxHeight = Math.max(120, Math.min(tenRows, viewportMax)) + 'px';
    }

    function render(list, emptyText) {
      box.innerHTML = '';
      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'tag-suggest-empty';
        empty.textContent = emptyText || '没有匹配的联系人';
        box.appendChild(empty);
        return;
      }
      list.forEach(function (c, idx) {
        var item = document.createElement('div');
        item.className = 'tag-suggest-item' + (idx === activeIndex ? ' active' : '');
        item.setAttribute('role', 'option');
        item.dataset.name = c.nickname || '';
        var at = document.createElement('span');
        at.className = 'at-sign';
        at.textContent = '@';
        var name = document.createElement('span');
        name.textContent = c.nickname || c.remark || '';
        item.appendChild(at);
        item.appendChild(name);
        if (c.remark && c.remark !== c.nickname) {
          var remark = document.createElement('span');
          remark.className = 'at-remark';
          remark.textContent = c.remark;
          item.appendChild(remark);
        }
        var rel = linkTypeLabel(c.linkType);
        if (rel) {
          var relSpan = document.createElement('span');
          relSpan.className = 'at-relation';
          relSpan.textContent = rel;
          item.appendChild(relSpan);
        }
        box.appendChild(item);
      });
    }

    function open(list, state, emptyText) {
      ensureBox();
      queryState = state;
      activeIndex = 0;
      render(list, emptyText);
      box.classList.remove('hidden');
      position();
    }

    function close() {
      queryState = null;
      if (box) box.classList.add('hidden');
    }

    function move(dir) {
      var items = box.querySelectorAll('.tag-suggest-item');
      if (!items.length) return;
      activeIndex = Math.max(0, Math.min(items.length - 1, activeIndex + dir));
      items.forEach(function (it, idx) { it.classList.toggle('active', idx === activeIndex); });
    }

    function pick() {
      if (!queryState || !box) return;
      var items = box.querySelectorAll('.tag-suggest-item');
      var item = items[activeIndex];
      if (!item) { close(); return; }
      var end = composer.caretOffset();
      composer.replaceText(queryState.start, end, '@' + item.dataset.name + ' ');
      close();
      composer.focus();
    }

    /** 联系人准备就绪后按当前 query 刷新列表；加载失败显示占位 */
    function renderWithContacts(state) {
      if (detached || !queryState || queryState.start !== state.start) return; // 光标已移动，丢弃过期结果
      var list = limitContacts(filterContacts(contacts, state.query), MAX_ITEMS);
      if (list.length) open(list, state);
      else open([], state, contacts && contacts.length ? '没有匹配的联系人' : '暂无联系人');
    }

    /** 打开前确保联系人已加载（首次异步拉取，成功后缓存） */
    function ensureContacts(state) {
      if (contacts) { renderWithContacts(state); return; }
      if (loading) return;
      loading = true;
      Promise.resolve()
        .then(function () { return loadContacts(); })
        .then(function (list) {
          loading = false;
          if (!Array.isArray(list)) list = [];
          contacts = list;
          renderWithContacts(state);
        })
        .catch(function (err) {
          loading = false;
          if (detached || !queryState || queryState.start !== state.start) return;
          open([], state, '联系人加载失败');
        });
    }

    /** 重新检测光标位置并刷新下拉；不在 @ 输入态则关闭 */
    function refresh() {
      if (detached) return;
      var text = composer.rawValue();
      var off = composer.caretOffset();
      var st = detectAtQuery(text, off);
      if (!st) { close(); return; }
      // 先记录输入态：联系人异步加载完成前 queryState 也要可用，
      // 否则 renderWithContacts 的过期守卫会误判（加载完前 queryState 恒为 null）
      queryState = st;
      ensureContacts(st);
    }

    function onKeydown(e) {
      if (!box || box.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation(); move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation(); move(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation(); pick();
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation(); close();
      }
    }

    var rafId = null;
    function onReposition() {
      if (rafId) return;
      rafId = window.requestAnimationFrame(function () {
        rafId = null;
        if (detached) return;
        // 下拉处于关闭状态（Esc/失焦/选中后）时，光标移动不重新打开
        if (!box || box.classList.contains('hidden')) return;
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount || !composer.el.contains(sel.getRangeAt(0).startContainer)) {
          close();
          return;
        }
        refresh();
      });
    }

    function onBlur() {
      setTimeout(function () {
        if (detached) return;
        if (!box || box.classList.contains('hidden')) return;
        var ae = document.activeElement;
        if (ae && (composer.el.contains(ae) || box.contains(ae))) return;
        close();
      }, 120);
    }

    function onInput(ev) {
      if (ev && ev.isComposing) return; // IME 组合期间不干扰
      refresh();
    }

    composer.el.addEventListener('input', onInput);
    composer.el.addEventListener('compositionend', onInput);
    composer.el.addEventListener('keydown', onKeydown, true); // 捕获阶段先于 composer 自身处理
    composer.el.addEventListener('blur', onBlur);
    document.addEventListener('selectionchange', onReposition);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);

    // 初次挂载时若光标已在 @ 后（例如编辑态回填内容），立即检测
    refresh();

    return function detach() {
      if (detached) return;
      detached = true;
      composer.el.removeEventListener('input', onInput);
      composer.el.removeEventListener('compositionend', onInput);
      composer.el.removeEventListener('keydown', onKeydown, true);
      composer.el.removeEventListener('blur', onBlur);
      document.removeEventListener('selectionchange', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
      if (rafId) { window.cancelAnimationFrame(rafId); rafId = null; }
      if (box && box.parentNode) box.parentNode.removeChild(box);
      box = null;
    };
  }

  return {
    detectAtQuery: detectAtQuery,
    filterContacts: filterContacts,
    limitContacts: limitContacts,
    linkTypeLabel: linkTypeLabel,
    attach: attach
  };
});
