/**
 * cli.test.js —— qz/cli.js 纯函数单元测试（@ 提及解析 / 联系人匹配 / 会话选择 / 文案）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  extractMentions,
  resolveMentions,
  pickConversation,
  makeNotifyText,
  sortContactsByLastActive,
  attachAgentTitles,
  bundledCliEntry,
  stripAnsi,
  extractQrBlock,
  cliErrorMessage,
  QzCli
} = require('../qz/cli');

// ============ extractMentions ============
test('extractMentions: 提取中文昵称', () => {
  assert.deepStrictEqual(extractMentions('今天 @施展 一起讨论'), [
    { raw: '@施展', name: '施展' }
  ]);
});

test('extractMentions: 提取英文昵称', () => {
  assert.deepStrictEqual(extractMentions('联系 @Pitt 确认'), [
    { raw: '@Pitt', name: 'Pitt' }
  ]);
});

test('extractMentions: 多个提及去重保留原文', () => {
  assert.deepStrictEqual(extractMentions('@a 和 @b 还有 @a'), [
    { raw: '@a', name: 'a' },
    { raw: '@b', name: 'b' },
    { raw: '@a', name: 'a' }
  ]);
});

test('extractMentions: 标签 # 后的 @ 不误判为正文标签冲突', () => {
  // #后跟@不是合法标签，但正文里 @xx 仍应提取
  assert.deepStrictEqual(extractMentions('邮件 a@b.com 不算'), []);
});

test('extractMentions: 邮箱地址不提取', () => {
  assert.deepStrictEqual(extractMentions('发到 test@example.com 抄送'), []);
});

test('extractMentions: 空白/标点中断昵称', () => {
  assert.deepStrictEqual(extractMentions('@a，你好'), [{ raw: '@a', name: 'a' }]);
});

test('extractMentions: 无提及 / 空 / 非字符串', () => {
  assert.deepStrictEqual(extractMentions('没有提及的文本'), []);
  assert.deepStrictEqual(extractMentions(''), []);
  assert.deepStrictEqual(extractMentions(null), []);
});

// ============ resolveMentions ============
const CONTACTS = [
  { uid: 'u1', nickname: '施展', remark: '老施' },
  { uid: 'u2', nickname: 'Pitt', remark: '' },
  { uid: 'u3', nickname: '李超然', remark: '超然' }
];

test('resolveMentions: 按昵称精确匹配', () => {
  const r = resolveMentions([{ name: '施展' }], CONTACTS);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].uid, 'u1');
});

test('resolveMentions: 按备注匹配', () => {
  const r = resolveMentions([{ name: '老施' }], CONTACTS);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].uid, 'u1');
});

test('resolveMentions: 忽略大小写', () => {
  const r = resolveMentions([{ name: 'pitt' }], CONTACTS);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].uid, 'u2');
});

test('resolveMentions: 未匹配的联系人跳过', () => {
  const r = resolveMentions([{ name: '不存在的人' }], CONTACTS);
  assert.strictEqual(r.length, 0);
});

test('resolveMentions: 重复提及只通知一次', () => {
  const r = resolveMentions([{ name: '施展' }, { name: '施展' }], CONTACTS);
  assert.strictEqual(r.length, 1);
});

test('resolveMentions: 空联系人/空提及', () => {
  assert.strictEqual(resolveMentions([{ name: '施展' }], []).length, 0);
  assert.strictEqual(resolveMentions([], CONTACTS).length, 0);
});

test('resolveMentions: 昵称与备注指向同一人时按昵称命中', () => {
  const r = resolveMentions([{ name: '超然' }], CONTACTS);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].uid, 'u3');
});

// ============ pickConversation（@ 通知：必须是「我+我的默认助理+对方+对方的默认助理」双人会话） ============
test('pickConversation: 双方默认助理都在的双人会话命中', () => {
  const convs = [
    { conversationId: 'g1', isGroup: 1, ownerAgentId: '1', friendAgentId: '9' },
    { conversationId: 's1', isGroup: 0, ownerAgentId: '1', friendAgentId: '9' },
    { conversationId: 's2', isGroup: 0, ownerAgentId: '1', friendAgentId: '3' }
  ];
  assert.strictEqual(pickConversation(convs, '1', '9').conversationId, 's1');
});

test('pickConversation: 对方侧不是对方的默认助理（数字员工）不选', () => {
  const convs = [
    { conversationId: 's1', isGroup: 0, ownerAgentId: '1', friendAgentId: '3' },
    { conversationId: 's2', isGroup: 0, ownerAgentId: '1', friendAgentId: '9' }
  ];
  assert.strictEqual(pickConversation(convs, '1', '9').conversationId, 's2');
});

test('pickConversation: owner 侧不是我的默认助理不选', () => {
  const convs = [
    { conversationId: 's1', isGroup: 0, ownerAgentId: '2', friendAgentId: '9' },
    { conversationId: 's2', isGroup: 0, ownerAgentId: '3', friendAgentId: '9' }
  ];
  assert.strictEqual(pickConversation(convs, '1', '9'), null);
});

test('pickConversation: 群聊即使双方默认助理都在也不选（必须双人会话）', () => {
  const convs = [
    { conversationId: 'g1', isGroup: 1, ownerAgentId: '1', friendAgentId: '9' },
    { conversationId: 'g2', isGroup: 1, ownerAgentId: '1', friendAgentId: '9' }
  ];
  assert.strictEqual(pickConversation(convs, '1', '9'), null);
});

test('pickConversation: 全部不匹配返回 null（触发创建）', () => {
  const convs = [
    { conversationId: 'g1', isGroup: 1, ownerAgentId: '9', friendAgentId: '1' },
    { conversationId: 's1', isGroup: 0, ownerAgentId: '9', friendAgentId: '9' }
  ];
  assert.strictEqual(pickConversation(convs, '1', '9'), null);
});

test('pickConversation: 空数组 / null / undefined 返回 null', () => {
  assert.strictEqual(pickConversation([], '1', '9'), null);
  assert.strictEqual(pickConversation(null, '1', '9'), null);
  assert.strictEqual(pickConversation(undefined, '1', '9'), null);
});

test('pickConversation: 缺 ownerAgentId / friendAgentId 的会话不算双人双助理会话', () => {
  const convs = [
    { conversationId: 's1', isGroup: 0, ownerAgentId: null, friendAgentId: '9' },
    { conversationId: 's2', isGroup: 0, ownerAgentId: '1', friendAgentId: undefined },
    { conversationId: 's3', isGroup: 0, ownerAgentId: undefined, friendAgentId: undefined }
  ];
  assert.strictEqual(pickConversation(convs, '1', '9'), null);
});

// ============ bundledCliEntry（应用捆绑 qzhuliCLI 探测） ============
test('bundledCliEntry: 找到捆绑 cmd.js', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-cli-test-'));
  const pkgDir = path.join(tmp, 'node_modules', '@qzhuli', 'qzhuli-cli', 'dist');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'cmd.js'), '#!/usr/bin/env node\n');
  assert.strictEqual(bundledCliEntry(tmp), path.join(pkgDir, 'cmd.js'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('bundledCliEntry: 无捆绑返回空串', () => {
  assert.strictEqual(bundledCliEntry('/nonexistent-app-dir'), '');
  assert.strictEqual(bundledCliEntry(''), '');
  assert.strictEqual(bundledCliEntry(null), '');
});

test('makeNotifyText: 含发送者与全文', () => {
  const text = makeNotifyText('疯狐狸', '今天 #想法\n第二行');
  assert.ok(text.indexOf('疯狐狸') >= 0);
  assert.ok(text.indexOf('今天 #想法') > 0);
  assert.ok(text.indexOf('第二行') > 0);
  assert.ok(text.indexOf('【灵感笔记】') === 0);
});

test('makeNotifyText: 无发送者用默认称谓', () => {
  const text = makeNotifyText('', '内容');
  assert.ok(text.indexOf('你的朋友') >= 0);
  assert.ok(text.indexOf('内容') > 0);
});

test('makeNotifyText: null 正文不抛错', () => {
  assert.ok(makeNotifyText('某人', null).indexOf('') >= 0);
});

test('makeNotifyText: 带分享页 URL 附在末尾', () => {
  const text = makeNotifyText('疯狐狸', '正文', 'https://ideanote.7373.com.cn/notes/abc123');
  assert.ok(text.indexOf('查看完整笔记：https://ideanote.7373.com.cn/notes/abc123') >= 0);
});

test('makeNotifyText: URL 为空/空白时不带链接', () => {
  const text = makeNotifyText('疯狐狸', '正文', '');
  assert.ok(text.indexOf('查看完整笔记') < 0);
  const text2 = makeNotifyText('疯狐狸', '正文', '   ');
  assert.ok(text2.indexOf('查看完整笔记') < 0);
  const text3 = makeNotifyText('疯狐狸', '正文', null);
  assert.ok(text3.indexOf('查看完整笔记') < 0);
  const text4 = makeNotifyText('疯狐狸', '正文', undefined);
  assert.ok(text4.indexOf('查看完整笔记') < 0);
});

// ============ sortContactsByLastActive ============
test('sortContactsByLastActive: 按最后沟通时间倒序', () => {
  const contacts = [
    { uid: 'a', nickname: '旧' },
    { uid: 'b', nickname: '新' },
    { uid: 'c', nickname: '中' }
  ];
  const map = new Map([
    ['a', '1000000000000000000'],
    ['b', '3000000000000000000'],
    ['c', '2000000000000000000']
  ]);
  const sorted = sortContactsByLastActive(contacts, map);
  assert.deepStrictEqual(sorted.map((c) => c.uid), ['b', 'c', 'a']);
  assert.strictEqual(sorted[0].lastActiveTs, '3000000000000000000');
});

test('sortContactsByLastActive: 无记录的联系人排在最后且保持原顺序', () => {
  const contacts = [
    { uid: 'a', nickname: '有记录' },
    { uid: 'x', nickname: '无记录1' },
    { uid: 'b', nickname: '有记录2' },
    { uid: 'y', nickname: '无记录2' }
  ];
  const map = { a: '2000000000000000000', b: '1000000000000000000' };
  const sorted = sortContactsByLastActive(contacts, map);
  assert.deepStrictEqual(sorted.map((c) => c.uid), ['a', 'b', 'x', 'y']);
});

test('sortContactsByLastActive: 支持对象形式的 map 与空 map', () => {
  const contacts = [{ uid: 'a', nickname: '甲' }];
  assert.deepStrictEqual(sortContactsByLastActive(contacts, {}).map((c) => c.uid), ['a']);
  assert.deepStrictEqual(sortContactsByLastActive(contacts, null).map((c) => c.uid), ['a']);
  assert.deepStrictEqual(sortContactsByLastActive(null, {}), []);
});

test('sortContactsByLastActive: 超大时间戳按字符串比较（超出 JS 安全整数）', () => {
  const contacts = [
    { uid: 'a', nickname: 'A' },
    { uid: 'b', nickname: 'B' }
  ];
  const map = new Map([
    ['a', '1793782453119045600'],
    ['b', '1793782453119045601']
  ]);
  const sorted = sortContactsByLastActive(contacts, map);
  // 末位差 1 的微秒时间戳，Number 会丢精度，字符串比较仍能正确区分
  assert.deepStrictEqual(sorted.map((c) => c.uid), ['b', 'a']);
});

// ============ attachAgentTitles ============
test('attachAgentTitles: 命中 Map 附加 agentTitle', () => {
  const contacts = [{ uid: 'u1', nickname: '李世祥' }, { uid: 'u2', nickname: '黄捷' }];
  const map = new Map([['u1', { title: '李青蓝', ts: '1' }]]);
  const r = attachAgentTitles(contacts, map);
  assert.strictEqual(r[0].agentTitle, '李青蓝');
  assert.strictEqual(r[1].agentTitle, undefined);
  // 原数组不被修改
  assert.strictEqual(contacts[0].agentTitle, undefined);
});

test('attachAgentTitles: 支持对象形式 map 与无会话联系人', () => {
  const contacts = [{ uid: 'a', nickname: '甲' }];
  assert.strictEqual(attachAgentTitles(contacts, { a: { title: '李青蓝', ts: '1' } })[0].agentTitle, '李青蓝');
  assert.strictEqual(attachAgentTitles(contacts, {})[0].agentTitle, undefined);
  assert.strictEqual(attachAgentTitles(contacts, null)[0].agentTitle, undefined);
});

test('attachAgentTitles: 非法输入返回空数组', () => {
  assert.deepStrictEqual(attachAgentTitles(null, {}), []);
  assert.deepStrictEqual(attachAgentTitles(undefined, {}), []);
  assert.deepStrictEqual(attachAgentTitles('x', {}), []);
});

// ============ 候选降级（打包版原生模块 ABI 不匹配时自动换捆绑 CLI） ============
/** 造一个假 appPath（含 electron-builder 打包后的捆绑入口），cmd.js 内容可控 */
function makeFakeAppPath(cmdJs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzcli-app-'));
  const cliDir = path.join(dir, 'node_modules', '@qzhuli', 'qzhuli-cli', 'dist');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'cmd.js'), cmdJs);
  return dir;
}

/** 造一个假的「坏 qz」：脚本退出码 1，stderr 打 ABI 报错 */
function makeBrokenBin(stderrText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzcli-bin-'));
  const bin = path.join(dir, 'qz');
  fs.writeFileSync(bin, '#!/bin/sh\necho "' + stderrText + '" >&2\nexit 1\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('resolveCandidates: 捆绑 CLI 永远排在最后（首选候选失败才能降级）', () => {
  const appPath = makeFakeAppPath('console.log("{}")');
  const cli = new QzCli({ appPath });
  const c = cli.resolveCandidates();
  assert.ok(c.length >= 1, '至少应有捆绑候选');
  assert.strictEqual(c[c.length - 1].bundled, true);
  assert.ok(c[c.length - 1].bin.endsWith(path.join('node_modules', '@qzhuli', 'qzhuli-cli', 'dist', 'cmd.js')));
});

test('run: 首选候选 ABI 崩溃时自动降级，仍能拿到结果', async () => {
  const bad = makeBrokenBin('Error: NODE_MODULE_VERSION 147');
  const appPath = makeFakeAppPath(
    'console.log(JSON.stringify({status:"success",code:"OK",data:{links:[{uid:"u1",nickname:"甲"}]}}))'
  );
  const cli = new QzCli({ appPath, binPath: bad });
  // 固定候选为「坏 qz → 捆绑 CLI」，避免机器上真实安装的 qz 干扰断言
  cli.resolveCandidates = () => [{ bin: bad, bundled: false }, { bin: bundledCliEntry(appPath), bundled: true }];
  const r = await cli.run(['friend', 'list']);
  assert.strictEqual(r.status, 'success');
  assert.ok(r.data && r.data.links && r.data.links.length === 1, '降级后的捆绑 CLI 必须真的被执行');
  assert.ok(cli._badBins.has(bad), '坏候选应被记录，避免每次重试');
  assert.strictEqual(cli._lastBin, bundledCliEntry(appPath), '应记录实际应答的那份 CLI');
});

test('run: 业务错误（正常 JSON status=error）不触发降级', async () => {
  const cli = new QzCli({
    appPath: makeFakeAppPath('console.log(JSON.stringify({status:"success",code:"SHOULD_NOT_RUN"}))'),
    binPath: makeBrokenBin('placeholder')
  });
  // 用一个「正常应答业务错误」的候选：直接覆盖 _runOnce 返回，验证不降级
  cli.resolveCandidates = () => [{ bin: '/fake/qz-outdated', bundled: false }];
  cli._runOnce = async () => ({ status: 'error', code: 'AUTH_EXPIRED', message: 'token 过期', data: { status: 'error', code: 'AUTH_EXPIRED' } });
  const r = await cli.run(['auth', 'status']);
  assert.strictEqual(r.code, 'AUTH_EXPIRED');
  assert.strictEqual(r.data.status, 'error');
});

// ============ 扫码登录：终端二维码提取（qz auth login） ============
// 样本取自真实 `qz auth login --method qr-code` 的 stdout（qrcode-terminal small 模式，
// 每行 35 字符、18 行；实心字符=黑模块，浏览器里白底黑字即标准二维码）
const QR_SAMPLE = [
  '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '█ ▄▄▄▄▄ █▄▀ ▀ █▄█  █▄▀ ▄ ▄█ ▄▄▄▄▄ █',
  '█ █   █ █   █▀ ▀▄▀▀██▄█▄█▄█ █   █ █',
  '█ █▄▄▄█ █▄█▀ ▄ ██  █ ▀▄ ███ █▄▄▄█ █',
  '█▄▄▄▄▄▄▄█▄█ █ █▄█ ▀ █ █ ▀▄█▄▄▄▄▄▄▄█',
  '█ ▄▄▄▀▀▄▀ █ ▄ █ █▀▄▀▀▄ █   ▀▀▄  █ █',
  '█ ▄▀  ▄▄ █  ▄▄▀▄▀███████▄█ ▄ ▀▀█▄ █',
  '█▀█ ▀ █▄█▀▄▄▀ ▄ ▀▀▄▄▀██▄██▄█ ▄█▀███',
  '█ ▄ ▀ █▄██▀▄ █▄ ▀▀█ ▄█ ▄█▄▄▀▄▄▀ ▀▀█',
  '█ ▀▄▀▄▄▄█▄▄▀█▄ ▄▀█████▄█ ▀█ ▄  ▄█ █',
  '██▀▀█  ▄▀ █▄▀█▄▀▄▄ ▄█▄▄▀▀▀▀ ▄▄▄▄▄██',
  '█▀▄▄ ▀▄▄▄▀ ███▀▀▄ ▄  ▄▄ ▀  ▀▀█ █▄▀█',
  '██▀▀▀██▄   ▄▀▀ ▄██▄▀▀▄██  ███▄▀▄█ █',
  '█▄█▄▄▄▄▄█▀▀▄ █▄█▀▀ ▀  █▄█ ▄▄▄ ▀▀▀▄█',
  '█ ▄▄▄▄▄ ██▀▀█ █▀███▀ ▄ ▄▄ █▄█  ▀▀▀█',
  '█ █   █ █▀▄█▄▀▄▀▀█▀▄██▄█▄▄▄▄ ▄ ▄▀▄█',
  '█ █▄▄▄█ █  ▄▄ █▄  ▀ █▄▄ █▀▀ ▄▀▀▄▄▀█',
  '█▄▄▄▄▄▄▄█▄██▄█▄█▄██▄▄▄▄▄██▄▄█▄█▄███'
];
const QR_RAW = '\x1B[2J\x1B[H正在生成二维码...\n\x1B[2J\x1B[H扫码登录\n\n'
  + QR_SAMPLE.join('\n') + '\n\n\n请使用 Q 助理手机 App 扫描下方二维码。\n等待扫码中... 5min\n';

test('stripAnsi: 去掉清屏/定位控制序列，保留中文', () => {
  assert.strictEqual(stripAnsi('\x1B[2J\x1B[H扫码登录'), '扫码登录');
  assert.strictEqual(stripAnsi(null), '');
});

test('extractQrBlock: 从真实输出里取出 18 行二维码', () => {
  const block = extractQrBlock(QR_RAW);
  assert.strictEqual(block, QR_SAMPLE.join('\n'));
  assert.strictEqual(block.split('\n').length, 18);
});

test('extractQrBlock: 增量输出（先半截）也能取到完整块', () => {
  const lines = QR_RAW.split('\n');
  const half = lines.slice(0, 3 + 5).join('\n'); // 只有开头 5 行二维码
  assert.strictEqual(extractQrBlock(half), '');
  assert.strictEqual(extractQrBlock(QR_RAW), QR_SAMPLE.join('\n'));
});

test('extractQrBlock: 没有二维码 / 中文提示不误判', () => {
  assert.strictEqual(extractQrBlock('请使用 Q 助理手机 App 扫描下方二维码。'), '');
  assert.strictEqual(extractQrBlock(''), '');
  assert.strictEqual(extractQrBlock(null), '');
});

test('cliErrorMessage: 提取 qz 输出的 message（含转义）', () => {
  assert.strictEqual(cliErrorMessage('{"status":"error","message":"登录已失效，请重新登录。"}'), '登录已失效，请重新登录。');
  assert.strictEqual(cliErrorMessage('no json here'), '');
});

// ============ listContacts：过滤自己（qz 0.7.x 行为） ============
test('listContacts: 过滤掉自己（0.7.x 的 friend list 会把自己列进 links）', async () => {
  const cli = new QzCli({});
  cli.resolveCandidates = () => [{ bin: '/fake/qz', bundled: false }];
  cli._runOnce = async (found, args) => {
    const cmd = (args || []).join(' ');
    if (cmd.startsWith('auth status')) {
      return { status: 'success', code: 'AUTH_LOGIN_SUCCESS', data: { uid: 'me-uid' } };
    }
    if (cmd.startsWith('friend list')) {
      return {
        status: 'success',
        code: 'FRIENDS_LIST',
        data: [
          { uid: 'me-uid', nickname: '我自己', friend_name: '', link_type: 0 },
          { uid: 'other-uid', nickname: '别人', friend_name: '备注乙', link_type: 5 }
        ]
      };
    }
    return { status: 'error', code: 'CLI_EXIT', message: 'unexpected args: ' + cmd, data: null };
  };
  const list = await cli.listContacts();
  assert.deepStrictEqual(list.map((c) => c.uid), ['other-uid'], '自己必须被过滤掉');
  assert.strictEqual(list[0].linkType, 5, '在职同事关系保留');
  assert.strictEqual(list[0].remark, '备注乙', '备注字段保留');
});

test('listContacts: 拿不到自己 uid 时不过滤（保持旧行为，避免空列表）', async () => {
  const cli = new QzCli({});
  cli.resolveCandidates = () => [{ bin: '/fake/qz', bundled: false }];
  cli._runOnce = async (found, args) => {
    const cmd = (args || []).join(' ');
    if (cmd.startsWith('auth status')) return { status: 'error', code: 'AUTH_FAILED', data: { status: 'error', code: 'AUTH_FAILED' } };
    if (cmd.startsWith('friend list')) {
      return { status: 'success', code: 'FRIENDS_LIST', data: [{ uid: 'a', nickname: '甲' }] };
    }
    return { status: 'error', code: 'CLI_EXIT', message: 'x', data: null };
  };
  const list = await cli.listContacts();
  assert.deepStrictEqual(list.map((c) => c.uid), ['a']);
});

// ============ Windows 平台候选探测 / 错误码区分 / 诊断日志 ============
test('resolveCandidates: win32 平台捆绑版优先，且不把无扩展名的 qz（POSIX 脚本）当候选', () => {
  const appPath = makeFakeAppPath('console.log("{}")');
  const exeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzwin-'));
  const exe = path.join(exeDir, 'qz.exe');
  fs.writeFileSync(exe, 'placeholder');
  // npm 全局安装在 Windows 生成的 POSIX 脚本（无扩展名）：spawn 直调必然失败
  const bare = path.join(exeDir, 'qz');
  fs.writeFileSync(bare, '#!/bin/sh\nexit 0\n');
  const oldPath = process.env.PATH;
  process.env.PATH = exeDir + path.delimiter + (oldPath || '');
  try {
    const cli = new QzCli({ appPath, platform: 'win32' });
    const c = cli.resolveCandidates();
    assert.ok(c.length >= 2, '捆绑版 + qz.exe 至少两个候选');
    assert.strictEqual(c[0].bundled, true, 'Windows 上捆绑版必须排第一（ABI 与 Electron 一致）');
    assert.ok(c.some((x) => x.bin === exe), 'PATH 里的 qz.exe 作为兜底候选');
    assert.ok(!c.some((x) => x.bin === bare), '无扩展名的 qz 不得进入候选');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('run: 候选全部被标记坏时返回 CLI_UNAVAILABLE（与「没装」区分，避免误导文案）', async () => {
  const bad = makeBrokenBin('boom');
  const cli = new QzCli({ binPath: bad });
  cli.resolveCandidates = () => [{ bin: bad, bundled: false }];
  const r1 = await cli.run(['auth', 'status']);
  assert.strictEqual(r1.code, 'CLI_EXIT', '首次失败是真实的执行错误');
  assert.ok(cli._badBins.has(bad), '坏候选应被记录');
  const r2 = await cli.run(['auth', 'status']);
  assert.strictEqual(r2.code, 'CLI_UNAVAILABLE', '全部候选被标坏后必须报「启动失败」而不是「未找到」');
});

test('isAvailable: 完全没有候选时 reason=cli_not_found', async () => {
  const cli = new QzCli({});
  cli.resolveCandidates = () => [];
  const av = await cli.isAvailable();
  assert.strictEqual(av.ok, false);
  assert.strictEqual(av.reason, 'cli_not_found');
});

test('_log: 诊断信息落盘（Windows 安装版没有终端，只能靠文件回传）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzlog-'));
  const file = path.join(dir, 'qz-cli.log');
  const cli = new QzCli({ logFile: file });
  cli._log('测试诊断一行');
  const txt = fs.readFileSync(file, 'utf8');
  assert.ok(txt.includes('测试诊断一行'));
});

test('setLogFile: 设置即落盘启动行（文件必须立刻存在，否则用户按指示找不到）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzlog-'));
  const file = path.join(dir, 'qz-cli.log');
  const cli = new QzCli({});
  cli.resolveCandidates = () => [
    { bin: '/fake/qz', bundled: false },
    { bin: '/fake/app/node_modules/@qzhuli/qzhuli-cli/dist/cmd.js', bundled: true }
  ];
  cli.setLogFile(file);
  assert.ok(fs.existsSync(file), 'setLogFile 后文件必须立刻存在');
  const txt = fs.readFileSync(file, 'utf8');
  assert.ok(txt.includes('诊断日志启用'), '启动行要能看出候选清单');
  assert.ok(txt.includes('bundled'), '候选要标出捆绑版');
});

test('run: 成功路径也落日志（命令标签 + 候选 + 耗时）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzlog-'));
  const file = path.join(dir, 'qz-cli.log');
  const cli = new QzCli({ logFile: file });
  cli.resolveCandidates = () => [{ bin: '/fake/bundled/cmd.js', bundled: true }];
  cli._runOnce = async () => ({ status: 'success', code: 'OK', data: { links: [] } });
  const r = await cli.run(['friend', 'list']);
  assert.strictEqual(r.status, 'success');
  const txt = fs.readFileSync(file, 'utf8');
  assert.ok(/run friend list → ok via bundled \d+ms/.test(txt), '正常调用也要留痕: ' + txt);
});

test('run: 日志不落参数值（笔记正文/@昵称不进日志文件）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzlog-'));
  const file = path.join(dir, 'qz-cli.log');
  const cli = new QzCli({ logFile: file });
  cli.resolveCandidates = () => [{ bin: '/fake/qz', bundled: false }];
  cli._runOnce = async () => ({ status: 'success', code: 'OK', data: {} });
  await cli.run(['message', 'send', '--role', '1', '--text', '机密正文内容']);
  const txt = fs.readFileSync(file, 'utf8');
  assert.ok(!txt.includes('机密正文内容'), '参数值不得写进日志');
  assert.ok(txt.includes('run message send'), '命令标签要保留');
});

/** 造一个「延迟出二维码」的假 CLI：delayMs 后输出真实二维码样本 */
function makeSlowQrBin(delayMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qzslow-'));
  const qrFile = path.join(dir, 'qr.txt');
  fs.writeFileSync(qrFile, QR_SAMPLE.join('\n'));
  const bin = path.join(dir, 'qz');
  fs.writeFileSync(
    bin,
    '#!/usr/bin/env node\n' +
    'setTimeout(function(){process.stdout.write(require("fs").readFileSync(' + JSON.stringify(qrFile) + ', "utf8"))}, ' + delayMs + ')\n'
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('startQrLogin: 唯一候选超过阈值仍继续等待出码（不杀进程、不标记坏）', async () => {
  const bin = makeSlowQrBin(700);
  const cli = new QzCli({ binPath: bin, qrProbeMs: 250 });
  cli.resolveCandidates = () => [{ bin, bundled: false }];
  const events = [];
  cli.startQrLogin({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 1800));
  assert.ok(events.some((e) => e.phase === 'qr'), '唯一候选超时后应继续等到出码（Windows 冷启动慢）');
  assert.ok(!cli._badBins.has(bin), '探针超时不得把候选标坏（否则之后每次 @ 都显示「找不到 qz CLI」）');
});

test('startQrLogin: 多候选时慢候选超时换下一个，且不标记坏', async () => {
  const slow = makeSlowQrBin(3000);
  const fast = makeSlowQrBin(120);
  const cli = new QzCli({ binPath: slow, qrProbeMs: 250 });
  cli.resolveCandidates = () => [{ bin: slow, bundled: false }, { bin: fast, bundled: false }];
  const events = [];
  cli.startQrLogin({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(events.some((e) => e.phase === 'qr'), '应降级到第二个候选并出码');
  assert.ok(!cli._badBins.has(slow), '超时换候选不得把慢候选标坏');
});

test('startQrLogin: 阈值内出码时正常展示二维码（Windows 阈值已放宽）', async () => {
  const bin = makeSlowQrBin(700);
  const cli = new QzCli({ binPath: bin, qrProbeMs: 3000 });
  cli.resolveCandidates = () => [{ bin, bundled: false }];
  const events = [];
  cli.startQrLogin({ onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(events.some((e) => e.phase === 'qr'), '700ms 出码在 3s 阈值内应正常展示');
  assert.ok(!cli._badBins.has(bin));
});

// ============ 登录态缓存重置（qz CLI 扫码成功后无需重启应用） ============
test('resetAuthCache: 清掉 ownerUid / 默认助理缓存与误标的坏候选', () => {
  const cli = new QzCli({ appPath: makeFakeAppPath('console.log("{}")') });
  cli._ownerUidCache = 'u-old';
  cli._defaultAgent = { id: 'a1', title: '旧助理' };
  cli._badBins = new Set(['/fake/qz']);
  cli.resetAuthCache();
  assert.strictEqual(cli._ownerUidCache, null, '旧账号 uid 必须清掉，否则联系人按旧 uid 过滤');
  assert.strictEqual(cli._defaultAgent, null);
  assert.strictEqual(cli._badBins.size, 0, '登录成功说明候选可用，误标的坏候选要恢复');
});

test('resetAuthCache: 未创建坏候选集合时也不抛错', () => {
  const cli = new QzCli({ appPath: makeFakeAppPath('console.log("{}")') });
  assert.doesNotThrow(() => cli.resetAuthCache());
  assert.strictEqual(cli._ownerUidCache, null);
});
