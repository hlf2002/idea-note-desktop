/**
 * tags.js —— ideaNote 风格标签提取（UMD，可在 Node 与浏览器中复用）
 *
 * ideaNote 标签规则：
 *  - 以 # 开头，紧跟标签名
 *  - 标签名首字符：中文 / 字母 / 下划线（不能以数字开头）
 *  - 标签名后续字符：中文 / 字母 / 数字 / 下划线 / 连字符
 *  - 遇到空白、标点或行尾即结束
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Tags = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 中文/英文/下划线开头，后续可含数字与连字符
  var TAG_RE = /#([\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_-]*)/g;

  /**
   * 从文本中提取全部标签，去重且保持出现顺序
   * @param {string} content
   * @returns {string[]}
   */
  function extractTags(content) {
    if (typeof content !== 'string' || content.length === 0) return [];
    var seen = {};
    var result = [];
    var m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(content)) !== null) {
      var tag = m[1];
      if (!seen[tag]) {
        seen[tag] = true;
        result.push(tag);
      }
    }
    return result;
  }

  /**
   * 统计一组 memo 中每个标签出现的次数（按出现次数降序，同次数按名称）
   * @param {Array<{tags: string[]}>} memos
   * @returns {Array<{name: string, count: number}>}
   */
  function countByMemos(memos) {
    var counter = {};
    if (Array.isArray(memos)) {
      for (var i = 0; i < memos.length; i++) {
        var tags = memos[i].tags;
        if (Array.isArray(tags)) {
          for (var j = 0; j < tags.length; j++) {
            counter[tags[j]] = (counter[tags[j]] || 0) + 1;
          }
        }
      }
    }
    return Object.keys(counter)
      .map(function (name) { return { name: name, count: counter[name] }; })
      .sort(function (a, b) {
        return b.count - a.count || a.name.localeCompare(b.name);
      });
  }

  return {
    extractTags: extractTags,
    countByMemos: countByMemos
  };
});
