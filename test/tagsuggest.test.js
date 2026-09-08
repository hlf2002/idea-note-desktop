/**
 * tagsuggest.test.js —— 标签联想纯函数单元测试（detectTagQuery / filterTags）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { detectTagQuery, filterTags } = require('../renderer/tagsuggest.js');

// ============ detectTagQuery：标签输入态检测 ============
test('detectTagQuery: 空文本 / offset<=0 返回 null', () => {
  assert.strictEqual(detectTagQuery('', 0), null);
  assert.strictEqual(detectTagQuery('abc', 0), null);
  assert.strictEqual(detectTagQuery(null, 1), null);
  assert.strictEqual(detectTagQuery('abc', -1), null);
  assert.strictEqual(detectTagQuery('abc', NaN), null);
});

test('detectTagQuery: 光标紧跟 # 且 # 前是空白 → query 为空串', () => {
  assert.deepStrictEqual(detectTagQuery('你好 #', 4), { query: '', start: 3 });
});

test('detectTagQuery: 行首 # 后无内容 → 空 query，start=0', () => {
  assert.deepStrictEqual(detectTagQuery('#', 1), { query: '', start: 0 });
});

test('detectTagQuery: # 后已输入中文 → 返回片段', () => {
  assert.deepStrictEqual(detectTagQuery('你好 #工', 5), { query: '工', start: 3 });
  assert.deepStrictEqual(detectTagQuery('#工作', 3), { query: '工作', start: 0 });
});

test('detectTagQuery: 前导空格 + #片段', () => {
  assert.deepStrictEqual(detectTagQuery(' #工', 3), { query: '工', start: 1 });
});

test('detectTagQuery: 标签字符含数字/连字符/下划线', () => {
  assert.deepStrictEqual(detectTagQuery('#标签-1', 5), { query: '标签-1', start: 0 });
  assert.deepStrictEqual(detectTagQuery('#a_b2', 5), { query: 'a_b2', start: 0 });
});

test('detectTagQuery: # 前紧贴标签字符不算标签输入（abc#de / 工作#）', () => {
  assert.strictEqual(detectTagQuery('abc#de', 6), null);
  assert.strictEqual(detectTagQuery('工作#', 3), null);
  assert.strictEqual(detectTagQuery('中文#x', 4), null);
});

test('detectTagQuery: 多个 # 取最近一个', () => {
  assert.deepStrictEqual(detectTagQuery('a#b #c', 6), { query: 'c', start: 4 });
  assert.deepStrictEqual(detectTagQuery('#a #b', 5), { query: 'b', start: 3 });
});

test('detectTagQuery: 标签片段中间有空白不算（#工 作，光标在作后）', () => {
  assert.strictEqual(detectTagQuery('#工 作', 4), null);
});

test('detectTagQuery: 标签首字符为数字不算（#1 不触发）', () => {
  assert.strictEqual(detectTagQuery('#1', 2), null);
  assert.strictEqual(detectTagQuery('#123', 4), null);
});

test('detectTagQuery: 英文标签', () => {
  assert.deepStrictEqual(detectTagQuery('todo #Work', 10), { query: 'Work', start: 5 });
});

test('detectTagQuery: 光标在非标签输入处不触发（普通文字 / 标点后）', () => {
  assert.strictEqual(detectTagQuery('hello world', 5), null);
  assert.strictEqual(detectTagQuery('a#b', 2), null); // 光标在 b 后，# 前是 a
});

// ============ filterTags：子串筛选 ============
test('filterTags: 非数组返回空数组', () => {
  assert.deepStrictEqual(filterTags(null, ''), []);
  assert.deepStrictEqual(filterTags('abc', ''), []);
  assert.deepStrictEqual(filterTags(undefined, 'x'), []);
});

test('filterTags: 空 query 返回全部（副本，保持顺序）', () => {
  const tags = ['工作', '灵感', '读书'];
  const r = filterTags(tags, '');
  assert.deepStrictEqual(r, ['工作', '灵感', '读书']);
  assert.notStrictEqual(r, tags); // 返回副本
  assert.deepStrictEqual(filterTags(tags, null), tags);
});

test('filterTags: 中文子串筛选', () => {
  assert.deepStrictEqual(filterTags(['工作', '工作计划', '灵感', '读书'], '工作'), ['工作', '工作计划']);
  assert.deepStrictEqual(filterTags(['工作', '灵感', '读书'], '感'), ['灵感']);
});

test('filterTags: 不区分大小写', () => {
  assert.deepStrictEqual(filterTags(['Work', 'Homework', 'workout'], 'work'), ['Work', 'Homework', 'workout']);
  assert.deepStrictEqual(filterTags(['Work'], 'WORK'), ['Work']);
});

test('filterTags: 无匹配返回空数组', () => {
  assert.deepStrictEqual(filterTags(['工作', '灵感'], '不存在的标签'), []);
});

test('filterTags: 混合字符（数字/连字符）', () => {
  assert.deepStrictEqual(filterTags(['标签-1', '标签-2', '其他'], '标签-'), ['标签-1', '标签-2']);
  assert.deepStrictEqual(filterTags(['a1', 'a2'], '1'), ['a1']);
});
