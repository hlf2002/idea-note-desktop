/**
 * tagsuggest.js —— 灵感笔记标签联想下拉（UMD，可在 Node 与浏览器中复用）
 *
 * 功能：
 *  - 输入 # 或点击工具栏 # 按钮后，在输入框下方弹出下拉，展示全部待选标签
 *  - 继续输入字符时按子串筛选相关标签（不区分大小写）
 *  - ↑/↓ 选择、Enter 确认（替换已输入的 #query 为 #标签 ）、Esc 关闭、点击选择、点击外部关闭
 *
 * 用法（浏览器）：
 *   var detach = TagSuggester.attach(composer, { getTags: function () { return ['工作', '灵感']; } });
 *   // detach() 在输入框销毁时调用，释放浮层与监听
 *
 * 纯函数（Node require 使用）：
 *   detectTagQuery(text, offset) -> { query, start } | null
 *   filterTags(tags, query) -> string[]
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TagSuggester = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 与 tags.js 标签规则一致：中文/字母/数字/下划线/连字符
  var TAG_CHAR_RE = /[\u4e00-\u9fa5A-Za-z0-9_-]/;

  /**
   * 检测光标是否处于「标签输入态」：光标前最近的 # 与光标之间只有标签字符，
   * 且 # 前是行首 / 空白 / 标点（标签必须独立成词，避免误判 abc#de）。
   * @param {string} text 原始逻辑文本（未 cleanText，偏移与光标一致）
   * @param {number} offset 光标偏移
   * @returns {{query: string, start: number} | null} query=已输入的标签片段（可为空串），start=# 的位置
   */
  function detectTagQuery(text, offset) {
    if (typeof text !== 'string' || typeof offset !== 'number' || offset <= 0) return null;
    var i = offset - 1;
    // 从光标往前扫过标签字符
    while (i >= 0 && TAG_CHAR_RE.test(text.charAt(i))) i--;
    if (i < 0 || text.charAt(i) !== '#') return null;
    // # 前紧贴标签字符（如 工作#）不算标签输入，与渲染层高亮规则一致
    if (i > 0 && TAG_CHAR_RE.test(text.charAt(i - 1))) return null;
    var query = text.slice(i + 1, offset);
    // 标签首字符不能是数字（tags.js 规则）
    if (/^[0-9]/.test(query)) return null;
    return { query: query, start: i };
  }

  /**
   * 按子串筛选标签（不区分大小写）；query 为空返回全部（保持原顺序）。
   * @param {string[]} tags
   * @param {string} query
   * @returns {string[]}
   */
  function filterTags(tags, query) {
    if (!Array.isArray(tags)) return [];
    var q = String(query == null ? '' : query).toLowerCase();
    if (!q) return tags.slice();
    return tags.filter(function (t) {
      return String(t).toLowerCase().indexOf(q) !== -1;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * 给 MarkdownComposer 实例挂载标签联想。
   * composer 需具备：el / value() / rawValue() / caretOffset() / replaceText(start,end,text) / focus()
   * @param {object} composer
   * @param {{getTags?: function(): string[]}} opts
   * @returns {function} detach —— 卸载浮层与全部监听
   */
  function attach(composer, opts) {
    opts = opts || {};
    var getTags = opts.getTags || function () { return []; };

    var box = null;        // 浮层元素（fixed 定位，挂在 body，独立于编辑器 DOM，reflow 不破坏）
    var queryState = null; // 当前 { query, start }
    var activeIndex = 0;
    var detached = false;

    function ensureBox() {
      if (box) return box;
      box = document.createElement('div');
      box.className = 'tag-suggest hidden';
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
      // 折叠光标时 width/height 可能为 0，但 left/top 有效；全 0 视为无效
      if (!r || (r.left === 0 && r.top === 0 && r.width === 0 && r.height === 0)) return null;
      return r;
    }

    /** 浮层定位：显示在输入光标正下方；光标矩形不可用时回退到输入框底部 */
    function position() {
      if (!box) return;
      var r = caretRect(); // 折叠光标宽高为 0 但 left/top 有效，caretRect 已过滤全 0 无效矩形
      if (!r) {
        r = composer.el.getBoundingClientRect();
        if (!r || (!r.width && !r.height)) return;
      }
      var left = Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8));
      var top = (r.bottom || r.top) + 4;
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.maxHeight = Math.max(120, window.innerHeight - top - 12) + 'px';
    }

    function render(list, emptyText) {
      box.innerHTML = '';
      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'tag-suggest-empty';
        empty.textContent = emptyText || '暂无标签';
        box.appendChild(empty);
        return;
      }
      list.forEach(function (tag, idx) {
        var item = document.createElement('div');
        item.className = 'tag-suggest-item' + (idx === activeIndex ? ' active' : '');
        item.setAttribute('role', 'option');
        item.dataset.tag = tag;
        var hash = document.createElement('span');
        hash.className = 'tag-hash';
        hash.textContent = '#';
        var name = document.createElement('span');
        name.textContent = tag;
        item.appendChild(hash);
        item.appendChild(name);
        box.appendChild(item);
      });
    }

    function open(list, state) {
      ensureBox(); // 首次打开时创建浮层
      queryState = state;
      activeIndex = 0;
      render(list, '没有匹配的标签');
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
      composer.replaceText(queryState.start, end, '#' + item.dataset.tag + ' ');
      close();
      composer.focus();
    }

    /** 重新检测光标位置并刷新下拉；不在标签输入态则关闭 */
    function refresh(ev) {
      if (detached) return;
      if (ev && ev.isComposing) return; // IME 组合期间不干扰
      var text = composer.rawValue();
      var off = composer.caretOffset();
      var st = detectTagQuery(text, off);
      if (!st) { close(); return; }
      var all = getTags();
      if (!all.length) { open([], st, '暂无标签'); return; }
      var list = filterTags(all, st.query);
      open(list, st);
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
      if (!box || box.classList.contains('hidden')) return;
      if (rafId) return;
      // selectionchange 高频触发，rAF 合并到每帧一次
      rafId = window.requestAnimationFrame(function () {
        rafId = null;
        position();
      });
    }

    function onBlur() {
      // 延迟关闭：真实鼠标点击工具栏按钮时，输入框先失焦（blur 触发），
      // 随后 click 才插入 # 并弹出下拉；延迟到 click 完成后检查——
      // 焦点若已回到输入框（或浮层内）则保持打开，否则才关闭。
      setTimeout(function () {
        if (detached) return;
        if (!box || box.classList.contains('hidden')) return;
        var ae = document.activeElement;
        if (ae && (composer.el.contains(ae) || box.contains(ae))) return;
        close();
      }, 120);
    }

    composer.el.addEventListener('input', refresh);
    composer.el.addEventListener('compositionend', refresh);
    composer.el.addEventListener('keydown', onKeydown, true); // 捕获阶段先于 composer 自身处理
    composer.el.addEventListener('blur', onBlur);
    // 光标/选区变化（输入、方向键、鼠标点击）时跟随光标移动
    document.addEventListener('selectionchange', onReposition);
    // 滚动（捕获，覆盖编辑器在滚动容器内的场景）与窗口缩放时重定位
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);

    // 初次挂载时若光标已在 # 后（例如编辑态回填内容），立即检测
    refresh();

    return function detach() {
      if (detached) return;
      detached = true;
      composer.el.removeEventListener('input', refresh);
      composer.el.removeEventListener('compositionend', refresh);
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
    detectTagQuery: detectTagQuery,
    filterTags: filterTags,
    attach: attach
  };
});
