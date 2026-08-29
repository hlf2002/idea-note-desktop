/**
 * content-image.test.js —— 图片 URL 归一化单元测试
 * 覆盖 qz/content.js 的 extractImageUrls 与 qz/sync.js 的 mapServerMemo 图片映射。
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractImageUrls } = require('../qz/content');
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
test('mapServerMemo: 归一化 images 数组，保留 imageUrl', () => {
  const memo = mapServerMemo({
    id: 1,
    plain_text: '带图 #灵感',
    tags: ['灵感'],
    image_url: 'https://cdn.example.com/a.png',
    create_time: 1000,
    update_time: 2000
  });
  assert.strictEqual(memo.imageUrl, 'https://cdn.example.com/a.png');
  assert.deepStrictEqual(memo.images, ['https://cdn.example.com/a.png']);
});

test('mapServerMemo: 多图 image_url 与空 image_url', () => {
  const multi = mapServerMemo({
    id: 2, plain_text: 'x', tags: [], image_url: '["https://a.com/1.png","https://a.com/2.png"]',
    create_time: 1, update_time: 1
  });
  assert.deepStrictEqual(multi.images, ['https://a.com/1.png', 'https://a.com/2.png']);
  const empty = mapServerMemo({ id: 3, plain_text: 'y', tags: [], image_url: '', create_time: 1, update_time: 1 });
  assert.deepStrictEqual(empty.images, []);
  assert.strictEqual(empty.imageUrl, '');
});
