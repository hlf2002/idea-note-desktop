/**
 * store.js —— 本地 MEMO 存储层（纯 Node 模块，主进程与单测共用）
 *
 * 特性：
 *  - JSON 文件持久化，内存态 + 串行写队列
 *  - 原子写入：先写同目录 .tmp 再 rename 覆盖，避免写一半损坏
 *  - 文件损坏时备份为 .corrupt-<ts> 并返回空数据（不丢原始文件）
 *  - 创建/更新时自动提取标签
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MemoStore {
  /**
   * @param {string} filePath 数据文件绝对路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.memos = [];
    this._writeChain = Promise.resolve();
  }

  /** 加载数据（文件不存在 -> 空；损坏 -> 备份后空） */
  async load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.memos = [];
        return this.memos;
      }
      throw err;
    }
    try {
      const data = JSON.parse(raw);
      this.memos = Array.isArray(data) ? data : [];
    } catch (err) {
      // 损坏：备份后从空开始，绝不静默覆盖用户数据
      const backup = this.filePath + '.corrupt-' + Date.now();
      try {
        fs.copyFileSync(this.filePath, backup);
      } catch (e) { /* 备份失败不阻断 */ }
      this.memos = [];
    }
    return this.memos;
  }

  /** 全部 memo，按创建时间倒序（新的在前） */
  list() {
    return this.memos
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt);
  }

  /** 新建 memo，返回新对象 */
  async create(content) {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('memo 内容不能为空');
    }
    const now = Date.now();
    const memo = {
      id: crypto.randomUUID(),
      content: content,
      tags: extractTags(content),
      createdAt: now,
      updatedAt: now
    };
    this.memos.push(memo);
    await this._persist();
    return memo;
  }

  /** 按 id 更新内容，返回更新后的 memo；不存在返回 null */
  async update(id, content) {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('memo 内容不能为空');
    }
    const memo = this.memos.find((m) => m.id === id);
    if (!memo) return null;
    memo.content = content;
    memo.tags = extractTags(content);
    memo.updatedAt = Date.now();
    await this._persist();
    return memo;
  }

  /** 按 id 删除，返回是否删除成功 */
  async remove(id) {
    const idx = this.memos.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.memos.splice(idx, 1);
    await this._persist();
    return true;
  }

  /** 串行化原子写入：tmp + rename */
  _persist() {
    const snapshot = JSON.stringify(this.memos, null, 2);
    const tmpPath = this.filePath + '.tmp';
    this._writeChain = this._writeChain.then(() => {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, snapshot, 'utf8');
      fs.renameSync(tmpPath, this.filePath);
    });
    return this._writeChain;
  }
}

// 与 tags.js 保持同一规则（避免循环依赖，内联一份）
const TAG_RE = /#([\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_-]*)/g;
function extractTags(content) {
  const seen = {};
  const result = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content)) !== null) {
    if (!seen[m[1]]) {
      seen[m[1]] = true;
      result.push(m[1]);
    }
  }
  return result;
}

module.exports = { MemoStore };
