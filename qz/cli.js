/**
 * qz/cli.js —— 本机 qz CLI 封装（@ 提及通知用）
 *
 * 思路：灵感笔记开放平台没有「给联系人发消息」的接口，而 qz CLI
 * （内部网关 client.qzhuli.com 的登录态，~/.qzhuli-cli/）可以发私信，因此 @ 提及通知
 * 通过 spawn qz CLI 完成：friend list 拿联系人 → conversation search 找会话
 * → message send 发私信。
 *
 * @ 通知规则（用户拍板，通用产品全量生效）：
 *  - 消息必须发在「和自己的私人助理（默认助理）的会话」中：即会话里 owner 侧
 *    agent.id === 我的默认助理 agent.id（user search 自己的 uid 返回 agent）。
 *  - 没有这样的会话时自动创建：conversation create <对方uid> --agent-id <对方agent.id>
 *    （create 的 agent-id 是 friend_agent_id，即对方的 agent；owner 侧默认就是自己的默认助理）。
 *  - 始终以本人名义发出（--role 1）。
 *  - 所有用户安装产品都捆绑 qzhuliCLI；用户已装 qz CLI 时优先用用户自己的（探测顺序：
 *    固定路径 / PATH / 应用捆绑目录）。
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

/** 应用捆绑 qzhuliCLI 的入口（electron-builder 把 dependencies 打进 asar，此处探测 dist/cmd.js） */
function bundledCliEntry(appPath) {
  if (!appPath) return '';
  const p = path.join(appPath, 'node_modules', '@qzhuli', 'qzhuli-cli', 'dist', 'cmd.js');
  return fs.existsSync(p) ? p : '';
}

class QzCli {
  /**
   * @param {object} opts
   * @param {string} [opts.binPath] qz 可执行文件绝对路径（测试/特殊安装场景）
   * @param {string} [opts.cwd] 子进程工作目录（默认主目录，确保读生产 ~/.qzhuli-cli/）
   * @param {number} [opts.timeoutMs] 单条命令超时
   * @param {string} [opts.appPath] 应用根目录（Electron app.getAppPath()），用于探测捆绑 qzhuliCLI
   */
  constructor(opts = {}) {
    this.binPath = opts.binPath || '';
    this.cwd = opts.cwd || os.homedir();
    this.timeoutMs = opts.timeoutMs || 15000;
    this.appPath = opts.appPath || '';
  }

  /**
   * 探测 qz CLI：固定路径 > PATH（用户已装的优先）> 应用捆绑（asar 内 dist/cmd.js，走 ELECTRON_RUN_AS_NODE）。
   * @returns {{bin: string, bundled: boolean}|null} null 表示完全找不到
   */
  resolveBin() {
    if (this.binPath && fs.existsSync(this.binPath)) return { bin: this.binPath, bundled: false };
    for (const p of CANDIDATE_BINS) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return { bin: p, bundled: false };
      } catch (e) { /* continue */ }
    }
    for (const dir of (process.env.PATH || '').split(':')) {
      if (!dir) continue;
      const p = path.join(dir, 'qz');
      if (fs.existsSync(p)) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return { bin: p, bundled: false };
        } catch (e) { /* continue */ }
      }
    }
    const entry = bundledCliEntry(this.appPath);
    if (entry) return { bin: entry, bundled: true };
    return null;
  }

  /** 执行一条 qz 命令，解析 stdout JSON；任何异常都返回 { status:'error', ... } 不 throw */
  run(args, timeoutMs) {
    const found = this.resolveBin();
    if (!found) return Promise.resolve({ status: 'error', code: 'CLI_NOT_FOUND', message: '未找到 qz CLI', data: null });
    const env = {
      ...process.env,
      PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(':')
    };
    // 捆绑版：cmd.js 是 Node 脚本，用当前 Electron 可执行文件以纯 Node 模式运行
    const bin = found.bundled ? process.execPath : found.bin;
    const runArgs = found.bundled ? [found.bin, ...args] : args;
    if (found.bundled) env.ELECTRON_RUN_AS_NODE = '1';
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, runArgs, {
          cwd: this.cwd,
          env
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
    const found = this.resolveBin();
    if (!found) return { ok: false, reason: 'cli_not_found', binPath: '' };
    const r = await this.run(['auth', 'status']);
    if (r.status === 'success' && r.data && r.data.uid) {
      return { ok: true, binPath: found.bin };
    }
    return { ok: false, reason: r.code || 'auth_failed', message: r.message || 'qz CLI 未登录' };
  }

  /** 联系人列表（qz friend list），按最后沟通时间倒序（越新越靠前）；读不到时间则保持原顺序。
   * 每个联系人附带 agentTitle：我的默认助理（私人助理）名——用户拍板「私人助理=默认助理」，
   * @ 通知统一发到默认助理会话，故下拉里显示的名字统一是默认助理名（如「李青蓝」），
   * 而不是各自会话归属的数字员工（曾按会话归属显示「易发版/战争：世界征服」等，用户指正为错）。 */
  async listContacts() {
    const r = await this.run(['friend', 'list', '--jq', '.data.links']);
    if (r.status !== 'success' || !Array.isArray(r.data)) return [];
    const agent = await this.myDefaultAgent();
    const agentTitle = (agent && agent.title) || '';
    const contacts = r.data
      .filter((l) => l && l.uid)
      .map((l) => ({
        uid: l.uid,
        nickname: l.nickname || '',
        remark: l.friend_name || '',
        linkType: l.link_type,
        avatar: l.avatar || '',
        agentTitle
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

  /** 某 uid 的既有会话（含 owner 侧 agent.id，供「私人助理会话」判定） */
  async findConversation(uid) {
    if (!uid) return [];
    const ownerUid = await this._ownerUid();
    const r = await this.run(['conversation', 'search', uid, '--uid', '--jq', '.data']);
    if (r.status !== 'success' || !r.data) return [];
    const convs = Array.isArray(r.data.conversations) ? r.data.conversations : [];
    return convs
      .filter((c) => c && c.conversationId)
      .map((c) => {
        let ownerAgentId = null;
        if (ownerUid && Array.isArray(c.users)) {
          const me = c.users.find((u) => u && String(u.uid) === String(ownerUid));
          if (me && me.agent && me.agent.id != null) ownerAgentId = String(me.agent.id);
        }
        return { conversationId: c.conversationId, isGroup: c.isGroup || 0, ownerAgentId };
      });
  }

  /** 我的默认助理（私人助理）：user search 自己的 uid → data.agent {id, title}；进程内缓存 */
  async myDefaultAgent() {
    if (this._defaultAgent) return this._defaultAgent;
    const ownerUid = await this._ownerUid();
    if (!ownerUid) return null;
    const r = await this.run(['user', 'search', ownerUid, '--uid', '--jq', '.data.agent']);
    if (r.status === 'success' && r.data && r.data.id != null) {
      this._defaultAgent = {
        id: String(r.data.id),
        title: String(r.data.title || '')
      };
      return this._defaultAgent;
    }
    return null;
  }

  /** 我的默认助理（私人助理）agent.id；获取失败返回空串 */
  async myDefaultAgentId() {
    const agent = await this.myDefaultAgent();
    return agent ? agent.id : '';
  }

  /** 某 uid 的默认助理 agent.id（user search 对方 uid）——创建会话时作为 friend_agent_id */
  async friendAgentId(uid) {
    if (!uid) return '';
    const r = await this.run(['user', 'search', uid, '--uid', '--jq', '.data.agent']);
    return r.status === 'success' && r.data && r.data.id != null ? String(r.data.id) : '';
  }

  /** 创建与某 uid 的会话（owner 侧自动是调用者的默认助理），返回 conversationId */
  async createConversation(uid, friendAgentId) {
    if (!uid || !friendAgentId) return { ok: false, code: 'NO_AGENT', error: '缺少联系人助理信息' };
    const r = await this.run(['conversation', 'create', uid, '--agent-id', friendAgentId, '--jq', '.data']);
    if (r.status === 'success' && r.data && r.data.conversationId) {
      return { ok: true, conversationId: String(r.data.conversationId), error: null };
    }
    return { ok: false, code: r.code, error: r.message || '创建会话失败' };
  }

  /** 发一条私信（固定以本人名义 --role 1 发出，不以助理/数字员工身份） */
  async sendMessage(conversationId, content) {
    if (!conversationId) return { ok: false, error: '缺少会话ID' };
    const r = await this.run(['message', 'send', conversationId, content, '--role', '1']);
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

    // 我的默认助理（私人助理）：所有目标都发在「owner 侧 = 我的默认助理」的会话里
    const myAgentId = await this.myDefaultAgentId();
    if (!myAgentId) {
      return { ok: false, sent: [], error: '无法获取默认助理信息' };
    }

    const body = makeNotifyText(senderName, text);
    const sent = [];
    for (const t of targets) {
      const convs = await this.findConversation(t.uid);
      const conv = pickConversation(convs, myAgentId);
      if (!conv) {
        // 没有私人助理会话 → 自动创建（create 的 agent-id 是对方 agent；owner 侧默认即我的默认助理）
        const friendAgent = await this.friendAgentId(t.uid);
        if (!friendAgent) {
          sent.push({ name: t.name, nickname: t.contact.nickname || t.name, uid: t.uid, ok: false, error: '无法获取对方助理信息', conversationId: '' });
          continue;
        }
        const cr = await this.createConversation(t.uid, friendAgent);
        if (!cr.ok) {
          sent.push({ name: t.name, nickname: t.contact.nickname || t.name, uid: t.uid, ok: false, error: cr.error || '创建会话失败', conversationId: '' });
          continue;
        }
        const r = await this.sendMessage(cr.conversationId, body);
        sent.push({
          name: t.name,
          nickname: t.contact.nickname || t.name,
          uid: t.uid,
          ok: r.ok,
          error: r.error,
          conversationId: cr.conversationId,
          created: true
        });
        continue;
      }
      const r = await this.sendMessage(conv.conversationId, body);
      sent.push({
        name: t.name,
        nickname: t.contact.nickname || t.name,
        uid: t.uid,
        ok: r.ok,
        error: r.error,
        conversationId: conv.conversationId,
        created: false
      });
    }
    return { ok: sent.some((s) => s.ok), sent };
  }
}

// ---------- 纯函数（单测覆盖） ----------

/**
 * 把「会话归属助理」附加到联系人：agentByUid 为 Map/对象 uid → {title, ts}；
 * 命中则复制一份并加 agentTitle 字段，未命中保持原对象不变。
 * 注意：listContacts 已改为统一显示默认助理名（不调用本函数）；本函数保留作通用工具。
 */
function attachAgentTitles(contacts, agentByUid) {
   if (!Array.isArray(contacts)) return [];
   const map = agentByUid instanceof Map ? agentByUid : new Map(Object.entries(agentByUid || {}));
   return contacts.map((c) => {
     const a = map.get(String(c && c.uid));
     return a && a.title ? { ...c, agentTitle: a.title } : c;
   });
 }

 /** 按最后沟通时间倒序排列联系人（越新越靠前）。
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

/**
 * 选会话（@ 通知规则）：必须是「和自己的私人助理（默认助理）的会话」——
 * 即会话里 owner 侧 agent.id === myAgentId（user search 自己的 uid 拿到的默认助理）。
 * 没有匹配的会话返回 null（调用方走创建会话分支）。匹配内优先单聊，其次任意。
 * @param {object[]} convs [{conversationId, isGroup, ownerAgentId}]
 * @param {string} myAgentId 我的默认助理 agent.id
 */
function pickConversation(convs, myAgentId) {
  if (!Array.isArray(convs) || !convs.length) return null;
  const mine = convs.filter((c) => String(c.ownerAgentId) === String(myAgentId));
  if (!mine.length) return null;
  return mine.find((c) => !c.isGroup) || mine[0];
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
  sortContactsByLastActive,
  attachAgentTitles,
  bundledCliEntry
};
