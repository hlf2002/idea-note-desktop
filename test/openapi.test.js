/**
 * openapi.test.js —— 开放平台客户端（QzOpenApi）单元测试
 * 覆盖：登录中转、token 续期与永久登录策略、业务代理请求、鉴权自愈
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { QzOpenApi } = require('../qz/openapi');

const RELAY = 'https://relay.test';
const PIN = 'pin123';

function res(obj, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => obj };
}

/** 记录请求的 mock fetch */
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function makeApi(handler, extra = {}) {
  const rec = recorder(handler);
  const api = new QzOpenApi({
    relayUrl: RELAY,
    appKey: 'qz_app',
    clientPin: PIN,
    fetchImpl: rec.fetchImpl,
    ...extra
  });
  return { api, calls: rec.calls };
}

const AUTH = {
  q_uid: 'q_1',
  nickname: '老板',
  avatar: 'https://a/b.png',
  access_token: 'ou_1',
  refresh_token: 'or_1',
  expires_at: Date.now() + 7200 * 1000,
  refresh_expires_at: Date.now() + 90 * 24 * 3600 * 1000
};

// ---------- 登录流程 ----------
test('startLogin 调中转服务 /oauth/start', async () => {
  const { api, calls } = makeApi(() => res({ code: 0, data: { state: 'st_1234567890123456', authorizeUrl: 'https://open/x' } }));
  const r = await api.startLogin();
  assert.strictEqual(r.state, 'st_1234567890123456');
  assert.strictEqual(r.authorizeUrl, 'https://open/x');
  assert.strictEqual(calls[0].url, RELAY + '/oauth/start');
  assert.strictEqual(calls[0].init.headers['x-ideanote-pin'], PIN);
});

test('startLogin: 中转服务报错时抛出明确错误', async () => {
  const { api } = makeApi(() => res({ code: 1, message: '服务端未配置' }, 503));
  await assert.rejects(() => api.startLogin(), /服务端未配置/);
});

test('pollLogin 透传状态', async () => {
  const { api } = makeApi(() => res({ code: 0, data: { status: 'pending' } }));
  assert.deepStrictEqual(await api.pollLogin('st_1'), { status: 'pending' });
});

test('acceptLoginResult 生成登录态并回调 onTokens（必须落盘）', async () => {
  const persisted = [];
  const { api } = makeApi(() => res({}), { onTokens: async (a) => persisted.push(a) });
  await api.acceptLoginResult({
    status: 'ok', q_uid: 'q_9', nickname: 'n', avatar: 'a',
    access_token: 'ou_new', refresh_token: 'or_new', expires_in: 7200, refresh_expires_in: 7776000
  });
  assert.strictEqual(api.isAuthed, true);
  assert.strictEqual(api.auth.access_token, 'ou_new');
  assert.ok(api.auth.expires_at > Date.now() + 7000 * 1000);
  assert.ok(api.auth.refresh_expires_at > Date.now() + 89 * 24 * 3600 * 1000);
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0].refresh_token, 'or_new');
});

test('acceptLoginResult: 非 ok 结果拒绝', async () => {
  const { api } = makeApi(() => res({}));
  await assert.rejects(() => api.acceptLoginResult({ status: 'error', error: 'access_denied' }), /授权结果无效/);
});

test('profile 不泄露 token', () => {
  const { api } = makeApi(() => res({}));
  api.setAuth(AUTH);
  const p = api.profile();
  assert.strictEqual(p.q_uid, 'q_1');
  assert.strictEqual(p.nickname, '老板');
  assert.strictEqual(p.access_token, undefined);
  assert.strictEqual(p.refresh_token, undefined);
});

// ---------- token 续期（永久登录核心） ----------
test('refresh 成功：轮换 token 并立即落盘', async () => {
  const persisted = [];
  const { api, calls } = makeApi(
    () => res({ code: 0, data: { access_token: 'ou_2', refresh_token: 'or_2', expires_in: 7200, refresh_expires_in: 7776000, q_uid: 'q_1' } }),
    { onTokens: async (a) => persisted.push(a) }
  );
  api.setAuth(AUTH);
  const a = await api.refresh();
  assert.strictEqual(a.access_token, 'ou_2');
  assert.strictEqual(a.refresh_token, 'or_2', 'refresh_token 必须使用轮换后的新值');
  assert.strictEqual(calls[0].url, RELAY + '/oauth/refresh');
  assert.strictEqual(calls[0].body.refresh_token, 'or_1');
  assert.strictEqual(persisted.length, 1, '轮换后必须落盘，否则重启后旧 refresh_token 已失效');
  assert.strictEqual(persisted[0].refresh_token, 'or_2');
});

test('refresh: 401 + invalid → authExpired（唯一允许登出的情形）', async () => {
  const { api } = makeApi(() => res({ code: 1, invalid: true, message: 'revoked' }, 401));
  api.setAuth(AUTH);
  await assert.rejects(() => api.refresh(), (err) => {
    assert.strictEqual(err.authExpired, true);
    assert.strictEqual(err.code, 401);
    return true;
  });
});

test('refresh: 502 瞬时故障 → 不标记 authExpired，保留登录态', async () => {
  const { api } = makeApi(() => res({ code: 1, invalid: false, message: 'upstream' }, 502));
  api.setAuth(AUTH);
  await assert.rejects(() => api.refresh(), (err) => {
    assert.ok(!err.authExpired, '瞬时故障绝不能踢登录');
    return true;
  });
  assert.strictEqual(api.isAuthed, true);
});

test('refresh: 网络异常 → 抛错但不标记 authExpired', async () => {
  const { api } = makeApi(() => { throw new Error('ECONNRESET'); });
  api.setAuth(AUTH);
  await assert.rejects(() => api.refresh(), (err) => err.authExpired !== true);
  assert.strictEqual(api.isAuthed, true);
});

test('refresh: 缺少 refresh_token → authExpired', async () => {
  const { api } = makeApi(() => res({}));
  api.setAuth({ ...AUTH, refresh_token: '' });
  await assert.rejects(() => api.refresh(), (err) => err.authExpired === true);
});

test('ensureFresh: token 都足够新时不发请求', async () => {
  const { api, calls } = makeApi(() => res({}));
  api.setAuth(AUTH);
  await api.ensureFresh();
  assert.strictEqual(calls.length, 0);
});

test('ensureFresh: access 剩余不足 5 分钟 → 刷新', async () => {
  const { api } = makeApi(() => res({ code: 0, data: { access_token: 'ou_new', refresh_token: 'or_new', expires_in: 7200 } }));
  api.setAuth({ ...AUTH, expires_at: Date.now() + 60 * 1000 });
  const a = await api.ensureFresh();
  assert.strictEqual(a.access_token, 'ou_new');
});

test('ensureFresh: refresh 窗口不足 7 天 → 主动滚动续期', async () => {
  const { api } = makeApi(() => res({ code: 0, data: { access_token: 'ou_new', refresh_token: 'or_new', expires_in: 7200, refresh_expires_in: 7776000 } }));
  api.setAuth({ ...AUTH, refresh_expires_at: Date.now() + 3 * 24 * 3600 * 1000 });
  const a = await api.ensureFresh();
  assert.strictEqual(a.access_token, 'ou_new');
});

test('probeAuth: 未登录 / 链路失败区分原因', async () => {
  const { api } = makeApi(() => { throw new Error('net'); });
  assert.deepStrictEqual(await api.probeAuth(), { ok: false, reason: 'no_auth' });
  api.setAuth(AUTH);
  const r = await api.probeAuth();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'network', '网络失败不得判定为凭证失效');
});

// ---------- 业务接口（经中转服务代签名） ----------
test('listNotes 经 /api/open 转发，带 PIN 与 access_token', async () => {
  const { api, calls } = makeApi(() => res({ code: 200, msg: '获取成功', data: { list: [], has_more: false } }));
  api.setAuth(AUTH);
  const data = await api.listNotes({ page: 2, pageSize: 20 });
  assert.strictEqual(data.has_more, false);
  const req = calls[0];
  assert.strictEqual(req.url, RELAY + '/api/open');
  assert.strictEqual(req.init.headers['x-ideanote-pin'], PIN);
  assert.deepStrictEqual(req.body, {
    method: 'GET',
    path: '/open/idea_note/list',
    query: { page: 2, page_size: 20 },
    access_token: 'ou_1'
  });
});

test('createNote: 没有图片时不传 images 字段', async () => {
  const { api, calls } = makeApi(() => res({ code: 200, data: { id: 1 } }));
  api.setAuth(AUTH);
  await api.createNote({ content_json: { type: 'doc', content: [] } });
  assert.strictEqual(calls[0].body.body.images, undefined);
  assert.strictEqual(calls[0].body.path, '/open/idea_note/create');
  // 实测：平台要求 content_json 是 JSON 字符串，传对象会 40002 签名参数无效
  assert.strictEqual(typeof calls[0].body.body.content_json, 'string');
  assert.deepStrictEqual(JSON.parse(calls[0].body.body.content_json), { type: 'doc', content: [] });
});

test('createNote: 有图片时传 image_id 数组', async () => {
  const { api, calls } = makeApi(() => res({ code: 200, data: { id: 1 } }));
  api.setAuth(AUTH);
  await api.createNote({ content_json: { type: 'doc', content: [] }, images: ['img_1', 'img_2'] });
  assert.deepStrictEqual(calls[0].body.body.images, ['img_1', 'img_2']);
  assert.strictEqual(typeof calls[0].body.body.content_json, 'string');
});

test('updateNote: 必须带 id 与 images 数组（不传等于清空）', async () => {
  const { api, calls } = makeApi(() => res({ code: 200, data: { id: 3 } }));
  api.setAuth(AUTH);
  await api.updateNote({ id: 3, content_json: { type: 'doc', content: [] } });
  assert.deepStrictEqual(calls[0].body.body.images, []);
  assert.strictEqual(typeof calls[0].body.body.content_json, 'string', 'update 同样要传字符串');
  await assert.rejects(() => api.updateNote({ content_json: {} }), /缺少 id/);
});

test('deleteNote 与 requestUpload 路径正确', async () => {
  const { api, calls } = makeApi(() => res({ code: 200, data: [] }));
  api.setAuth(AUTH);
  await api.deleteNote(7);
  assert.deepStrictEqual(calls[0].body, {
    method: 'POST', path: '/open/idea_note/delete', body: { id: 7 }, access_token: 'ou_1'
  });
  await api.requestUpload({ mime_type: 'image/png', size: 100 });
  assert.strictEqual(calls[1].body.path, '/open/media/upload');
  assert.deepStrictEqual(calls[1].body.body, { mime_type: 'image/png', size: 100 });
});

test('业务接口 40003 → 先 refresh 自愈；refresh 被判死才 authExpired', async () => {
  const { api } = makeApi((url) => {
    if (url.endsWith('/oauth/refresh')) return res({ code: 1, invalid: true, message: 'revoked' }, 401);
    return res({ code: 40003, msg: 'token 无效' });
  });
  api.setAuth(AUTH);
  await assert.rejects(() => api.listNotes(), (err) => {
    assert.strictEqual(err.authExpired, true);
    return true;
  });
});

test('业务接口 5xx → code -3，不标记失效', async () => {
  const { api } = makeApi(() => res({ code: -1, message: 'upstream error' }, 502));
  api.setAuth(AUTH);
  await assert.rejects(() => api.listNotes(), (err) => {
    assert.strictEqual(err.code, -3);
    assert.ok(!err.authExpired);
    return true;
  });
});

test('业务接口 401 → 自动 refresh 后重试一次', async () => {
  let n = 0;
  const { api } = makeApi((url) => {
    if (url.endsWith('/oauth/refresh')) {
      return res({ code: 0, data: { access_token: 'ou_2', refresh_token: 'or_2', expires_in: 7200 } });
    }
    n += 1;
    if (n === 1) return res({ code: 40003, msg: 'expired' });
    return res({ code: 200, data: { list: [], has_more: false } });
  });
  api.setAuth(AUTH);
  const data = await api.listNotes();
  assert.strictEqual(data.has_more, false);
  assert.strictEqual(n, 2, '重试一次');
  assert.strictEqual(api.auth.access_token, 'ou_2');
});

test('未登录调用业务接口直接抛 401，不发请求', async () => {
  const { api, calls } = makeApi(() => res({}));
  await assert.rejects(() => api.listNotes(), (err) => err.code === 401);
  assert.strictEqual(calls.length, 0);
});

test('中转服务 403（PIN 不匹配）提示明确', async () => {
  const { api } = makeApi(() => res({ code: 1, message: 'forbidden' }, 403));
  api.setAuth(AUTH);
  await assert.rejects(() => api.listNotes(), /客户端密钥不匹配/);
});
