/**
 * content-image.test.js —— 图片 URL 归一化单元测试
 * 覆盖 qz/content.js 的 extractImageUrls 与 qz/sync.js 的 mapServerMemo 图片映射。
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractImageUrls, isQiniuUrl, thumbnailUrl, largeImageUrl } = require('../qz/content');
const { mapServerMemo } = require('../qz/sync');

// ============ extractImageUrls ============
test('extractImageUrls: 空值/空串返回空数组', () => {
  assert.deepStrictEqual(extractImageUrls(null), []);
  assert.deepStrictEqual(extractImageUrls(undefined), []);
  assert.deepStrictEqual(extractImageUrls(''), []);
  assert.deepStrictEqual(extractImageUrls('   '), []);
});

test('extractImageUrls: 单条 https URL', () => {
  assert.deepStrictEqual(
    extractImageUrls('https://cdn.example.com/a.png'),
    ['https://cdn.example.com/a.png']
  );
});

test('extractImageUrls: 单条 http URL', () => {
  assert.deepStrictEqual(
    extractImageUrls('http://cdn.example.com/a.jpg'),
    ['http://cdn.example.com/a.jpg']
  );
});

test('extractImageUrls: data URI 图片', () => {
  assert.deepStrictEqual(
    extractImageUrls('data:image/png;base64,abc'),
    ['data:image/png;base64,abc']
  );
});

test('extractImageUrls: JSON 数组串展开多图', () => {
  assert.deepStrictEqual(
    extractImageUrls('["https://a.com/1.png","https://a.com/2.png"]'),
    ['https://a.com/1.png', 'https://a.com/2.png']
  );
});

test('extractImageUrls: 逗号/换行分隔多图', () => {
  assert.deepStrictEqual(
    extractImageUrls('https://a.com/1.png,https://a.com/2.png'),
    ['https://a.com/1.png', 'https://a.com/2.png']
  );
  assert.deepStrictEqual(
    extractImageUrls('https://a.com/1.png\nhttps://a.com/2.png'),
    ['https://a.com/1.png', 'https://a.com/2.png']
  );
});

test('extractImageUrls: 真实数组输入', () => {
  assert.deepStrictEqual(
    extractImageUrls(['https://a.com/1.png', 'https://a.com/2.png']),
    ['https://a.com/1.png', 'https://a.com/2.png']
  );
});

test('extractImageUrls: 剔除非法协议（javascript:）', () => {
  assert.deepStrictEqual(extractImageUrls('javascript:alert(1)'), []);
  assert.deepStrictEqual(
    extractImageUrls('https://a.com/ok.png,javascript:alert(1)'),
    ['https://a.com/ok.png']
  );
});

test('extractImageUrls: 剔除空段与非字符串元素，去重保序', () => {
  assert.deepStrictEqual(extractImageUrls('https://a.com/1.png,, https://a.com/2.png,https://a.com/1.png'), [
    'https://a.com/1.png', 'https://a.com/2.png'
  ]);
  assert.deepStrictEqual(extractImageUrls(['https://a.com/1.png', null, 42]), ['https://a.com/1.png']);
});

test('extractImageUrls: 损坏 JSON 数组串按单段处理并校验协议', () => {
  assert.deepStrictEqual(extractImageUrls('[oops'), []);
});

// ============ mapServerMemo ============
test('mapServerMemo: 归一化 images 对象数组，保留 imageUrl（非七牛域名 thumbnail/large 回退原图）', () => {
  const memo = mapServerMemo({
    id: 1,
    plain_text: '带图 #灵感',
    tags: ['灵感'],
    image_url: 'https://cdn.example.com/a.png',
    create_time: 1000,
    update_time: 2000
  });
  assert.strictEqual(memo.imageUrl, 'https://cdn.example.com/a.png');
  assert.deepStrictEqual(memo.images, [{
    original: 'https://cdn.example.com/a.png',
    thumbnail: 'https://cdn.example.com/a.png',
    large: 'https://cdn.example.com/a.png'
  }]);
});

test('mapServerMemo: 七牛域名生成缩略图与大图参数', () => {
  const memo = mapServerMemo({
    id: 9, plain_text: 'x', tags: [],
    image_url: 'https://res.qzhuli.com/idea_note/2026_08_29/abc.jpg',
    create_time: 1, update_time: 1
  });
  assert.strictEqual(memo.images.length, 1);
  assert.strictEqual(memo.images[0].original, 'https://res.qzhuli.com/idea_note/2026_08_29/abc.jpg');
  assert.ok(memo.images[0].thumbnail.includes('imageView2/2/w/180/h/180'));
  assert.ok(memo.images[0].large.includes('imageView2/2/w/1200'));
});

test('mapServerMemo: 多图 image_url 与空 image_url', () => {
  const multi = mapServerMemo({
    id: 2, plain_text: 'x', tags: [], image_url: '["https://a.com/1.png","https://a.com/2.png"]',
    create_time: 1, update_time: 1
  });
  assert.strictEqual(multi.images.length, 2);
  assert.strictEqual(multi.images[0].original, 'https://a.com/1.png');
  assert.strictEqual(multi.images[1].original, 'https://a.com/2.png');
  const empty = mapServerMemo({ id: 3, plain_text: 'y', tags: [], image_url: '', create_time: 1, update_time: 1 });
  assert.deepStrictEqual(empty.images, []);
  assert.strictEqual(empty.imageUrl, '');
});

// ============ 七牛 URL 构建 ============
test('isQiniuUrl: 七牛域名返回 true，其他返回 false', () => {
  assert.strictEqual(isQiniuUrl('https://res.qzhuli.com/a.jpg'), true);
  assert.strictEqual(isQiniuUrl('https://cdn.example.com/a.jpg'), false);
  assert.strictEqual(isQiniuUrl('data:image/png;base64,abc'), false);
  assert.strictEqual(isQiniuUrl(''), false);
  assert.strictEqual(isQiniuUrl(null), false);
});

test('thumbnailUrl: 七牛域名加 imageView2 等比缩略参数', () => {
  const u = thumbnailUrl('https://res.qzhuli.com/a.jpg');
  assert.ok(u.startsWith('https://res.qzhuli.com/a.jpg?'));
  assert.ok(u.includes('imageView2/2/w/180/h/180/format/jpeg'));
});

test('thumbnailUrl: 自定义 maxEdge', () => {
  const u = thumbnailUrl('https://res.qzhuli.com/a.jpg', 96);
  assert.ok(u.includes('w/96/h/96'));
});

test('thumbnailUrl: 非七牛域名返回原 URL', () => {
  assert.strictEqual(thumbnailUrl('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
});

test('largeImageUrl: 七牛域名加大图参数，非七牛回退原图', () => {
  const u = largeImageUrl('https://res.qzhuli.com/a.jpg');
  assert.ok(u.includes('imageView2/2/w/1200/format/jpeg'));
  assert.strictEqual(largeImageUrl('https://cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
});

test('URL 构建: 已有 query string 时用 & 连接', () => {
  const u = thumbnailUrl('https://res.qzhuli.com/a.jpg?token=xyz');
  assert.ok(u.includes('?token=xyz&imageView2'));
});
