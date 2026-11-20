'use strict';

/**
 * scripts/qiniu-artifact.js 的纯逻辑与端到端单测：
 * 命名规则、输入收集、etag、去重判定、参数解析、主流程（假 fetch，不联网）。
 * 发布链路 qiniu-upload.js 的既有行为由 qiniu-upload.test.js 覆盖，这里只验证「不被影响」。
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const artifact = require('../scripts/qiniu-artifact');

const ENV = {
  QINIU_ACCESS_KEY: 'AK_test_access',
  QINIU_SECRET_KEY: 'SK_test_secret',
  QINIU_BUCKET: 'ideanote-release',
  QINIU_PREFIX: 'autoupdates/'
};

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiniu-artifact-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
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

function keyFromStatUrl(url) {
  const entry = url.split('/stat/')[1];
  const decoded = Buffer.from(entry.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1);
}

/**
 * 假七牛：remote 是 key -> { size, hash } 的 Map。
 * 上传成功后按本地内容写入 etag，使 main 的上传后校验能通过。
 */
function fakeQiniu({ dir, remote = new Map(), statCalls = [], uploadCalls = [], failUploadStatus = null }) {
  const fetchImpl = async (url, init = {}) => {
    if (url === 'https://upload.qiniup.com/') {
      const key = init.body.get('key');
      uploadCalls.push(key);
      if (failUploadStatus) return response(failUploadStatus, { error: 'bad token' });
      const name = key.split('/').pop();
      const source = fs.readdirSync(dir).find((item) => item === name);
      const body = fs.readFileSync(path.join(dir, source || name));
      const hash = artifact.qiniuEtag(body);
      remote.set(key, { size: body.length, hash });
      return response(200, { key, hash });
    }
    if (url.startsWith('https://rs.qiniu.com/stat/')) {
      const key = keyFromStatUrl(url);
      statCalls.push(key);
      const found = remote.get(key);
      if (!found) return response(612, { error: 'no such file' });
      return response(200, { fsize: found.size, hash: found.hash });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchImpl, remote };
}

// ------------------------------------------------------------ 命名规则

test('sanitizeName: 去路径、空白折叠、保留中文，拒绝隐藏文件', () => {
  assert.equal(artifact.sanitizeName('dir/截屏 2026-11-20 14.50.00.png'), '截屏-2026-11-20-14.50.00.png');
  assert.equal(artifact.sanitizeName('  a\tb  .zip '), 'a-b-.zip');
  assert.throws(() => artifact.sanitizeName('.env'), /隐藏文件/);
  assert.throws(() => artifact.sanitizeName('../'), /对象名不能为空|隐藏文件/);
  assert.throws(() => artifact.sanitizeName(''), /不能为空/);
});

test('sanitizeName: 默认拒绝发布清单，--allow-manifest 可放行', () => {
  assert.throws(() => artifact.sanitizeName('latest-mac.yml'), /拒绝单传发布清单/);
  assert.throws(() => artifact.sanitizeName('latest.yml'), /upload:qiniu/);
  assert.equal(artifact.sanitizeName('latest-mac.yml', { allowManifest: true }), 'latest-mac.yml');
  assert.equal(artifact.sanitizeName('latest-notes.txt'), 'latest-notes.txt');
});

test('normalizeSubdir: 去首尾斜杠、反斜杠归一、拒绝 .. 穿越', () => {
  assert.equal(artifact.normalizeSubdir('/qa/1.2.4/'), 'qa/1.2.4/');
  assert.equal(artifact.normalizeSubdir('qa\\1.2.4'), 'qa/1.2.4/');
  assert.equal(artifact.normalizeSubdir(' qa  1.2.4 '), 'qa-1.2.4/');
  assert.equal(artifact.normalizeSubdir(''), '');
  assert.throws(() => artifact.normalizeSubdir('../etc'), /不允许包含 \. 或 \.\./);
});

test('buildKey: prefix + subdir + [日期] + name', () => {
  const date = new Date(2026, 10, 20);
  assert.equal(artifact.buildKey({ prefix: 'artifacts', name: 'a.png', date }), 'artifacts/a.png');
  assert.equal(
    artifact.buildKey({ prefix: 'artifacts/', subdir: 'qa', dated: true, name: 'a.png', date }),
    'artifacts/qa/2026-11-20/a.png'
  );
  assert.equal(
    artifact.buildKey({ prefix: '/tmp', subdir: '/x/y/', dated: true, name: '灵感 笔记.dmg', date }),
    'tmp/x/y/2026-11-20/灵感 笔记.dmg'
  );
});

test('dateDir: 本地日期补零', () => {
  assert.equal(artifact.dateDir(new Date(2026, 0, 5)), '2026-01-05');
});

// ------------------------------------------------------------ 输入收集

test('collectInputs: 目录只取第一层，跳过隐藏文件与子目录', () => {
  const dir = tempDir({ 'a.png': 'a', '.DS_Store': 'x', 'sub/b.png': 'b' });
  try {
    const inputs = artifact.collectInputs({ sources: [{ value: dir, kind: 'dir' }] });
    assert.deepEqual(inputs.map((i) => i.name), ['a.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectInputs: 同一路径去重，不同路径同名报错', () => {
  const dir = tempDir({ 'x/a.png': 'a', 'y/a.png': 'b' });
  try {
    const same = artifact.collectInputs({
      sources: [
        { value: path.join(dir, 'x/a.png'), kind: 'file' },
        { value: path.join(dir, 'x/a.png'), kind: 'file' }
      ]
    });
    assert.equal(same.length, 1);

    assert.throws(
      () => artifact.collectInputs({
        sources: [
          { value: path.join(dir, 'x/a.png'), kind: 'file' },
          { value: path.join(dir, 'y/a.png'), kind: 'file' }
        ]
      }),
      /清洗后同名/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectInputs: 路径不存在时给 shell 通配符提示', () => {
  assert.throws(
    () => artifact.collectInputs({ sources: [{ value: 'dist/*.dmg', kind: 'auto' }] }),
    (e) => /找不到输入/.test(e.message) && /通配符/.test(e.message)
  );
  assert.throws(
    () => artifact.collectInputs({ sources: [{ value: os.tmpdir(), kind: 'file' }] }),
    /--file 需要普通文件/
  );
});

// ------------------------------------------------------------ etag 与去重

test('qiniuEtag: ≤4MB 用 0x16 + md5，URL 安全 Base64', () => {
  const body = Buffer.from('hello');
  const expected = Buffer.concat([Buffer.from([0x16]), crypto.createHash('md5').update(body).digest()])
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const etag = artifact.qiniuEtag(body);
  assert.equal(etag, expected);
  // 解码后首字节是 0x16，其后是 md5；padding 是否存在不影响比对（脚本内部会归一）
  assert.equal(
    Buffer.from(etag.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex'),
    `16${crypto.createHash('md5').update(body).digest('hex')}`
  );
});

test('qiniuEtag: >4MB 按 4MB 分块 sha1 再聚合', () => {
  const body = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
  const blocks = [];
  for (let offset = 0; offset < body.length; offset += 4 * 1024 * 1024) {
    blocks.push(crypto.createHash('sha1').update(body.subarray(offset, offset + 4 * 1024 * 1024)).digest());
  }
  const expected = Buffer.concat([Buffer.from([0x16]), crypto.createHash('sha1').update(Buffer.concat(blocks)).digest()])
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(artifact.qiniuEtag(body), expected);
  assert.notEqual(artifact.qiniuEtag(Buffer.alloc(4 * 1024 * 1024 + 1, 7)), artifact.qiniuEtag(Buffer.alloc(4 * 1024 * 1024 + 1, 8)));
});

test('decideAction: 不存在/一致/不一致/force/skipExisting', () => {
  assert.equal(artifact.decideAction({ remote: null, etag: 'E', size: 1 }).action, 'upload');

  const same = { size: 10, hash: 'E' };
  assert.equal(artifact.decideAction({ remote: same, etag: 'E', size: 10 }).action, 'skip');
  assert.equal(artifact.decideAction({ remote: same, etag: 'E', size: 10, force: true }).action, 'upload');
  assert.equal(artifact.decideAction({ remote: { size: 99, hash: 'X' }, etag: 'E', size: 10 }).reason.includes('大小'), true);
  assert.equal(artifact.decideAction({ remote: { size: 10, hash: 'X' }, etag: 'E', size: 10 }).reason.includes('etag'), true);
  assert.equal(artifact.decideAction({ remote: same, etag: 'E', size: 10, skipExisting: true }).action, 'skip');
  assert.equal(artifact.decideAction({ remote: { size: 1, hash: 'Z' }, etag: 'E', size: 10, skipExisting: true }).action, 'skip');
});

// ------------------------------------------------------------ 配置

test('resolveArtifactConfig: 默认 artifacts/，与更新源前缀分离', () => {
  const cfg = artifact.resolveArtifactConfig({ env: ENV, config: {} });
  assert.equal(cfg.prefix, 'artifacts/');
  assert.equal(cfg.updatePrefix, 'autoupdates/');
  assert.equal(cfg.prefixFrom, '默认值');
  assert.equal(cfg.overlap, false);
});

test('resolveArtifactConfig: 环境变量 > 配置文件 > 默认值', () => {
  const fromEnv = artifact.resolveArtifactConfig({
    env: { ...ENV, QINIU_ARTIFACT_PREFIX: 'tmp/art' },
    config: { qiniu: { artifactPrefix: 'from-file/' } }
  });
  assert.equal(fromEnv.prefix, 'tmp/art/');
  assert.equal(fromEnv.prefixFrom, 'env QINIU_ARTIFACT_PREFIX');

  const fromFile = artifact.resolveArtifactConfig({ env: ENV, config: { qiniu: { artifactPrefix: 'from-file' } } });
  assert.equal(fromFile.prefix, 'from-file/');
  assert.match(fromFile.prefixFrom, /artifactPrefix/);
});

test('resolveArtifactConfig: 与更新源前缀重叠会被标出', () => {
  const nested = artifact.resolveArtifactConfig({ env: ENV, config: { qiniu: { artifactPrefix: 'autoupdates/tmp/' } } });
  assert.equal(nested.overlap, true);

  const parent = artifact.resolveArtifactConfig({ env: ENV, config: { qiniu: { artifactPrefix: 'autoupdates' } } });
  assert.equal(parent.overlap, true, '归一后同一前缀也算重叠');

  const root = artifact.resolveArtifactConfig({ env: ENV, config: { qiniu: { artifactPrefix: '/' } } });
  assert.equal(root.overlap, true, '桶根与任何前缀都重叠');
});

test('resolveArtifactConfig: --prefix 显式覆盖时记录来源', () => {
  const cfg = artifact.resolveArtifactConfig({ env: ENV, config: {}, prefixOverride: 'shots/' });
  assert.equal(cfg.prefix, 'shots/');
  assert.equal(cfg.prefixExplicit, true);
  assert.equal(cfg.prefixFrom, '--prefix');
});

// ------------------------------------------------------------ 参数解析

test('parseArgs: 位置参数自动识别、--dir/--file 可重复', () => {
  const opts = artifact.parseArgs(['a.png', '--dir', 'reports', '--file=b.zip', 'reports']);
  assert.deepEqual(opts.sources, [
    { value: 'a.png', kind: 'auto' },
    { value: 'reports', kind: 'dir' },
    { value: 'b.zip', kind: 'file' },
    { value: 'reports', kind: 'auto' }
  ]);
  assert.equal(opts.retries, 3);
  assert.equal(opts.dryRun, false);
});

test('parseArgs: -- 之后一律当路径，未知参数报错', () => {
  assert.deepEqual(artifact.parseArgs(['--', '--weird.png']).sources, [{ value: '--weird.png', kind: 'auto' }]);
  assert.throws(() => artifact.parseArgs(['a.png', '--nope']), /未知参数/);
  assert.throws(() => artifact.parseArgs([]), /缺少要上传的文件或目录/);
});

test('parseArgs: 互斥与非法取值', () => {
  assert.throws(() => artifact.parseArgs(['a.png', '--check', '--dry-run']), /互斥/);
  assert.throws(() => artifact.parseArgs(['a.png', '--check', '--cdn']), /不能与 --cdn 同用/);
  assert.throws(() => artifact.parseArgs(['a.png', '--retries', '0']), /正整数/);
  assert.throws(() => artifact.parseArgs(['a.png', '--name', 'qa/a.png']), /--subdir/);
  assert.throws(() => artifact.parseArgs(['a.png', '--prefix']), /缺少取值/);
});

// ------------------------------------------------------------ 主流程

test('main: 新文件上传、内容一致的跳过，前缀与 --dated 生效', async () => {
  const dir = tempDir({ 'new.png': 'new-bytes', 'same.png': 'same-bytes' });
  const { fetchImpl, remote } = fakeQiniu({ dir });
  const keyPrefix = 'artifacts/qa/2026-11-20/';
  remote.set(`${keyPrefix}same.png`, {
    size: fs.statSync(path.join(dir, 'same.png')).size,
    hash: artifact.qiniuEtag(fs.readFileSync(path.join(dir, 'same.png')))
  });
  const logs = [];
  const realLog = console.log;
  console.log = (msg) => logs.push(String(msg));
  try {
    const code = await artifact.main(
      [path.join(dir, 'new.png'), path.join(dir, 'same.png'), '--subdir', 'qa', '--dated'],
      { env: ENV, config: {}, now: new Date(2026, 10, 20), fetchImpl, sleepImpl: async () => {} }
    );
    assert.equal(code, 0);
    assert.deepEqual(remote.get(`${keyPrefix}new.png`) !== undefined, true);
    assert.equal(logs.join('\n').includes('1 上传 / 1 跳过'), true, logs.join('\n'));
    assert.ok(logs.join('\n').includes('远端已存在且内容一致'));
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --force 时内容一致也重传', async () => {
  const dir = tempDir({ 'a.png': 'aaa' });
  const uploadCalls = [];
  const { fetchImpl, remote } = fakeQiniu({ dir, uploadCalls });
  remote.set('artifacts/a.png', { size: 3, hash: artifact.qiniuEtag(Buffer.from('aaa')) });
  const realLog = console.log;
  console.log = () => {};
  try {
    const code = await artifact.main([path.join(dir, 'a.png'), '--force'], {
      env: ENV, config: {}, fetchImpl, sleepImpl: async () => {}
    });
    assert.equal(code, 0);
    assert.deepEqual(uploadCalls, ['artifacts/a.png']);
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --check 在远端缺失时返回 1 且不写数据', async () => {
  const dir = tempDir({ 'a.png': 'aaa' });
  const uploadCalls = [];
  const { fetchImpl } = fakeQiniu({ dir, uploadCalls });
  const realLog = console.log;
  const realErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const code = await artifact.main([path.join(dir, 'a.png'), '--check'], {
      env: ENV, config: {}, fetchImpl, sleepImpl: async () => {}
    });
    assert.equal(code, 1);
    assert.deepEqual(uploadCalls, []);
  } finally {
    console.log = realLog;
    console.error = realErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --dry-run 不联网、不要求凭据', async () => {
  const dir = tempDir({ 'a.png': 'aaa' });
  const realLog = console.log;
  console.log = () => {};
  try {
    const code = await artifact.main([path.join(dir, 'a.png'), '--dry-run', '--dated'], {
      env: {},
      config: {},
      now: new Date(2026, 10, 20),
      fetchImpl: async () => { throw new Error('dry-run 不应联网'); }
    });
    assert.equal(code, 0);
  } finally {
    console.log = realLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: 上传 401 立即失败，剩余文件标记未执行', async () => {
  const dir = tempDir({ 'a.png': 'aaa', 'b.png': 'bbb' });
  const uploadCalls = [];
  const { fetchImpl } = fakeQiniu({ dir, uploadCalls, failUploadStatus: 401 });
  const realLog = console.log;
  const realErr = console.error;
  const errors = [];
  console.log = () => {};
  console.error = (msg) => errors.push(String(msg));
  try {
    const code = await artifact.main([path.join(dir, 'a.png'), path.join(dir, 'b.png')], {
      env: ENV, config: {}, fetchImpl, sleepImpl: async () => {}
    });
    assert.equal(code, 1);
    assert.equal(uploadCalls.length, 1, '4xx 属致命错误，不应重试也不应继续下一个文件');
    assert.ok(errors.join('\n').includes('另有 1 个文件因中断未执行'));
  } finally {
    console.log = realLog;
    console.error = realErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: 产物前缀与更新源重叠时拒绝执行', async () => {
  const dir = tempDir({ 'a.png': 'aaa' });
  try {
    await assert.rejects(
      () => artifact.main([path.join(dir, 'a.png')], {
        env: ENV,
        config: { qiniu: { artifactPrefix: 'autoupdates/tmp/' } },
        fetchImpl: async () => { throw new Error('不应联网'); }
      }),
      /重叠/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --json 输出结构化结果，stdout 只有 JSON', async () => {
  const dir = tempDir({ 'a.png': 'aaa' });
  const { fetchImpl } = fakeQiniu({ dir });
  const chunks = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    const code = await artifact.main([path.join(dir, 'a.png'), '--json'], {
      env: ENV, config: {}, fetchImpl, sleepImpl: async () => {}
    });
    assert.equal(code, 0);
    const report = JSON.parse(chunks.join(''));
    assert.equal(report.ok, true);
    assert.equal(report.prefix, 'artifacts/');
    assert.equal(report.items[0].status, 'uploaded');
    assert.equal(report.items[0].key, 'artifacts/a.png');
    assert.equal(report.summary.uploaded, 1);
    assert.equal(report.summary.failed, 0);
  } finally {
    process.stdout.write = realWrite;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: 发布清单走产物链路被拒绝（提示改用 upload:qiniu）', async () => {
  const dir = tempDir({ 'latest-mac.yml': 'version: 1.2.4\n' });
  try {
    await assert.rejects(
      () => artifact.main([path.join(dir, 'latest-mac.yml')], { env: ENV, config: {} }),
      /拒绝单传发布清单/
    );
    const code = await artifact.main([path.join(dir, 'latest-mac.yml'), '--allow-manifest', '--dry-run'], {
      env: {}, config: {}, fetchImpl: async () => { throw new Error('dry-run 不应联网'); }
    });
    assert.equal(code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: --cdn 未配 publicBase 时报配置错误', async () => {
  const dir = tempDir({ 'a.png': 'aaa' });
  try {
    await assert.rejects(
      () => artifact.main([path.join(dir, 'a.png'), '--cdn'], { env: ENV, config: {}, fetchImpl: async () => response(612, {}) }),
      /--cdn 需要 QINIU_PUBLIC_BASE/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main: 失败提示含处置建议，重跑语义为覆盖写', async () => {
  const dir = tempDir({ 'a.png': 'aaa' });
  const { fetchImpl } = fakeQiniu({ dir, failUploadStatus: 403 });
  const realLog = console.log;
  const realErr = console.error;
  const errors = [];
  console.log = () => {};
  console.error = (msg) => errors.push(String(msg));
  try {
    const code = await artifact.main([path.join(dir, 'a.png')], {
      env: ENV, config: {}, fetchImpl, sleepImpl: async () => {}
    });
    assert.equal(code, 1);
    const text = errors.join('\n');
    assert.ok(text.includes('凭据被拒'), text);
    assert.ok(text.includes('重跑同一命令'), text);
  } finally {
    console.log = realLog;
    console.error = realErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
