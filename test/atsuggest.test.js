/**
 * atsuggest.test.js —— @联系人联想纯函数单元测试（detectAtQuery / filterContacts）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectAtQuery, filterContacts, linkTypeLabel } = require('../renderer/atsuggest');

// ============ detectAtQuery ============
test('detectAtQuery: 行首 @ 后中文昵称', () => {
  assert.deepStrictEqual(detectAtQuery('@施展 你好', 3), { query: '施展', start: 0 });
});

test('detectAtQuery: 空白后的 @', () => {
  assert.deepStrictEqual(detectAtQuery('今天 @Pitt 确认', 8), { query: 'Pitt', start: 3 });
});

test('detectAtQuery: 刚输入 @ 显示全部', () => {
  assert.deepStrictEqual(detectAtQuery('你好 @', 4), { query: '', start: 3 });
});

test('detectAtQuery: 邮箱 a@b 不误判', () => {
  assert.strictEqual(detectAtQuery('a@b.com', 5), null);
});

test('detectAtQuery: 行中间连续字符前的 @ 不误判', () => {
  // @ 前紧贴中文（"讨论@Pitt"）不算提及
  assert.strictEqual(detectAtQuery('讨论@Pitt', 8), null);
});

test('detectAtQuery: 标签后空格 @ 仍可触发（@ 独立成词）', () => {
  assert.deepStrictEqual(detectAtQuery('#标签 @', 5), { query: '', start: 4 });
});

test('detectAtQuery: 光标在 @ 输入态之外不触发', () => {
  assert.strictEqual(detectAtQuery('@Pitt 结束', 7), null);
  assert.strictEqual(detectAtQuery('普通文本', 2), null);
  assert.strictEqual(detectAtQuery('', 0), null);
  assert.strictEqual(detectAtQuery(null, 0), null);
});

test('detectAtQuery: 中文标点中断 @ 输入态', () => {
  // "今天 @施展。" 光标停在句号后：不再处于输入态
  assert.strictEqual(detectAtQuery('今天 @施展。', 7), null);
});

// ============ filterContacts ============
const CONTACTS = [
  { uid: 'u1', nickname: '施展', remark: '老施' },
  { uid: 'u2', nickname: 'Pitt', remark: '' },
  { uid: 'u3', nickname: '李超然', remark: '超然' }
];

test('filterContacts: 空 query 返回全部（保持顺序）', () => {
  assert.strictEqual(filterContacts(CONTACTS, '').length, 3);
});

test('filterContacts: 按昵称子串匹配', () => {
  const r = filterContacts(CONTACTS, '施');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].uid, 'u1');
});

test('filterContacts: 按备注匹配', () => {
  const r = filterContacts(CONTACTS, '老施');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].uid, 'u1');
});

test('filterContacts: 忽略大小写', () => {
  const r = filterContacts(CONTACTS, 'pitt');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].uid, 'u2');
});

test('filterContacts: 无匹配返回空数组', () => {
  assert.deepStrictEqual(filterContacts(CONTACTS, '不存在'), []);
});

test('filterContacts: 非法输入', () => {
  assert.deepStrictEqual(filterContacts(null, 'a'), []);
  assert.deepStrictEqual(filterContacts([], 'a'), []);
});

// ============ linkTypeLabel ============
test('linkTypeLabel: 关系映射', () => {
  assert.strictEqual(linkTypeLabel(0), '陌生人');
  assert.strictEqual(linkTypeLabel(1), '家人');
  assert.strictEqual(linkTypeLabel(2), '朋友');
  assert.strictEqual(linkTypeLabel(3), '前同事');
  assert.strictEqual(linkTypeLabel(4), '同学');
  assert.strictEqual(linkTypeLabel(5), '同事');
});

test('linkTypeLabel: 未知类型返回空', () => {
  assert.strictEqual(linkTypeLabel(99), '');
  assert.strictEqual(linkTypeLabel(null), '');
  assert.strictEqual(linkTypeLabel(undefined), '');
});
