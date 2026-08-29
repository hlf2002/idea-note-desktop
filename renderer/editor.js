/**
 * editor.js —— ideaNote 风格所见即所得 Markdown 输入框（UMD）
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

  /**
   * 解析行首列表标记；非列表行返回 null。
   * 无序：- / * / + 后跟空白；有序：数字 + . 或 ) 后跟空白。
   * 返回 { marker, nextMarker, content }：marker=本行标记，nextMarker=回车后下一行标记（有序 +1），content=标记后的文本。
   */
  function listMarker(line) {
    var ul = /^(\s*[-*+]\s+)(.*)$/.exec(line);
    if (ul) return { marker: ul[1], nextMarker: ul[1], content: ul[2] };
    var ol = /^(\s*)(\d+)([.)])(\s+)(.*)$/.exec(line);
    if (ol) {
      var next = parseInt(ol[2], 10) + 1;
      return {
        marker: ol[1] + ol[2] + ol[3] + ol[4],
        nextMarker: ol[1] + next + ol[3] + ol[4],
        content: ol[5]
      };
    }
    return null;
  }

  /** 逻辑文本中，光标 offset 所在行的行首偏移 */
  function lineStartAt(text, offset) {
    return text.lastIndexOf('\n', offset - 1) + 1;
  }

  /**
   * 回车处理：返回 { text, caret }（纯函数，便于单测）。
   *  - 列表行有内容：插入换行并续下一标记（无序同标记，有序数字 +1）
   *  - 列表行仅标记（整行无内容）：删除标记退出列表，光标到新空行行首
   *  - 普通行：插入换行
   */
  function enterAt(text, offset) {
    var ls = lineStartAt(text, offset);
    var nl = text.indexOf('\n', offset);
    var le = nl === -1 ? text.length : nl;
    var line = text.slice(ls, le);
    var info = listMarker(line);
    if (info) {
      if (info.content.trim() === '') {
        // 空列表项回车：删除整行标记退出列表（该行变为空行），光标停在空行行首
        // 注意：ls 前一个字符已是上一行的换行符，删除本行内容即可，不能额外插 \n
        return { text: text.slice(0, ls) + text.slice(le), caret: ls };
      }
      var insert = '\n' + info.nextMarker;
      return { text: text.slice(0, offset) + insert + text.slice(offset), caret: offset + insert.length };
    }
    return { text: text.slice(0, offset) + '\n' + text.slice(offset), caret: offset + 1 };
  }

  /** 列表按钮：光标行首无内容则本行插入标记，否则另起一行插入标记。返回 { text, caret } */
  function beginListAt(text, offset, marker) {
    var ls = lineStartAt(text, offset);
    var head = text.slice(ls, offset);
    var insert = head.trim() === '' ? marker : '\n' + marker;
    return { text: text.slice(0, offset) + insert + text.slice(offset), caret: offset + insert.length };
  }

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
          // 单独 Enter：换行（不发布）；当前行为列表行时自动续列表，空列表项回车退出列表
          e.preventDefault();
          var off = caretOffset();
          var txt = extract(el);
          var r = enterAt(txt, off);
          el.innerHTML = render(r.text);
          setCaret(r.caret);
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
      /** 开始/继续列表项：光标行首无内容则本行插入标记，否则另起一行（工具条列表按钮用） */
      beginList: function (marker) {
        el.focus();
        var off = caretOffset();
        var txt = extract(el);
        var r = beginListAt(txt, off, marker);
        el.innerHTML = render(r.text);
        setCaret(r.caret);
      },
      reflow: reflow
    };
  }

  // 导出纯函数供单元测试（Node 环境 require 使用）
  makeComposer.listMarker = listMarker;
  makeComposer.enterAt = enterAt;
  makeComposer.beginListAt = beginListAt;

  return makeComposer;
});
