/**
 * notes-page.test.js —— qz/notes-page.js 单元测试（发布分享页）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { publishNotePage, PUBLISH_PATH, TEXT_MAX_LEN } = require('../qz/notes-page');

// 注入式 fetch：记录请求，返回预设响应
function makeFetchImpl({ status = 200, body = { code: 0, data: { url: 'https://ideanote.7373.com.cn/notes/abc123' } } } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  };
  return { impl, calls };
}

test('publishNotePage: 发布成功返回 URL，请求体与头正确', async () => {
  const { impl, calls } = makeFetchImpl();
  const url = await publishNotePage({
    text: '今天 @施展 讨论 #方案',
    author: '疯狐狸',
    avatar: 'https://cdn.qzhuli.com/avatar/a1.png',
    tags: ['方案'],
    createdAt: 1700000000000,
    relayUrl: 'https://ideanote.7373.com.cn',
    clientPin: 'pin_x',
    fetchImpl: impl
  });
  assert.strictEqual(url, 'https://ideanote.7373.com.cn/notes/abc123');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://ideanote.7373.com.cn' + PUBLISH_PATH);
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers['X-Ideanote-Pin'], 'pin_x');
  assert.strictEqual(calls[0].body.text, '今天 @施展 讨论 #方案');
  assert.strictEqual(calls[0].body.author, '疯狐狸');
  assert.strictEqual(calls[0].body.avatar, 'https://cdn.qzhuli.com/avatar/a1.png');
  assert.deepStrictEqual(calls[0].body.tags, ['方案']);
});

test('publishNotePage: 无头像时 avatar 传空串', async () => {
  const { impl, calls } = makeFetchImpl();
  await publishNotePage({ text: 'x', fetchImpl: impl });
  assert.strictEqual(calls[0].body.avatar, '');
});

test('publishNotePage: 无正文返回 null 且不发请求', async () => {
  const { impl, calls } = makeFetchImpl();
  assert.strictEqual(await publishNotePage({ text: '   ', fetchImpl: impl }), null);
  assert.strictEqual(await publishNotePage({ text: null, fetchImpl: impl }), null);
  assert.strictEqual(calls.length, 0);
});

test('publishNotePage: 超长正文截断到上限', async () => {
  const { impl, calls } = makeFetchImpl();
  const long = 'x'.repeat(TEXT_MAX_LEN + 100);
  await publishNotePage({ text: long, fetchImpl: impl });
  assert.strictEqual(calls[0].body.text.length, TEXT_MAX_LEN);
});

test('publishNotePage: HTTP 非 2xx 返回 null', async () => {
  const { impl } = makeFetchImpl({ status: 403 });
  assert.strictEqual(await publishNotePage({ text: 'x', fetchImpl: impl }), null);
});

test('publishNotePage: 响应 code 非 0 返回 null', async () => {
  const { impl } = makeFetchImpl({ body: { code: 1, message: 'forbidden' } });
  assert.strictEqual(await publishNotePage({ text: 'x', fetchImpl: impl }), null);
});

test('publishNotePage: fetch 抛异常返回 null（不阻塞通知）', async () => {
  const impl = async () => { throw new Error('network down'); };
  assert.strictEqual(await publishNotePage({ text: 'x', fetchImpl: impl }), null);
});

test('publishNotePage: 响应缺少 data.url 返回 null', async () => {
  const { impl } = makeFetchImpl({ body: { code: 0, data: { id: 'x' } } });
  assert.strictEqual(await publishNotePage({ text: 'x', fetchImpl: impl }), null);
});

test('publishNotePage: 标签过滤空值并截断到 20 个', async () => {
  const { impl, calls } = makeFetchImpl();
  const tags = ['a', '', 'b', null, 'c'].concat(Array.from({ length: 30 }, (_, i) => 't' + i));
  await publishNotePage({ text: 'x', tags, fetchImpl: impl });
  assert.strictEqual(calls[0].body.tags.length, 20);
  assert.ok(!calls[0].body.tags.includes(''));
  assert.ok(!calls[0].body.tags.includes(null));
});
