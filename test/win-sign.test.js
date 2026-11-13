'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSigning, DEFAULT_TIMESTAMP } = require('../scripts/win-sign');

const CLI_EMPTY = { signSha1: '', signSubject: '', publisherName: '' };
const ENV_EMPTY = {};
const CONFIG_EMPTY = {};
const PKG_EMPTY = null;
const ONE_CERT = [{ thumbprint: 'ABC123', subject: 'CN=Test Co, O=Test', notAfter: '2027-01-01T00:00:00' }];
const TWO_CERTS = [
  { thumbprint: 'AAA', subject: 'CN=A', notAfter: '2027-01-01T00:00:00' },
  { thumbprint: 'BBB', subject: 'CN=B', notAfter: '2027-01-01T00:00:00' }
];

function argByPrefix(args, prefix) {
  return args.find((a) => a.includes(prefix));
}

test('优先级① 命令行 --sign-sha1 高于环境变量与配置', () => {
  const r = resolveSigning({
    cli: { ...CLI_EMPTY, signSha1: 'CLI_FPR' },
    env: { WIN_SIGN_SHA1: 'ENV_FPR' },
    config: { signing: { windows: { certificateSha1: 'CFG_FPR' } } },
    pkgSigntool: PKG_EMPTY,
    platform: 'win32',
    certs: ONE_CERT
  });
  assert.equal(r.mode, 'explicit');
  assert.match(argByPrefix(r.builderArgs, '--c.win.signtoolOptions.certificateSha1'), /CLI_FPR/);
  assert.ok(argByPrefix(r.builderArgs, '--c.win.signtoolOptions.rfc3161TimeStampServer'));
});

test('优先级② 环境变量 WIN_SIGN_SHA1（无 CLI 时生效），SIGN_SHA1 为兜底', () => {
  const r = resolveSigning({ cli: CLI_EMPTY, env: { WIN_SIGN_SHA1: 'ENV_FPR' }, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY, platform: 'win32', certs: ONE_CERT });
  assert.equal(r.mode, 'explicit');
  assert.match(argByPrefix(r.builderArgs, 'certificateSha1'), /ENV_FPR/);
  const r2 = resolveSigning({ cli: CLI_EMPTY, env: { SIGN_SHA1: 'ENV2_FPR' }, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY, platform: 'win32', certs: ONE_CERT });
  assert.equal(r2.mode, 'explicit');
  assert.match(argByPrefix(r2.builderArgs, 'certificateSha1'), /ENV2_FPR/);
});

test('显式模式可带 publisherName（环境变量注入）', () => {
  const r = resolveSigning({
    cli: { ...CLI_EMPTY, signSha1: 'FPR' },
    env: { WIN_PUBLISHER_NAME: 'CN=Company' },
    config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY, platform: 'win32', certs: ONE_CERT
  });
  assert.match(argByPrefix(r.builderArgs, 'publisherName'), /CN=Company/);
});

test('优先级③ method:"none" 显式关闭签名，builderArgs 为空', () => {
  const r = resolveSigning({
    cli: CLI_EMPTY, env: ENV_EMPTY,
    config: { signing: { windows: { method: 'none', certificateSha1: 'IGNORED' } } },
    pkgSigntool: PKG_EMPTY, platform: 'win32', certs: ONE_CERT
  });
  assert.equal(r.mode, 'off');
  assert.deepEqual(r.builderArgs, []);
});

test('优先级③ .electron-release.json certificateSha1 生效', () => {
  const r = resolveSigning({
    cli: CLI_EMPTY, env: ENV_EMPTY,
    config: { signing: { windows: { certificateSha1: 'CFG_FPR', timestampServer: 'http://ts.example' } } },
    pkgSigntool: PKG_EMPTY, platform: 'win32', certs: ONE_CERT
  });
  assert.equal(r.mode, 'config');
  assert.match(argByPrefix(r.builderArgs, 'certificateSha1'), /CFG_FPR/);
  assert.match(argByPrefix(r.builderArgs, 'rfc3161TimeStampServer'), /ts\.example/);
});

test('优先级④ package.json signtoolOptions 在配置为空时生效', () => {
  const r = resolveSigning({
    cli: CLI_EMPTY, env: ENV_EMPTY, config: CONFIG_EMPTY,
    pkgSigntool: { certificateSha1: 'PKG_FPR' },
    platform: 'win32', certs: ONE_CERT
  });
  assert.equal(r.mode, 'pkg');
  assert.match(argByPrefix(r.builderArgs, 'certificateSha1'), /PKG_FPR/);
});

test('优先级⑤ 证书存储唯一可用证书 → auto：注入指纹 + 时间戳 + publisherName=Subject', () => {
  const r = resolveSigning({
    cli: CLI_EMPTY, env: ENV_EMPTY, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY,
    platform: 'win32', certs: ONE_CERT
  });
  assert.equal(r.mode, 'auto');
  assert.equal(r.canBuild, true);
  assert.match(argByPrefix(r.builderArgs, 'certificateSha1'), /ABC123/);
  assert.match(argByPrefix(r.builderArgs, 'publisherName'), /CN=Test Co/);
  assert.equal(r.timestampServer, DEFAULT_TIMESTAMP);
});

test('auto：零张证书 → missing 且 canBuild=false（未登录 SimplySign 的默认停止行为）', () => {
  const r = resolveSigning({ cli: CLI_EMPTY, env: ENV_EMPTY, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY, platform: 'win32', certs: [] });
  assert.equal(r.mode, 'missing');
  assert.equal(r.canBuild, false);
});

test('auto：多张证书 → ambiguous 且列出候选，不替你猜', () => {
  const r = resolveSigning({ cli: CLI_EMPTY, env: ENV_EMPTY, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY, platform: 'win32', certs: TWO_CERTS });
  assert.equal(r.mode, 'ambiguous');
  assert.equal(r.canBuild, false);
  assert.equal(r.candidates.length, 2);
});

test('非 Windows 宿主 → unavailable 且 canBuild=false（禁止交叉构建，--allow-unsigned 也不放行）', () => {
  const r = resolveSigning({ cli: CLI_EMPTY, env: ENV_EMPTY, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY, platform: 'darwin', certs: null });
  assert.equal(r.mode, 'unavailable');
  assert.equal(r.canBuild, false);
  assert.deepEqual(r.builderArgs, []);
});

test('默认时间戳服务器为 RFC3161 (digicert)，可被环境变量覆盖', () => {
  const r = resolveSigning({ cli: CLI_EMPTY, env: { WIN_TIMESTAMP_URL: 'http://ts.local' }, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY, platform: 'win32', certs: ONE_CERT });
  assert.equal(r.timestampServer, 'http://ts.local');
  assert.match(argByPrefix(r.builderArgs, 'rfc3161TimeStampServer'), /ts\.local/);
});
