'use strict';

/**
 * window-resize.js —— 无边框窗口边缘拖拽缩放的纯计算
 *
 * 背景：Electron 33 的 Windows 无边框窗口只在内侧留 5px 的缩放命中区
 * （FramelessView::kResizeInsideBoundsSize），实际抓不住。渲染层叠了 8px 热区，
 * 按下后把「屏幕坐标」交给主进程，由这里换算成新的窗口 bounds 再 setBounds。
 *
 * 约定：所有坐标/尺寸都是 DIP（Electron 的 screen / setBounds 都用 DIP）。
 * 纯函数、无 Electron 依赖，便于单测。
 */

const RESIZE_EDGES = Object.freeze([
  'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right'
]);

const EDGE_SET = new Set(RESIZE_EDGES);

function isPoint(p) {
  return !!p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
}

/**
 * 计算缩放后的窗口 bounds。
 * @param {object} params
 * @param {string} params.edge 取值见 RESIZE_EDGES
 * @param {{x:number,y:number,width:number,height:number}} params.start 按下时的窗口 bounds
 * @param {{x:number,y:number}} params.startCursor 按下时的屏幕光标坐标
 * @param {{x:number,y:number}} params.cursor 当前屏幕光标坐标
 * @param {{width:number,height:number}} params.min 窗口最小尺寸
 * @returns {{x:number,y:number,width:number,height:number}|null} 输入非法时返回 null
 */
function computeResizedBounds(params) {
  const { edge, start, startCursor, cursor, min } = params || {};
  if (!EDGE_SET.has(edge)) return null;
  if (!isPoint(startCursor) || !isPoint(cursor)) return null;

  const sx = Number(start && start.x);
  const sy = Number(start && start.y);
  const sw = Number(start && start.width);
  const sh = Number(start && start.height);
  if (![sx, sy, sw, sh].every(Number.isFinite)) return null;
  if (sw <= 0 || sh <= 0) return null;

  const minW = Math.max(1, Math.round(Number(min && min.width) || 1));
  const minH = Math.max(1, Math.round(Number(min && min.height) || 1));

  const dx = Number(cursor.x) - Number(startCursor.x);
  const dy = Number(cursor.y) - Number(startCursor.y);

  let x = sx;
  let y = sy;
  let width = sw;
  let height = sh;

  if (edge.indexOf('left') >= 0) {
    x = sx + dx;
    width = sw - dx;
  } else if (edge.indexOf('right') >= 0) {
    width = sw + dx;
  }
  if (edge.indexOf('top') >= 0) {
    y = sy + dy;
    height = sh - dy;
  } else if (edge.indexOf('bottom') >= 0) {
    height = sh + dy;
  }

  // 最小尺寸夹紧：被拖的那条边不动，只把对边收住（否则窗口会「跳」一下）
  if (width < minW) {
    if (edge.indexOf('left') >= 0) x = sx + sw - minW;
    width = minW;
  }
  if (height < minH) {
    if (edge.indexOf('top') >= 0) y = sy + sh - minH;
    height = minH;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  };
}

module.exports = { computeResizedBounds, RESIZE_EDGES };
