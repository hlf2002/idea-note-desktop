/**
 * qz.unit.test.js —— qz 模块单元测试（content / sign / sync，mock API）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { extractServerTags, textToContentJson, contentJsonToText } = require('../qz/content');
const { createSign } = require('../qz/sign');
const { QzApi } = require('../qz/api');
const { IdeaSync, mapServerMemo } = require('../qz/sync');

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

// ============ sign.js ============
test('createSign: 文档算法固定向量', () => {
  // params {uid,r}, token=tk123 -> "r=abc&uid=10001&token=tk123" 的 md5
  const key = createSign({ uid: '10001', r: 'abc' }, 'tk123');
  assert.strictEqual(key, 'd720acc02e7092bf9b16c59617ef2c22');
});

test('createSign: 跳过 key/token/base 与空值', () => {
  const a = createSign({ uid: '1', a: 'x', key: 'k', token: 't', base: 'b', empty: '', nil: null }, 'realtoken');
  const b = createSign({ uid: '1', a: 'x' }, 'realtoken');
  assert.strictEqual(a, b);
});

test('createSign: 键名排序', () => {
  // uid 与 r 排序后 r 在前
  const k1 = createSign({ uid: 'u', r: 'r' }, 'tok');
  const k2 = createSign({ r: 'r', uid: 'u' }, 'tok');
  assert.strictEqual(k1, k2);
});

// ============ api.js（mock fetch） ============
function mockFetch(handler) {
  const api = new QzApi({ baseUrl: 'https://mock.qzhuli.com', fetchImpl: handler });
  return api;
}

test('api: qrLoginCreate 请求路径与渠道', async () => {
  let captured = null;
  const api = mockFetch(async (url, init) => {
    captured = { url, init };
    return { json: async () => ({ code: 200, msg: 'ok', data: { scene_id: 'sc1', expires_in: 300 } }) };
  });
  const r = await api.qrLoginCreate(3);
  assert.strictEqual(r.scene_id, 'sc1');
  assert.ok(captured.url.endsWith('/user/qr_login_create/3'));
  assert.strictEqual(captured.init.method, 'POST');
});

test('api: qrLoginStatus 提交 scene_id', async () => {
  let captured = null;
  const api = mockFetch(async (url, init) => {
    captured = init;
    return { json: async () => ({ code: 200, msg: 'ok', data: { status: 'pending' } }) };
  });
  await api.qrLoginStatus('scene-abc');
  assert.ok(captured.body.includes('scene_id=scene-abc'));
});

// ---------- 灵感笔记 API（需先经 /h5/jump 换取 Vue token） ----------
const VUE_LOCATION = 'https://www.qzhuli.cn/client_h5/#/app_auth/idea_note?uid=u1&token=vue_tok_1&expire=86400&tk=vue_tk_1';

/** 构造能同时处理 /h5/jump（302 带 location）与灵感笔记接口的 mock；所有请求记录在 api.__calls */
function mockIdeaFetch(ideaHandler) {
  const calls = [];
  const api = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/h5/jump/')) {
        return { headers: { get: (k) => (k === 'location' ? VUE_LOCATION : null) }, status: 302 };
      }
      return ideaHandler(url, init);
    }
  });
  api.__calls = calls;
  return api;
}

test('api: getIdeaList 先经 jump 换 Vue token 再带 Vue token 鉴权', async () => {
  const api = mockIdeaFetch(async (url, init) => {
    return { json: async () => ({ code: 200, msg: 'ok', data: { list: [], has_more: false } }) };
  });
  api.setAuth({ uid: 'u1', token: 'tok1', tk: 'p_session_x' });

  await api.getIdeaList({ page: 2, pageSize: 20, keyword: '产品' });

  const calls = api.__calls;
  // jump 请求：携带 md5(token+qzhuli_v1) 与扩展端 tk
  const jump = calls.find((c) => c.url.includes('/h5/jump/idea_note'));
  assert.ok(jump, '应先调用 /h5/jump 换取 Vue token');
  assert.ok(jump.url.includes('uid=u1'));
  assert.ok(jump.url.includes('tk=p_session_x'));
  assert.ok(jump.url.includes('token=' + require('crypto').createHash('md5').update('tok1qzhuli_v1').digest('hex')));

  // 灵感笔记请求：Header 用 Vue token
  const idea = calls.find((c) => c.url.includes('/h5/idea_note/get_list'));
  assert.ok(idea, '应调用灵感笔记列表');
  assert.strictEqual(idea.init.headers.token, 'vue_tok_1');
  assert.strictEqual(idea.init.headers.tk, 'vue_tk_1');
  assert.strictEqual(idea.init.headers.uid, 'u1');
  assert.ok(idea.url.includes('page=2'));
  assert.ok(idea.url.includes('page_size=20'));
  assert.ok(idea.url.includes('keyword=' + encodeURIComponent('产品')));
});

test('api: Vue token 24h 内缓存，只 jump 一次', async () => {
  const api = mockIdeaFetch(async (url, init) => {
    return { json: async () => ({ code: 200, msg: 'ok', data: { list: [], has_more: false } }) };
  });
  api.setAuth({ uid: 'u1', token: 'tok1', tk: 'p_x' });
  await api.getIdeaList({});
  await api.getIdeaList({});
  const jumpCount = api.__calls.filter((c) => c.url.includes('/h5/jump/')).length;
  assert.strictEqual(jumpCount, 1, '应只 jump 一次（缓存生效）');
});

test('api: saveIdea JSON body（带 Vue token）', async () => {
  let captured = null;
  const api = mockIdeaFetch(async (url, init) => {
    captured = init;
    return { json: async () => ({ code: 200, msg: 'ok', data: { id: 1 } }) };
  });
  api.setAuth({ uid: 'u1', token: 't1', tk: 'p_x' });
  await api.saveIdea({ id: 99, content_json: { type: 'doc', content: [] }, plain_text: 'hi', tags: ['a'] });
  const body = JSON.parse(captured.body);
  assert.strictEqual(body.id, 99);
  assert.strictEqual(body.plain_text, 'hi');
  assert.deepStrictEqual(body.tags, ['a']);
  assert.strictEqual(captured.headers['Content-Type'], 'application/json');
  assert.strictEqual(captured.headers.token, 'vue_tok_1');
});

test('api: 业务错误码抛 QzApiError', async () => {
  const api = mockIdeaFetch(async () => ({
    json: async () => ({ code: 400, msg: 'tk参数无效', data: null })
  }));
  api.setAuth({ uid: 'u1', token: 't1', tk: 'p_x' });
  await assert.rejects(() => api.getIdeaList({}), (err) => {
    assert.strictEqual(err.name, 'QzApiError');
    assert.strictEqual(err.code, 400);
    assert.ok(err.message.includes('tk参数无效'));
    return true;
  });
});

test('api: 未登录调用灵感笔记直接抛 401，不发请求', async () => {
  let requested = false;
  const api = mockIdeaFetch(async () => {
    requested = true;
    return { json: async () => ({ code: 200, msg: 'ok', data: { list: [], has_more: false } }) };
  });
  await assert.rejects(() => api.getIdeaList({}), (err) => {
    assert.strictEqual(err.code, 401);
    return true;
  });
  assert.strictEqual(requested, false, '未登录不应发任何请求');
});

// ============ sync.js（mock api） ============
function mockSync(api) {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qz-cache-')), 'cache.json');
  return new IdeaSync({ api, cacheFile });
}

test('sync: pullAll 分页拉取合并并写缓存', async () => {
  const calls = [];
  const api = {
    getIdeaList: async ({ page, pageSize }) => {
      calls.push(page);
      if (page === 1) {
        return { list: [{ id: 2, plain_text: 'b', tags: [], create_time: 200, update_time: 200, image_url: '' }], has_more: true };
      }
      return { list: [{ id: 1, plain_text: 'a', tags: ['x'], create_time: 100, update_time: 150, image_url: 'img' }], has_more: false };
    }
  };
  const s = mockSync(api);
  const memos = await s.pullAll();
  assert.strictEqual(memos.length, 2);
  assert.strictEqual(memos[0].id, 2); // 新的在前
  assert.strictEqual(memos[1].id, 1);
  assert.deepStrictEqual(calls, [1, 2]);
  // 缓存已写入
  const cached = s.loadCache();
  assert.strictEqual(cached.length, 2);
  assert.strictEqual(cached[1].tags[0], 'x');
  assert.strictEqual(cached[1].createdAt, 100000); // 秒 -> 毫秒
});

test('sync: createFromText 生成正确正文并 upsert 缓存', async () => {
  let saved = null;
  const api = {
    saveIdea: async (payload) => {
      saved = payload;
      return { id: 7, plain_text: payload.plain_text, tags: payload.tags, create_time: 300, update_time: 300, image_url: '' };
    }
  };
  const s = mockSync(api);
  const memo = await s.createFromText('记一条 #灵感');
  assert.strictEqual(memo.id, 7);
  assert.strictEqual(saved.plain_text, '记一条 #灵感');
  assert.deepStrictEqual(saved.tags, ['灵感']);
  assert.strictEqual(saved.content_json.type, 'doc');
  // 标签带 ideaTag mark
  const p1 = saved.content_json.content[0];
  assert.ok(p1.content.some((n) => n.marks && n.marks[0].type === 'ideaTag'));
  // 缓存 upsert
  assert.strictEqual(s.loadCache().length, 1);
});

test('sync: update 与 remove 维护缓存', async () => {
  let nextId = 1;
  const api = {
    // 模拟真实服务端：新建时分配 id，编辑时回显传入 id
    saveIdea: async (payload) => ({
      id: payload.id || nextId++,
      plain_text: payload.plain_text,
      tags: payload.tags,
      create_time: 1,
      update_time: 2,
      image_url: ''
    }),
    deleteIdea: async (id) => null
  };
  const s = mockSync(api);
  await s.createFromText('第一版');
  await s.update(1, '第二版 #改');
  assert.strictEqual(s.loadCache().length, 1); // 更新而非新增
  assert.strictEqual(s.loadCache()[0].content, '第二版 #改');
  await s.remove(1);
  assert.strictEqual(s.loadCache().length, 0);
});

test('sync: loadCache 损坏时返回空且备份', () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qz-cache-')), 'cache.json');
  fs.writeFileSync(cacheFile, '{ broken');
  const s = new IdeaSync({ api: {}, cacheFile });
  assert.deepStrictEqual(s.loadCache(), []);
  assert.ok(fs.readdirSync(path.dirname(cacheFile)).some((f) => f.includes('.corrupt-')));
});

test('mapServerMemo: 字段映射', () => {
  const m = mapServerMemo({
    id: 5, plain_text: 'hi', tags: ['a'], image_url: 'u', create_time: 1000, update_time: 2000
  });
  assert.strictEqual(m.id, 5);
  assert.strictEqual(m.createdAt, 1000000);
  assert.strictEqual(m.updatedAt, 2000000);
});

// ---------- 令牌自愈 / 保鲜（api.js 新能力） ----------
/** 换取失败：服务端直接跳登录页 */
const LOGIN_LOCATION = 'https://www.qzhuli.cn/client_h5/?_h5=1788531617#/login';

test('api: 业务接口 401 -> 强制重换 Vue token 并重试一次', async () => {
  let ideaCalls = 0;
  let jumpCount = 0;
  const api = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url) => {
      if (url.includes('/h5/jump/')) {
        jumpCount += 1;
        return { headers: { get: (k) => (k === 'location' ? VUE_LOCATION : null) }, status: 302 };
      }
      ideaCalls += 1;
      if (ideaCalls === 1) {
        return { json: async () => ({ code: 401, msg: 'token 失效', data: null }) };
      }
      return { json: async () => ({ code: 200, msg: 'ok', data: { list: [], has_more: false } }) };
    }
  });
  api.setAuth({ uid: 'u1', token: 'tok1', tk: 'p_x' });
  const r = await api.getIdeaList({});
  assert.strictEqual(ideaCalls, 2, '第一次 401 后应自动重试');
  assert.strictEqual(jumpCount, 2, '重试前应重新换取 Vue token');
  assert.deepStrictEqual(r, { list: [], has_more: false });
});

test('api: 业务接口连续 401 -> 重试一次后仍抛 401', async () => {
  let ideaCalls = 0;
  const api = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url) => {
      if (url.includes('/h5/jump/')) {
        return { headers: { get: (k) => (k === 'location' ? VUE_LOCATION : null) }, status: 302 };
      }
      ideaCalls += 1;
      return { json: async () => ({ code: 401, msg: 'token 失效', data: null }) };
    }
  });
  api.setAuth({ uid: 'u1', token: 'tok1', tk: 'p_x' });
  await assert.rejects(() => api.getIdeaList({}), (err) => {
    assert.strictEqual(err.code, 401);
    return true;
  });
  assert.strictEqual(ideaCalls, 2, '最多重试一次，不应无限重试');
});

test('api: 换取 Vue token 失败（跳登录页）-> 抛 401 + authExpired，且不重试', async () => {
  let jumpCount = 0;
  const api = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url) => {
      if (url.includes('/h5/jump/')) {
        jumpCount += 1;
        return { headers: { get: (k) => (k === 'location' ? LOGIN_LOCATION : null) }, status: 302 };
      }
      throw new Error('不应调用业务接口');
    }
  });
  api.setAuth({ uid: 'u1', token: 'dead', tk: 'p_x' });
  await assert.rejects(() => api.getIdeaList({}), (err) => {
    assert.strictEqual(err.code, 401);
    assert.strictEqual(err.authExpired, true);
    return true;
  });
  assert.strictEqual(jumpCount, 1, '凭证已判死，不应重复换取');
});

test('api: ensureH5Fresh 寿命<70% 不重换，>=70% 强制重换', async () => {
  let jumpCount = 0;
  const api = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url) => {
      if (url.includes('/h5/jump/')) {
        jumpCount += 1;
        return { headers: { get: (k) => (k === 'location' ? VUE_LOCATION : null) }, status: 302 };
      }
      return { json: async () => ({ code: 200, msg: 'ok', data: {} }) };
    }
  });
  api.setAuth({ uid: 'u1', token: 't', tk: 'p' });
  await api.getH5Access();
  assert.strictEqual(jumpCount, 1);
  // 把剩余寿命压到 10%：应强制重换
  const ttl = api._h5.ttlMs;
  api._h5.expiresAt = Date.now() + ttl * 0.1;
  await api.ensureH5Fresh();
  assert.strictEqual(jumpCount, 2, '剩余寿命<30% 应强制重换');
  // 刚换完，寿命充足：不应重换
  await api.ensureH5Fresh();
  assert.strictEqual(jumpCount, 2, '寿命充足不应重换');
});

test('api: invalidateH5 丢弃缓存后强制重换', async () => {
  let jumpCount = 0;
  const api = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url) => {
      if (url.includes('/h5/jump/')) {
        jumpCount += 1;
        return { headers: { get: (k) => (k === 'location' ? VUE_LOCATION : null) }, status: 302 };
      }
      return { json: async () => ({ code: 200, msg: 'ok', data: { list: [], has_more: false } }) };
    }
  });
  api.setAuth({ uid: 'u1', token: 't', tk: 'p' });
  await api.getH5Access();
  assert.ok(api._h5);
  api.invalidateH5();
  assert.strictEqual(api._h5, null);
  await api.getIdeaList({});
  assert.strictEqual(jumpCount, 2, '缓存失效后应重新换取');
});

test('api: probeAuth 区分有效 / 判死 / 未登录', async () => {
  const valid = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url) => ({ headers: { get: (k) => (k === 'location' ? VUE_LOCATION : null) }, status: 302 })
  });
  valid.setAuth({ uid: 'u1', token: 't', tk: 'p' });
  assert.deepStrictEqual(await valid.probeAuth(), { ok: true });

  const invalid = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async () => ({ headers: { get: () => LOGIN_LOCATION }, status: 302 })
  });
  invalid.setAuth({ uid: 'u1', token: 'dead', tk: 'p' });
  const r = await invalid.probeAuth();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'token_invalid');

  const noAuth = new QzApi({ baseUrl: 'https://mock.qzhuli.com' });
  const r2 = await noAuth.probeAuth();
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'no_auth');
});

test('api: startH5KeepAlive 周期保鲜，stop 后停止', async () => {
  let jumpCount = 0;
  // expire=1 秒：token 寿命短，保鲜阈值（70%）很快触发
  const SHORT_LOCATION = 'https://www.qzhuli.cn/client_h5/#/app_auth/idea_note?uid=u1&token=v1&expire=1&tk=t1';
  const api = new QzApi({
    baseUrl: 'https://mock.qzhuli.com',
    fetchImpl: async (url) => {
      if (url.includes('/h5/jump/')) {
        jumpCount += 1;
        return { headers: { get: (k) => (k === 'location' ? SHORT_LOCATION : null) }, status: 302 };
      }
      return { json: async () => ({ code: 200, msg: 'ok', data: {} }) };
    }
  });
  api.setAuth({ uid: 'u1', token: 't', tk: 'p' });
  await api.getH5Access();
  assert.strictEqual(jumpCount, 1);
  api.startH5KeepAlive(20); // 20ms 检查一次保鲜
  await new Promise((r) => setTimeout(r, 2100)); // 覆盖 2 个 1s 生命周期
  api.stopH5KeepAlive();
  const after = jumpCount;
  assert.ok(after >= 3, '保鲜应多次触发重换（实际 ' + after + ' 次）');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(jumpCount, after, 'stop 后不应再重换');
});
