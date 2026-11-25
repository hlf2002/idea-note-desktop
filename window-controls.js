'use strict';

/**
 * window-controls.js —— 无边框窗口的窗口操作 IPC（自绘三按钮 + 边缘拖拽缩放）
 *
 * 从 main.js 抽出来，便于 smoke-test 在自建窗口上复用同一套 IPC 逻辑
 * （否则 smoke 只能验证 IPC 发出去，验证不到 setBounds 真的生效）。
 */

const { ipcMain } = require('electron');
const { computeResizedBounds } = require('./window-resize');

/**
 * 注册窗口控制 IPC。重复调用会先移除旧监听，保证幂等。
 * @param {object} opts
 * @param {() => import('electron').BrowserWindow|null} opts.getWindow 取当前主窗口（可能为 null）
 * @param {() => void} [opts.onResizeEnd] 缩放结束回调（用于持久化窗口尺寸）
 * @param {{width:number,height:number}} opts.minSize 窗口最小尺寸（缩放夹紧用）
 */
function registerWindowControls(opts) {
  const options = opts || {};
  const getWindow = typeof options.getWindow === 'function' ? options.getWindow : () => null;
  const onResizeEnd = typeof options.onResizeEnd === 'function' ? options.onResizeEnd : () => {};
  const minSize = options.minSize || { width: 1, height: 1 };

  // 幂等：先摘掉同名监听，避免重复注册导致一次移动执行多次 setBounds
  const CHANNELS = [
    'window:minimize', 'window:toggle-maximize', 'window:close',
    'window:resize-start', 'window:resize-move', 'window:resize-end'
  ];
  CHANNELS.forEach((ch) => ipcMain.removeAllListeners(ch));

  const alive = (win) => !!win && !win.isDestroyed();

  ipcMain.on('window:minimize', () => {
    const win = getWindow();
    if (alive(win)) win.minimize();
  });
  ipcMain.on('window:toggle-maximize', () => {
    const win = getWindow();
    if (!alive(win)) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  // 关闭走 close 事件 → 沿用「隐藏到托盘、不退出」的既有语义
  ipcMain.on('window:close', () => {
    const win = getWindow();
    if (alive(win)) win.close();
  });

  // ---- 边缘拖拽缩放 ----
  let resizeSession = null;
  ipcMain.on('window:resize-start', (_e, payload) => {
    const win = getWindow();
    if (!alive(win)) { resizeSession = null; return; }
    if (win.isMaximized() || win.isFullScreen()) { resizeSession = null; return; }
    const p = payload || {};
    resizeSession = {
      edge: typeof p.edge === 'string' ? p.edge : '',
      start: win.getBounds(),
      startCursor: { x: Number(p.x), y: Number(p.y) }
    };
  });
  ipcMain.on('window:resize-move', (_e, payload) => {
    const win = getWindow();
    if (!alive(win) || !resizeSession) return;
    if (win.isMaximized() || win.isFullScreen()) return;
    const p = payload || {};
    const bounds = computeResizedBounds({
      edge: resizeSession.edge,
      start: resizeSession.start,
      startCursor: resizeSession.startCursor,
      cursor: { x: Number(p.x), y: Number(p.y) },
      min: minSize
    });
    if (!bounds) return; // 非法输入直接丢弃，不抛错给渲染层
    win.setBounds(bounds);
  });
  ipcMain.on('window:resize-end', () => {
    if (!resizeSession) return;
    resizeSession = null;
    try { onResizeEnd(); } catch (e) { /* 持久化失败不影响窗口操作 */ }
  });
}

module.exports = { registerWindowControls };
