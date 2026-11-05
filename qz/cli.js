/**
 * qz/cli.js —— 本机 qz CLI 封装（@ 提及通知用）
 *
 * 思路：灵感笔记开放平台没有「给联系人发消息」的接口，而用户本机装了 qz CLI
 * （内部网关 client.qzhuli.com 的登录态，~/.qzhuli-cli/），因此 @ 提及通知
 * 通过 spawn 本机 qz CLI 完成：friend list 拿联系人 → conversation search 找会话
 * → message send 发私信。
 *
 * 适用边界（有意为之）：
 *  - 仅本机装有 qz CLI 且已登录时可用（GUI 启动 PATH 不含 /opt/homebrew/bin，
 *    必须按固定路径探测，不能只靠 which）；
 *  - 目标联系人没有会话时无法自动建会话（create 需要 friend_agent_id，
 *    friend list 不返回该字段），跳过并标记 error。
 *
 * 对外暴露：
 *  - isAvailable()            qz CLI 是否存在且已登录
 *  - listContacts()           联系人列表 [{uid, nickname, remark, avatar}]
 *  - notifyMentions(text, senderName)  解析 @昵称 → 逐人发私信，返回结果数组
 *  - 纯函数 extractMentions / resolveMentions / pickConversation / makeNotifyText（单测用）
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** macOS GUI 应用启动 PATH 不含 /opt/homebrew/bin，必须按固定路径探测 */
const CANDIDATE_BINS = ['/opt/homebrew/bin/qz', '/usr/local/bin/qz', '/usr/bin/qz'];
/** 子进程 PATH 补充（防止 qz 依赖的同名命令找不到） */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];
/** qz CLI 缓存库（SQLite，macOS 自带 sqlite3 直读；读不到就降级为不排序） */
const SQLITE3_BIN = '/usr/bin/sqlite3';
/** 缓存同步新鲜度：12 小时内同步过就不再 cache sync（避免每次 @ 都等几秒） */
const SYNC_FRESH_MS = 12 * 3600 * 1000;

class QzCli {
  /**
   * @param {object} opts
   * @param {string} [opts.binPath] qz 可执行文件绝对路径（测试/特殊安装场景）
   * @param {string} [opts.cwd] 子进程工作目录（默认主目录，确保读生产 ~/.qzhuli-cli/）
   * @param {number} [opts.timeoutMs] 单条命令超时
   */
  constructor(opts = {}) {
    this.binPath = opts.binPath || '';
    this.cwd = opts.cwd || os.homedir();
    this.timeoutMs = opts.timeoutMs || 15000;
  }

  /** 探测 qz 可执行文件：固定路径 > PATH（GUI 启动 PATH 不全，固定路径优先） */
  resolveBin() {
    if (this.binPath && fs.existsSync(this.binPath)) return this.binPath;
    for (const p of CANDIDATE_BINS) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (e) { /* continue */ }
    }
    for (const dir of (process.env.PATH || '').split(':')) {
      if (!dir) continue;
      const p = path.join(dir, 'qz');
      if (fs.existsSync(p)) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch (e) { /* continue */ }
      }
    }
    return '';
  }

  /** 执行一条 qz 命令，解析 stdout JSON；任何异常都返回 { status:'error', ... } 不 throw */
  run(args, timeoutMs) {
    const bin = this.resolveBin();
    if (!bin) return Promise.resolve({ status: 'error', code: 'CLI_NOT_FOUND', message: '未找到 qz CLI', data: null });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, {
          cwd: this.cwd,
          env: {
            ...process.env,
            PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(':')
          }
        });
      } catch (err) {
        resolve({ status: 'error', code: 'CLI_SPAWN', message: (err && err.message) || String(err), data: null });
        return;
      }
      let out = '';
      let errOut = '';
      child.stdout.on('data', (c) => { out += String(c); });
      child.stderr.on('data', (c) => { errOut += String(c); });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
        resolve({ status: 'error', code: 'CLI_TIMEOUT', message: 'qz CLI 响应超时', data: null });
      }, timeoutMs || this.timeoutMs);
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'error', code: 'CLI_SPAWN', message: (err && err.message) || String(err), data: null });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let data = null;
        try { data = JSON.parse(out); } catch (e) { data = null; }
        if (data && data.status) { resolve(data); return; }
        if (code === 0) { resolve({ status: 'success', code: 'OK', data }); return; }
        resolve({ status: 'error', code: 'CLI_EXIT', message: errOut.trim() || out.trim() || 'qz CLI 执行失败(exit ' + code + ')', data });
      });
    });
  }

  /** qz CLI 是否可用（存在 + 已登录） */
  async isAvailable() {
    const bin = this.resolveBin();
    if (!bin) return { ok: false, reason: 'cli_not_found', binPath: '' };
    const r = await this.run(['auth', 'status']);
    if (r.status === 'success' && r.data && r.data.uid) {
      return { ok: true, binPath: bin };
    }
    return { ok: false, reason: r.code || 'auth_failed', message: r.message || 'qz CLI 未登录' };
  }

  /** 联系人列表（qz friend list），按最后沟通时间倒序（越新越靠前）；读不到时间则保持原顺序 */
  async listContacts() {
    const r = await this.run(['friend', 'list', '--jq', '.data.links']);
    if (r.status !== 'success' || !Array.isArray(r.data)) return [];
    const contacts = r.data
      .filter((l) => l && l.uid)
      .map((l) => ({
        uid: l.uid,
        nickname: l.nickname || '',
        remark: l.friend_name || '',
        linkType: l.link_type,
        avatar: l.avatar || ''
      }));
    const lastActiveByUid = await this._lastActiveByUid();
    if (lastActiveByUid) return sortContactsByLastActive(contacts, lastActiveByUid);
    return contacts;
  }

  /**
   * 每个联系人的最后沟通时间（读 qz CLI 本地 SQLite 缓存）。
   * 链路：先 cache sync 增量同步 → 直读 cache-<ownerUid>.db 的 messages_cache /
   * conversation_profiles → 每个 uid 取其参与会话的最新消息时间戳。
   * 任何一步失败返回 null（调用方降级为不排序）。
   * @returns {Promise<Map<string, string>|null>} uid → 时间戳字符串（19 位微秒，字符串比较即数值序）
   */
  async _lastActiveByUid() {
    try {
      // 1. 定位缓存库：cache-<ownerUid>.db（ownerUid = auth status 的 uid）
      const ownerUid = await this._ownerUid();
      if (!ownerUid) return null;
      const dbFile = path.join(this.cwd, '.qzhuli-cli', 'cache-' + ownerUid + '.db');
      if (!fs.existsSync(dbFile) || !fs.existsSync(SQLITE3_BIN)) return null;

      // 2. 增量同步缓存（保证时间新鲜）：缓存 12 小时内同步过就跳过，避免每次 @ 都慢
      const mtimeMs = fs.statSync(dbFile).mtimeMs;
      if (Date.now() - mtimeMs > SYNC_FRESH_MS) {
        await this.run(['cache', 'sync'], 30000);
      }

      // 3. 会话级聚合最新消息时间；user_ids 在 JS 侧拆分（逗号分隔）
      const sql = [
        "SELECT cp.user_ids, m.ts FROM (",
        "  SELECT conversation_id, MAX(json_extract(data, '$.timestamp')) AS ts",
        "  FROM messages_cache GROUP BY conversation_id",
        ") m JOIN conversation_profiles cp ON cp.conversation_id = m.conversation_id;"
      ].join(' ');
      const out = execFileSync(SQLITE3_BIN, [dbFile, sql], {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 32 * 1024 * 1024
      });
      const map = new Map();
      for (const line of out.split('\n')) {
        if (!line) continue;
        const idx = line.indexOf('|');
        if (idx <= 0) continue;
        const uids = line.slice(0, idx).split(',');
        const ts = line.slice(idx + 1).trim();
        if (!ts) continue;
        // 时间戳为 19 位微秒，超出 JS 安全整数范围，全程按字符串比较（等长字典序=数值序）
        for (const u of uids) {
          if (!u) continue;
          const prev = map.get(u);
          if (!prev || ts > prev) map.set(u, ts);
        }
      }
      return map.size ? map : null;
    } catch (err) {
      console.warn('[qz-cli] 读取最后沟通时间失败，联系人按原顺序展示: ' + ((err && err.message) || err));
      return null;
    }
  }

  /** 当前登录账号的 owner uid（qz auth status） */
  async _ownerUid() {
    const r = await this.run(['auth', 'status']);
    if (r.status === 'success' && r.data && r.data.uid) return String(r.data.uid);
    return '';
  }

  /** 某 uid 的既有会话（单聊优先由调用方 pick） */
  async findConversation(uid) {
    if (!uid) return [];
    const r = await this.run(['conversation', 'search', uid, '--uid', '--jq', '.data']);
    if (r.status !== 'success' || !r.data) return [];
    const convs = Array.isArray(r.data.conversations) ? r.data.conversations : [];
    return convs
      .filter((c) => c && c.conversationId)
      .map((c) => ({ conversationId: c.conversationId, isGroup: c.isGroup || 0 }));
  }

  /** 发一条私信 */
  async sendMessage(conversationId, content) {
    if (!conversationId) return { ok: false, error: '缺少会话ID' };
    const r = await this.run(['message', 'send', conversationId, content]);
    if (r.status === 'success') return { ok: true, code: r.code, error: null };
    return { ok: false, code: r.code, error: r.message || '发送失败' };
  }

  /**
   * 通知文本中的全部 @联系人。
   * @returns {Promise<{ok:boolean, sent:Array, skipped?:string, error?:string}>}
   *   sent 每项 { name, nickname, uid, ok, error, conversationId }
   */
  async notifyMentions(text, senderName) {
    const mentions = extractMentions(String(text == null ? '' : text));
    if (!mentions.length) return { ok: true, sent: [], skipped: 'no_mentions' };

    const av = await this.isAvailable();
    if (!av.ok) {
      return {
        ok: false,
        sent: [],
        error: av.reason === 'cli_not_found' ? '未找到 qz CLI' : (av.message || 'qz CLI 未登录')
      };
    }

    const contacts = await this.listContacts();
    const targets = resolveMentions(mentions, contacts);
    if (!targets.length) return { ok: true, sent: [], skipped: 'no_matched_contact' };

    const body = makeNotifyText(senderName, text);
    const sent = [];
    for (const t of targets) {
      const convs = await this.findConversation(t.uid);
      const conv = pickConversation(convs);
      if (!conv) {
        sent.push({ name: t.name, nickname: t.contact.nickname || t.name, uid: t.uid, ok: false, error: '该联系人暂无会话', conversationId: '' });
        continue;
      }
      const r = await this.sendMessage(conv.conversationId, body);
      sent.push({
        name: t.name,
        nickname: t.contact.nickname || t.name,
        uid: t.uid,
        ok: r.ok,
        error: r.error,
        conversationId: conv.conversationId
      });
    }
    return { ok: sent.some((s) => s.ok), sent };
  }
}

// ---------- 纯函数（单测覆盖） ----------

/**
 * 按最后沟通时间倒序排列联系人（越新越靠前）。
 * @param {object[]} contacts [{uid, nickname, ...}]
 * @param {Map<string,string>|object|null} lastActiveByUid uid → 时间戳字符串（19 位微秒）
 * @returns {object[]} 有记录者按 ts 降序，无记录者保持原顺序排在最后
 */
function sortContactsByLastActive(contacts, lastActiveByUid) {
  if (!Array.isArray(contacts)) return [];
  const map = lastActiveByUid instanceof Map
    ? lastActiveByUid
    : new Map(Object.entries(lastActiveByUid || {}));
  const withTs = [];
  const withoutTs = [];
  for (const c of contacts) {
    const ts = map.get(c.uid);
    if (ts) withTs.push({ ...c, lastActiveTs: ts });
    else withoutTs.push(c);
  }
  withTs.sort((a, b) => (b.lastActiveTs > a.lastActiveTs ? 1 : b.lastActiveTs < a.lastActiveTs ? -1 : 0));
  return withTs.concat(withoutTs);
}

/** 提取正文中的 @提及：昵称字符集为 中文/字母/数字/下划线/连字符；@ 前必须独立成词（避免 a@b 邮箱误提） */
function extractMentions(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const re = /@([\u4e00-\u9fa5A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const prev = m.index > 0 ? text.charAt(m.index - 1) : '';
    if (prev && /[\u4e00-\u9fa5A-Za-z0-9_-]/.test(prev)) continue; // @ 前紧贴昵称字符（邮箱等）
    out.push({ raw: m[0], name: m[1] });
  }
  return out;
}

/** @提及名 匹配联系人（昵称或备注，忽略大小写）；去重保序 */
function resolveMentions(mentions, contacts) {
  const byName = new Map();
  for (const c of contacts || []) {
    const nick = String(c.nickname || '').toLowerCase();
    const remark = String(c.remark || '').toLowerCase();
    if (nick) byName.set(nick, c);
    if (remark && !byName.has(remark)) byName.set(remark, c);
  }
  const seen = new Set();
  const out = [];
  for (const m of mentions || []) {
    const key = String(m.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    const c = byName.get(key);
    if (!c) continue;
    seen.add(key);
    out.push({ name: m.name, uid: c.uid, contact: c });
  }
  return out;
}

/** 选会话：优先单聊，否则第一个（可能是群聊，对方同样能收到通知） */
function pickConversation(convs) {
  if (!Array.isArray(convs) || !convs.length) return null;
  return convs.find((c) => !c.isGroup) || convs[0];
}

/** 通知文案：发送者昵称 + 想法全文 */
function makeNotifyText(senderName, text) {
  const from = (senderName && String(senderName).trim()) || '你的朋友';
  return '【灵感笔记】' + from + ' 在灵感笔记 @了你：\n\n' + String(text == null ? '' : text);
}

module.exports = {
  QzCli,
  extractMentions,
  resolveMentions,
  pickConversation,
  makeNotifyText,
  sortContactsByLastActive
};
