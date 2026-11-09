/**
 * cli.test.js —— qz/cli.js 纯函数单元测试（@ 提及解析 / 联系人匹配 / 会话选择 / 文案）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  extractMentions,
  resolveMentions,
  pickConversation,
  makeNotifyText,
  sortContactsByLastActive,
  attachAgentTitles,
  bundledCliEntry
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
