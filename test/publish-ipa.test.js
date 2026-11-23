'use strict';

/**
 * scripts/publish-ipa.js 的纯逻辑单测：URL 拼接、响应字段解析、状态判据、
 * 飞书端点替换、参数解析、产物定位。网络部分不发真实请求。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ipa = require('../scripts/publish-ipa');

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-ipa-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content ?? 'x');
  }
  return dir;
}

// ------------------------------------------------------------ URL 拼接

test('joinUrl: 完整 URL 直接返回', () => {
  assert.equal(ipa.joinUrl('https://ipa.qzhuli.cn', 'https://other.example/x'), 'https://other.example/x');
});

test('joinUrl: 拼接时去掉重复斜杠', () => {
  assert.equal(ipa.joinUrl('https://ipa.qzhuli.cn/', '/open-api/v1/uploads/policy'), 'https://ipa.qzhuli.cn/open-api/v1/uploads/policy');
  assert.equal(ipa.joinUrl('https://ipa.qzhuli.cn', 'open-api/v1'), 'https://ipa.qzhuli.cn/open-api/v1');
});

// ------------------------------------------------------------ 响应字段解析

test('firstApiValue: 顶层 / data. / result. 前缀逐级取值', () => {
  const resp = { data: { uploadUrl: 'https://up', key: 'k1' }, code: 0 };
  assert.equal(ipa.firstApiValue(resp, ['uploadUrl', 'data.uploadUrl']), 'https://up');
  assert.equal(ipa.firstApiValue(resp, ['key', 'data.key']), 'k1');
  assert.equal(ipa.firstApiValue(resp, ['result.key', 'data.key']), 'k1');
});

test('firstApiValue: 跳过空值并返回第一个非空', () => {
  const resp = { key: '', data: { key: 'k2' } };
  assert.equal(ipa.firstApiValue(resp, ['key', 'data.key']), 'k2');
});

test('firstApiValue: 全部缺失返回 null', () => {
  assert.equal(ipa.firstApiValue({}, ['key', 'data.key']), null);
  assert.equal(ipa.firstApiValue(null, ['key']), null);
});

// ------------------------------------------------------------ 状态判据

test('statusIsOk: 兼容 0/200/ok/布尔', () => {
  assert.equal(ipa.statusIsOk(undefined), true);
  assert.equal(ipa.statusIsOk(null), true);
  assert.equal(ipa.statusIsOk(true), true);
  assert.equal(ipa.statusIsOk(false), false);
  assert.equal(ipa.statusIsOk(0), true);
  assert.equal(ipa.statusIsOk(200), true);
  assert.equal(ipa.statusIsOk(500), false);
  assert.equal(ipa.statusIsOk('ok'), true);
  assert.equal(ipa.statusIsOk('0'), true);
  assert.equal(ipa.statusIsOk('200'), true);
  assert.equal(ipa.statusIsOk('failed'), false);
});

test('successIsTrue: 兼容 true/1/"true"/"1"', () => {
  assert.equal(ipa.successIsTrue(null), false);
  assert.equal(ipa.successIsTrue(true), true);
  assert.equal(ipa.successIsTrue(false), false);
  assert.equal(ipa.successIsTrue(1), true);
  assert.equal(ipa.successIsTrue(0), false);
  assert.equal(ipa.successIsTrue('true'), true);
  assert.equal(ipa.successIsTrue('1'), true);
  assert.equal(ipa.successIsTrue('yes'), false);
});

// ------------------------------------------------------------ JSON 解析

test('decodeJson: 正常解析', () => {
  assert.deepEqual(ipa.decodeJson(Buffer.from('{"a":1}'), 'ctx'), { a: 1 });
});

test('decodeJson: 空体返回 null', () => {
  assert.equal(ipa.decodeJson(Buffer.from('   '), 'ctx'), null);
});

test('decodeJson: 非法 JSON 抛 PublishError', () => {
  assert.throws(() => ipa.decodeJson(Buffer.from('not-json'), 'ctx'), ipa.PublishError);
});

// ------------------------------------------------------------ 飞书端点

test('buildFeishuUrl: 替换 %s 与 {versionId}', () => {
  assert.equal(
    ipa.buildFeishuUrl('https://ipa.qzhuli.cn', '/open-api/v1/versions/%s/publish-feishu', 167),
    'https://ipa.qzhuli.cn/open-api/v1/versions/167/publish-feishu'
  );
  assert.equal(
    ipa.buildFeishuUrl('https://ipa.qzhuli.cn', '/open-api/v1/versions/{versionId}/publish-feishu', 'v9'),
    'https://ipa.qzhuli.cn/open-api/v1/versions/v9/publish-feishu'
  );
});

// ------------------------------------------------------------ 参数解析

test('parseArgs: 正常解析键值参数与开关', () => {
  const o = ipa.parseArgs(['--platform', 'win', '--app-id', 'app123', '--token', 'tok456', '--dry-run']);
  assert.equal(o.platform, 'win');
  assert.equal(o.appId, 'app123');
  assert.equal(o.token, 'tok456');
  assert.equal(o.dryRun, true);
});

test('parseArgs: 默认值对齐 q_assistant 契约', () => {
  const o = ipa.parseArgs([]);
  assert.equal(o.baseUrl, ipa.DEFAULT_BASE_URL);
  assert.equal(o.policyPath, ipa.DEFAULT_POLICY_PATH);
  assert.equal(o.completePath, ipa.DEFAULT_COMPLETE_PATH);
  assert.equal(o.feishuPath, ipa.DEFAULT_FEISHU_PATH);
});

// ------------------------------------------------------------ 产物定位

test('locateInstaller: --file 显式指定并校验存在', () => {
  const dir = tempDir({ 'a.exe': 'x' });
  const target = path.join(dir, 'a.exe');
  assert.equal(ipa.locateInstaller({ file: target, platform: 'win' }), target);
  assert.throws(() => ipa.locateInstaller({ file: path.join(dir, 'missing.exe'), platform: 'win' }), ipa.PublishError);
});

test('locateInstaller: win 匹配 *Setup*.exe，排除 blockmap', () => {
  const dir = tempDir({
    'idea-note-Setup-1.2.4.exe': 'exe',
    'idea-note-Setup-1.2.4.exe.blockmap': 'bm',
    'latest.yml': 'yaml'
  });
  const found = ipa.locateInstaller({ platform: 'win', dir });
  assert.equal(path.basename(found), 'idea-note-Setup-1.2.4.exe');
});

test('locateInstaller: mac 默认 x64（排除 arm64）', () => {
  const dir = tempDir({
    '灵感笔记-1.2.4.dmg': 'x64',
    '灵感笔记-1.2.4-arm64.dmg': 'arm64'
  });
  const found = ipa.locateInstaller({ platform: 'mac', dir, architecture: 'intel' });
  assert.equal(path.basename(found), '灵感笔记-1.2.4.dmg');
});

test('locateInstaller: mac 指定 apple_silicon 选 arm64', () => {
  const dir = tempDir({
    '灵感笔记-1.2.4.dmg': 'x64',
    '灵感笔记-1.2.4-arm64.dmg': 'arm64'
  });
  const found = ipa.locateInstaller({ platform: 'mac', dir, architecture: 'apple_silicon' });
  assert.equal(path.basename(found), '灵感笔记-1.2.4-arm64.dmg');
});

test('locateInstaller: 目录无匹配产物抛 PublishError', () => {
  const dir = tempDir({ 'readme.txt': 'x' });
  assert.throws(() => ipa.locateInstaller({ platform: 'win', dir }), ipa.PublishError);
});

// ------------------------------------------------------------ 架构推断（mac 专用）

test('inferArchitecture: 文件名含 arm64 → apple_silicon', () => {
  assert.equal(ipa.inferArchitecture('mac', '灵感笔记-1.2.4-arm64.dmg'), 'apple_silicon');
  assert.equal(ipa.inferArchitecture('mac', 'idea-note-1.2.4-arm64-mac.zip'), 'apple_silicon');
});

test('inferArchitecture: 无 arch 后缀 → intel（x64 为 electron-builder 默认命名）', () => {
  assert.equal(ipa.inferArchitecture('mac', '灵感笔记-1.2.4.dmg'), 'intel');
  assert.equal(ipa.inferArchitecture('mac', '灵感笔记-1.2.4-x64.dmg'), 'intel');
});

test('inferArchitecture: win 平台返回空串', () => {
  assert.equal(ipa.inferArchitecture('win', 'idea-note-Setup-1.2.4.exe'), '');
});

test('parseArgs: 解析 --architecture', () => {
  const o = ipa.parseArgs(['--platform', 'mac', '--architecture', 'apple_silicon']);
  assert.equal(o.architecture, 'apple_silicon');
});

// ------------------------------------------------------------ q助理群通知

test('buildQzhuliMessage: mac 消息内容与下载地址', () => {
  const msg = ipa.buildQzhuliMessage({
    displayName: '灵感笔记',
    platform: 'mac',
    version: '1.2.4',
    buildNumber: '20261123101059',
    policyKey: 'dmg/xxx/intel/1795401101852.dmg'
  });
  assert.equal(msg.title, '📱 新版本发布 — 灵感笔记（macOS）');
  assert.equal(msg.content, '**Version / Build**: 1.2.4 / 20261123101059');
  assert.equal(msg.url, `${ipa.DISTRIBUTION_BASE}/dmg/xxx/intel/1795401101852.dmg`);
});

test('buildQzhuliMessage: win 标题使用 Windows 平台名', () => {
  const msg = ipa.buildQzhuliMessage({
    displayName: '灵感笔记',
    platform: 'win',
    version: '1.2.4',
    buildNumber: '123',
    policyKey: 'exe/xxx'
  });
  assert.equal(msg.title, '📱 新版本发布 — 灵感笔记（Windows）');
});

test('parseArgs: 解析 --qzhuli-conversation-id / --qzhuli-token', () => {
  const o = ipa.parseArgs([
    '--qzhuli-conversation-id', 'conv-123',
    '--qzhuli-token', 'qzw_test'
  ]);
  assert.equal(o.qzhuliConversationId, 'conv-123');
  assert.equal(o.qzhuliToken, 'qzw_test');
});

test('parseArgs: --mode 默认 publish-feishu，可覆盖', () => {
  assert.equal(ipa.parseArgs([]).mode, 'publish-feishu');
  assert.equal(ipa.parseArgs(['--mode', 'publish-qzhuli']).mode, 'publish-qzhuli');
  assert.equal(ipa.parseArgs(['--mode', 'publish-both']).mode, 'publish-both');
});
