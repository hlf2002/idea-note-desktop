'use strict';

/**
 * scripts/qiniu-upload.js 的纯逻辑单测：签名串、配置优先级、上传计划顺序、失败映射。
 * 网络部分用注入的假 fetch，不发真实请求。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const qiniu = require('../scripts/qiniu-upload');

const CFG = {
  accessKey: 'AK_test_access',
  secretKey: 'SK_test_secret',
  bucket: 'ideanote-release',
  prefix: 'autoupdates/',
  uploadHost: 'https://upload.qiniup.com',
  rsHost: 'https://rs.qiniu.com',
  publicBase: ''
};

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-upload-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => text
  };
}

// ------------------------------------------------------------ 编码与签名

test('urlSafeBase64: 保留 padding 并把 + / 换成 - _（七牛按带 padding 的值校验，实测去 padding 必 BadToken）', () => {
  const encoded = qiniu.urlSafeBase64(Buffer.from([0xfb, 0xff]));
  assert.match(encoded, /^[A-Za-z0-9_-]+=*$/);
  assert.ok(encoded.endsWith('='), '尾部 padding 必须保留');
  assert.equal(encoded, Buffer.from([0xfb, 0xff]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
  assert.equal(Buffer.from(encoded, 'base64').toString('hex'), 'fbff');
});

test('normalizePrefix: 去首斜杠、补尾斜杠，空值表示桶根', () => {
  assert.equal(qiniu.normalizePrefix('autoupdates'), 'autoupdates/');
  assert.equal(qiniu.normalizePrefix('/autoupdates/'), 'autoupdates/');
  assert.equal(qiniu.normalizePrefix('  '), '');
  assert.equal(qiniu.normalizePrefix(null), '');
  assert.equal(qiniu.objectKey('', 'latest-mac.yml'), 'latest-mac.yml');
  assert.equal(qiniu.objectKey('cdn/rel', 'a.dmg'), 'cdn/rel/a.dmg');
});

test('uploadToken: 三段结构，policy 含 scope/deadline/insertOnly=0，签名可独立复算', () => {
  const token = qiniu.uploadToken({ ...CFG, key: 'autoupdates/latest-mac.yml', expiresIn: 600, now: 1700000000 });
  const [ak, sign, policyB64] = token.split(':');
  assert.equal(ak, CFG.accessKey);

  const policy = JSON.parse(Buffer.from(policyB64, 'base64').toString('utf8'));
  assert.equal(policy.scope, 'ideanote-release:autoupdates/latest-mac.yml');
  assert.equal(policy.deadline, 1700000600);
  assert.equal(policy.insertOnly, 0, 'insertOnly=0 是可重复执行（覆盖写）的前提');

  const expected = crypto.createHmac('sha1', CFG.secretKey).update(policyB64).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sign, expected);
});

test('uploadToken: 缺 accessKey/secretKey/bucket/key 抛 ConfigError', () => {
  assert.throws(() => qiniu.uploadToken({ accessKey: '', secretKey: 's', bucket: 'b', key: 'k' }), qiniu.ConfigError);
  assert.throws(() => qiniu.uploadToken({ ...CFG }), qiniu.ConfigError);
});

test('managementToken: QBox 前缀，签名基于 path + 换行', () => {
  const entry = qiniu.encodedEntry(CFG.bucket, 'autoupdates/latest-mac.yml');
  const requestPath = `/stat/${entry}`;
  const token = qiniu.managementToken({ accessKey: CFG.accessKey, secretKey: CFG.secretKey, path: requestPath });
  assert.ok(token.startsWith(`QBox ${CFG.accessKey}:`));

  const sign = token.slice(`QBox ${CFG.accessKey}:`.length);
  const expected = crypto.createHmac('sha1', CFG.secretKey).update(`${requestPath}\n`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sign, expected);
  assert.equal(Buffer.from(entry, 'base64').toString('utf8'), 'ideanote-release:autoupdates/latest-mac.yml');
});

// ------------------------------------------------------------ 配置优先级

test('resolveConfig: 环境变量 > 配置文件 > 默认值', () => {
  const cfg = qiniu.resolveConfig({
    env: { QINIU_ACCESS_KEY: 'AK_env', QINIU_BUCKET: 'bucket_env' },
    config: { qiniu: { accessKey: 'AK_file', secretKey: 'SK_file', bucket: 'bucket_file', prefix: '/rel' } }
  });
  assert.equal(cfg.accessKey, 'AK_env');
  assert.equal(cfg.from.accessKey, 'env QINIU_ACCESS_KEY');
  assert.equal(cfg.secretKey, 'SK_file');
  assert.equal(cfg.bucket, 'bucket_env');
  assert.equal(cfg.prefix, 'rel/', '前缀归一为带尾斜杠');
  assert.equal(cfg.uploadHost, 'https://upload.qiniup.com');
});

test('resolveConfig: 缺凭据时报出环境变量名与配置位置', () => {
  assert.throws(
    () => qiniu.resolveConfig({ env: {}, config: {} }),
    (e) => e instanceof qiniu.ConfigError &&
      /QINIU_ACCESS_KEY/.test(e.message) &&
      /QINIU_SECRET_KEY/.test(e.message) &&
      /QINIU_BUCKET/.test(e.message) &&
      /\.release\.config\.json/.test(e.message)
  );
});

test('resolveConfig: dry-run 允许无凭据', () => {
  const cfg = qiniu.resolveConfig({ env: {}, config: {}, requireCredentials: false });
  assert.equal(cfg.accessKey, '');
  assert.equal(cfg.bucket, '');
});

test('resolveConfig: uploadHost 可只写域名，自动补 https', () => {
  const cfg = qiniu.resolveConfig({
    env: { QINIU_ACCESS_KEY: 'a', QINIU_SECRET_KEY: 's', QINIU_BUCKET: 'b', QINIU_UPLOAD_HOST: 'upload-z2.qiniup.com' },
    config: {}
  });
  assert.equal(cfg.uploadHost, 'https://upload-z2.qiniup.com');
});

test('mask: 只暴露前 4 位', () => {
  assert.equal(qiniu.mask('AK_abcdefg'), 'AK_a****');
  assert.equal(qiniu.mask(''), '（未配置）');
  assert.equal(qiniu.mask('ab'), '****');
});

// ------------------------------------------------------------ 上传计划

test('planUploads: 清单排最后，blockmap 与安装包在前', () => {
  const dir = tempDir({
    'latest-mac.yml': 'version: 1.2.4\n',
    'idea-note-1.2.4-arm64.dmg': 'x',
    'idea-note-1.2.4-arm64.dmg.blockmap': 'y',
    'idea-note-1.2.4-mac.zip': 'z',
    'notes.txt': 'ignored? no'
  });
  try {
    const plan = qiniu.planUploads(dir);
    assert.deepEqual(plan.manifests, ['latest-mac.yml']);
    assert.equal(plan.all[plan.all.length - 1], 'latest-mac.yml', '清单必须最后上传');
    assert.ok(plan.payload.includes('idea-note-1.2.4-arm64.dmg.blockmap'));
    assert.equal(plan.all.length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planUploads: 没有清单时拒绝（客户端拿不到版本）', () => {
  const dir = tempDir({ 'a.dmg': 'x' });
  try {
    assert.throws(() => qiniu.planUploads(dir), /没有 latest\*\.yml 清单/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planUploads: 只有清单没有包时拒绝（避免清单指向 404）', () => {
  const dir = tempDir({ 'latest.yml': 'version: 1.2.4\n' });
  try {
    assert.throws(() => qiniu.planUploads(dir), /只有清单没有安装包/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('planUploads: 目录不存在时给明确错误', () => {
  assert.throws(() => qiniu.planUploads(path.join(os.tmpdir(), 'definitely-missing-qiniu-dir')), /目录不存在/);
});

// ------------------------------------------------------------ 网络动作

test('statObject: 612 视为对象不存在，返回 null', async () => {
  const calls = [];
  const result = await qiniu.statObject({
    cfg: CFG,
    key: 'autoupdates/latest-mac.yml',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(612, { error: 'no such file or directory' });
    }
  });
  assert.equal(result, null);
  assert.equal(calls[0].url, 'https://rs.qiniu.com/stat/' + qiniu.encodedEntry(CFG.bucket, 'autoupdates/latest-mac.yml'));
  assert.match(calls[0].init.headers.Authorization, /^QBox AK_test_access:/);
});

test('statObject: 200 返回远端大小与 hash', async () => {
  const result = await qiniu.statObject({
    cfg: CFG,
    key: 'k.yml',
    fetchImpl: async () => response(200, { fsize: 1024, hash: 'Fabc', mimeType: 'text/yaml' })
  });
  assert.deepEqual(result, { size: 1024, hash: 'Fabc', mime: 'text/yaml' });
});

test('putObject: 成功时返回 key/size/hash', async () => {
  const content = 'version: 1.2.4\n';
  const dir = tempDir({ 'latest-mac.yml': content });
  try {
    const result = await qiniu.putObject({
      cfg: CFG,
      dir,
      name: 'latest-mac.yml',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://upload.qiniup.com/');
        assert.equal(init.method, 'POST');
        assert.ok(init.body instanceof FormData);
        return response(200, { key: 'autoupdates/latest-mac.yml', hash: 'Fxyz' });
      }
    });
    assert.equal(result.key, 'autoupdates/latest-mac.yml');
    assert.equal(result.size, Buffer.byteLength(content));
    assert.equal(result.hash, 'Fxyz');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('putObject: incorrect region 时自动改用七牛提示的域名重试一次', async () => {
  const dir = tempDir({ 'a.dmg': 'x' });
  const urls = [];
  try {
    const result = await qiniu.putObject({
      cfg: { ...CFG },
      dir,
      name: 'a.dmg',
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        urls.push(url);
        if (url === 'https://upload.qiniup.com/') {
          return response(400, { error: 'incorrect region, please use up-z2.qiniup.com, bucket is: ideanote-release' });
        }
        return response(200, { key: 'autoupdates/a.dmg', hash: 'Fok' });
      }
    });
    assert.equal(result.hash, 'Fok');
    assert.deepEqual(urls, ['https://upload.qiniup.com/', 'https://up-z2.qiniup.com/'], '换域名后应重试并成功');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('putObject: 401 属致命错误，不重试并给出凭据处置', async () => {
  const dir = tempDir({ 'a.dmg': 'x' });
  let calls = 0;
  try {
    await assert.rejects(
      qiniu.putObject({
        cfg: CFG,
        dir,
        name: 'a.dmg',
        sleepImpl: async () => {},
        fetchImpl: async () => { calls += 1; return response(401, { error: 'bad token' }); }
      }),
      (e) => e instanceof qiniu.UploadError && /凭据被拒/.test(e.hint)
    );
    assert.equal(calls, 1, '4xx 不应重试');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('putObject: 5xx 重试后成功', async () => {
  const dir = tempDir({ 'a.dmg': 'hello' });
  let calls = 0;
  try {
    const result = await qiniu.putObject({
      cfg: CFG,
      dir,
      name: 'a.dmg',
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? response(503, 'service unavailable') : response(200, { key: 'autoupdates/a.dmg', hash: 'F1' });
      }
    });
    assert.equal(calls, 2);
    assert.equal(result.size, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('putObject: 重试用尽后抛错并带处置建议', async () => {
  const dir = tempDir({ 'a.dmg': 'hello' });
  try {
    await assert.rejects(
      qiniu.putObject({
        cfg: CFG,
        dir,
        name: 'a.dmg',
        retries: 2,
        sleepImpl: async () => {},
        fetchImpl: async () => response(599, 'unknown error')
      }),
      (e) => e instanceof qiniu.UploadError && /重试/.test(e.hint)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explainFailure: 常见七牛错误码映射到可执行建议', () => {
  assert.match(qiniu.explainFailure('no such bucket', 631), /bucket 不存在/);
  assert.match(qiniu.explainFailure('file exists', 614), /insertOnly/);
  assert.match(qiniu.explainFailure('bad token', 401), /凭据被拒/);
  assert.match(qiniu.explainFailure('', 503), /重试/);
});

test('checkPublic: 未配置 publicBase 时跳过', async () => {
  const result = await qiniu.checkPublic({ cfg: { ...CFG, publicBase: '' }, key: 'k', size: 1 });
  assert.equal(result.skipped, true);
});

test('checkPublic: 200 且长度一致可通过', async () => {
  const result = await qiniu.checkPublic({
    cfg: { ...CFG, publicBase: 'https://cdn.example.com' },
    key: 'autoupdates/a.dmg',
    size: 12,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://cdn.example.com/autoupdates/a.dmg');
      return response(200, '', { 'content-length': '12' });
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.length, 12);
});

// ------------------------------------------------------------ 清单 MIME 与 CDN 刷新

test('changeMime: 走 rs 域名 /chgm/<encEntry>/mime/<encMime>，签名只覆盖 path', async () => {
  const calls = [];
  const result = await qiniu.changeMime({
    cfg: { ...CFG, cdnHost: 'https://fusion.qiniuapi.com' },
    key: 'autoupdates/latest-mac.yml',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, '{}');
    }
  });

  const entry = qiniu.encodedEntry(CFG.bucket, 'autoupdates/latest-mac.yml');
  const encMime = qiniu.urlSafeBase64(qiniu.MANIFEST_CONTENT_TYPE);
  assert.equal(calls[0].url, `https://rs.qiniu.com/chgm/${entry}/mime/${encMime}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(result.mime, 'text/yaml; charset=utf-8');

  // 复算签名：管理凭证只签 path，不签 body（此处 body 为空）
  const requestPath = new URL(calls[0].url).pathname;
  const expected = crypto.createHmac('sha1', CFG.secretKey).update(`${requestPath}\n`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(calls[0].init.headers.Authorization, `QBox ${CFG.accessKey}:${expected}`);
});

test('changeMime: 失败时带处置建议抛出', async () => {
  await assert.rejects(
    qiniu.changeMime({
      cfg: CFG,
      key: 'k.yml',
      fetchImpl: async () => response(401, { error: 'bad token' })
    }),
    (e) => e instanceof qiniu.UploadError && /凭据被拒/.test(e.hint)
  );
});

test('refreshCdn: POST /v2/tune/refresh，body 是 urls 且不参与签名', async () => {
  const calls = [];
  const urls = ['https://cdn.example.com/autoupdates/a.dmg', 'https://cdn.example.com/autoupdates/latest-mac.yml'];
  const result = await qiniu.refreshCdn({
    cfg: { ...CFG, cdnHost: 'https://fusion.qiniuapi.com' },
    urls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, { code: 200, requestId: 'req-1' });
    }
  });

  assert.equal(calls[0].url, 'https://fusion.qiniuapi.com/v2/tune/refresh');
  assert.deepEqual(JSON.parse(calls[0].init.body), { urls });

  // 关键：签名串只有 path + \n。官方 SDK 用空 body 生成凭证，把 JSON 算进去会被拒
  const expected = crypto.createHmac('sha1', CFG.secretKey).update('/v2/tune/refresh\n').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(calls[0].init.headers.Authorization, `QBox ${CFG.accessKey}:${expected}`);
  assert.equal(result.requestId, 'req-1');
});

test('refreshCdn: HTTP 200 但 code 非 200 也判失败', async () => {
  await assert.rejects(
    qiniu.refreshCdn({
      cfg: CFG,
      urls: ['https://cdn.example.com/x'],
      fetchImpl: async () => response(200, { code: 400100, error: 'url not in domain list' })
    }),
    /刷新 CDN 失败/
  );
});

test('refreshCdn: 域名未绑定类错误不误判成凭据问题', async () => {
  const error = await qiniu.refreshCdn({
    cfg: CFG,
    urls: ['https://wrong.example.com/x'],
    fetchImpl: async () => response(403, { code: 40131001, error: 'url not in domain list' })
  }).catch((e) => e);
  assert.ok(error instanceof qiniu.UploadError);
  assert.match(error.hint, /QINIU_PUBLIC_BASE/);
  assert.doesNotMatch(error.hint, /凭据被拒/);
});

test('publicUrlFor: 中文 key 逐段 percent-encode，未配 publicBase 返回空串', () => {
  const cfg = { ...CFG, publicBase: 'https://cdn.example.com' };
  assert.equal(
    qiniu.publicUrlFor(cfg, 'autoupdates/灵感笔记-1.2.4-arm64.dmg'),
    'https://cdn.example.com/autoupdates/%E7%81%B5%E6%84%9F%E7%AC%94%E8%AE%B0-1.2.4-arm64.dmg'
  );
  assert.equal(qiniu.publicUrlFor({ ...CFG, publicBase: '' }, 'k'), '');
});

test('main: 安装包先传、清单最后传，之后才修 MIME 并刷 CDN', async () => {
  const dmg = 'dmg-bytes';
  const manifest = [
    'version: 1.2.4',
    'files:',
    '  - url: 灵感笔记-1.2.4-arm64.dmg',
    `    sha512: ${crypto.createHash('sha512').update(dmg).digest('base64')}`,
    `    size: ${Buffer.byteLength(dmg)}`,
    'path: 灵感笔记-1.2.4-arm64.dmg'
  ].join('\n');
  const dir = tempDir({ '灵感笔记-1.2.4-arm64.dmg': dmg, 'latest-mac.yml': manifest });

  const calls = [];
  const statCount = new Map();
  // /stat/<urlsafe_b64(bucket:key)>：解出 key 再读本地文件大小，否则 fsize 校验必挂
  const localOf = (url) => {
    const entry = url.split('/stat/')[1];
    const decoded = Buffer.from(entry.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const key = decoded.slice(decoded.indexOf(':') + 1);
    const name = key.replace(/^autoupdates\//, '');
    return { key, name, size: fs.statSync(path.join(dir, name)).size };
  };
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://upload.qiniup.com/') {
      const key = init.body.get('key');
      calls.push({ kind: 'upload', url, key });
      return response(200, { key, hash: 'Fake' });
    }
    if (url.startsWith('https://rs.qiniu.com/stat/')) {
      const { key, size } = localOf(url);
      const seen = (statCount.get(key) || 0) + 1;
      statCount.set(key, seen);
      calls.push({ kind: 'stat', url, key });
      // 第一次查不到 → 触发上传；上传后再查返回真实大小
      if (seen === 1) return response(612, { error: 'no such file' });
      return response(200, { fsize: size, hash: 'Fake' });
    }
    if (url.startsWith('https://rs.qiniu.com/chgm/')) {
      calls.push({ kind: 'chgm', url });
      return response(200, '{}');
    }
    if (url === 'https://fusion.qiniuapi.com/v2/tune/refresh') {
      calls.push({ kind: 'refresh', url, body: JSON.parse(init.body) });
      return response(200, { code: 200, requestId: 'req-e2e' });
    }
    if (url.startsWith('https://cdn.example.com/')) {
      calls.push({ kind: 'head', url });
      const name = decodeURIComponent(url.split('/').pop());
      return response(200, '', { 'content-length': String(fs.statSync(path.join(dir, name)).size) });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  Object.assign(process.env, {
    QINIU_ACCESS_KEY: CFG.accessKey,
    QINIU_SECRET_KEY: CFG.secretKey,
    QINIU_BUCKET: CFG.bucket,
    QINIU_PREFIX: CFG.prefix,
    QINIU_PUBLIC_BASE: 'https://cdn.example.com'
  });
  globalThis.fetch = fetchImpl;
  try {
    const code = await qiniu.main(['--dir', dir]);
    assert.equal(code, 0);

    const uploads = calls.filter((c) => c.kind === 'upload').map((c) => c.key);
    assert.deepEqual(uploads, ['autoupdates/灵感笔记-1.2.4-arm64.dmg', 'autoupdates/latest-mac.yml'], '清单必须最后上传');

    const chgmAt = calls.findIndex((c) => c.kind === 'chgm');
    const refreshAt = calls.findIndex((c) => c.kind === 'refresh');
    const lastUploadAt = calls.map((c) => c.kind).lastIndexOf('upload');
    assert.ok(chgmAt > lastUploadAt, 'Content-Type 修正在上传之后');
    assert.ok(refreshAt > chgmAt, 'CDN 刷新在最后');

    const refreshed = calls[refreshAt].body.urls;
    assert.equal(refreshed.length, 2);
    assert.ok(refreshed.some((u) => u.includes('%E7%81%B5%E6%84%9F%E7%AC%94%E8%AE%B0')), '中文 dmg 的刷新 URL 必须编码');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --no-cdn 时不发 chgm / refresh', async () => {
  const dmg = 'dmg-bytes';
  const manifest = [
    'version: 1.2.4',
    'files:',
    '  - url: idea-note-1.2.4-arm64.dmg',
    `    sha512: ${crypto.createHash('sha512').update(dmg).digest('base64')}`,
    `    size: ${Buffer.byteLength(dmg)}`,
    'path: idea-note-1.2.4-arm64.dmg'
  ].join('\n');
  const dir = tempDir({ 'idea-note-1.2.4-arm64.dmg': dmg, 'latest-mac.yml': manifest });

  const kinds = [];
  const statSeen = new Set();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (url === 'https://upload.qiniup.com/') {
      kinds.push('upload');
      return response(200, { key: init.body.get('key'), hash: 'F' });
    }
    if (url.startsWith('https://rs.qiniu.com/stat/')) {
      const entry = url.split('/stat/')[1];
      const decoded = Buffer.from(entry.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const key = decoded.slice(decoded.indexOf(':') + 1);
      if (!statSeen.has(key)) { statSeen.add(key); return response(612, {}); }
      const name = key.replace(/^autoupdates\//, '');
      return response(200, { fsize: fs.statSync(path.join(dir, name)).size });
    }
    if (url.includes('/chgm/') || url.includes('/v2/tune/refresh')) { kinds.push('cdn'); return response(200, '{}'); }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const saved = { ...process.env };
  Object.assign(process.env, {
    QINIU_ACCESS_KEY: CFG.accessKey, QINIU_SECRET_KEY: CFG.secretKey,
    QINIU_BUCKET: CFG.bucket, QINIU_PREFIX: CFG.prefix
  });
  try {
    assert.equal(await qiniu.main(['--dir', dir, '--no-cdn']), 0);
    assert.equal(kinds.includes('cdn'), false);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: 清单 sha512 与产物不符时直接失败，且一个对象都不上传', async () => {
  const dir = tempDir({
    'a.zip': 'hello',
    'latest-mac.yml': [
      'version: 1.2.4',
      'files:',
      '  - url: a.zip',
      '    sha512: WRONG',
      '    size: 5'
    ].join('\n')
  });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    throw new Error(`校验未通过时不该联网：${url}`);
  };
  const saved = { ...process.env };
  Object.assign(process.env, {
    QINIU_ACCESS_KEY: CFG.accessKey, QINIU_SECRET_KEY: CFG.secretKey, QINIU_BUCKET: CFG.bucket
  });
  try {
    await assert.rejects(() => qiniu.main(['--dir', dir]), /sha512 与清单不一致/);
    assert.equal(calls.length, 0, 'sha512 门禁必须在联网前中断');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ------------------------------------------------------------ CLI 解析

test('parseArgs: 默认值 / = 语法 / 未知参数', () => {
  const opts = qiniu.parseArgs(['--dir=dist/package', '--dry-run']);
  assert.equal(opts.dir, 'dist/package');
  assert.equal(opts.dryRun, true);
  assert.equal(opts.retries, 3);
  assert.equal(opts.noCdn, false, '默认要做 Content-Type 与 CDN 刷新');
  assert.equal(opts.strictCdn, false);

  const cdnOff = qiniu.parseArgs(['--dir', 'x', '--no-cdn']);
  assert.equal(cdnOff.noCdn, true);
  assert.equal(qiniu.parseArgs(['--dir', 'x', '--strict-cdn']).strictCdn, true);

  assert.throws(() => qiniu.parseArgs(['--dir', 'x', '--nope']), /未知参数/);
  assert.throws(() => qiniu.parseArgs(['--dry-run']), /缺少 --dir/);
  assert.throws(() => qiniu.parseArgs(['--dir', 'x', '--retries', '0']), /正整数/);
});

test('formatSize: 大文件按 MB 取整，小文件按 KB', () => {
  assert.equal(qiniu.formatSize(118 * 1048576), '118MB');
  assert.equal(qiniu.formatSize(1024), '1KB');
  assert.equal(qiniu.formatSize(5 * 1048576), '5.0MB');
});
