/**
 * window-resize.test.js —— 无边框窗口边缘缩放换算的单元测试
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeResizedBounds, RESIZE_EDGES } = require('../window-resize');

const BASE = {
  start: { x: 100, y: 80, width: 1000, height: 700 },
  startCursor: { x: 500, y: 400 },
  min: { width: 760, height: 520 }
};

function calc(edge, cursor) {
  return computeResizedBounds(Object.assign({}, BASE, { edge, cursor }));
}

test('右下角拖动：宽高都增加，位置不变', () => {
  const b = calc('bottom-right', { x: 540, y: 430 });
  assert.deepStrictEqual(b, { x: 100, y: 80, width: 1040, height: 730 });
});

test('左边缘向左拖：x 前移、宽度增加', () => {
  const b = calc('left', { x: 460, y: 400 });
  assert.deepStrictEqual(b, { x: 60, y: 80, width: 1040, height: 700 });
});

test('左边缘向右拖：x 后移、宽度减小', () => {
  const b = calc('left', { x: 600, y: 400 });
  assert.deepStrictEqual(b, { x: 200, y: 80, width: 900, height: 700 });
});

test('上边缘向上拖：y 前移、高度增加', () => {
  const b = calc('top', { x: 500, y: 340 });
  assert.deepStrictEqual(b, { x: 100, y: 20, width: 1000, height: 760 });
});

test('下边缘向下拖：只增加高度', () => {
  const b = calc('bottom', { x: 500, y: 460 });
  assert.deepStrictEqual(b, { x: 100, y: 80, width: 1000, height: 760 });
});

test('右边缘向左收：宽度减小、x 不变', () => {
  const b = calc('right', { x: 430, y: 400 });
  assert.deepStrictEqual(b, { x: 100, y: 80, width: 930, height: 700 });
});

test('左上角拖动：x/y 前移、宽高同时变化', () => {
  const b = calc('top-left', { x: 440, y: 340 });
  assert.deepStrictEqual(b, { x: 40, y: 20, width: 1060, height: 760 });
});

test('最小宽度夹紧：拖左边的边不动，只把右边界收住', () => {
  const b = calc('left', { x: 900, y: 400 }); // 宽度算出来 1000-400=600 < 760
  assert.strictEqual(b.width, 760);
  assert.strictEqual(b.x, 100 + 1000 - 760); // 340：左边界停在最小宽度位置
  assert.strictEqual(b.height, 700);
});

test('最小高度夹紧：拖上边的边不动', () => {
  const b = calc('top', { x: 500, y: 700 }); // 高度 700-300=400 < 520
  assert.strictEqual(b.height, 520);
  assert.strictEqual(b.y, 80 + 700 - 520); // 260
  assert.strictEqual(b.width, 1000);
});

test('最小尺寸对右下角不改变位置', () => {
  const b = calc('bottom-right', { x: -200, y: -200 }); // 收缩到最小：宽 1000-700=300、高 700-600=100
  assert.strictEqual(b.width, 760);
  assert.strictEqual(b.height, 520);
  assert.strictEqual(b.x, 100);
  assert.strictEqual(b.y, 80);
});

test('未移动（光标原地）返回原始 bounds', () => {
  const b = calc('right', { x: 500, y: 400 });
  assert.deepStrictEqual(b, BASE.start);
});

test('非法 edge / 坐标返回 null', () => {
  assert.strictEqual(computeResizedBounds({ edge: 'nope', start: BASE.start, startCursor: BASE.startCursor, cursor: { x: 1, y: 1 } }), null);
  assert.strictEqual(computeResizedBounds({ edge: 'left', start: BASE.start, startCursor: { x: NaN, y: 0 }, cursor: { x: 1, y: 1 } }), null);
  assert.strictEqual(computeResizedBounds({ edge: 'left', start: { x: 0, y: 0, width: 0, height: 0 }, startCursor: BASE.startCursor, cursor: { x: 1, y: 1 } }), null);
  assert.strictEqual(computeResizedBounds(null), null);
  assert.strictEqual(computeResizedBounds(), null);
});

test('缺省 min 时按 1 像素兜底，不抛错', () => {
  const b = computeResizedBounds({ edge: 'right', start: BASE.start, startCursor: BASE.startCursor, cursor: { x: 100, y: 400 } });
  assert.strictEqual(b.width, 600); // dx=-400 → 1000-400=600，未触发夹紧
  assert.strictEqual(b.height, 700);

  const tiny = computeResizedBounds({ edge: 'right', start: BASE.start, startCursor: BASE.startCursor, cursor: { x: -700, y: 400 } });
  assert.strictEqual(tiny.width, 1); // dx=-1200 → 负宽度，兜底 1px
});

test('支持的边共 8 种', () => {
  assert.deepStrictEqual(RESIZE_EDGES.slice().sort(), [
    'bottom', 'bottom-left', 'bottom-right', 'left', 'right', 'top', 'top-left', 'top-right'
  ]);
});
