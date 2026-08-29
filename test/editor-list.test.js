/**
 * editor-list.test.js —— 输入框列表逻辑单元测试（listMarker / enterAt / beginListAt）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { listMarker, enterAt, beginListAt } = require('../renderer/editor.js');

// ============ listMarker：行首标记解析 ============
test('listMarker: 无序列表 - 续同标记', () => {
  assert.deepStrictEqual(listMarker('- item'), { marker: '- ', nextMarker: '- ', content: 'item' });
});

test('listMarker: 无序列表 * 和 +', () => {
  assert.deepStrictEqual(listMarker('* item').nextMarker, '* ');
  assert.deepStrictEqual(listMarker('+ item').nextMarker, '+ ');
});

test('listMarker: 有序列表 1. 续 2.', () => {
  assert.deepStrictEqual(listMarker('1. item'), { marker: '1. ', nextMarker: '2. ', content: 'item' });
});

test('listMarker: 有序列表 10) 续 11)', () => {
  const r = listMarker('10) item');
  assert.strictEqual(r.marker, '10) ');
  assert.strictEqual(r.nextMarker, '11) ');
  assert.strictEqual(r.content, 'item');
});

test('listMarker: 保留前导空格', () => {
  assert.strictEqual(listMarker('  - item').nextMarker, '  - ');
  assert.strictEqual(listMarker('  3) item').nextMarker, '  4) ');
});

test('listMarker: 普通文本返回 null', () => {
  assert.strictEqual(listMarker('hello world'), null);
  assert.strictEqual(listMarker(''), null);
});

test('listMarker: 无空格的符号/数字不是列表标记', () => {
  assert.strictEqual(listMarker('-'), null);      // 无后续空格
  assert.strictEqual(listMarker('1.'), null);      // 无后续空格
  assert.strictEqual(listMarker('1.5 item'), null); // 数字后不是 . 分隔
});

// ============ enterAt：回车处理 ============
test('enterAt: 普通文本回车换行', () => {
  assert.deepStrictEqual(enterAt('hello', 5), { text: 'hello\n', caret: 6 });
});

test('enterAt: 光标在行中普通文本', () => {
  assert.deepStrictEqual(enterAt('hello world', 5), { text: 'hello\n world', caret: 6 });
});

test('enterAt: 无序列表回车续 -', () => {
  assert.deepStrictEqual(enterAt('- a', 3), { text: '- a\n- ', caret: 6 });
});

test('enterAt: 有序列表回车续递增 1.→2.', () => {
  assert.deepStrictEqual(enterAt('1. a', 4), { text: '1. a\n2. ', caret: 8 });
});

test('enterAt: 有序列表多行续第 3 项', () => {
  assert.deepStrictEqual(enterAt('1. a\n2. b', 9), { text: '1. a\n2. b\n3. ', caret: 13 });
});

test('enterAt: 空无序列表项回车退出列表', () => {
  // "- " 整行仅标记：删除标记，该行变空行
  assert.deepStrictEqual(enterAt('- a\n- ', 6), { text: '- a\n', caret: 4 });
});

test('enterAt: 空有序列表项回车退出列表', () => {
  // 文档开头唯一一行是空列表项：回车后变空
  assert.deepStrictEqual(enterAt('1. ', 3), { text: '', caret: 0 });
});

test('enterAt: 列表行中间回车仍续列表（分割）', () => {
  // 光标在 "1. abc|d"（off=6）：续 2. 并分割
  assert.deepStrictEqual(enterAt('1. abcd', 6), { text: '1. abc\n2. d', caret: 10 });
});

// ============ beginListAt：工具栏按钮插入 ============
test('beginListAt: 空输入插入标记', () => {
  assert.deepStrictEqual(beginListAt('', 0, '- '), { text: '- ', caret: 2 });
});

test('beginListAt: 行首无内容直接插标记', () => {
  assert.deepStrictEqual(beginListAt('hello\n', 6, '1. '), { text: 'hello\n1. ', caret: 9 });
});

test('beginListAt: 行尾有内容则另起一行', () => {
  assert.deepStrictEqual(beginListAt('hello', 5, '- '), { text: 'hello\n- ', caret: 8 });
});

test('beginListAt: 光标在行中则分割另起', () => {
  // "ab| cd"：另起一行插入标记，光标后的内容保留原空格
  assert.deepStrictEqual(beginListAt('ab cd', 2, '- '), { text: 'ab\n-  cd', caret: 5 });
});
