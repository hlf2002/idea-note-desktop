/**
 * md.js —— 安全的轻量 Markdown 渲染器（UMD）
 *
 * 复刻 flomo 支持的 Markdown 子集：
 *   - 行内：**加粗**、*斜体*、~~删除线~~、`行内代码`、[链接](https://...)
 *   - 块级：> 引用、``` 代码块、空行分段
 *
 * 安全策略（防 XSS）：
 *   1. 所有用户文本先做 HTML 转义，再套格式标签
 *   2. 行内代码/代码块最先提取为占位符，其内部不再解析任何格式
 *   3. 链接 href 仅放行 http / https / mailto 协议
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Md = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PLACEHOLDER_PREFIX = '\u0000FLM\u0000';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    var u = String(url || '').trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    return null;
  }

  /**
   * 行内渲染：输入已转义的文本，输出带格式标签的 HTML。
   * 先保护 `code`，再处理链接，最后加粗/斜体/删除线；opts.highlightTags 时把 #标签 变绿。
   */
  function renderInline(text, opts) {
    opts = opts || {};
    var escaped = escapeHtml(text);
    var placeholders = [];

    // 1) 行内代码 -> 占位符（内容不再解析）
    escaped = escaped.replace(/`([^`\n]+)`/g, function (_, code) {
      var key = PLACEHOLDER_PREFIX + placeholders.length + '\u0000';
      placeholders.push('<code>' + escapeHtml(code) + '</code>');
      return key;
    });

    // 2) 链接 [text](url)
    escaped = escaped.replace(/\[([^\[\]\n]+)\]\(([^()\s]+)\)/g, function (_, label, url) {
      var href = safeUrl(url);
      if (href === null) return _; // 不合法协议保持原文
      return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer">' + label + '</a>';
    });

    // 3) **加粗**（先于斜体，避免 ** 被拆散）
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // 4) *斜体*
    escaped = escaped.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // 5) ~~删除线~~
    escaped = escaped.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // 6) 恢复行内代码
    escaped = escaped.replace(
      new RegExp(PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)\\u0000', 'g'),
      function (_, idx) { return placeholders[Number(idx)]; }
    );

    // 7) 标签高亮（仅输入框所见即所得用）：#标签 变绿（要求前面是行首/空白/引用符号）
    if (opts.highlightTags) {
      escaped = escaped.replace(
        /(^|[\s>（(])#([\u4e00-\u9fa5A-Za-z0-9_\-]+)/g,
        function (_, pre, tag) {
          return pre + '<span class="tag-inline">#' + tag + '</span>';
        }
      );
    }

    return escaped;
  }

  /**
   * 整体渲染：text -> HTML 字符串
   * opts.highlightTags: 输入框所见即所得时把 #标签 渲染为绿色
   */
  function render(text, opts) {
    opts = opts || {};
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块 ``` lang
      var fence = line.match(/^```([\w-]*)\s*$/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过结束围栏
        out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 引用块：连续 > 行
      if (/^>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderInline(quote.join('\n'), opts) + '</blockquote>');
        continue;
      }

      // 空行分隔
      if (line.trim() === '') {
        i++;
        continue;
      }

      // 分割线 --- / *** / ___
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr />');
        i++;
        continue;
      }

      // 待办 / 无序列表 / 有序列表
      var listStart = /^\s*([-*+])\s+\[([ xX])\]\s+/.test(line)
        || /^\s*([-*+])\s+/.test(line)
        || /^\s*(\d+)[.)]\s+/.test(line);
      if (listStart) {
        var listType = line.match(/^\s*\d+[.)]/) ? 'ol' : 'ul';
        var items = [];
        while (i < lines.length) {
          var tl = lines[i];
          var todo = tl.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
          var ul = tl.match(/^\s*[-*+]\s+(.*)$/);
          var ol = tl.match(/^\s*(\d+)[.)]\s+(.*)$/);
          if (todo) {
            items.push({ todo: todo[1].toLowerCase() !== ' ', text: todo[2] });
            i++;
          } else if (listType === 'ul' && ul) {
            items.push({ text: ul[1] });
            i++;
          } else if (listType === 'ol' && ol) {
            items.push({ text: ol[2] });
            i++;
          } else {
            break;
          }
        }
        var tag = listType === 'ol' ? 'ol' : 'ul';
        out.push('<' + tag + '>');
        items.forEach(function (it) {
          out.push('<li>'
            + (it.todo !== undefined
                ? '<span class="todo-box">' + (it.todo ? '☑' : '☐') + '</span> '
                : '')
            + renderInline(it.text, opts)
            + '</li>');
        });
        out.push('</' + tag + '>');
        continue;
      }

      // 普通段落：连续非空行合并在一个 <p> 内，保留换行（配合 white-space:pre-wrap）
      var para = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^```/.test(lines[i]) && !/^>/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + renderInline(para.join('\n'), opts) + '</p>');
    }

    return out.join('\n');
  }

  /**
   * 所见即所得渲染（供编辑器用）：保留所有 markdown 标记字符，只加视觉样式。
   * 保证渲染后 DOM 的 textContent === 源文本，从而 reflow 不丢失源标记。
   */
  function renderWysiwygInline(text) {
    var escaped = escapeHtml(text);
    var placeholders = [];
    var keyRe = PLACEHOLDER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)\\u0000';

    // 行内代码：反引号弱化为标记，内容用 code 样式
    escaped = escaped.replace(/`([^`\n]+)`/g, function (_, c) {
      var k = PLACEHOLDER_PREFIX + placeholders.length + '\u0000';
      placeholders.push('<span class="md-marker">`</span><code>' + escapeHtml(c) + '</code><span class="md-marker">`</span>');
      return k;
    });
    // 链接：保留 [text](url) 标记字符
    escaped = escaped.replace(/\[([^\[\]\n]+)\]\(([^()\s]+)\)/g, function (_, label, url) {
      var href = safeUrl(url);
      return '<span class="md-marker">[</span>'
        + (href ? '<a href="' + escapeHtml(href) + '">' : '') + label + (href ? '</a>' : '')
        + '<span class="md-marker">]</span><span class="md-marker">(</span>'
        + escapeHtml(url) + '<span class="md-marker">)</span>';
    });
    // 加粗：** 弱化为标记，内容加粗
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g,
      '<span class="md-marker">**</span><strong>$1</strong><span class="md-marker">**</span>');
    // 斜体：* 弱化为标记，内容斜体
    escaped = escaped.replace(/(^|[^*])\*([^*\n]+)\*/g,
      '$1<span class="md-marker">*</span><em>$2</em><span class="md-marker">*</span>');
    // 删除线：~~ 弱化为标记，内容删除线
    escaped = escaped.replace(/~~([^~\n]+)~~/g,
      '<span class="md-marker">~~</span><del>$1</del><span class="md-marker">~~</span>');
    // 恢复行内代码
    escaped = escaped.replace(new RegExp(keyRe, 'g'), function (_, idx) { return placeholders[Number(idx)]; });
    // 标签高亮：保留 # 与标签文本
    escaped = escaped.replace(
      /(^|[\s>（(])#([\u4e00-\u9fa5A-Za-z0-9_\-]+)/g,
      function (_, pre, tag) { return pre + '<span class="tag-inline">#' + tag + '</span>'; }
    );
    return escaped;
  }

  function renderWysiwyg(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // 围栏代码块（保留 ``` 围栏）
      if (/^```/.test(line)) {
        var buf = [line];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) { buf.push(lines[i]); i++; }
        out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }
      // 引用（保留 > 前缀）
      if (/^>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i]); i++; }
        out.push('<blockquote>' + renderWysiwygInline(q.join('\n')) + '</blockquote>');
        continue;
      }
      // 空行
      if (line.trim() === '') { i++; continue; }
      // 列表行（保留 - / 1. 前缀，用 div 保持 textContent）
      var li = line.match(/^(\s*(?:[-*+]\s+|\d+[.)]\s+))(.*)$/);
      if (li) {
        out.push('<div class="md-li">' + escapeHtml(li[1]) + renderWysiwygInline(li[2]) + '</div>');
        i++;
        continue;
      }
      // 段落
      var para = [];
      while (i < lines.length && lines[i].trim() !== ''
        && !/^```/.test(lines[i]) && !/^>/.test(lines[i])
        && !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length === 0) { i++; continue; }
      out.push('<p>' + renderWysiwygInline(para.join('\n')) + '</p>');
    }
    // 注意：块间不能注入 \n（会成为 DOM 文本节点，破坏 innerText 偏移与源还原）
    return out.join('');
  }

  return { render: render, renderWysiwyg: renderWysiwyg };
});
