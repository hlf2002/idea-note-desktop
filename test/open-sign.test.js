/**
 * open-sign.test.js —— 开放平台签名模块单元测试
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createOpenSign, canonicalString, rfc3986 } = require('../qz/open-sign');

test('rfc3986: 编码 !\'()* 与空格', () => {
  assert.strictEqual(rfc3986("a b!c'd(e)f*g"), 'a%20b%21c%27d%28e%29f%2Ag');
});

test('canonicalString: 字段名 ASCII 升序 + 过滤空值', () => {
  const s = canonicalString({ b: '2', a: '1', c: null, d: undefined, e: '' });
  assert.strictEqual(s, 'a=1&b=2&e=');
});

test('canonicalString: 布尔/整数/字符串数组', () => {
  const s = canonicalString({ flag: true, off: false, n: 10, arr: ['x', 'y'] });
  assert.strictEqual(s, 'arr=%5B%22x%22%2C%22y%22%5D&flag=true&n=10&off=false');
});

test('createOpenSign: 与独立实现（Python hmac）固定向量一致', () => {
  // 向量由 python3 hmac.new(b"secret_test_value", text, sha256) 独立计算
  const r = createOpenSign({
    method: 'POST',
    path: '/oauth/access_token',
    business: { grant_type: 'client_credentials' },
    appKey: 'ak_test_123',
    appSecret: 'secret_test_value',
    timestamp: 1730000000000,
    nonce: 'abcdefghij0123456789'
  });
  assert.strictEqual(
    r.canonical,
    'app_key=ak_test_123&grant_type=client_credentials&nonce=abcdefghij0123456789&timestamp=1730000000000'
  );
  assert.strictEqual(r.sign, '09bb0001202f549302cd9e4e434da18125e51a6352b0949fb517d1eab71814c5');
});

test('createOpenSign: access_token 参与签名，业务字段中的保留名被忽略', () => {
  const a = createOpenSign({
    method: 'GET', path: '/open/idea_note/list', business: { page: 1 },
    appKey: 'k', appSecret: 's', timestamp: 1, nonce: 'abcdefghij0123456789', accessToken: 'ou_x'
  });
  const b = createOpenSign({
    method: 'GET', path: '/open/idea_note/list', business: { page: 1 },
    appKey: 'k', appSecret: 's', timestamp: 1, nonce: 'abcdefghij0123456789'
  });
  assert.notStrictEqual(a.sign, b.sign);
  assert.ok(a.canonical.includes('access_token=ou_x'));

  const c = createOpenSign({
    method: 'GET', path: '/p', business: { app_key: 'evil', sign: 'evil', page: 1 },
    appKey: 'k', appSecret: 's', timestamp: 1, nonce: 'abcdefghij0123456789'
  });
  assert.strictEqual((c.canonical.match(/app_key=/g) || []).length, 1);
  assert.ok(!c.canonical.includes('sign='));
});

test('createOpenSign: method 大小写不敏感，路径参与待签文本', () => {
  const a = createOpenSign({ method: 'get', path: '/x', appKey: 'k', appSecret: 's', timestamp: 1, nonce: 'abcdefghij0123456789' });
  const b = createOpenSign({ method: 'GET', path: '/y', appKey: 'k', appSecret: 's', timestamp: 1, nonce: 'abcdefghij0123456789' });
  assert.notStrictEqual(a.sign, b.sign);
});

test('createOpenSign: 参数缺失与非法 nonce 抛错', () => {
  assert.throws(() => createOpenSign({ path: '/x', appKey: 'k', appSecret: 's' }), /method/);
  assert.throws(() => createOpenSign({ method: 'GET', appKey: 'k', appSecret: 's' }), /path/);
  assert.throws(() => createOpenSign({ method: 'GET', path: '/x', appSecret: 's' }), /appKey/);
  assert.throws(() => createOpenSign({ method: 'GET', path: '/x', appKey: 'k' }), /appSecret/);
  assert.throws(() => createOpenSign({ method: 'GET', path: '/x', appKey: 'k', appSecret: 's', nonce: 'short' }), /nonce/);
});

test('createOpenSign: 默认自动生成 16-64 位 nonce 与毫秒时间戳', () => {
  const r = createOpenSign({ method: 'POST', path: '/x', appKey: 'k', appSecret: 's' });
  assert.match(r.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  assert.ok(Math.abs(Date.now() - r.timestamp) < 5000);
});
