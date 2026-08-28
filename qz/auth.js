/**
 * qz/auth.js —— 登录态持久化（userData/auth.json，原子写入）
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

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.uid && data.token) {
        this.auth = data;
      } else {
        this.auth = null;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 损坏的认证文件：忽略并重建，不影响使用
        try { fs.renameSync(this.filePath, this.filePath + '.corrupt-' + Date.now()); } catch (e) { /* noop */ }
      }
      this.auth = null;
    }
    return this.auth;
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
