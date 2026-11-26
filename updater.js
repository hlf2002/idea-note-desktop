/**
 * updater.js —— 自动化升级（基于 electron-updater）
 *
 * 能力：
 *   - 打包版（app.isPackaged）启动后延迟自动检查更新，之后每 4 小时自动检查一次
 *   - 发现新版本默认自动后台下载（可用 update-config.json 关闭），下载完成提示一键重启安装
 *   - 升级事件实时推送到渲染层（updater:event），供更新条 UI 展示
 *   - 更新服务器地址：默认取 package.json build.publish（electron-builder 打包时写入
 *     resources/app-update.yml）；可用 userData/update-config.json 运行时覆盖
 *
 * update-config.json 示例（可选，放在用户数据目录）：
 *   { "provider": "generic", "url": "https://your-server.example.com/updates/", "autoDownload": false }
 *
 * 发布新版本（生成 latest.yml / latest-mac.yml + 安装包 + zip）：
 *   npm run build        # 产物在 dist/，把整个 dist 目录上传到更新服务器即可
 */
'use strict';

const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const FIRST_CHECK_DELAY_MS = 10 * 1000;       // 启动 10 秒后首次静默检查

// ============ 纯逻辑（可单测） ============

/** 解析版本号 "1.2.3" / "1.2.3-beta.1"，非法返回 null */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: v.trim() };
}

/** 提取预发布标识段（如 "1.1.0-beta.1" → ["beta","1"]），无预发布返回 null */
function preRelease(raw) {
  const m = /-([0-9A-Za-z.-]+)/.exec(raw);
  return m ? m[1].split('.') : null;
}

/** 比较两个版本号（semver）：a>b→1，a<b→-1，相等→0，任一非法→NaN */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return NaN;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
  }
  // 主序号相同：比较预发布标识（无预发布 > 有预发布；数字段按数值比较，字母段按字典序）
  const aPre = preRelease(pa.raw);
  const bPre = preRelease(pb.raw);
  if (aPre === null && bPre === null) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const x = aPre[i];
    const y = bPre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return (+x > +y) ? 1 : -1;
    if (xNum) return -1; // 数字段优先于字母段
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 读取 userData/update-config.json 运行时配置（损坏/缺失返回 { file, config: null }） */
function loadUserUpdateConfig(dataDir) {
  const file = path.join(dataDir, 'update-config.json');
  let config = null;
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
      else console.warn('[updater] update-config.json 格式非法，忽略（应为 JSON 对象）');
    }
  } catch (e) {
    console.warn('[updater] update-config.json 解析失败，忽略: ' + e.message);
  }
  return { file, config };
}

/** 校验更新源配置：仅接受 generic provider + http(s) url */
function normalizeFeed(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (cfg.provider === 'generic' && typeof cfg.url === 'string' && /^https?:\/\//i.test(cfg.url.trim())) {
    return { provider: 'generic', url: cfg.url.trim() };
  }
  return null;
}

/** 是否自动下载：默认开启，update-config.json 可显式关闭 */
function resolveAutoDownload(cfg) {
  if (cfg && typeof cfg.autoDownload === 'boolean') return cfg.autoDownload;
  return true;
}

/**
 * 把升级组件抛出的原始错误归一化为可展示的短句。
 * 原始消息常含 URL、HTTP 状态、堆栈（用户看到就是「一串很长的错误代码」），只留给日志。
 * 纯函数，供单测与 IPC/事件共用。
 */
function friendlyUpdateError(err) {
  const raw = String((err && (err.message || err.code)) || '').trim();
  const firstLine = raw.split(/\r?\n/)[0] || '';
  // 顺序重要：404 的原文里通常也带 latest.yml，先按「清单缺失」归类
  if (/latest(?:-mac)?\.yml|Cannot find .*release artifacts|no (?:latest|update) (?:yaml|yml)/i.test(raw)) {
    return '更新服务器暂未提供更新清单，请稍后再试';
  }
  // 5xx 要先于 404 判定：原文形如 "HttpError: 503 Service Unavailable" 不含 404，
  // 但 "HttpError" 关键字不能单独当 404 依据
  if (/\b5\d\d\b|Internal Server Error|Bad Gateway|Service Unavailable/i.test(raw)) {
    return '更新服务暂时不可用，请稍后再试';
  }
  if (/HttpError[^\n]*\b404\b|status code 404|\b404\b/i.test(raw)) {
    return '更新服务返回异常（HTTP 404），请稍后再试';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ENETUNREACH|ECONNREFUSED|ECONNRESET/i.test(raw)) {
    return '网络不可用，无法连接更新服务器';
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out/i.test(raw)) return '连接更新服务器超时';
  if (/sha512|checksum|integrity/i.test(raw)) return '更新包校验失败，请稍后重试';
  if (/EPERM|EACCES|permission denied/i.test(raw)) return '没有权限写入更新文件，请检查安装目录权限';
  const cut = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
  return cut || '升级组件异常';
}

// ============ 主进程装配 ============

let autoUpdater = null;
let getWindow = null;
let onBeforeInstall = null;
let enabled = false;
let lastCheckManual = false; // 最近一次检查是否由用户手动触发（决定渲染层是否弹提示）

const state = {
  checking: false,
  downloading: false,
  downloaded: false,
  availableVersion: null,
  error: null,
  feedUrl: null,
  autoDownload: true
};

function emit(event, payload) {
  const win = getWindow && getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:event', Object.assign({ event }, payload || {}));
  }
}

function registerIpc() {
  ipcMain.handle('updater:getInfo', () => ({
    enabled,
    currentVersion: app.getVersion(),
    checking: state.checking,
    downloading: state.downloading,
    downloaded: state.downloaded,
    availableVersion: state.availableVersion,
    autoDownload: state.autoDownload,
    feedUrl: state.feedUrl,
    error: state.error ? state.error.message : null
  }));

  ipcMain.handle('updater:check', async () => {
    if (!enabled || !autoUpdater) {
      return { ok: false, message: '当前为开发模式，打包后自动检查更新才可用' };
    }
    if (state.downloading || state.downloaded) {
      return { ok: true, message: state.downloaded ? '新版本已就绪，可直接重启安装' : '正在下载更新…' };
    }
    try {
      lastCheckManual = true;
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      lastCheckManual = false;
      return { ok: false, message: friendlyUpdateError(err) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    if (!enabled || !autoUpdater) return { ok: false, message: '当前为开发模式，无法下载更新' };
    if (state.downloaded) return { ok: true, message: '新版本已就绪' };
    try {
      if (!state.downloading) await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: friendlyUpdateError(err) };
    }
  });

  ipcMain.handle('updater:install', () => {
    if (!enabled || !autoUpdater || !state.downloaded) return { ok: false, message: '尚无已下载的新版本' };
    if (onBeforeInstall) onBeforeInstall();
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
}

function bindEvents() {
  autoUpdater.on('checking-for-update', () => {
    state.checking = true;
    state.error = null;
    emit('checking', { manual: lastCheckManual });
  });
  autoUpdater.on('update-available', (info) => {
    state.checking = false;
    state.availableVersion = info && info.version;
    emit('available', { version: state.availableVersion, manual: lastCheckManual });
    lastCheckManual = false;
    console.log('[updater] 发现新版本: ' + state.availableVersion);
  });
  autoUpdater.on('update-not-available', (info) => {
    state.checking = false;
    emit('not-available', { version: info && info.version, manual: lastCheckManual });
    lastCheckManual = false;
  });
  autoUpdater.on('download-progress', (p) => {
    state.downloading = true;
    emit('downloading', {
      percent: Math.round((p && p.percent) || 0),
      transferred: p && p.transferred,
      total: p && p.total
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    state.downloading = false;
    state.downloaded = true;
    state.availableVersion = info && info.version;
    emit('downloaded', { version: state.availableVersion });
    console.log('[updater] 新版本已下载完成: ' + state.availableVersion);
  });
  autoUpdater.on('error', (err) => {
    state.checking = false;
    state.downloading = false;
    state.error = err;
    // 静默检查失败不打扰用户：事件照发（渲染层只复位状态），展示文案走友好化短句，
    // 原始长串（URL/HTTP/堆栈）只进日志。用户主动操作的失败由 IPC 返回值提示。
    emit('error', { message: friendlyUpdateError(err), manual: lastCheckManual });
    lastCheckManual = false;
    console.warn('[updater] 错误: ' + ((err && err.message) || err));
  });
}

/**
 * 初始化升级模块（main.js 在 whenReady 后调用）
 * @param {object} opts
 * @param {string} opts.dataDir 用户数据目录（读取 update-config.json）
 * @param {Function} opts.getWindow 返回主窗口（用于推送事件）
 * @param {Function} [opts.onBeforeInstall] 重启安装前回调（如放行退出）
 */
function initUpdater(opts) {
  getWindow = opts && opts.getWindow;
  onBeforeInstall = opts && opts.onBeforeInstall;

  // 开发模式：仅注册 IPC，返回当前版本与状态，不实际检查
  if (!app.isPackaged) {
    registerIpc();
    console.log('[updater] 开发模式：自动更新已禁用（打包版生效）');
    return { enabled: false };
  }

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    console.warn('[updater] electron-updater 加载失败，自动更新不可用: ' + e.message);
    registerIpc();
    return { enabled: false };
  }

  const userCfg = loadUserUpdateConfig(opts.dataDir);
  const feed = normalizeFeed(userCfg.config);
  if (feed) {
    autoUpdater.setFeedURL(feed);
    state.feedUrl = feed.url;
    console.log('[updater] 使用运行时更新源: ' + feed.url);
  } else {
    // 无运行时配置：使用打包时写入的 app-update.yml（来自 package.json build.publish）
    state.feedUrl = '(app-update.yml)';
  }

  state.autoDownload = resolveAutoDownload(userCfg.config);
  autoUpdater.autoDownload = state.autoDownload;
  autoUpdater.autoInstallOnAppQuit = true; // 已下载但用户未点安装时，退出应用自动完成安装
  autoUpdater.logger = console;

  bindEvents();
  registerIpc();
  enabled = true;

  // 启动后延迟静默检查 + 周期检查
  setTimeout(() => { if (enabled) checkNow().catch(() => {}); }, FIRST_CHECK_DELAY_MS);
  setInterval(() => { if (enabled) checkNow().catch(() => {}); }, CHECK_INTERVAL_MS);

  console.log('[updater] 自动更新已启用（autoDownload=' + state.autoDownload + '），当前版本 ' + app.getVersion());
  return { enabled: true, feedUrl: state.feedUrl };
}

async function checkNow() {
  if (!enabled || !autoUpdater) return;
  if (state.downloading || state.downloaded || state.checking) return; // 已有任务进行中
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    // 错误已通过 error 事件推送到渲染层，这里避免未处理 rejection
  }
}

module.exports = {
  initUpdater,
  // 纯逻辑导出（供单元测试）
  parseVersion,
  compareVersions,
  loadUserUpdateConfig,
  normalizeFeed,
  resolveAutoDownload,
  friendlyUpdateError
};
