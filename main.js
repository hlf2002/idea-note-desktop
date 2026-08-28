/**
 * main.js —— Electron 主进程
 *   - 创建主窗口（contextIsolation 安全隔离）
 *   - IPC：memo 增删改查、数据路径
 *   - 系统托盘 + 关闭隐藏到托盘
 *   - 全局快捷键 CmdOrCtrl+Shift+M 唤起快速记录
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage } = require('electron');
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

// 应用图标（平台相关）：mac 用 macOS 版，Windows/Linux 用 Windows 版
const APP_ICON = () => process.platform === 'darwin'
  ? path.join(__dirname, 'assets', 'icon-mac.png')
  : path.join(__dirname, 'assets', 'icon-win.png');

// 旧版数据目录（应用曾名为 flomo-local）：应用更名后 userData 路径变化，
// 首次启动时把旧登录态/缓存/待导入数据迁移到新目录，避免登录态丢失。
// 仅复制「新目录中不存在」的文件，绝不覆盖已有数据。
const OLD_DATA_DIR = () => path.join(app.getPath('appData'), 'flomo-local');

function migrateLegacyDataDir() {
  const nd = DATA_DIR();
  const od = OLD_DATA_DIR();
  if (!fs.existsSync(od)) return;
  try {
    if (!fs.existsSync(nd)) fs.mkdirSync(nd, { recursive: true });
    for (const f of fs.readdirSync(od)) {
      if (!/^(auth|idea-cache|flomo-local)\.json(\.imported-.*)?$/.test(f)) continue;
      const src = path.join(od, f);
      const dst = path.join(nd, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        console.log('[idea-note-local] 已迁移旧数据: ' + f);
      }
    }
  } catch (e) {
    console.warn('[idea-note-local] 旧数据迁移跳过: ' + e.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    title: '灵感笔记 · Q助理',
    backgroundColor: '#faf9f8',
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

  // 点击关闭按钮 -> 隐藏到托盘（保持后台快速记录能力）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
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

// macOS 下点击窗口关闭即隐藏，避免应用"无窗口但 dock 存在"的困惑
app.on('window-all-closed', () => {
  // 保留在托盘，不退出（macOS 规范之外的桌面端也保持一致）
});
