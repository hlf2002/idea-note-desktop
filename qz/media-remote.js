/**
 * qz/media-remote.js —— 图片远端地址补齐（纯函数 + 持久化索引）
 *
 * 背景：开放平台 /open/idea_note/* 只返回 image_id 数组，不给图片访问 URL；
 * 而内部接口（qz CLI `note get <id>`）返回真实 image_url（CDN 地址，CSP 允许 https）。
 * 桌面端对「本机没有副本」的图（老数据 / 其他设备上传）用这份 URL 兜底展示。
 *
 * 配对规则（宁缺勿错位）：
 *  1. URL 里带 image_id（如 .../user_media/img_xxx.png）→ 按 image_id 直接对应；
 *  2. 剩余 URL 与剩余 image_id 数量相等 → 按顺序配对（老数据 URL 不含 image_id）；
 *  3. 数量不等 → 不配对（错位比缺图更糟）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 从 CDN URL 中提取 image_id（形如 img_xxxxxxxx，允许下划线，如 img_mock_1），没有则返回 '' */
function imageIdFromUrl(url) {
  const s = String(url == null ? '' : url);
  const m = /(img_[A-Za-z0-9_]+)/.exec(s);
  return m ? m[1] : '';
}

/**
 * 把服务端图片 URL 列表与本地 image_id 列表配对。
 * @param {string[]} imageIds 本地 memo 的 image_id 数组（按展示顺序）
 * @param {string[]} urls 内部接口返回的图片 URL 数组
 * @returns {{byId: Object<string,string>, leftovers: string[]}}
 *   byId：image_id → URL；leftovers：没能配对的 URL（调用方记日志）
 */
function pairImageUrls(imageIds, urls) {
  const ids = (Array.isArray(imageIds) ? imageIds : []).filter((x) => typeof x === 'string' && x);
  const list = (Array.isArray(urls) ? urls : []).filter((x) => typeof x === 'string' && /^https?:\/\//i.test(x));
  const byId = {};
  const usedIdx = new Set();
  // 1. URL 内含 image_id → 精确对应
  list.forEach((url, i) => {
    const id = imageIdFromUrl(url);
    if (id && ids.includes(id)) {
      if (!byId[id]) {
        byId[id] = url;
        usedIdx.add(i);
      }
    }
  });
  // 2. 剩下的按顺序配对（仅当数量相等，避免错位）
  const restUrls = list.filter((_, i) => !usedIdx.has(i));
  const restIds = ids.filter((id) => !byId[id]);
  if (restUrls.length && restUrls.length === restIds.length) {
    restIds.forEach((id, i) => { byId[id] = restUrls[i]; });
    return { byId, leftovers: [] };
  }
  return { byId, leftovers: restUrls };
}

/**
 * 远端图片地址索引：image_id → URL，落在 <dataDir>/media-remote.json。
 * 与 media-index.json（本机文件副本）分开存：远端地址是「兜底展示」用，本机副本仍优先。
 */
class RemoteMediaStore {
  /** @param {{file: string}} opts */
  constructor({ file }) {
    this.file = file;
  }

  /** 读取索引；文件缺失/损坏返回 {}（不抛错） */
  map() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      const out = {};
      for (const key of Object.keys(data)) {
        const url = data[key];
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) out[key] = url;
      }
      return out;
    } catch (e) {
      return {};
    }
  }

  /**
   * 合并写入（原子写）；只接受 https URL，返回合并后的映射。
   * @param {Object<string,string>} byId
   */
  merge(byId) {
    const map = this.map();
    let changed = 0;
    for (const id of Object.keys(byId || {})) {
      const url = byId[id];
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) continue;
      if (map[id] === url) continue;
      map[id] = url;
      changed += 1;
    }
    if (changed) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    }
    return map;
  }
}

module.exports = {
  imageIdFromUrl,
  pairImageUrls,
  RemoteMediaStore
};
