/**
 * qz/open-sign.js —— Q助理开放平台 HMAC-SHA256 请求签名
 *
 * 规则（open.qzhuli.com/open-platform/api.html「签名规则」）：
 *  1. 收集 body（POST）或 query（GET）的全部业务字段；
 *  2. 业务 API 时把 access_token（= Authorization: Bearer 的值）加入参与签名的字段；
 *  3. 加入请求头里的 app_key / timestamp / nonce；
 *  4. 字段名按 ASCII 升序；字符串原样、整数十进制、布尔 true/false；
 *     字符串数组保持顺序并编码为无空格 JSON；
 *  5. 字段名和值按 RFC 3986 编码，以 key=value&... 拼接；
 *  6. 待签名文本 = UPPERCASE_METHOD + "\n" + PATH + "\n" + 规范字段串；
 *  7. 用 AppSecret 的原始 UTF-8 值做 HMAC-SHA256，输出小写 hex。
 *
 * 待验证：嵌套对象（如 content_json 笔记正文）的规范化。文档只明确了字符串数组，
 * 此处按「无空格 JSON.stringify」处理，需用真实凭证与生产网关比对一次。
 */
'use strict';

const crypto = require('crypto');

/** 只作为头/凭证出现、不允许业务字段重复使用的名字 */
const RESERVED_KEYS = new Set(['app_key', 'timestamp', 'nonce', 'access_token', 'sign']);

/** RFC 3986 严格编码：在 encodeURIComponent 基础上额外编码 !'()* */
function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * 把参与签名的值规范化为字符串。
 * null/undefined 返回 null（调用方决定丢弃）。
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    // 字符串数组保持顺序，编码为无空格 JSON
    return JSON.stringify(value.map((v) => String(v)));
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('签名参数含非法数值: ' + value);
    return String(value);
  }
  if (typeof value === 'object') {
    // 嵌套对象（如 content_json）：无空格 JSON
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * 生成规范化字段串：key=value&key=value（已排序、已编码）。
 * @param {object} fields 参与签名的全部字段
 * @returns {string}
 */
function canonicalString(fields) {
  const entries = [];
  for (const [key, raw] of Object.entries(fields || {})) {
    if (raw === null || raw === undefined) continue;
    const val = normalizeValue(raw);
    if (val === null) continue;
    entries.push([String(key), val]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => rfc3986(k) + '=' + rfc3986(v)).join('&');
}

/**
 * 计算签名。
 * @param {object} opts
 * @param {string} opts.method HTTP 方法
 * @param {string} opts.path 请求路径（不含 query，如 /open/idea_note/list）
 * @param {object} [opts.business] 业务字段（body 或 query）
 * @param {string} opts.appKey
 * @param {string} opts.appSecret
 * @param {number} [opts.timestamp] Unix 毫秒，默认 Date.now()
 * @param {string} [opts.nonce] 16–64 位 [A-Za-z0-9_-]，默认自动生成
 * @param {string} [opts.accessToken] 业务 API 的 Bearer token
 * @returns {{sign:string, timestamp:number, nonce:string, canonical:string}}
 */
function createOpenSign(opts) {
  const {
    method,
    path: reqPath,
    business,
    appKey,
    appSecret,
    accessToken,
    timestamp = Date.now(),
    nonce = crypto.randomBytes(24).toString('base64url')
  } = opts || {};

  if (!method) throw new Error('签名缺少 method');
  if (!reqPath) throw new Error('签名缺少 path');
  if (!appKey) throw new Error('签名缺少 appKey');
  if (!appSecret) throw new Error('签名缺少 appSecret');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Error('nonce 需为 16-64 位 [A-Za-z0-9_-]');

  const fields = {};
  for (const [k, v] of Object.entries(business || {})) {
    if (RESERVED_KEYS.has(k)) continue; // 业务字段不得使用保留名
    fields[k] = v;
  }
  fields.app_key = appKey;
  fields.timestamp = timestamp;
  fields.nonce = nonce;
  if (accessToken) fields.access_token = accessToken;

  const canonical = canonicalString(fields);
  const text = String(method).toUpperCase() + '\n' + reqPath + '\n' + canonical;
  const sign = crypto.createHmac('sha256', Buffer.from(String(appSecret), 'utf8'))
    .update(text, 'utf8')
    .digest('hex')
    .toLowerCase();

  return { sign, timestamp, nonce, canonical };
}

module.exports = { createOpenSign, canonicalString, normalizeValue, rfc3986, RESERVED_KEYS };
