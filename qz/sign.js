/**
 * qz/sign.js —— createSign 请求签名（agent.md「请求签名 key」）
 *
 * 规则：去掉键名为 key/token/base 的项；去掉值为空串或 null 的项；
 * 按键名排序后拼成 k1=v1&k2=v2&，末尾追加 token={用户登录 token}，
 * 再 strtolower(md5(...)) 得到 key。
 *
 * 说明：灵感笔记 H5 接口（/h5/idea_note/*）按文档仅需 Header token/uid/tk，
 * 本模块作为兼容能力保留（供未来 /user、/office 等接口扩展）。
 */
'use strict';

const crypto = require('crypto');

const SKIP_KEYS = new Set(['key', 'token', 'base']);

/**
 * @param {object} params 参与签名的业务参数
 * @param {string} token 用户登录 token
 * @returns {string} 32 位小写 md5
 */
function createSign(params, token) {
  const cleaned = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (SKIP_KEYS.has(k)) continue;
    if (v === '' || v === null || v === undefined) continue;
    cleaned[k] = String(v);
  }
  const sortedKeys = Object.keys(cleaned).sort();
  let str = '';
  for (const k of sortedKeys) str += k + '=' + cleaned[k] + '&';
  str += 'token=' + token;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toLowerCase();
}

module.exports = { createSign };
