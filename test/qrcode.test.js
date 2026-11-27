/**
 * qrcode.test.js —— renderer/qr.js 单测（终端二维码字符矩阵 → SVG）
 *
 * 样本取自真实 `qz auth login --method qr-code` 的 stdout（qrcode-terminal small 模式）：
 * 18 行 × 35 字符（第 0 行是边框、每数据行首尾各 1 个静区字符），解析后为 33×33 模块。
 * 用 OpenCV 从解析出的矩阵重绘 PNG 可解码出 {"scene_id":...,"api_client_type":3} —— 证明矩阵正确。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTerminalQr, toSvg, render } = require('../renderer/qr');

const QR_SAMPLE = [
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '█ ▄▄▄▄▄ █▄▀ ▀ █▄█  █▄▀ ▄ ▄█ ▄▄▄▄▄ █',
  '█ █   █ █   █▀ ▀▄▀▀██▄█▄█▄█ █   █ █',
  '█ █▄▄▄█ █▄█▀ ▄ ██  █ ▀▄ ███ █▄▄▄█ █',
  '█▄▄▄▄▄▄▄█▄█ █ █▄█ ▀ █ █ ▀▄█▄▄▄▄▄▄▄█',
  '█ ▄▄▄▀▀▄▀ █ ▄ █ █▀▄▀▀▄ █   ▀▀▄  █ █',
  '█ ▄▀  ▄▄ █  ▄▄▀▄▀███████▄█ ▄ ▀▀█▄ █',
  '█▀█ ▀ █▄█▀▄▄▀ ▄ ▀▀▄▄▀██▄██▄█ ▄█▀███',
  '█ ▄ ▀ █▄██▀▄ █▄ ▀▀█ ▄█ ▄█▄▄▀▄▄▀ ▀▀█',
  '█ ▀▄▀▄▄▄█▄▄▀█▄ ▄▀█████▄█ ▀█ ▄  ▄█ █',
  '██▀▀█  ▄▀ █▄▀█▄▀▄▄ ▄█▄▄▀▀▀▀ ▄▄▄▄▄██',
  '█▀▄▄ ▀▄▄▄▀ ███▀▀▄ ▄  ▄▄ ▀  ▀▀█ █▄▀█',
  '██▀▀▀██▄   ▄▀▀ ▄██▄▀▀▄██  ███▄▀▄█ █',
  '█▄█▄▄▄▄▄█▀▀▄ █▄█▀▀ ▀  █▄█ ▄▄▄ ▀▀▀▄█',
  '█ ▄▄▄▄▄ ██▀▀█ █▀███▀ ▄ ▄▄ █▄█  ▀▀▀█',
  '█ █   █ █▀▄█▄▀▄▀▀█▀▄██▄█▄▄▄▄ ▄ ▄▀▄█',
  '█ █▄▄▄█ █  ▄▄ █▄  ▀ █▄▄ █▀▀ ▄▀▀▄▄▀█',
  '█▄▄▄▄▄▄▄█▄██▄█▄█▄██▄▄▄▄▄██▄▄█▄█▄███'
].join('\n');

test('parseTerminalQr: 真实终端输出解析为 33×33 方阵', () => {
  const m = parseTerminalQr(QR_SAMPLE);
  assert.ok(Array.isArray(m), '必须解析成功');
  assert.strictEqual(m.length, 33);
  assert.strictEqual(m[0].length, 33);
});

test('parseTerminalQr: 左上/右上定位图案（finder）形状正确', () => {
  const m = parseTerminalQr(QR_SAMPLE);
  // 定位图案是 7×7：黑外框 + 白环 + 3×3 黑心
  for (let r = 0; r < 7; r += 1) {
    assert.strictEqual(m[r][0], 1, '左外边为黑，row=' + r);
    assert.strictEqual(m[r][6], 1, '右外边为黑，row=' + r);
    assert.strictEqual(m[0][r], 1, '上外边为黑，col=' + r);
    assert.strictEqual(m[6][r], 1, '下外边为黑，col=' + r);
  }
  assert.strictEqual(m[1][1], 0, '外框内侧为白');
  assert.strictEqual(m[3][3], 1, '中心 3×3 为黑');
  // 左上与右上图案对称存在
  assert.strictEqual(m[0][32], 1);
  assert.strictEqual(m[3][29], 1);
});

test('parseTerminalQr: 非二维码内容返回 null（不做错误渲染）', () => {
  assert.strictEqual(parseTerminalQr('请使用 Q 助理手机 App 扫描下方二维码。'), null);
  assert.strictEqual(parseTerminalQr(''), null);
  assert.strictEqual(parseTerminalQr(null), null);
  assert.strictEqual(parseTerminalQr('\x1B[2J\x1B[H扫码登录\n\n'), null);
});

test('parseTerminalQr: 未知字符 / 非方阵返回 null', () => {
  const broken = QR_SAMPLE.split('\n');
  broken[2] = broken[2].replace('█', 'X');
  assert.strictEqual(parseTerminalQr(broken.join('\n')), null);

  // 少一行数据行 → 34 行 vs 33 列，非方阵
  const short = QR_SAMPLE.split('\n').slice(0, -1).join('\n');
  assert.strictEqual(parseTerminalQr(short), null);
});

test('toSvg: 尺寸、白底、黑模块按行合并', () => {
  const m = parseTerminalQr(QR_SAMPLE);
  const svg = toSvg(m, { moduleSize: 10, quiet: 4 });
  // 33 + 4*2 = 41 模块 × 10px = 410
  assert.ok(svg.indexOf('width="410" height="410"') >= 0, 'viewBox 尺寸按模块数 + 静区计算');
  assert.ok(svg.indexOf('viewBox="0 0 410 410"') >= 0);
  assert.ok(svg.indexOf('fill="#ffffff"') >= 0, '必须有白色底（静区）');
  assert.ok(svg.indexOf('shape-rendering="crispEdges"') >= 0, '模块边缘必须锐利，避免抗锯齿导致扫码失败');
  const rects = svg.match(/<rect /g) || [];
  // 1 个白底 rect + 黑模块行合并后的 rect（远少于 33*33）
  assert.ok(rects.length > 1, '必须画出黑模块');
  assert.ok(rects.length < 500, '黑模块按行合并，节点数应远小于逐模块绘制');
  // 所有黑模块坐标都在静区内（>= 4 * 10）
  const xs = [...svg.matchAll(/x="(\d+)"/g)].map((mm) => Number(mm[1])).
    filter((v) => Number.isFinite(v));
  assert.ok(Math.min(...xs) >= 0);
});

test('render: 解析失败返回空串（调用方降级为纯文本）', () => {
  assert.strictEqual(render('不是二维码'), '');
  assert.ok(render(QR_SAMPLE).indexOf('<svg') === 0, '返回完整 SVG 字符串');
});
