/**
 * release-manifest.test.js —— 发布清单改写纯函数单元测试（node:test）
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  asciiName,
  assetName,
  releaseAssetUrl,
  buildDeployManifest,
  buildRelativeManifest,
  refreshDigests,
  verifyDigests
} = require('../scripts/release-manifest');

const BUILD_MANIFEST = `version: 1.2.0
files:
  - url: 灵感笔记-1.2.0-arm64-mac.zip
    sha512: AAAA1111
    size: 112768946
  - url: 灵感笔记-1.2.0-mac.zip
    sha512: BBBB2222
    size: 117396139
  - url: 灵感笔记-1.2.0-arm64.dmg
    sha512: CCCC3333
    size: 118114752
path: 灵感笔记-1.2.0-arm64-mac.zip
sha512: AAAA1111
releaseDate: '2026-09-21T10:00:00.000Z'
`;

const BASE = { manifestText: BUILD_MANIFEST, repo: 'hlf2002/idea-note-desktop', tag: 'v1.2.0', version: '1.2.0' };

// ============ asciiName ============
test('asciiName: 中文产品名前缀换成 ASCII，架构与扩展名保留', () => {
  assert.strictEqual(asciiName('灵感笔记-1.2.0-arm64-mac.zip'), 'idea-note-1.2.0-arm64-mac.zip');
  assert.strictEqual(asciiName('灵感笔记-1.2.0.dmg'), 'idea-note-1.2.0.dmg');
  assert.strictEqual(asciiName('idea-note-1.2.0-arm64-mac.zip.blockmap'), 'idea-note-1.2.0-arm64-mac.zip.blockmap');
});

test('asciiName: 空值报错', () => {
  assert.throws(() => asciiName(''), /资产名不能为空/);
});

// ============ assetName（两套名字的分界） ============
test('assetName: dmg 保留中文原名（只供人工下载）', () => {
  assert.strictEqual(assetName('灵感笔记-1.2.0-arm64.dmg'), '灵感笔记-1.2.0-arm64.dmg');
  assert.strictEqual(assetName('idea-note-1.2.0.dmg'), 'idea-note-1.2.0.dmg');
});

test('assetName: zip / blockmap 强制 ASCII（自动更新链路）', () => {
  assert.strictEqual(assetName('灵感笔记-1.2.0-arm64-mac.zip'), 'idea-note-1.2.0-arm64-mac.zip');
  assert.strictEqual(assetName('灵感笔记-1.2.0-mac.zip.blockmap'), 'idea-note-1.2.0-mac.zip.blockmap');
});

test('assetName: 空值报错', () => {
  assert.throws(() => assetName(''), /资产名不能为空/);
});

test('releaseAssetUrl: zip 用 ASCII 名，dmg 用 percent-encoded 中文名', () => {
  assert.strictEqual(
    releaseAssetUrl('a/b', 'v1.2.0', '灵感笔记-1.2.0-mac.zip'),
    'https://github.com/a/b/releases/download/v1.2.0/idea-note-1.2.0-mac.zip'
  );
  assert.strictEqual(
    releaseAssetUrl('a/b', 'v1.2.0', '灵感笔记-1.2.0-arm64.dmg'),
    'https://github.com/a/b/releases/download/v1.2.0/%E7%81%B5%E6%84%9F%E7%AC%94%E8%AE%B0-1.2.0-arm64.dmg'
  );
});

// ============ buildDeployManifest ============
test('buildDeployManifest: zip 走 ASCII 地址，dmg 走 percent-encoded 中文地址', () => {
  const out = yaml.load(buildDeployManifest(BASE));
  assert.deepStrictEqual(out.files.map((f) => f.url), [
    'https://github.com/hlf2002/idea-note-desktop/releases/download/v1.2.0/idea-note-1.2.0-arm64-mac.zip',
    'https://github.com/hlf2002/idea-note-desktop/releases/download/v1.2.0/idea-note-1.2.0-mac.zip',
    'https://github.com/hlf2002/idea-note-desktop/releases/download/v1.2.0/%E7%81%B5%E6%84%9F%E7%AC%94%E8%AE%B0-1.2.0-arm64.dmg'
  ]);
});

test('buildDeployManifest: sha512 / size 不因改写丢失（缩进事故回归）', () => {
  const out = yaml.load(buildDeployManifest(BASE));
  assert.deepStrictEqual(out.files.map((f) => f.sha512), ['AAAA1111', 'BBBB2222', 'CCCC3333']);
  assert.deepStrictEqual(out.files.map((f) => f.size), [112768946, 117396139, 118114752]);
});

test('buildDeployManifest: 顶层 path / version / releaseDate 原样保留', () => {
  const out = yaml.load(buildDeployManifest(BASE));
  assert.strictEqual(out.version, '1.2.0');
  assert.strictEqual(out.path, 'idea-note-1.2.0-arm64-mac.zip');
  assert.strictEqual(out.sha512, 'AAAA1111');
  assert.strictEqual(out.releaseDate, '2026-09-21T10:00:00.000Z');
});

test('buildDeployManifest: 输出可被 electron-updater 那样的解析器重新读回', () => {
  const out = buildDeployManifest(BASE);
  assert.strictEqual(yaml.load(out).files.length, 3);
});

test('buildDeployManifest: 长 url 不折行成块标量，各自独占一行', () => {
  const out = buildDeployManifest(BASE);
  assert.doesNotMatch(out, />-/);
  assert.match(out, /^ {2}- url: https:\/\/github\.com\/\S+arm64-mac\.zip$/m);
});

test('buildDeployManifest: 拒绝缺 sha512 的条目', () => {
  const broken = BUILD_MANIFEST.replace('    sha512: BBBB2222\n', '');
  assert.throws(
    () => buildDeployManifest({ ...BASE, manifestText: broken }),
    /files\[1\] 缺少 sha512/
  );
});

test('buildDeployManifest: 拒绝手改缩进错位的清单（url 变成多行字符串）', () => {
  const indented = `version: 1.2.0
files:
- url: 灵感笔记-1.2.0-arm64-mac.zip
    sha512: AAAA1111
    size: 112768946
`;
  assert.throws(() => buildDeployManifest({ ...BASE, manifestText: indented }), /bad indentation of a mapping entry/);
});

test('buildDeployManifest: 拒绝空 files', () => {
  assert.throws(() => buildDeployManifest({ ...BASE, manifestText: 'version: 1.2.0\n' }), /缺少 files 数组/);
});

test('buildDeployManifest: 清单版本与发布版本不一致时报错', () => {
  assert.throws(() => buildDeployManifest({ ...BASE, version: '1.3.0' }), /清单版本 1.2.0 与发布版本 1.3.0 不一致/);
});

// ============ buildRelativeManifest ============
test('buildRelativeManifest: dmg 保留中文原名，zip 换成 ASCII 相对名', () => {
  const out = yaml.load(buildRelativeManifest(BUILD_MANIFEST, { version: '1.2.0' }));
  assert.deepStrictEqual(out.files.map((f) => f.url), [
    'idea-note-1.2.0-arm64-mac.zip',
    'idea-note-1.2.0-mac.zip',
    '灵感笔记-1.2.0-arm64.dmg'
  ]);
  assert.strictEqual(out.path, 'idea-note-1.2.0-arm64-mac.zip');
});

test('buildRelativeManifest: sha512 / size / version 原样保留', () => {
  const out = yaml.load(buildRelativeManifest(BUILD_MANIFEST));
  assert.strictEqual(out.version, '1.2.0');
  assert.deepStrictEqual(out.files.map((f) => f.sha512), ['AAAA1111', 'BBBB2222', 'CCCC3333']);
  assert.deepStrictEqual(out.files.map((f) => f.size), [112768946, 117396139, 118114752]);
});

test('buildRelativeManifest: 不传 version 时跳过版本校验', () => {
  assert.ok(buildRelativeManifest(BUILD_MANIFEST).includes('url: idea-note-1.2.0-mac.zip'));
});

test('buildRelativeManifest: 同样拒绝缺 sha512 的条目', () => {
  const broken = BUILD_MANIFEST.replace('    sha512: CCCC3333\n', '');
  assert.throws(() => buildRelativeManifest(broken), /files\[2\] 缺少 sha512/);
});

// ============ verifyDigests ============
function makeFixtureDir(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-note-release-'));
  const files = Object.entries(contents).map(([name, text]) => {
    fs.writeFileSync(path.join(dir, name), text);
    return {
      name,
      sha512: crypto.createHash('sha512').update(text).digest('base64'),
      size: Buffer.byteLength(text)
    };
  });
  return { dir, files };
}

function manifestOf(files) {
  return yaml.dump({
    version: '1.2.0',
    files: files.map((f) => ({ url: f.name, sha512: f.sha512, size: f.size }))
  }, { lineWidth: -1 });
}

test('verifyDigests: 产物 sha512 / size 与清单一致时通过', () => {
  const { dir, files } = makeFixtureDir({ 'idea-note-1.2.0-mac.zip': 'hello', 'idea-note-1.2.0-arm64.dmg': 'world' });
  assert.deepStrictEqual(
    verifyDigests({ manifestText: manifestOf(files), dir }),
    ['idea-note-1.2.0-mac.zip  0MB', 'idea-note-1.2.0-arm64.dmg  0MB']
  );
});

test('verifyDigests: 清单 url 是 percent-encoded 中文时也能对上中文文件', () => {
  const { dir, files } = makeFixtureDir({ '灵感笔记-1.2.0-arm64.dmg': 'hello' });
  const manifest = manifestOf([{ ...files[0], name: encodeURIComponent('灵感笔记-1.2.0-arm64.dmg') }]);
  assert.strictEqual(verifyDigests({ manifestText: manifest, dir })[0].startsWith('灵感笔记-1.2.0-arm64.dmg'), true);
});

test('verifyDigests: 清单 url 是中文原名时直接按原名找文件', () => {
  const { dir, files } = makeFixtureDir({ '灵感笔记-1.2.0-arm64.dmg': 'hello' });
  const manifest = manifestOf([{ ...files[0], name: '灵感笔记-1.2.0-arm64.dmg' }]);
  assert.doesNotThrow(() => verifyDigests({ manifestText: manifest, dir }));
});

test('verifyDigests: 清单写中文名但目录只有 ASCII 名时报错（命名契约不能漂移）', () => {
  const { dir, files } = makeFixtureDir({ 'idea-note-1.2.0-arm64.dmg': 'hello' });
  const manifest = manifestOf([{ ...files[0], name: '灵感笔记-1.2.0-arm64.dmg' }]);
  assert.throws(() => verifyDigests({ manifestText: manifest, dir }), /ENOENT/);
});

test('verifyDigests: 字节数对不上时报错', () => {
  const { dir, files } = makeFixtureDir({ 'idea-note-1.2.0-mac.zip': 'hello' });
  const manifest = manifestOf([{ ...files[0], size: 999 }]);
  assert.throws(() => verifyDigests({ manifestText: manifest, dir }), /实际 5 字节，清单记录 999/);
});

test('verifyDigests: 内容被改动（sha512 不符）时报错', () => {
  const { dir, files } = makeFixtureDir({ 'idea-note-1.2.0-mac.zip': 'hello' });
  const manifest = manifestOf([{ ...files[0], sha512: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }]);
  assert.throws(() => verifyDigests({ manifestText: manifest, dir }), /sha512 与清单不一致/);
});

// ============ refreshDigests ============
test('refreshDigests: 装订改写 dmg 字节后，清单按磁盘实际内容重算', () => {
  const { dir, files } = makeFixtureDir({ 'idea-note-1.2.0-arm64.dmg': 'signed-and-stapled' });
  const stale = manifestOf([{ ...files[0], sha512: 'OLDSTALE', size: 1 }]);
  const refreshed = refreshDigests({ manifestText: stale, dir });
  assert.doesNotThrow(() => verifyDigests({ manifestText: refreshed, dir }));
  const out = yaml.load(refreshed);
  assert.strictEqual(out.files[0].size, Buffer.byteLength('signed-and-stapled'));
  assert.notStrictEqual(out.files[0].sha512, 'OLDSTALE');
});

test('refreshDigests: 只改哈希与字节数，url / version 原样保留', () => {
  const { dir, files } = makeFixtureDir({ 'idea-note-1.2.0-mac.zip': 'hello' });
  const before = yaml.load(manifestOf(files));
  const after = yaml.load(refreshDigests({ manifestText: manifestOf(files), dir }));
  assert.strictEqual(after.version, before.version);
  assert.deepStrictEqual(after.files.map((f) => f.url), before.files.map((f) => f.url));
});

test('refreshDigests: 清单登记的文件在目录里缺失时报错', () => {
  const { dir } = makeFixtureDir({ 'idea-note-1.2.0-mac.zip': 'hello' });
  const manifest = `version: 1.2.0
files:
  - url: idea-note-1.2.0-arm64.dmg
    sha512: AAAA
    size: 1
`;
  assert.throws(() => refreshDigests({ manifestText: manifest, dir }), /在 .* 中不存在/);
});
