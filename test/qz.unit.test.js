/**
 * qz.unit.test.js —— qz 模块单元测试（content / sync，mock API）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { extractServerTags, textToContentJson, contentJsonToText } = require('../qz/content');
const { IdeaSync, mapServerMemo, mapTrashMemo } = require('../qz/sync');

// ============ content.js ============
test('extractServerTags: 基本提取', () => {
  assert.deepStrictEqual(extractServerTags('这是一个 #产品思考'), ['产品思考']);
});

test('extractServerTags: 标签遇空白结束', () => {
  assert.deepStrictEqual(extractServerTags('#foo bar #baz'), ['foo', 'baz']);
});

test('extractServerTags: 长度限制取前 10 字符', () => {
  const r = extractServerTags('#' + 'a'.repeat(15));
  assert.deepStrictEqual(r, ['a'.repeat(10)]);
});

test('extractServerTags: 去重保序', () => {
  assert.deepStrictEqual(extractServerTags('#x #y #x'), ['x', 'y']);
});

test('extractServerTags: 无标签', () => {
  assert.deepStrictEqual(extractServerTags('没有任何标签'), []);
  assert.deepStrictEqual(extractServerTags(''), []);
  assert.deepStrictEqual(extractServerTags(null), []);
});

test('textToContentJson: 段落与 ideaTag mark', () => {
  const json = textToContentJson('这是一个 #产品思考\n第二行');
  assert.strictEqual(json.type, 'doc');
  assert.strictEqual(json.content.length, 2);
  const p1 = json.content[0];
  assert.strictEqual(p1.type, 'paragraph');
  // 文本被切成 [普通文本, 标签]
  assert.deepStrictEqual(
    p1.content.map((n) => n.text),
    ['这是一个 ', '#产品思考']
  );
  assert.strictEqual(p1.content[1].marks[0].type, 'ideaTag');
  assert.strictEqual(p1.content[0].marks, undefined);
});

test('textToContentJson: 空行跳过，空文本给空段落', () => {
  assert.strictEqual(textToContentJson('a\n\nb').content.length, 2);
  const empty = textToContentJson('');
  assert.strictEqual(empty.content.length, 1);
  assert.strictEqual(empty.content[0].type, 'paragraph');
});

test('contentJsonToText: 还原纯文本（含列表）', () => {
  const json = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '第一段 #标签' }] },
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '条目一' }] }]
          }
        ]
      }
    ]
  };
  assert.strictEqual(contentJsonToText(json), '第一段 #标签\n1. 条目一');
});

test('textToContentJson <-> contentJsonToText 往返一致', () => {
  const text = '今天的 #灵感\n**加粗**内容 #技术';
  assert.strictEqual(contentJsonToText(textToContentJson(text)), text);
});


// ============ sync.js（mock api，开放平台接口） ============
function mockSync(api) {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qz-cache-')), 'cache.json');
  return new IdeaSync({ api, cacheFile });
}

test('sync: pullAll 分页拉取合并并写缓存', async () => {
  const calls = [];
  const api = {
    listNotes: async ({ page, pageSize }) => {
      calls.push({ page, pageSize });
      if (page === 1) {
        return { list: [{ id: 2, plain_text: 'b', tags: [], create_time: 200, update_time: 200, images: [] }], has_more: true };
      }
      return { list: [{ id: 1, plain_text: 'a', tags: ['x'], create_time: 100, update_time: 150, images: ['img_9'] }], has_more: false };
    }
  };
  const s = mockSync(api);
  const memos = await s.pullAll();
  assert.strictEqual(memos.length, 2);
  assert.strictEqual(memos[0].id, 2); // 新的在前
  assert.strictEqual(memos[1].id, 1);
  assert.deepStrictEqual(calls.map((c) => c.page), [1, 2]);
  assert.strictEqual(calls[0].pageSize, 20, '分页大小取默认 PAGE_SIZE');
  const cached = s.loadCache();
  assert.strictEqual(cached.length, 2);
  assert.deepStrictEqual(cached[1].imageIds, ['img_9']);
  assert.strictEqual(cached[1].createdAt, 100000); // 秒 -> 毫秒
});

test('sync: createFromText 只传 content_json，标签走 ideaTag mark', async () => {
  let sent = null;
  const api = {
    createNote: async (payload) => {
      sent = payload;
      return { id: 7, plain_text: '记一条 #灵感', tags: ['灵感'], create_time: 300, update_time: 300, images: [] };
    }
  };
  const s = mockSync(api);
  const memo = await s.createFromText('记一条 #灵感');
  assert.strictEqual(memo.id, 7);
  assert.strictEqual(sent.content_json.type, 'doc');
  assert.strictEqual(sent.plain_text, undefined, '开放平台不接受 plain_text，不能传');
  assert.strictEqual(sent.tags, undefined, '开放平台不接受 tags，不能传');
  const p1 = sent.content_json.content[0];
  assert.ok(p1.content.some((n) => n.marks && n.marks[0].type === 'ideaTag'));
  assert.strictEqual(s.loadCache().length, 1);
});

test('sync: update 带上缓存里的 imageIds（避免平台整组替换时清空图片）', async () => {
  let updated = null;
  const api = {
    createNote: async () => ({ id: 1, plain_text: '第一版', tags: [], create_time: 1, update_time: 2, images: ['img_a', 'img_b'] }),
    updateNote: async (payload) => {
      updated = payload;
      return { id: payload.id, plain_text: '第二版 #改', tags: ['改'], create_time: 1, update_time: 3, images: payload.images };
    }
  };
  const s = mockSync(api);
  await s.createFromText('第一版');
  await s.update(1, '第二版 #改');
  assert.deepStrictEqual(updated.images, ['img_a', 'img_b'], '未显式传图片时必须沿用原有 imageIds');
  assert.strictEqual(updated.id, 1);
  assert.strictEqual(s.loadCache().length, 1); // 更新而非新增
  assert.strictEqual(s.loadCache()[0].content, '第二版 #改');
});

test('sync: update 缓存缺失时拉详情拿最新图片', async () => {
  let detailCalled = 0;
  let updated = null;
  const api = {
    getNote: async (id) => { detailCalled += 1; return { id, images: ['img_live'] }; },
    updateNote: async (payload) => { updated = payload; return { id: payload.id, plain_text: 'x', tags: [], create_time: 1, update_time: 2, images: payload.images }; }
  };
  const s = mockSync(api);
  await s.update(99, 'x');
  assert.strictEqual(detailCalled, 1);
  assert.deepStrictEqual(updated.images, ['img_live']);
});

test('sync: update 显式传 imageIds 时优先使用', async () => {
  let updated = null;
  const api = {
    updateNote: async (payload) => { updated = payload; return { id: payload.id, plain_text: 'x', tags: [], create_time: 1, update_time: 2, images: payload.images }; }
  };
  const s = mockSync(api);
  await s.update(5, 'x', ['img_new']);
  assert.deepStrictEqual(updated.images, ['img_new']);
});

test('sync: remove 调 deleteNote 并清缓存', async () => {
  let deletedId = null;
  const api = {
    createNote: async () => ({ id: 1, plain_text: 'a', tags: [], create_time: 1, update_time: 1, images: [] }),
    deleteNote: async (id) => { deletedId = id; return []; }
  };
  const s = mockSync(api);
  await s.createFromText('a');
  await s.remove(1);
  assert.strictEqual(deletedId, 1);
  assert.strictEqual(s.loadCache().length, 0);
});

test('sync: pullTrash 平台无接口，返回 unsupported 空列表', async () => {
  const s = mockSync({});
  const res = await s.pullTrash();
  assert.deepStrictEqual(res.list, []);
  assert.strictEqual(res.unsupported, true);
});

test('sync: restore 平台无接口时抛明确错误', async () => {
  const s = mockSync({});
  await assert.rejects(() => s.restore(42), /暂未开放/);
});

test('sync: loadCache 损坏时返回空且备份', async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qz-cache-')), 'cache.json');
  fs.writeFileSync(cacheFile, '{ broken');
  const s = new IdeaSync({ api: {}, cacheFile });
  assert.deepStrictEqual(s.loadCache(), []);
  assert.ok(fs.readdirSync(path.dirname(cacheFile)).some((f) => f.includes('.corrupt-')));
});

test('mapServerMemo: 字段映射（images -> imageIds）', () => {
  const m = mapServerMemo({
    id: 5, plain_text: 'hi', tags: ['a'], images: ['img_1', '', null], create_time: 1000, update_time: 2000
  });
  assert.strictEqual(m.id, 5);
  assert.strictEqual(m.createdAt, 1000000);
  assert.strictEqual(m.updatedAt, 2000000);
  assert.deepStrictEqual(m.imageIds, ['img_1'], '过滤空值');
  assert.deepStrictEqual(m.images, [], '无图片 URL 时展示列表为空');
});
