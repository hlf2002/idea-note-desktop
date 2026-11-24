'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSigning, decideLogin, DEFAULT_TIMESTAMP, findUnsafeArgs } = require('../scripts/win-sign');

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

test('优先级⑤ 证书存储唯一可用证书 → auto：只注入指纹 + 时间戳，不注入 publisherName', () => {
  const r = resolveSigning({
    cli: CLI_EMPTY, env: ENV_EMPTY, config: CONFIG_EMPTY, pkgSigntool: PKG_EMPTY,
    platform: 'win32', certs: ONE_CERT
  });
  assert.equal(r.mode, 'auto');
  assert.equal(r.canBuild, true);
  assert.match(argByPrefix(r.builderArgs, 'certificateSha1'), /ABC123/);
  // 证书 Subject 是完整 X500 DN（"CN=Test Co, O=Test"，含 ", "），直接当参数值会被
  // shell 按空格拆成多段 → yargs strict 报 Unknown arguments。交给 electron-builder
  // 自己从证书取 commonName，语义等价且没有空白字符。
  assert.equal(argByPrefix(r.builderArgs, 'publisherName'), undefined);
  assert.equal(r.publisherName, '');
  assert.deepEqual(findUnsafeArgs(r.builderArgs), []);
  assert.equal(r.timestampServer, DEFAULT_TIMESTAMP);
});

test('findUnsafeArgs：揪出会被 shell 拆词的参数（回归样例为完整证书 DN）', () => {
  // 2026-11-20 打包机实测：这条参数在 Windows 上被拆成 5 段，后 4 段成 Unknown arguments
  const dn = '--c.win.signtoolOptions.publisherName=CN=射手科技（珠海）有限公司, O=射手科技（珠海）有限公司, L=珠海, S=广东, C=CN';
  assert.deepEqual(findUnsafeArgs([dn]), [dn]);
  assert.deepEqual(findUnsafeArgs([
    '--c.win.signtoolOptions.certificateSha1=ABC123',
    '--c.win.signtoolOptions.rfc3161TimeStampServer=http://timestamp.digicert.com'
  ]), []);
  assert.deepEqual(findUnsafeArgs(['--c.win.publisherName=CN= ']), ['--c.win.publisherName=CN= ']); // 结尾空格同样危险
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

// ------------------------------------------------------------ SimplySign 登录决策

test('登录 auto：无证书 → 触发', () => {
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: {}, certs: [] });
  assert.equal(d.attempt, true);
  assert.equal(d.mode, 'auto');
  assert.match(d.reason, /连接状态/);
});

test('登录 auto：证书残留也触发（证书在 ≠ 会话已连接）', () => {
  // 2026-11-24 打包机实测：SimplySign 断开后证书仍留在 Cert:\CurrentUser\My，
  // HasPrivateKey 仍为 true，但 signtool 报 No certificates were found。
  // 判据只能是连接状态，不能是证书数量——否则会跳过登录直接进入预热失败。
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: {}, certs: ONE_CERT });
  assert.equal(d.attempt, true);
  assert.match(d.reason, /残留/);
});

test('登录 force：无视现有证书强制重登（证书过期/指纹变更时用）', () => {
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: { WIN_SIMPLYSIGN_LOGIN: 'force' }, certs: ONE_CERT });
  assert.equal(d.attempt, true);
  assert.equal(d.mode, 'force');
});

test('登录 off：完全不碰 SimplySign，排障与回滚用', () => {
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: { WIN_SIMPLYSIGN_LOGIN: 'off' }, certs: [] });
  assert.equal(d.attempt, false);
});

test('登录：非法取值按 off 处理，不因拼写错误产生副作用', () => {
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: { WIN_SIMPLYSIGN_LOGIN: 'yes' }, certs: [] });
  assert.equal(d.attempt, false);
  assert.equal(d.mode, 'off');
  assert.match(d.reason, /非法/);
});

test('登录：--no-sign / method:none / --dry-run 一律不触发（force 也不越过）', () => {
  const force = { WIN_SIMPLYSIGN_LOGIN: 'force' };
  assert.equal(decideLogin({ cli: { ...CLI_EMPTY, noSign: true }, cfgWin: {}, env: force, certs: [] }).attempt, false);
  assert.equal(decideLogin({ cli: CLI_EMPTY, cfgWin: { method: 'none' }, env: force, certs: [] }).attempt, false);
  assert.equal(decideLogin({ cli: { ...CLI_EMPTY, dryRun: true }, cfgWin: {}, env: {}, certs: [] }).attempt, false);
});

test('登录：大小写与空白容错（deploy.sh 透传值不保证规范化）', () => {
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: { WIN_SIMPLYSIGN_LOGIN: ' FORCE ' }, certs: ONE_CERT });
  assert.equal(d.attempt, true);
  assert.equal(d.mode, 'force');
});

test('登录：非 Windows 宿主 certs=null 不崩，按「无证书」处理', () => {
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: {}, certs: null });
  assert.equal(d.attempt, true);
});

test('登录：非 Windows 宿主直接跳过，把原因留给 unavailable 分支', () => {
  const d = decideLogin({ cli: CLI_EMPTY, cfgWin: {}, env: {}, certs: null, platform: 'darwin' });
  assert.equal(d.attempt, false);
  assert.match(d.reason, /非 Windows/);
});

