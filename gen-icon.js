/**
 * gen-icon.js —— 生成托盘/应用图标（红色圆点，ideaNote 风格）
 * 运行：node gen-icon.js  ->  输出 assets/tray.png
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- 最小 PNG 编码器（RGBA 无调色板）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // 每行前加 filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- 绘制 24x24 红色圆点（中心渐晕）----
const SIZE = 24;
const rgba = Buffer.alloc(SIZE * SIZE * 4);
const cx = (SIZE - 1) / 2;
const R = SIZE / 2 - 1;
const FILL = [0xe8, 0x5a, 0x4e]; // ideaNote 珊瑚红
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.sqrt((x - cx) ** 2 + (y - cx) ** 2);
    const idx = (y * SIZE + x) * 4;
    if (d <= R) {
      // 边缘 1px 柔化抗锯齿
      const a = Math.max(0, Math.min(1, R - d + 0.5));
      rgba[idx] = FILL[0];
      rgba[idx + 1] = FILL[1];
      rgba[idx + 2] = FILL[2];
      rgba[idx + 3] = Math.round(a * 255);
    } else {
      rgba[idx + 3] = 0;
    }
  }
}

const outDir = path.join(__dirname, 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tray.png'), encodePng(SIZE, SIZE, rgba));
console.log('icon generated ->', path.join(outDir, 'tray.png'));
