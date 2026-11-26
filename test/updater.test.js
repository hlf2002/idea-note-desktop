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
  resolveAutoDownload,
  friendlyUpdateError,
  hasBrokenPublisherName
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

// ============ friendlyUpdateError（用户报「更新失败 toast 显示一长串错误代码」）============
test('friendlyUpdateError: 清单缺失/404 归一化为短句，不泄露 URL 与堆栈', () => {
  const e404 = new Error(
    'Cannot find latest.yml in the latest release artifacts (https://ideanote.7373.com.cn/autoupdates/latest.yml):\n' +
    'HttpError: 404 Not Found\n    at GenericProvider.getLatestVersion (/app/node_modules/builder-util-runtime/out/provider.js:1:1)\n' +
    '    at async Updater.checkForUpdates (/app/node_modules/electron-updater/out/AppUpdater.js:1:1)'
  );
  const msg = friendlyUpdateError(e404);
  assert.strictEqual(msg, '更新服务器暂未提供更新清单，请稍后再试');
  assert.ok(!/http|https|\.yml|at async/i.test(msg), '不得把 URL / 堆栈透给用户');
});

test('friendlyUpdateError: 网络 DNS 与超时分别归类', () => {
  assert.strictEqual(friendlyUpdateError(new Error('getaddrinfo ENOTFOUND ideanote.7373.com.cn')), '网络不可用，无法连接更新服务器');
  assert.strictEqual(friendlyUpdateError(new Error('request to https://x timed out')), '连接更新服务器超时');
});

test('friendlyUpdateError: 5xx / 校验失败 / 权限分别归类', () => {
  assert.strictEqual(friendlyUpdateError(new Error('HttpError: 503 Service Unavailable')), '更新服务暂时不可用，请稍后再试');
  assert.strictEqual(friendlyUpdateError(new Error('sha512 checksum mismatch, expected x got y')), '更新包校验失败，请稍后重试');
  assert.strictEqual(friendlyUpdateError(new Error('EACCES: permission denied, open app.zip')), '没有权限写入更新文件，请检查安装目录权限');
});

test('friendlyUpdateError: 未知错误取首行并截断，空值兜底', () => {
  const long = 'E'.repeat(200) + '\nsecond line';
  const msg = friendlyUpdateError(new Error(long));
  assert.ok(msg.length <= 61, '未知错误最多 60 字符 + 省略号，实际 ' + msg.length);
  assert.ok(msg.endsWith('…'));
  assert.strictEqual(friendlyUpdateError(null), '升级组件异常');
  assert.strictEqual(friendlyUpdateError(new Error('')), '升级组件异常');
});

test('friendlyUpdateError: 签名主体校验失败 → 引导手动下载，不透出 publisherNames 与原始 JSON', () => {
  // 2026-11-26 实测原文（1.2.8 客户端点更新，下载 100% 后失败）
  const raw = 'New version 1.2.9 is not signed by the application owner: publisherNames: '
    + '射手科技（珠海）有限公司, raw info: {"SignerCertificate":{"Subject":"CN=射手科技（珠海）有限公司, O=…"},'
    + '"Status":0,"Path":"C:\\Users\\x\\AppData\\Local\\idea-note-local-updater\\pending\\x.exe"}';
  const msg = friendlyUpdateError(new Error(raw));
  assert.strictEqual(msg, '新版本签名校验未通过，请到官网手动下载安装最新版');
  assert.ok(!/publisherNames|SignerCertificate|C:\\Users|raw info/i.test(msg), '不得把证书/路径原文透给用户');
});

test('hasBrokenPublisherName: 识别打包环节把中文 CN 写成 U+FFFD 的坏清单', () => {
  // 打包机实测字节：UTF-8 的 YAML 里 publisherName 全是 EF BF BD
  assert.strictEqual(hasBrokenPublisherName('publisherName:\n  - \ufffd\ufffd\ufffd\ufffd公司\n'), true);
  assert.strictEqual(hasBrokenPublisherName('publisherName: \ufffd公司\n'), true);
  // 正确中文 / 英文 / 缺失 都不算损坏
  assert.strictEqual(hasBrokenPublisherName('publisherName:\n  - 射手科技（珠海）有限公司\n'), false);
  assert.strictEqual(hasBrokenPublisherName('publisherName: Acme Inc\n'), false);
  assert.strictEqual(hasBrokenPublisherName('provider: generic\nurl: https://x/\n'), false);
  assert.strictEqual(hasBrokenPublisherName(''), false);
  assert.strictEqual(hasBrokenPublisherName(null), false);
});
