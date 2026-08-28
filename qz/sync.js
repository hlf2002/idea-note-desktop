/**
 * qz/sync.js —— 灵感笔记数据同步（服务端为数据源，本地 JSON 仅作缓存）
 *
 * - pullAll：分页拉取全量灵感笔记 -> 归一化为本地 memo 结构 -> 写缓存
 * - createFromText / update / remove：直接落服务端，成功后更新缓存
 * - loadCache：离线/启动时从缓存读取
 *
 * 缓存文件结构：{ "memos": [...], "syncedAt": 毫秒时间戳 }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PAGE_SIZE } = require('./config');
const { extractServerTags, textToContentJson } = require('./content');

/** 服务端条目 -> 本地 memo 结构 */
function mapServerMemo(item) {
  return {
    id: item.id,
    content: item.plain_text || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    imageUrl: item.image_url || '',
    createdAt: (item.create_time || 0) * 1000,
    updatedAt: (item.update_time || item.create_time || 0) * 1000
  };
}

class IdeaSync {
  /**
   * @param {object} deps
   * @param {object} deps.api QzApi 实例（已 setAuth）
   * @param {string} deps.cacheFile 缓存文件绝对路径
   */
  constructor({ api, cacheFile }) {
    this.api = api;
    this.cacheFile = cacheFile;
  }

  /** 分页拉取全量，归一化后写缓存，返回 memo 数组（新→旧） */
  async pullAll() {
    const all = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const data = await this.api.getIdeaList({ page, pageSize: PAGE_SIZE });
      const list = (data && Array.isArray(data.list)) ? data.list : [];
      list.forEach((item) => all.push(mapServerMemo(item)));
      hasMore = !!(data && data.has_more);
      if (list.length === 0) hasMore = false;
      page += 1;
      // 防御：异常循环保护
      if (page > 500) break;
    }
    all.sort((a, b) => b.createdAt - a.createdAt);
    this._writeCache(all);
    return all;
  }

  /** 新建：文本 -> 灵感笔记，返回本地 memo 结构 */
  async createFromText(text) {
    const saved = await this.api.saveIdea({
      content_json: textToContentJson(text),
      plain_text: text,
      tags: extractServerTags(text)
    });
    const memo = mapServerMemo(saved);
    this._upsertCache(memo);
    return memo;
  }

  /** 编辑：按服务端 id 更新，返回更新后的 memo */
  async update(id, text) {
    const saved = await this.api.saveIdea({
      id,
      content_json: textToContentJson(text),
      plain_text: text,
      tags: extractServerTags(text)
    });
    const memo = mapServerMemo(saved);
    this._upsertCache(memo);
    return memo;
  }

  /** 删除：按服务端 id 删除，并移除缓存 */
  async remove(id) {
    await this.api.deleteIdea(id);
    this._removeFromCache(id);
    return true;
  }

  /** 读取缓存（不访问网络）；不存在返回 [] */
  loadCache() {
    try {
      const raw = fs.readFileSync(this.cacheFile, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.memos)) return data.memos;
      return [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try { fs.renameSync(this.cacheFile, this.cacheFile + '.corrupt-' + Date.now()); } catch (e) { /* noop */ }
      }
      return [];
    }
  }

  // ---------- 缓存维护 ----------
  _writeCache(memos) {
    this._write({ memos, syncedAt: Date.now() });
  }

  _upsertCache(memo) {
    const memos = this.loadCache();
    const idx = memos.findIndex((m) => m.id === memo.id);
    if (idx >= 0) memos[idx] = memo;
    else memos.push(memo);
    memos.sort((a, b) => b.createdAt - a.createdAt);
    this._write({ memos, syncedAt: Date.now() });
  }

  _removeFromCache(id) {
    const memos = this.loadCache().filter((m) => m.id !== id);
    this._write({ memos, syncedAt: Date.now() });
  }

  _write(obj) {
    const tmp = this.cacheFile + '.tmp';
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, this.cacheFile);
  }
}

module.exports = { IdeaSync, mapServerMemo };
