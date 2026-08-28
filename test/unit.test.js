/**
 * unit.test.js —— 核心模块单元测试（node:test，零依赖）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { MemoStore } = require('../renderer/store');
const Tags = require('../renderer/tags');
const Md = require('../renderer/md');

// ============ tags.js ============
test('extractTags: 提取英文标签', () => {
  assert.deepStrictEqual(Tags.extractTags('今天写了 #product 的 review'), ['product']);
});

test('extractTags: 提取中文标签', () => {
  assert.deepStrictEqual(Tags.extractTags('#灵感 随手记'), ['灵感']);
});

test('extractTags: 多个标签去重保序', () => {
  assert.deepStrictEqual(
    Tags.extractTags('#a 和 #b 还有 #a'),
    ['a', 'b']
  );
});

test('extractTags: 数字开头不提取', () => {
  assert.deepStrictEqual(Tags.extractTags('版本 #123 不是标签'), []);
});

test('extractTags: 连字符标签', () => {
  assert.deepStrictEqual(Tags.extractTags('使用 #tag-name 记录'), ['tag-name']);
});

test('extractTags: 标点中断标签', () => {
  assert.deepStrictEqual(Tags.extractTags('#标签，后面是正文'), ['标签']);
});

test('extractTags: 无标签返回空数组', () => {
  assert.deepStrictEqual(Tags.extractTags('没有任何标签的文本'), []);
  assert.deepStrictEqual(Tags.extractTags(''), []);
  assert.deepStrictEqual(Tags.extractTags(null), []);
});

test('countByMemos: 统计标签数量并排序', () => {
  const memos = [
    { tags: ['a', 'b'] },
    { tags: ['a'] },
    { tags: ['c', 'b', 'b'] },
    { tags: [] },
    {}
  ];
  const res = Tags.countByMemos(memos);
  assert.deepStrictEqual(res, [
    { name: 'b', count: 3 },
    { name: 'a', count: 2 },
    { name: 'c', count: 1 }
  ]);
});

// ============ md.js ============
test('md: 加粗', () => {
  assert.ok(Md.render('这是 **重点** 内容').includes('<strong>重点</strong>'));
});

test('md: 斜体', () => {
  assert.ok(Md.render('这是 *斜体* 内容').includes('<em>斜体</em>'));
});

test('md: 删除线', () => {
  assert.ok(Md.render('这是 ~~删除~~ 内容').includes('<del>删除</del>'));
});

test('md: 行内代码且内部不解析格式', () => {
  const html = Md.render('运行 `**x**` 命令');
  assert.ok(html.includes('<code>**x**</code>'));
  assert.ok(!html.includes('<strong>'));
});

test('md: 链接', () => {
  const html = Md.render('见 [ideaNote](https://ideanote.com)');
  assert.ok(html.includes('<a href="https://ideanote.com" target="_blank" rel="noreferrer">ideaNote</a>'));
});

test('md: 危险协议链接不被渲染成可点击链接', () => {
  const html = Md.render('[bad](javascript:alert(1))');
  // 不产生 <a> 标签，原文以纯文本保留（安全）
  assert.ok(!html.includes('<a'));
  assert.ok(html.includes('javascript:alert(1)'));
});

test('md: XSS 注入被转义', () => {
  const html = Md.render('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('md: 引用块', () => {
  const html = Md.render('> 引用一句话');
  assert.ok(html.includes('<blockquote>引用一句话</blockquote>'));
});

test('md: 围栏代码块', () => {
  const html = Md.render('```js\nconst a = 1 < 2;\n```');
  assert.ok(html.includes('<pre><code>'));
  assert.ok(html.includes('const a = 1 &lt; 2;'));
});

test('md: 多段落', () => {
  const html = Md.render('第一段\n\n第二段');
  // 空行渲染为段落分隔（<p><br></p>），两段文本都保留
  assert.ok(html.includes('<p>第一段</p>'));
  assert.ok(html.includes('<p>第二段</p>'));
});

test('md: 空输入', () => {
  // 空输入渲染为单个空段落（空行的 DOM 载体）
  assert.strictEqual(Md.render(''), '<p><br></p>');
  assert.strictEqual(Md.render(null), '<p><br></p>');
});

// ============ store.js ============
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-note-test-'));
  return new MemoStore(path.join(dir, 'data.json'));
}

test('store: 创建与列表倒序', async () => {
  const s = tmpStore();
  await s.load();
  const a = await s.create('第一条');
  await new Promise((r) => setTimeout(r, 5));
  const b = await s.create('第二条');
  const list = s.list();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, b.id);
  assert.strictEqual(list[1].id, a.id);
  assert.deepStrictEqual(a.tags, []);
});

test('store: 创建时自动提取标签', async () => {
  const s = tmpStore();
  await s.load();
  const m = await s.create('记录 #重要 的 #想法');
  assert.deepStrictEqual(m.tags, ['重要', '想法']);
});

test('store: 更新内容与标签', async () => {
  const s = tmpStore();
  await s.load();
  const m = await s.create('旧的 #a');
  const updated = await s.update(m.id, '新的 #b');
  assert.strictEqual(updated.content, '新的 #b');
  assert.deepStrictEqual(updated.tags, ['b']);
  assert.ok(updated.updatedAt >= m.updatedAt);
});

test('store: 更新不存在的 id 返回 null', async () => {
  const s = tmpStore();
  await s.load();
  const r = await s.update('no-such-id', 'x');
  assert.strictEqual(r, null);
});

test('store: 删除', async () => {
  const s = tmpStore();
  await s.load();
  const m = await s.create('待删除');
  assert.strictEqual(await s.remove(m.id), true);
  assert.strictEqual(await s.remove(m.id), false);
  assert.strictEqual(s.list().length, 0);
});

test('store: 空内容拒绝', async () => {
  const s = tmpStore();
  await s.load();
  await assert.rejects(() => s.create('   '), /不能为空/);
  await assert.rejects(() => s.update('x', ''), /不能为空/);
});

test('store: 持久化后重新加载数据仍在', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-note-test-'));
  const file = path.join(dir, 'data.json');
  const s1 = new MemoStore(file);
  await s1.load();
  await s1.create('持久化测试 #keep');
  const s2 = new MemoStore(file);
  await s2.load();
  assert.strictEqual(s2.list().length, 1);
  assert.strictEqual(s2.list()[0].content, '持久化测试 #keep');
  assert.deepStrictEqual(s2.list()[0].tags, ['keep']);
});

test('store: 损坏文件 -> 备份 + 空数据，且原始文件保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-note-test-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{ this is not valid json !!!');
  const s = new MemoStore(file);
  await s.load();
  assert.deepStrictEqual(s.list(), []);
  // 损坏文件被备份
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.strictEqual(backups.length, 1);
});

test('store: 并发写入串行化，最终数据完整', async () => {
  const s = tmpStore();
  await s.load();
  await Promise.all([1, 2, 3, 4, 5].map((n) => s.create('并发' + n)));
  assert.strictEqual(s.list().length, 5);
  // 磁盘文件可正常解析且条数正确
  const raw = JSON.parse(fs.readFileSync(s.filePath, 'utf8'));
  assert.strictEqual(raw.length, 5);
  assert.ok(!fs.existsSync(s.filePath + '.tmp'), '不应残留 tmp 文件');
});
