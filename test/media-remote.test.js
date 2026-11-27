/**
 * media-remote.test.js —— qz/media-remote.js 纯函数与远端地址索引单测
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { imageIdFromUrl, pairImageUrls, RemoteMediaStore } = require('../qz/media-remote');

// ============ imageIdFromUrl ============
test('imageIdFromUrl: 开放平台路径里的 image_id', () => {
  assert.strictEqual(
    imageIdFromUrl('https://res.qzhuli.com/open_platform/user_media/img_2e082c0099caef04978aa73dd9e5e031.png'),
    'img_2e082c0099caef04978aa73dd9e5e031'
  );
});

test('imageIdFromUrl: 允许下划线的 image_id（img_mock_1）', () => {
  assert.strictEqual(
    imageIdFromUrl('https://res.qzhuli.com/open_platform/user_media/img_mock_1.png'),
    'img_mock_1'
  );
  assert.strictEqual(
    imageIdFromUrl('https://icon.res.qzhuli.com/common_image/2026_09_18/z0gi3zfoj35x7n1d2fne.jpg'),
    ''
  );
});

test('imageIdFromUrl: 老数据 CDN 路径没有 image_id', () => {
  assert.strictEqual(imageIdFromUrl('https://icon.res.qzhuli.com/common_image/2026_09_18/z0gi3zfoj35x7n1d2fne.jpg'), '');
});

test('imageIdFromUrl: 非字符串 / 空值', () => {
  assert.strictEqual(imageIdFromUrl(null), '');
  assert.strictEqual(imageIdFromUrl(undefined), '');
  assert.strictEqual(imageIdFromUrl(''), '');
});

// ============ pairImageUrls ============
test('pairImageUrls: URL 里带 image_id 时按 id 精确对应（顺序无关）', () => {
  const ids = ['img_aaa', 'img_bbb'];
  const urls = [
    'https://res.qzhuli.com/open_platform/user_media/img_bbb.png',
    'https://res.qzhuli.com/open_platform/user_media/img_aaa.png'
  ];
  const r = pairImageUrls(ids, urls);
  assert.strictEqual(r.byId['img_aaa'], urls[1]);
  assert.strictEqual(r.byId['img_bbb'], urls[0]);
  assert.deepStrictEqual(r.leftovers, []);
});

test('pairImageUrls: 老数据 URL 不含 image_id，数量相等时按顺序配对', () => {
  const ids = ['img_a', 'img_b'];
  const urls = ['https://icon.res.qzhuli.com/common_image/x/1.jpg', 'https://icon.res.qzhuli.com/common_image/x/2.jpg'];
  const r = pairImageUrls(ids, urls);
  assert.strictEqual(r.byId['img_a'], urls[0]);
  assert.strictEqual(r.byId['img_b'], urls[1]);
  assert.deepStrictEqual(r.leftovers, []);
});

test('pairImageUrls: 数量不等不配对（宁可缺图也不许错位）', () => {
  const ids = ['img_a', 'img_b', 'img_c'];
  const urls = ['https://icon.res.qzhuli.com/common_image/x/1.jpg'];
  const r = pairImageUrls(ids, urls);
  assert.deepStrictEqual(Object.keys(r.byId), []);
  assert.deepStrictEqual(r.leftovers, urls);
});

test('pairImageUrls: 精确配对后剩余数量相等，剩余的仍按顺序补齐', () => {
  const ids = ['img_aaa', 'img_b1'];
  const urls = [
    'https://res.qzhuli.com/open_platform/user_media/img_aaa.png',
    'https://icon.res.qzhuli.com/common_image/x/1.jpg'
  ];
  const r = pairImageUrls(ids, urls);
  assert.strictEqual(r.byId['img_aaa'], urls[0]);
  assert.strictEqual(r.byId['img_b1'], urls[1]);
});

test('pairImageUrls: 过滤非法输入（非 http URL / 非字符串 id）', () => {
  // 1 个有效 URL 配 2 个有效 image_id → 数量不等，不配对（不错位）
  const r = pairImageUrls(['img_a', '', null, 'img_b'], ['ftp://x/1.jpg', 'https://x/2.jpg']);
  assert.deepStrictEqual(Object.keys(r.byId), []);
  assert.deepStrictEqual(pairImageUrls(null, null).byId, {});
});

test('pairImageUrls: 同一 image_id 只取第一个 URL', () => {
  const urls = [
    'https://res.qzhuli.com/open_platform/user_media/img_aaa.png',
    'https://res.qzhuli.com/open_platform/user_media/img_aaa.png?v=2'
  ];
  const r = pairImageUrls(['img_aaa'], urls);
  assert.strictEqual(r.byId['img_aaa'], urls[0]);
});

// ============ RemoteMediaStore ============
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideanote-media-remote-'));
  return path.join(dir, 'media-remote.json');
}

test('RemoteMediaStore: merge 只接受 http(s) 并原子落盘', () => {
  const file = tmpFile();
  const store = new RemoteMediaStore({ file });
  const map = store.merge({ img_a: 'https://res.qzhuli.com/a.png', img_b: 'file:///etc/passwd' });
  assert.strictEqual(map.img_a, 'https://res.qzhuli.com/a.png');
  assert.strictEqual(map.img_b, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).img_a, 'https://res.qzhuli.com/a.png');
});

test('RemoteMediaStore: 重复 merge 幂等且不覆盖已有值以外的内容', () => {
  const file = tmpFile();
  const store = new RemoteMediaStore({ file });
  store.merge({ img_a: 'https://res.qzhuli.com/a.png' });
  const mtime1 = fs.statSync(file).mtimeMs;
  store.merge({ img_a: 'https://res.qzhuli.com/a.png' });
  assert.strictEqual(fs.statSync(file).mtimeMs, mtime1, '值未变时不应重写文件');
  assert.deepStrictEqual(Object.keys(store.map()), ['img_a']);
});

test('RemoteMediaStore: 文件缺失 / 损坏返回空映射（不抛错）', () => {
  const file = tmpFile();
  const store = new RemoteMediaStore({ file });
  assert.deepStrictEqual(store.map(), {});
  fs.writeFileSync(file, 'not json');
  assert.deepStrictEqual(store.map(), {});
});
