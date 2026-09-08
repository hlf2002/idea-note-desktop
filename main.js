/**
 * main.js —— Electron 主进程
 *   - 创建主窗口（contextIsolation 安全隔离）
 *   - IPC：memo 增删改查、数据路径
 *   - 系统托盘 + 关闭隐藏到托盘
 *   - 全局快捷键 CmdOrCtrl+Shift+M 唤起快速记录
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { initApp } = require('./app-core');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// 数据目录：userData 下集中存放
const DATA_DIR = () => app.getPath('userData');
const AUTH_FILE = () => path.join(DATA_DIR(), 'auth.json');
const CACHE_FILE = () => path.join(DATA_DIR(), 'idea-cache.json');
const LEGACY_FILE = () => path.join(DATA_DIR(), 'flomo-local.json');
const WIN_STATE_FILE = () => path.join(DATA_DIR(), 'window-state.json');

// 窗口宽高持久化：关闭时保存，下次启动恢复（夹在 min 与屏幕 workArea 之间，防外接屏断开后窗口超出可视区）
const MIN_W = 760;
const MIN_H = 520;

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(WIN_STATE_FILE(), 'utf8'));
    const w = Number(s.width);
    const h = Number(s.height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      width: Math.round(Math.min(Math.max(wa.width, MIN_W), Math.max(MIN_W, w))),
      height: Math.round(Math.min(Math.max(wa.height, MIN_H), Math.max(MIN_H, h)))
    };
  } catch (e) { return null; }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const [width, height] = mainWindow.getSize();
    fs.writeFileSync(WIN_STATE_FILE(), JSON.stringify({ width, height }));
  } catch (e) { /* 忽略：保存失败不影响运行 */ }
}

// 应用图标（平台相关）：mac 用 macOS 版，Windows/Linux 用 Windows 版
const APP_ICON = () => process.platform === 'darwin'
  ? path.join(__dirname, 'assets', 'icon-mac.png')
  : path.join(__dirname, 'assets', 'icon-win.png');

// 旧版数据目录：应用改名/打包后 userData 路径可能变化（flomo-local → idea-note-local → 灵感笔记），
// 首次启动把旧登录态/缓存/待导入数据迁移到当前目录，避免登录态丢失。
// auth.json 取所有已知目录中「最新」的一份（当前缺失或较旧则补齐）；
// 其余文件仅复制「当前目录中不存在」的，绝不覆盖已有数据。
const OLD_DATA_DIRS = () => [
  path.join(app.getPath('appData'), 'flomo-local'),
  path.join(app.getPath('appData'), 'idea-note-local'),
  path.join(app.getPath('appData'), '灵感笔记')
];

function migrateLegacyDataDir() {
  const nd = DATA_DIR();
  try {
    if (!fs.existsSync(nd)) fs.mkdirSync(nd, { recursive: true });
  } catch (e) { /* 忽略 */ }

  // auth.json：最新优先恢复（解决打包版/开发版登录态分裂导致的周期性要求重新登录）
  const authDst = path.join(nd, 'auth.json');
  let best = null;
  for (const od of OLD_DATA_DIRS()) {
    if (od === nd) continue;
    const src = path.join(od, 'auth.json');
    if (!fs.existsSync(src)) continue;
    try {
      const st = fs.statSync(src);
      if (!best || st.mtimeMs > best.mtimeMs) best = { src, mtimeMs: st.mtimeMs };
    } catch (e) { /* 忽略 */ }
  }
  if (best) {
    let need = !fs.existsSync(authDst);
    if (!need) {
      try { need = fs.statSync(authDst).mtimeMs < best.mtimeMs; } catch (e) { need = true; }
    }
    if (need) {
      try {
        fs.copyFileSync(best.src, authDst);
        console.log('[idea-note-local] 已恢复登录态: ' + best.src);
      } catch (e) {
        console.warn('[idea-note-local] 登录态恢复跳过: ' + e.message);
      }
    }
  }

  // 缓存/待导入数据：仅复制当前缺失的文件
  for (const od of OLD_DATA_DIRS()) {
    if (od === nd || !fs.existsSync(od)) continue;
    try {
      for (const f of fs.readdirSync(od)) {
        if (!/^(idea-cache|flomo-local)\.json(\.imported-.*)?$/.test(f)) continue;
        const src = path.join(od, f);
        const dst = path.join(nd, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
          console.log('[idea-note-local] 已迁移旧数据: ' + f);
        }
      }
    } catch (e) {
      console.warn('[idea-note-local] 旧数据迁移跳过 (' + od + '): ' + e.message);
    }
  }
}

function createWindow() {
  const state = loadWindowState() || {};
  mainWindow = new BrowserWindow({
    width: state.width || 1040,
    height: state.height || 720,
    minWidth: MIN_W,
    minHeight: MIN_H,
    title: '灵感笔记 · Q助理',
    backgroundColor: '#f4e9d3',
    show: false,
    icon: APP_ICON(),
    // 无边框窗口：隐藏原生标题栏，保留 macOS 红黄绿交通灯按钮
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 点击关闭按钮 -> 隐藏到托盘（保持后台快速记录能力）；隐藏/退出时保存窗口宽高
  mainWindow.on('close', (e) => {
    saveWindowState();
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // 调整大小时防抖保存窗口宽高（300ms）
  let resizeTimer = null;
  mainWindow.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(saveWindowState, 300);
  });

  // 外链统一交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('灵感笔记 · Q助理');
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏主窗口', click: toggleWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
    focusInput();
  }
}

function focusInput() {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('app:focus-input');
  }
}

function registerGlobalShortcut() {
  const ok = globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      mainWindow.focus();
    }
    focusInput();
  });
  if (!ok) console.warn('[idea-note-local] 全局快捷键注册失败（可能被其它应用占用）');
}

// ---- 应用生命周期 ----
app.whenReady().then(async () => {
  migrateLegacyDataDir();
  // macOS Dock 图标（开发/运行期即替换为产品图标）
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(APP_ICON());
  }
  initApp({
    authFile: AUTH_FILE(),
    cacheFile: CACHE_FILE(),
    legacyFile: LEGACY_FILE(),
    dataDir: DATA_DIR()
  });
  createWindow();
  createTray();
  registerGlobalShortcut();

  app.on('activate', () => {
    // macOS dock 图标点击恢复
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// 任何退出路径（Cmd+Q、Dock 右键退出、托盘退出、系统关机）都先触发 before-quit，
// 置 isQuitting 后，close 事件放行窗口关闭，避免退出被"隐藏到托盘"逻辑拦截导致无法结束进程
app.on('before-quit', () => {
  isQuitting = true;
});

// macOS 下点击窗口关闭即隐藏，避免应用"无窗口但 dock 存在"的困惑
app.on('window-all-closed', () => {
  // 保留在托盘，不退出（macOS 规范之外的桌面端也保持一致）
});
