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
  makeNotifyText
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

// ============ pickConversation ============
test('pickConversation: 优先单聊', () => {
  const convs = [
    { conversationId: 'g1', isGroup: 1 },
    { conversationId: 's1', isGroup: 0 }
  ];
  assert.strictEqual(pickConversation(convs).conversationId, 's1');
});

test('pickConversation: 只有群聊时用第一个', () => {
  const convs = [
    { conversationId: 'g1', isGroup: 1 },
    { conversationId: 'g2', isGroup: 1 }
  ];
  assert.strictEqual(pickConversation(convs).conversationId, 'g1');
});

test('pickConversation: 空数组返回 null', () => {
  assert.strictEqual(pickConversation([]), null);
  assert.strictEqual(pickConversation(null), null);
  assert.strictEqual(pickConversation(undefined), null);
});

// ============ makeNotifyText ============
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
