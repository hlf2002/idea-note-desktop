/**
 * qz/content.js —— 灵感笔记内容转换（idea_note.md）
 *
 * 职责：
 *  1. extractServerTags：按服务端规则提取标签（# 开头，遇空白/行尾/段落结束即止，最长 10 字符，入库不带 #）
 *  2. textToContentJson：把本地纯文本转换为服务端 TipTap 风格的 content_json
 *     （doc > paragraph > text；#标签 以 ideaTag mark 标记）
 *  3. contentJsonToText：逆向还原（用于本地展示/编辑）
 *
 * 可用性：CommonJS（主进程与单测共用）
 */
'use strict';

const { TAG_MAX_LEN } = require('./config');

// 服务端标签：以 # 开头，后跟 1~TAG_MAX_LEN 个非空白字符（遇空白/行尾即止）
function serverTagRe() {
  return new RegExp('#([^\\s#]{1,' + TAG_MAX_LEN + '})', 'g');
}

/**
 * 按服务端规则提取标签（去重保序，不带 #）
 * @param {string} text
 * @returns {string[]}
 */
function extractServerTags(text) {
  if (typeof text !== 'string' || !text) return [];
  const seen = {};
  const result = [];
  let m;
  const re = serverTagRe();
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      result.push(m[1]);
    }
  }
  return result;
}

/**
 * 把纯文本拆成「文本片段 + 标签片段」序列，供 content_json 使用
 * @returns {Array<{text: string, isTag: boolean}>}
 */
function splitTextAndTags(line) {
  const parts = [];
  const re = serverTagRe();
  re.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push({ text: line.slice(last, m.index), isTag: false });
    parts.push({ text: m[0], isTag: true }); // m[0] 含 # 前缀
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last), isTag: false });
  if (parts.length === 0 && line) parts.push({ text: line, isTag: false });
  return parts;
}

/**
 * 纯文本 -> content_json
 * @param {string} text
 * @returns {object} { type: 'doc', content: [...] }
 */
function textToContentJson(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const docContent = [];
  for (const line of lines) {
    // 空行跳过（idea_note.md：段落结束即标签结束）
    if (line.trim() === '') continue;
    const inline = [];
    for (const part of splitTextAndTags(line)) {
      const node = { type: 'text', text: part.text };
      if (part.isTag) node.marks = [{ type: 'ideaTag' }];
      inline.push(node);
    }
    docContent.push({ type: 'paragraph', content: inline });
  }
  if (docContent.length === 0) {
    // 空文本仍给一个空段落（服务端要求 content_json 含有效正文）
    docContent.push({ type: 'paragraph', content: [{ type: 'text', text: '' }] });
  }
  return { type: 'doc', content: docContent };
}

/**
 * content_json -> 纯文本（还原为 plain_text 形态）
 * @param {object} json
 * @returns {string}
 */
function contentJsonToText(json) {
  if (!json || json.type !== 'doc' || !Array.isArray(json.content)) return '';
  const lines = [];
  for (const block of json.content) {
    if (block.type === 'paragraph') {
      lines.push(inlineToText(block.content));
    } else if (block.type === 'orderedList') {
      // 列表项：每项前加序号
      const items = Array.isArray(block.content) ? block.content : [];
      items.forEach((li, i) => {
        if (li.type === 'listItem' && Array.isArray(li.content)) {
          const paraTexts = li.content
            .filter((c) => c.type === 'paragraph')
            .map((c) => inlineToText(c.content));
          lines.push((i + 1) + '. ' + paraTexts.join(' '));
        }
      });
    }
  }
  return lines.join('\n');
}

function inlineToText(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((n) => (n && n.type === 'text' ? n.text : '')).join('');
}

module.exports = {
  extractServerTags,
  textToContentJson,
  contentJsonToText,
  splitTextAndTags
};
