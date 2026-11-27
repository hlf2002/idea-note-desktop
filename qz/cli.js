/**
 * qz/cli.js —— 本机 qz CLI 封装（@ 提及通知用）
 *
 * 思路：灵感笔记开放平台没有「给联系人发消息」的接口，而 qz CLI
 * （内部网关 client.qzhuli.com 的登录态，~/.qzhuli-cli/）可以发私信，因此 @ 提及通知
 * 通过 spawn qz CLI 完成：friend list 拿联系人 → conversation search 找会话
 * → message send 发私信。
 *
 * @ 通知规则（用户拍板，通用产品全量生效）：
 *  - 消息必须发在「我 + 我的默认助理 + 对方 + 对方的默认助理」的双人会话中：
 *    owner 侧 agent.id === 我的默认助理 agent.id（user search 自己的 uid 返回 agent），
 *    且对方侧 agent.id === 对方的默认助理 agent.id（user search 对方 uid 返回 agent）；
 *    只有双方默认助理都在的双人会话才发，群聊/数字员工会话一律不选。
 *  - 没有这样的会话时自动创建：conversation create <对方uid> --agent-id <对方agent.id>
 *    （create 的 agent-id 是 friend_agent_id，即对方的默认助理；owner 侧默认就是自己的默认助理）。
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

/** macOS/Linux GUI 应用启动 PATH 不含 /opt/homebrew/bin，必须按固定路径探测 */
const POSIX_CANDIDATE_BINS = ['/opt/homebrew/bin/qz', '/usr/local/bin/qz', '/usr/bin/qz'];
/**
 * Windows 固定路径：只认可直接 spawn 的 .exe。
 * npm 全局安装生成的是 qz.cmd / qz.ps1（批处理与脚本），spawn 不能直调，
 * 走 cmd.exe /c 又会让「想法全文」进 shell（& | % 都是注入面）——所以一律不用。
 */
const WIN_QZ_EXE_NAMES = ['qz.exe'];
/** 子进程 PATH 补充（防止 qz 依赖的同名命令找不到） */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];
/** qz CLI 缓存库（SQLite，macOS 自带 sqlite3 直读；Windows 无 sqlite3 → 降级为不排序） */
const SQLITE3_BIN = '/usr/bin/sqlite3';
/** 缓存同步新鲜度：12 小时内同步过就不再 cache sync（避免每次 @ 都等几秒） */
const SYNC_FRESH_MS = 12 * 3600 * 1000;
/**
 * 扫码登录「多久没出二维码就判该候选不可用」。
 * Windows 下捆绑版要走 ELECTRON_RUN_AS_NODE 冷启动 Electron + 读 asar 里的 CLI，
 * 实测比 macOS 慢得多（杀毒软件/机械盘再叠加），3 秒会误杀可用候选。
 */
const QR_PROBE_MS_POSIX = 3000;
const QR_PROBE_MS_WIN = 12000;


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
    /** 平台可注入（单测用）：Windows 与 POSIX 的候选探测规则不同 */
    this.platform = opts.platform || process.platform;
    /** 诊断日志文件（Windows 安装版没有终端，console.warn 用户看不到） */
    this.logFile = opts.logFile || '';
    /** 扫码登录出码等待时间（可注入，单测用） */
    this.qrProbeMs = Number(opts.qrProbeMs) > 0
      ? Number(opts.qrProbeMs)
      : (this.platform === 'win32' ? QR_PROBE_MS_WIN : QR_PROBE_MS_POSIX);
  }

  /** 设置诊断日志文件（主进程按 userData 传入；每次写前做体积上限保护） */
  setLogFile(file) {
    this.logFile = String(file || '');
    return this;
  }

  /** 写诊断日志：始终 console.warn，能写文件时一并落盘（失败静默，绝不影响主流程） */
  _log(msg) {
    const line = '[qz-cli] ' + msg;
    try { console.warn(line); } catch (e) { /* noop */ }
    if (!this.logFile) return;
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 256 * 1024) {
        fs.renameSync(this.logFile, this.logFile + '.1');
      }
      fs.appendFileSync(this.logFile, new Date().toISOString() + ' ' + line + '\n', 'utf-8');
    } catch (e) { /* noop */ }
  }

  /**
   * 候选 qz CLI（按优先级）。
   *
   * POSIX（mac/linux）：用户已装（固定路径 > PATH）→ 应用捆绑（asar 内 dist/cmd.js）。
   * 保留「用户已装优先」（版本可能更新），但它依赖系统 node 的 ABI：打包版从 Finder 启动时
   * PATH 里只有 /opt/homebrew 的 node（ABI 137），而 qz 的 better_sqlite3.node 可能按别的
   * node 编译（ABI 147）→ 子进程一跑就 NODE_MODULE_VERSION 崩溃。所以 run() 会按顺序降级到
   * 下一个候选：捆绑版走 ELECTRON_RUN_AS_NODE，ABI 与 Electron 一致，不依赖系统 node。
   *
   * Windows：**捆绑版优先**。用户 npm 全局装的 qz 是 qz.cmd 批处理（spawn 不能直调，
   * 经 cmd.exe /c 会把想法全文交给 shell 解析），且其 better_sqlite3.node 按系统 node 编译，
   * 与 Electron ABI 不匹配；捆绑版（ELECTRON_RUN_AS_NODE）实测可运行、读同一份
   * ~/.qzhuli-cli 登录态。不带扩展名的 `qz`（npm 生成的 POSIX 脚本）在 Windows 上永远不可执行。
   * @returns {{bin: string, bundled: boolean}[]}
   */
  resolveCandidates() {
    const out = [];
    const push = (bin, bundled) => {
      if (!bin) return;
      if (out.some((c) => c.bin === bin)) return;
      out.push({ bin, bundled });
    };
    const bundled = bundledCliEntry(this.appPath);
    if (this.platform === 'win32') {
      push(bundled, true);
      if (this.binPath && fs.existsSync(this.binPath)) push(this.binPath, false);
      const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
      for (const dir of pathDirs) {
        for (const name of WIN_QZ_EXE_NAMES) {
          const p = path.join(dir, name);
          if (fs.existsSync(p)) push(p, false);
        }
      }
      return out;
    }
    if (this.binPath && fs.existsSync(this.binPath)) push(this.binPath, false);
    for (const p of POSIX_CANDIDATE_BINS) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        push(p, false);
      } catch (e) { /* continue */ }
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, 'qz');
      if (fs.existsSync(p)) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          push(p, false);
        } catch (e) { /* continue */ }
      }
    }
    push(bundled, true);
    return out;
  }

  /**
   * 首选 qz CLI（顺序与 resolveCandidates 一致：mac/linux 用户已装优先，Windows 绑定捆绑版优先）。
   * 注意：这是「第一个候选」，不代表可用；run() 会按候选顺序降级。
   * @returns {{bin: string, bundled: boolean}|null} null 表示完全找不到
   */
  resolveBin() {
    return this.resolveCandidates()[0] || null;
  }

  /** 执行一条 qz 命令：按候选顺序尝试，首个候选「起不来/崩了」自动降级到下一个。
   *  业务错误（qz 正常返回 status=error 的 JSON）不降级，原样返回。
   *  @returns {Promise<{status:string, code:string, message?:string, data:any}>} 不 throw */
  async run(args, timeoutMs) {
    if (!this._badBins) this._badBins = new Set();
    const all = this.resolveCandidates();
    const cands = all.filter((c) => !this._badBins.has(c.bin));
    if (!cands.length) {
      // 「没装」和「装了但起不来」要分开：Windows 打包版曾因一次慢启动被永久标坏，
      // 用户看到「未找到 qz CLI」完全误导（日志里才有真因）
      if (all.length) {
        this._log('候选全部不可用（进程内已标记坏）: ' + Array.from(this._badBins).join(' | '));
        return { status: 'error', code: 'CLI_UNAVAILABLE', message: 'qz CLI 启动失败（候选均不可用）', data: null };
      }
      return { status: 'error', code: 'CLI_NOT_FOUND', message: '未找到可用的 qz CLI', data: null };
    }
    let last = null;
    for (let i = 0; i < cands.length; i++) {
      const found = cands[i];
      const r = await this._runOnce(found, args, timeoutMs);
      if (r.data && r.data.status) {
        this._lastBin = found.bin;
        return r; // qz 正常应答（含业务错误），不再降级
      }
      if (r.status === 'success') {
        this._lastBin = found.bin;
        return r;
      }
      last = r;
      // 起不来 / 崩溃才换下一个；并记录坏候选，避免每次都重试（本次进程内）
      const broken = r.code === 'CLI_SPAWN' || r.code === 'CLI_EXIT';
      if (broken) {
        this._badBins.add(found.bin);
        const hint = /NODE_MODULE_VERSION/.test(r.message || '') ? '（原生模块 ABI 与运行 node 不匹配）' : '';
        this._log('候选不可用，降级到下一个: ' + found.bin + hint + ' / ' + (r.message || '').split('\n').slice(0, 3).join(' '));
      }
    }
    return last;
  }

  /** 用指定候选执行一次（内部） */
  _runOnce(found, args, timeoutMs) {
    const env = {
      ...process.env,
      PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(path.delimiter)
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
    const all = this.resolveCandidates();
    if (!all.length) return { ok: false, reason: 'cli_not_found', binPath: '' };
    const r = await this.run(['auth', 'status']);
    if (r.status === 'success' && r.data && r.data.uid) {
      // 报告实际应答的那份 CLI（可能是降级后的捆绑版，不是首选候选）
      return { ok: true, binPath: this._lastBin || all[0].bin };
    }
    return { ok: false, reason: r.code || 'auth_failed', message: r.message || 'qz CLI 未登录' };
  }

  /**
   * 扫码登录（qz auth login --method qr-code）：把终端二维码通过 onEvent 交给渲染层。
   * 为什么不等用户自己去终端跑：桌面端用户不知道 qz CLI 存在；未登录时应用直接发起登录，
   * 二维码显示在应用内（白底黑字即可扫），扫码成功后 CLI 自己落盘 ~/.qzhuli-cli/ 凭据。
   *
   * 候选降级：首选用户已装 CLI，起不来（ABI 崩/未安装）时换捆绑版；
   * 3 秒内没有任何二维码输出就判该候选不可用（正常候选几百毫秒就出图）。
   *
   * @param {{onEvent?: (e: {phase: 'qr'|'success'|'error'|'expired', text?: string, message?: string}) => void, timeoutMs?: number}} handlers
   * @returns {{cancel: () => void}}
   */
  startQrLogin(handlers = {}) {
    const emit = (p) => { try { if (typeof handlers.onEvent === 'function') handlers.onEvent(p); } catch (e) { /* noop */ } };
    // 二维码 5 分钟过期（CLI 侧），留 30s 余量后判过期
    const timeoutMs = Number(handlers.timeoutMs) > 0 ? Number(handlers.timeoutMs) : 330000;
    if (!this._badBins) this._badBins = new Set();
    const state = { cancelled: false, done: false, child: null, timer: null };
    const kill = (child) => { try { if (child) child.kill('SIGKILL'); } catch (e) { /* noop */ } };
    const stop = (payload) => {
      if (state.done) return;
      state.done = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      kill(state.child);
      state.child = null;
      if (!state.cancelled) emit(payload);
    };

    const cands = this.resolveCandidates().filter((c) => !this._badBins.has(c.bin));
    let idx = 0;
    const tryNext = () => {
      if (state.cancelled || state.done) return;
      const found = cands[idx];
      idx += 1;
      if (!found) {
        stop({ phase: 'error', message: '未找到可用的 qz CLI，无法发起扫码登录' });
        return;
      }
      let child;
      try {
        child = this._spawnLoginChild(found);
      } catch (e) {
        tryNext();
        return;
      }
      state.child = child;
      let out = '';
      let qrText = '';
      let settled = false;      // 已收到二维码块
      let attemptDone = false;  // 本候选已收尾（超时/退出/错误），防重复 tryNext
      const probeMs = this.qrProbeMs;
      // 超时没出二维码 → 放弃本候选、换下一个。
      // **不标记为坏候选**，且**没有下一个候选时干脆不杀**：Windows 冷启动 Electron +
      // 读 asar 里的 CLI 明显更慢（实测 6s 还没出码），杀一次就把捆绑版永久踢掉，
      // 用户之后每次 @ 都显示「找不到 qz CLI」。唯一候选继续等它自己出码，总超时兜底。
      const probeTimer = setTimeout(() => {
        if (settled || qrText || state.done || attemptDone) return;
        settled = true;
        if (idx >= cands.length) {
          this._log('扫码登录唯一候选 ' + probeMs + 'ms 未出码，继续等待（不杀进程，由总超时兜底）: ' + found.bin);
          return;
        }
        attemptDone = true;
        this._log('扫码登录候选 ' + probeMs + 'ms 未出二维码，尝试下一个: ' + found.bin);
        kill(child);
        tryNext();
      }, probeMs);
      const onChunk = (chunk) => {
        out += String(chunk);
        const block = extractQrBlock(out);
        if (block && block !== qrText) {
          qrText = block;
          if (!settled) { settled = true; clearTimeout(probeTimer); }
          this._lastBin = found.bin;
          emit({ phase: 'qr', text: block });
        }
        if (/"code"\s*:\s*"AUTH_LOGIN_SUCCESS"/.test(out)) {
          clearTimeout(probeTimer);
          stop({ phase: 'success' });
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('error', (err) => {
        clearTimeout(probeTimer);
        if (attemptDone || qrText) return;
        attemptDone = true;
        this._badBins.add(found.bin);
        this._log('扫码登录候选无法启动，降级到下一个: ' + found.bin + ' / ' + ((err && err.message) || err));
        tryNext();
      });
      child.on('close', () => {
        clearTimeout(probeTimer);
        if (attemptDone) return;
        attemptDone = true;
        if (qrText) {
          stop({ phase: 'error', message: cliErrorMessage(out) || '扫码登录中断，请重试' });
        } else if (!state.done) {
          this._badBins.add(found.bin);
          this._log('扫码登录候选退出且没有二维码，降级到下一个: ' + found.bin + ' / ' + (cliErrorMessage(out) || ''));
          tryNext();
        }
      });
    };

    state.timer = setTimeout(() => stop({ phase: 'expired' }), timeoutMs);
    tryNext();
    return {
      cancel: () => {
        state.cancelled = true;
        state.done = true;
        if (state.timer) clearTimeout(state.timer);
        kill(state.child);
        state.child = null;
      }
    };
  }

  /** 用指定候选 spawn 扫码登录子进程（内部；与 _runOnce 的 env 规则保持一致） */
  _spawnLoginChild(found) {
    const env = {
      ...process.env,
      PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(path.delimiter)
    };
    const bin = found.bundled ? process.execPath : found.bin;
    const args = found.bundled
      ? [found.bin, 'auth', 'login', '--method', 'qr-code']
      : ['auth', 'login', '--method', 'qr-code'];
    if (found.bundled) env.ELECTRON_RUN_AS_NODE = '1';
    return spawn(bin, args, { cwd: this.cwd, env });
  }

  /**
   * 单条笔记的远端图片地址（qz note get <id> → data.images）。
   * 开放平台只给 image_id；内部接口返回真实 CDN URL，用于「本机没有副本」的图兜底展示。
   * 未登录 / 网络失败 / 笔记不存在一律返回 null（调用方静默跳过，不影响列表渲染）。
   * @param {string|number} noteId
   * @returns {Promise<string[]|null>}
   */
  async noteImageUrls(noteId) {
    const id = String(noteId == null ? '' : noteId).trim();
    if (!id || !/^[0-9]+$/.test(id)) return null;
    const r = await this.run(['note', 'get', id, '--jq', '.data.images']);
    if (!r || r.status !== 'success') return null;
    if (!Array.isArray(r.data)) return [];
    return r.data.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
  }

  /** 联系人列表（qz friend list），按最后沟通时间倒序（越新越靠前）；读不到时间则保持原顺序。 */
  async listContacts() {
    const r = await this.run(['friend', 'list', '--jq', '.data.links']);
    if (r.status !== 'success' || !Array.isArray(r.data)) return [];
    // 0.7.x 起 friend list 的 links 里会带上自己（link_type 0）：@ 自己没有意义且会给自己发私信
    const myUid = await this._ownerUid();
    const contacts = r.data
      .filter((l) => l && l.uid && (!myUid || String(l.uid) !== myUid))
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
      this._log('读取最后沟通时间失败，联系人按原顺序展示: ' + ((err && err.message) || err));
      return null;
    }
  }

  /** 当前登录账号的 owner uid（qz auth status） */
  async _ownerUid() {
    if (this._ownerUidCache) return this._ownerUidCache;
    const r = await this.run(['auth', 'status']);
    if (r.status === 'success' && r.data && r.data.uid) {
      this._ownerUidCache = String(r.data.uid);
      return this._ownerUidCache;
    }
    return '';
  }

  /** 某 uid 的既有会话（带出 owner 侧与对方侧 agent.id，供「双人双助理会话」判定） */
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
        let friendAgentId = null;
        if (Array.isArray(c.users)) {
          for (const u of c.users) {
            if (!u || !u.uid) continue;
            const agentId = u.agent && u.agent.id != null ? String(u.agent.id) : null;
            if (ownerUid && String(u.uid) === String(ownerUid)) {
              ownerAgentId = agentId;
            } else if (String(u.uid) === String(uid)) {
              friendAgentId = agentId;
            }
          }
        }
        return { conversationId: c.conversationId, isGroup: c.isGroup || 0, ownerAgentId, friendAgentId };
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
   * @param {string} text 想法全文（含 @昵称）
   * @param {string} senderName 发送者昵称
   * @param {string} [pageUrl] 该想法对应的网站分享页 URL（有则附在私信末尾）
   * @returns {Promise<{ok:boolean, sent:Array, skipped?:string, error?:string}>}
   *   sent 每项 { name, nickname, uid, ok, error, conversationId }
   */
  async notifyMentions(text, senderName, pageUrl) {
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

    const body = makeNotifyText(senderName, text, pageUrl);
    const sent = [];
    for (const t of targets) {
      // 对方默认助理 agent.id：会话必须同时有「我的默认助理」和「对方的默认助理」才发
      const friendAgent = await this.friendAgentId(t.uid);
      if (!friendAgent) {
        sent.push({ name: t.name, nickname: t.contact.nickname || t.name, uid: t.uid, ok: false, error: '无法获取对方默认助理信息', conversationId: '' });
        continue;
      }
      const convs = await this.findConversation(t.uid);
      const conv = pickConversation(convs, myAgentId, friendAgent);
      if (!conv) {
        // 没有「我 + 我的默认助理 + 对方 + 对方的默认助理」的双人会话 → 自动创建
        // （create 的 agent-id 是对方默认助理；owner 侧默认即我的默认助理）
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

/** 去掉终端控制序列（清屏 ESC[2J / 定位 ESC[H 等）与回车；保留二维码字符与中文 */
function stripAnsi(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*\x07/g, '')
    .replace(/\r/g, '');
}

/** 二维码行：只由半块字符 █ / ▀ / ▄ 与空格组成（qrcode-terminal small 模式输出） */
const QR_LINE_RE = /^[\u2588\u2580\u2584 ]+$/;

/**
 * 从 qz CLI 的 stdout 里提取二维码文本块（最长的一段连续二维码行）。
 * 取不到返回 ''。渲染层直接用 <pre> 白底黑字显示即可扫（实心字符=黑模块）。
 * @param {string} raw
 * @returns {string}
 */
function extractQrBlock(raw) {
  const lines = stripAnsi(raw).split('\n');
  let run = [];
  let best = [];
  const flush = () => {
    if (run.length > best.length) best = run;
    run = [];
  };
  for (const line of lines) {
    const isQr = line.length >= 15 && QR_LINE_RE.test(line) && /[\u2588\u2580\u2584]/.test(line);
    if (isQr) run.push(line);
    else flush();
  }
  flush();
  return best.length >= 10 ? best.join('\n') : '';
}

/** 从 qz CLI 输出里取错误 message（取不到返回 ''） */
function cliErrorMessage(raw) {
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(stripAnsi(raw));
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
}

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
 * 选会话（@ 通知规则）：必须是「我 + 我的默认助理 + 对方 + 对方的默认助理」的双人会话——
 * 即会话里 owner 侧 agent.id === myAgentId（我的默认助理），且对方侧 agent.id === friendAgentId
 * （对方的默认助理），且是单聊（isGroup=0）。群聊/数字员工会话一律不选；
 * 没有匹配的会话返回 null（调用方走创建会话分支）。
 * @param {object[]} convs [{conversationId, isGroup, ownerAgentId, friendAgentId}]
 * @param {string} myAgentId 我的默认助理 agent.id
 * @param {string} friendAgentId 对方的默认助理 agent.id
 */
function pickConversation(convs, myAgentId, friendAgentId) {
  if (!Array.isArray(convs) || !convs.length) return null;
  return convs.find((c) =>
    !c.isGroup &&
    String(c.ownerAgentId) === String(myAgentId) &&
    String(c.friendAgentId) === String(friendAgentId)
  ) || null;
}

/** 通知文案：发送者昵称 + 想法全文 + 分享页链接（有则附在末尾） */
function makeNotifyText(senderName, text, pageUrl) {
  const from = (senderName && String(senderName).trim()) || '你的朋友';
  const base = '【灵感笔记】' + from + ' 在灵感笔记 @了你：\n\n' + String(text == null ? '' : text);
  const url = pageUrl && String(pageUrl).trim();
  if (!url) return base;
  return base + '\n\n查看完整笔记：' + url;
}

module.exports = {
  QzCli,
  extractMentions,
  resolveMentions,
  pickConversation,
  makeNotifyText,
  sortContactsByLastActive,
  attachAgentTitles,
  bundledCliEntry,
  stripAnsi,
  extractQrBlock,
  cliErrorMessage
};
