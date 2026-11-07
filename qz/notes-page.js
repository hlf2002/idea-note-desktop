/**
 * qz/notes-page.js —— 把想法发布成网站分享页（@ 提及通知时附带链接）
 *
 * 通道：中转服务（https://ideanote.7373.com.cn/api/notes/publish，带 CLIENT_PIN）
 * → 服务端存盘 → 返回公开 URL（https://ideanote.7373.com.cn/notes/<id>）。
 *
 * 设计：
 *  - 只发文本 + 作者 + 标签 + 时间，不上传图片（平台图片只有 image_id 无 URL，展示不了）。
 *  - 发布时带上笔记 id（ideaId）：删除笔记时按 ideaId 联动删除分享页，链接立即失效。
 *  - 发布失败返回 null（调用方降级为不带链接的普通 @ 通知，不阻塞发布）。
 *  - 删除分享页失败返回 { ok:false }（调用方不阻塞笔记删除，仅记日志）。
 *  - fetch 可注入，便于单元测试。
 */
'use strict';

const { RELAY_BASE_URL, RELAY_CLIENT_PIN } = require('./config');

const PUBLISH_PATH = '/api/notes/publish';
const UNPUBLISH_PATH = '/api/notes/unpublish';
const PUBLISH_TIMEOUT_MS = 15000;
/** 分享页正文上限（与服务端一致，防止超长请求被拒） */
const TEXT_MAX_LEN = 20000;

/**
 * 发布一条想法为网站分享页。
 * @param {object} opts
 * @param {string} opts.text 想法正文
 * @param {string} [opts.author] 作者昵称（展示用）
 * @param {string} [opts.avatar] 作者头像 URL（展示用；无则回退首字母）
 * @param {string[]} [opts.tags] 标签名数组（不含 #）
 * @param {number} [opts.createdAt] 记录时间（毫秒）
 * @param {string} [opts.ideaId] 笔记 id（服务端记录，删除笔记时联动删除分享页）
 * @param {string} [opts.relayUrl] 中转服务基址（默认 RELAY_BASE_URL）
 * @param {string} [opts.clientPin] 中转服务共享密钥（默认 RELAY_CLIENT_PIN）
 * @param {Function} [opts.fetchImpl] 可注入 fetch（测试用）
 * @returns {Promise<string|null>} 公开 URL；任何失败返回 null
 */
async function publishNotePage(opts = {}) {
  const text = String((opts.text == null ? '' : opts.text) || '').trim();
  if (!text) return null;

  const relayUrl = (opts.relayUrl || RELAY_BASE_URL).replace(/\/+$/, '');
  const clientPin = opts.clientPin || RELAY_CLIENT_PIN;
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));

  const body = {
    text: text.slice(0, TEXT_MAX_LEN),
    author: String(opts.author == null ? '' : opts.author).slice(0, 64),
    avatar: String(opts.avatar == null ? '' : opts.avatar).slice(0, 500),
    tags: Array.isArray(opts.tags) ? opts.tags.map((t) => String(t)).filter((t) => t).slice(0, 20) : [],
    createdAt: Number(opts.createdAt || Date.now())
  };
  if (opts.ideaId != null && String(opts.ideaId)) body.ideaId = String(opts.ideaId).slice(0, 64);

  try {
    const res = await fetchImpl(relayUrl + PUBLISH_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ideanote-Pin': clientPin
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS)
    });
    if (!res || !res.ok) {
      console.warn('[notes-page] 发布分享页失败: HTTP ' + (res && res.status));
      return null;
    }
    const data = await res.json();
    if (!data || data.code !== 0 || !data.data || !data.data.url) {
      console.warn('[notes-page] 发布分享页响应异常: ' + JSON.stringify(data || null));
      return null;
    }
    return String(data.data.url);
  } catch (err) {
    console.warn('[notes-page] 发布分享页网络异常: ' + ((err && err.message) || err));
    return null;
  }
}

/**
 * 删除某条笔记关联的全部分享页（服务端按 ideaId 幂等删除）。
 * 删除笔记时调用；失败不抛异常，返回 { ok:false } 由调用方降级（不阻塞笔记删除）。
 * @param {object} opts
 * @param {string} opts.ideaId 笔记 id（publish 时写入服务端记录的同一值）
 * @param {string} [opts.relayUrl] 中转服务基址（默认 RELAY_BASE_URL）
 * @param {string} [opts.clientPin] 中转服务共享密钥（默认 RELAY_CLIENT_PIN）
 * @param {Function} [opts.fetchImpl] 可注入 fetch（测试用）
 * @returns {Promise<{ok: boolean, removed?: number, error?: string}>}
 */
async function unpublishNotePages(opts = {}) {
  const ideaId = String(opts.ideaId == null ? '' : opts.ideaId).trim();
  if (!ideaId) {
    console.warn('[notes-page] 删除分享页缺少 ideaId，跳过');
    return { ok: false, error: '缺少 ideaId' };
  }

  const relayUrl = (opts.relayUrl || RELAY_BASE_URL).replace(/\/+$/, '');
  const clientPin = opts.clientPin || RELAY_CLIENT_PIN;
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));

  try {
    const res = await fetchImpl(relayUrl + UNPUBLISH_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ideanote-Pin': clientPin
      },
      body: JSON.stringify({ ideaId: ideaId.slice(0, 64) }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS)
    });
    if (!res || !res.ok) {
      console.warn('[notes-page] 删除分享页失败: HTTP ' + (res && res.status));
      return { ok: false, error: 'HTTP ' + (res && res.status) };
    }
    const data = await res.json();
    if (!data || data.code !== 0) {
      console.warn('[notes-page] 删除分享页响应异常: ' + JSON.stringify(data || null));
      return { ok: false, error: '响应 code 非 0' };
    }
    const removed = (data.data && typeof data.data.removed === 'number') ? data.data.removed : 0;
    return { ok: true, removed };
  } catch (err) {
    console.warn('[notes-page] 删除分享页网络异常: ' + ((err && err.message) || err));
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { publishNotePage, unpublishNotePages, PUBLISH_PATH, UNPUBLISH_PATH, PUBLISH_TIMEOUT_MS, TEXT_MAX_LEN };
