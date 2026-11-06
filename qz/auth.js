/**
 * qz/auth.js —— 登录态持久化（userData/auth.json，原子写入）
 *
 * 开放平台登录态字段：
 *   q_uid / nickname / avatar / access_token / refresh_token
 *   expires_at（access_token 过期，毫秒）/ refresh_expires_at（毫秒）/ authorized_at
 *
 * 旧版（内部接口）登录态只有 uid/token/tk，没有 access_token，无法迁移到开放平台，
 * load() 会把它标记为 legacy，由 app-core 提示用户重新扫码一次。
 */
'use strict';

const fs = require('fs');
const path = require('path');

class AuthStore {
  /**
   * @param {string} filePath 认证文件绝对路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.auth = null;
  }

  /**
   * 读取登录态。
   * @returns {object|null} 有效登录态；旧版登录态返回 { legacy: true, ... } 供上层提示
   */
  load() {
    let data;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 损坏的认证文件：备份后忽略，不影响使用
        try { fs.renameSync(this.filePath, this.filePath + '.corrupt-' + Date.now()); } catch (e) { /* noop */ }
      }
      this.auth = null;
      return null;
    }

    if (!data || typeof data !== 'object') {
      this.auth = null;
      return null;
    }

    // 开放平台登录态
    if (data.q_uid && data.access_token) {
      this.auth = data;
      return data;
    }

    // 旧版内部接口登录态（uid + token）：无法续期到开放平台，需重新授权一次
    if (data.uid && data.token) {
      this.auth = null;
      return { legacy: true, nickname: data.nickname || '', uid: data.uid };
    }

    this.auth = null;
    return null;
  }

  /** 保存登录态并返回 */
  save(auth) {
    this.auth = auth;
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
    return auth;
  }

  clear() {
    this.auth = null;
    try { fs.unlinkSync(this.filePath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

module.exports = { AuthStore };
