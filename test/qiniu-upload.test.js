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

test('urlSafeBase64: 去掉 padding 并把 + / 换成 - _', () => {
  const encoded = qiniu.urlSafeBase64(Buffer.from([0xfb, 0xff, 0xbf]));
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes('='));
  assert.equal(Buffer.from(encoded, 'base64').toString('hex'), 'fbffbf');
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
  assert.equal(policyB64.includes('='), false);

  const policy = JSON.parse(Buffer.from(policyB64, 'base64').toString('utf8'));
  assert.equal(policy.scope, 'ideanote-release:autoupdates/latest-mac.yml');
  assert.equal(policy.deadline, 1700000600);
  assert.equal(policy.insertOnly, 0, 'insertOnly=0 是可重复执行（覆盖写）的前提');

  const expected = crypto.createHmac('sha1', CFG.secretKey).update(policyB64).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

// ------------------------------------------------------------ CLI 解析

test('parseArgs: 默认值 / = 语法 / 未知参数', () => {
  const opts = qiniu.parseArgs(['--dir=dist/package', '--dry-run']);
  assert.equal(opts.dir, 'dist/package');
  assert.equal(opts.dryRun, true);
  assert.equal(opts.retries, 3);

  assert.throws(() => qiniu.parseArgs(['--dir', 'x', '--nope']), /未知参数/);
  assert.throws(() => qiniu.parseArgs(['--dry-run']), /缺少 --dir/);
  assert.throws(() => qiniu.parseArgs(['--dir', 'x', '--retries', '0']), /正整数/);
});

test('formatSize: 大文件按 MB 取整，小文件按 KB', () => {
  assert.equal(qiniu.formatSize(118 * 1048576), '118MB');
  assert.equal(qiniu.formatSize(1024), '1KB');
  assert.equal(qiniu.formatSize(5 * 1048576), '5.0MB');
});
