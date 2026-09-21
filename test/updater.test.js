/**
 * updater.test.js —— 自动升级模块纯逻辑单元测试（node:test，零依赖）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  parseVersion,
  compareVersions,
  loadUserUpdateConfig,
  normalizeFeed,
  resolveAutoDownload
} = require('../updater');

// ============ parseVersion ============
test('parseVersion: 标准版本号', () => {
  assert.deepStrictEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, raw: '1.2.3' });
});

test('parseVersion: 预发布/构建号', () => {
  assert.deepStrictEqual(parseVersion('2.0.0-beta.1'), { major: 2, minor: 0, patch: 0, raw: '2.0.0-beta.1' });
  assert.deepStrictEqual(parseVersion('1.1.0+build5'), { major: 1, minor: 1, patch: 0, raw: '1.1.0+build5' });
});

test('parseVersion: 非法输入返回 null', () => {
  assert.strictEqual(parseVersion('v1.0'), null);
  assert.strictEqual(parseVersion('1.0'), null);
  assert.strictEqual(parseVersion('abc'), null);
  assert.strictEqual(parseVersion(''), null);
  assert.strictEqual(parseVersion(null), null);
  assert.strictEqual(parseVersion(undefined), null);
  assert.strictEqual(parseVersion(1.2), null);
});

// ============ compareVersions ============
test('compareVersions: 大小比较', () => {
  assert.strictEqual(compareVersions('1.0.2', '1.1.0'), -1);
  assert.strictEqual(compareVersions('1.1.0', '1.0.2'), 1);
  assert.strictEqual(compareVersions('1.1.0', '1.1.0'), 0);
  assert.strictEqual(compareVersions('1.0.9', '1.0.10'), -1); // patch 数字比较而非字符串
});

test('compareVersions: 预发布版本（semver）', () => {
  assert.strictEqual(compareVersions('1.1.0-beta.1', '1.1.0'), -1); // 预发布 < 正式版
  assert.strictEqual(compareVersions('1.1.0', '1.1.0-beta.1'), 1);
  assert.strictEqual(compareVersions('1.1.0-beta.1', '1.1.0-beta.2'), -1); // 数字段数值比较
  assert.strictEqual(compareVersions('1.1.0-beta.2', '1.1.0-beta.10'), -1);
  assert.strictEqual(compareVersions('1.1.0-beta', '1.1.0-alpha'), 1); // 字母段字典序
  assert.strictEqual(compareVersions('1.1.0-alpha', '1.1.0-beta.1'), -1);
  assert.strictEqual(compareVersions('1.1.0-rc.1', '1.1.0-beta.9'), 1);
});

test('compareVersions: 任一非法返回 NaN', () => {
  assert.ok(Number.isNaN(compareVersions('1.0', '1.0.1')));
  assert.ok(Number.isNaN(compareVersions('1.0.1', 'x')));
});

// ============ loadUserUpdateConfig ============
test('loadUserUpdateConfig: 读取合法配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-cfg-'));
  const file = path.join(dir, 'update-config.json');
  fs.writeFileSync(file, JSON.stringify({ provider: 'generic', url: 'https://up.example.com/', autoDownload: false }));
  const r = loadUserUpdateConfig(dir);
  assert.strictEqual(r.file, file);
  assert.strictEqual(r.config.provider, 'generic');
  assert.strictEqual(r.config.url, 'https://up.example.com/');
  assert.strictEqual(r.config.autoDownload, false);
});

test('loadUserUpdateConfig: 缺失返回 null 配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-none-'));
  const r = loadUserUpdateConfig(dir);
  assert.strictEqual(r.config, null);
  assert.strictEqual(r.file, path.join(dir, 'update-config.json'));
});

test('loadUserUpdateConfig: 损坏 JSON 返回 null 配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-bad-'));
  fs.writeFileSync(path.join(dir, 'update-config.json'), '{broken');
  const r = loadUserUpdateConfig(dir);
  assert.strictEqual(r.config, null);
});

test('loadUserUpdateConfig: 非对象 JSON 返回 null 配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-arr-'));
  fs.writeFileSync(path.join(dir, 'update-config.json'), '[1,2,3]');
  const r = loadUserUpdateConfig(dir);
  assert.strictEqual(r.config, null);
});

// ============ normalizeFeed ============
test('normalizeFeed: 合法 generic + http(s) url', () => {
  assert.deepStrictEqual(
    normalizeFeed({ provider: 'generic', url: 'https://up.example.com/' }),
    { provider: 'generic', url: 'https://up.example.com/' }
  );
  assert.deepStrictEqual(
    normalizeFeed({ provider: 'generic', url: ' http://192.168.1.10:8080/updates ' }),
    { provider: 'generic', url: 'http://192.168.1.10:8080/updates' }
  );
});

test('normalizeFeed: 非法配置返回 null', () => {
  assert.strictEqual(normalizeFeed(null), null);
  assert.strictEqual(normalizeFeed({}), null);
  assert.strictEqual(normalizeFeed({ provider: 'github' }), null);
  assert.strictEqual(normalizeFeed({ provider: 'generic', url: 'ftp://x.com' }), null);
  assert.strictEqual(normalizeFeed({ provider: 'generic', url: '' }), null);
});

// ============ resolveAutoDownload ============
test('resolveAutoDownload: 默认开启，配置可关闭', () => {
  assert.strictEqual(resolveAutoDownload(null), true);
  assert.strictEqual(resolveAutoDownload({}), true);
  assert.strictEqual(resolveAutoDownload({ autoDownload: false }), false);
  assert.strictEqual(resolveAutoDownload({ autoDownload: true }), true);
});
