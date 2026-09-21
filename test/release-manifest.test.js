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
  releaseAssetUrl,
  buildDeployManifest,
  buildRelativeManifest,
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

test('releaseAssetUrl: 拼出 GitHub Release 绝对地址', () => {
  assert.strictEqual(
    releaseAssetUrl('a/b', 'v1.2.0', '灵感笔记-1.2.0-mac.zip'),
    'https://github.com/a/b/releases/download/v1.2.0/idea-note-1.2.0-mac.zip'
  );
});

// ============ buildDeployManifest ============
test('buildDeployManifest: 所有 url 改写为 GitHub 绝对地址', () => {
  const out = yaml.load(buildDeployManifest(BASE));
  assert.deepStrictEqual(out.files.map((f) => f.url), [
    'https://github.com/hlf2002/idea-note-desktop/releases/download/v1.2.0/idea-note-1.2.0-arm64-mac.zip',
    'https://github.com/hlf2002/idea-note-desktop/releases/download/v1.2.0/idea-note-1.2.0-mac.zip',
    'https://github.com/hlf2002/idea-note-desktop/releases/download/v1.2.0/idea-note-1.2.0-arm64.dmg'
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
test('buildRelativeManifest: url 只换成 ASCII 相对名，可整目录直投静态服务器', () => {
  const out = yaml.load(buildRelativeManifest(BUILD_MANIFEST, { version: '1.2.0' }));
  assert.deepStrictEqual(out.files.map((f) => f.url), [
    'idea-note-1.2.0-arm64-mac.zip',
    'idea-note-1.2.0-mac.zip',
    'idea-note-1.2.0-arm64.dmg'
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

test('verifyDigests: 中文产物名也能按清单 url 对上（先转 ASCII 再查文件）', () => {
  const { dir, files } = makeFixtureDir({ 'idea-note-1.2.0-mac.zip': 'hello' });
  const manifest = manifestOf([{ ...files[0], name: '灵感笔记-1.2.0-mac.zip' }]);
  assert.strictEqual(verifyDigests({ manifestText: manifest, dir })[0].startsWith('idea-note-1.2.0-mac.zip'), true);
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
