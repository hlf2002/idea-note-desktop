/**
 * editor.js —— flomo 风格所见即所得 Markdown 输入框（UMD）
 *
 * 基于 contenteditable 实现：
 *  - 输入时实时按 markdown 渲染（**粗体**、#标签、`代码`、> 引用、- 列表…）
 *  - 渲染保留源标记字符（textContent 恒等于源文本），reflow 不丢源
 *  - 统一的"逻辑文本"模型：文本节点拼接 + 块级元素边界计 1 个 \n
 *    （value / reflow / 光标偏移 / 光标定位 共用同一规则，不依赖 innerText）
 *  - Enter 提交、Shift+Enter 换行、IME 组合期间不重渲染
 *
 * 用法：
 *   var editor = MarkdownComposer(el, { render: Md.renderWysiwyg, onCommit: fn });
 *   editor.value() / editor.clear() / editor.setValue(text) / editor.focus()
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MarkdownComposer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BLOCK_RE = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6]|HR)$/;

  function makeComposer(el, opts) {
    opts = opts || {};
    var render = opts.render || function (t) { return t; };
    var composing = false;
    var suppress = false;

    /** 逻辑文本：文本节点拼接，块级元素边界在"前有内容且非换行"时插入 1 个 \n */
    function extract(root) {
      var out = '';
      function walk(node) {
        if (node.nodeType === 3) { out += node.nodeValue; return; }
        if (node.nodeType !== 1) return;
        if (node.nodeName === 'BR') {   // <br> 也视为一次换行
          if (out && out.charAt(out.length - 1) !== '\n') out += '\n';
          return;
        }
        var isBlock = BLOCK_RE.test(node.nodeName);
        if (isBlock && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        var children = node.childNodes;
        for (var i = 0; i < children.length; i++) walk(children[i]);
      }
      walk(root);
      return out;
    }

    /** 光标前（含光标所在文本节点前半）的逻辑文本长度 */
    function caretOffset() {
      var sel = window.getSelection();
      if (!sel.rangeCount) return 0;
      var range = sel.getRangeAt(0);
      if (!el.contains(range.startContainer)) return extract(el).length;
      var out = '';
      var stopNode = range.startContainer;
      var stopOffset = range.startOffset;
      var done = false;
      function walk(node) {
        if (done) return;
        if (node === stopNode) {
          if (node.nodeType === 3) out += node.nodeValue.slice(0, stopOffset);
          done = true;
          return;
        }
        if (node.nodeType === 3) { out += node.nodeValue; return; }
        if (node.nodeType !== 1) return;
        if (node.nodeName === 'BR') {
          if (out && out.charAt(out.length - 1) !== '\n') out += '\n';
          return;
        }
        var isBlock = BLOCK_RE.test(node.nodeName);
        if (isBlock && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        var children = node.childNodes;
        for (var i = 0; i < children.length; i++) walk(children[i]);
      }
      walk(el);
      return out.length;
    }

    /** 按逻辑文本偏移定位光标 */
    function setCaret(offset) {
      var r = locate(offset);
      var sel = window.getSelection();
      sel.removeAllRanges();
      if (r) sel.addRange(r);
    }

    function locate(offset) {
      var remaining = offset;
      var result = null;
      var lastChar = null; // null=尚未有内容

      function walk(node) {
        if (result) return;
        if (node.nodeType === 3) {
          var len = node.nodeValue.length;
          if (remaining <= len) {
            var r = document.createRange();
            r.setStart(node, Math.max(0, remaining));
            r.collapse(true);
            result = r;
            return;
          }
          remaining -= len;
          if (len > 0) lastChar = node.nodeValue.charAt(len - 1);
          return;
        }
        if (node.nodeType !== 1) return;
        if (node.nodeName === 'BR') {
          if (remaining <= 0 && !result) {
            // 偏移已耗尽：停在 <br> 之后（空段内）
            var r = document.createRange();
            r.setStart(node, 0);
            r.collapse(true);
            result = r;
            return;
          }
          if (lastChar !== null && lastChar !== '\n') {
            remaining -= 1;
            if (remaining < 0) remaining = 0;
            lastChar = '\n';
          }
          return;
        }
        var isBlock = BLOCK_RE.test(node.nodeName);
        if (isBlock && lastChar !== null && lastChar !== '\n') {
          remaining -= 1; // 块边界虚拟 \n
          if (remaining < 0) remaining = 0;
          lastChar = '\n';
        }
        var children = node.childNodes;
        for (var i = 0; i < children.length; i++) walk(children[i]);
      }
      walk(el);

      if (result) return result;
      var r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      return r;
    }

    function cleanText(t) {
      return t.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
    }

    function reflow() {
      if (composing || suppress) return;
      var sel = window.getSelection();
      if (!sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) return;
      var offset = caretOffset();
      var text = extract(el);
      el.innerHTML = render(text);
      setCaret(offset);
    }

    // ---- 事件 ----
    el.addEventListener('input', reflow);
    el.addEventListener('compositionstart', function () { composing = true; });
    el.addEventListener('compositionend', function () { composing = false; reflow(); });
    el.addEventListener('paste', function () {
      setTimeout(reflow, 0);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !composing) {
        if (e.metaKey || e.shiftKey) {
          // ⌘/⇧ + Enter：发布笔记
          e.preventDefault();
          if (opts.onCommit) opts.onCommit(cleanText(extract(el)));
        } else {
          // 单独 Enter：换行（不发布，避免误触）
          // 直接改源文本插入 \n 再重渲染，保证换行一定生效（不依赖 execCommand 生成 <br>）
          e.preventDefault();
          var off = caretOffset();
          var txt = extract(el);
          var newText = txt.slice(0, off) + '\n' + txt.slice(off);
          el.innerHTML = render(newText);
          setCaret(off + 1);
        }
      }
    });

    return {
      el: el,
      focus: function () { el.focus(); },
      blur: function () { el.blur(); },
      value: function () { return cleanText(extract(el)); },
      clear: function () {
        suppress = true;
        el.innerHTML = '';
        suppress = false;
        el.focus();
      },
      setValue: function (text) {
        suppress = true;
        el.innerHTML = render(text || '');
        suppress = false;
        setCaret(extract(el).length);
        el.focus();
      },
      /** 在光标处插入文本（工具条按钮用），触发 reflow */
      insertText: function (text) {
        el.focus();
        document.execCommand('insertText', false, text);
        reflow();
      },
      reflow: reflow
    };
  }

  return makeComposer;
});
