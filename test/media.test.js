/**
 * media.test.js —— 图片上传本地辅助（校验 / 命名 / 本地缓存）与新建带图的单测
 * 覆盖 qz/media.js 与 qz/sync.js 的 createFromText(imageIds)。
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  validateImage,
  mediaFileName,
  isSafeMediaFileName,
  MediaStore
} = require('../qz/media');
const { IMAGE_MAX_BYTES } = require('../qz/config');
const { IdeaSync } = require('../qz/sync');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============ validateImage ============
test('validateImage: 允许 jpg/jpeg/png/webp 并返回对应 MIME', () => {
  assert.deepStrictEqual(validateImage('/a/b.jpg', 1024), { mime: 'image/jpeg', ext: '.jpg' });
  assert.deepStrictEqual(validateImage('/a/b.JPEG', 1024), { mime: 'image/jpeg', ext: '.jpeg' });
  assert.deepStrictEqual(validateImage('/a/b.png', 1024), { mime: 'image/png', ext: '.png' });
  assert.deepStrictEqual(validateImage('/a/b.webp', 1024), { mime: 'image/webp', ext: '.webp' });
});

test('validateImage: 拒绝 GIF / BMP / 无扩展名 / 空路径', () => {
  assert.throws(() => validateImage('/a/b.gif', 100), /GIF/);
  assert.throws(() => validateImage('/a/b.bmp', 100), /BMP/);
  assert.throws(() => validateImage('/a/b.txt', 100), /仅支持/);
  assert.throws(() => validateImage('', 100), /请选择图片文件/);
  assert.throws(() => validateImage(null, 100), /请选择图片文件/);
});

test('validateImage: 空文件与超限', () => {
  assert.throws(() => validateImage('/a/b.png', 0), /为空/);
  assert.throws(() => validateImage('/a/b.png', -1), /为空/);
  assert.throws(() => validateImage('/a/b.png', NaN), /为空/);
  assert.throws(() => validateImage('/a/b.png', IMAGE_MAX_BYTES + 1), /MB/);
  // 边界：正好等于上限允许
  assert.strictEqual(validateImage('/a/b.png', IMAGE_MAX_BYTES).mime, 'image/png');
});

// ============ mediaFileName / isSafeMediaFileName ============
test('mediaFileName: 保留安全字符并拼接扩展名', () => {
  assert.strictEqual(mediaFileName('img_abc-1', '.png'), 'img_abc-1.png');
  // 含非法字符（/ 与 .）：清洗后追加短哈希，保证不与 img_name 之类撞名
  const name = mediaFileName('2026_08_29/abc.jpg', '.jpg');
  assert.match(name, /^2026_08_29abcjpg_[0-9a-f]{8}\.jpg$/);
  assert.strictEqual(mediaFileName('a.b', '.jpg') === mediaFileName('ab', '.jpg'), false);
});

test('mediaFileName: 非法扩展名回退 .jpg', () => {
  assert.strictEqual(mediaFileName('img_x', '.gif'), 'img_x.jpg');
  assert.strictEqual(mediaFileName('img_x', ''), 'img_x.jpg');
});

test('mediaFileName: image_id 清洗后为空时用哈希兜底且结果唯一', () => {
  const a = mediaFileName('///', '.png');
  const b = mediaFileName('***', '.png');
  assert.ok(isSafeMediaFileName(a));
  assert.ok(isSafeMediaFileName(b));
  assert.notStrictEqual(a, b); // 不同 id 必须不同文件名，避免互相覆盖
});

test('mediaFileName: 超长 image_id 截断到 60 字符内', () => {
  const name = mediaFileName('a'.repeat(200), '.png');
  assert.ok(name.length <= 64);
  assert.ok(isSafeMediaFileName(name));
});

test('isSafeMediaFileName: 拒绝路径穿越与非法字符', () => {
  assert.strictEqual(isSafeMediaFileName('abc.png'), true);
  assert.strictEqual(isSafeMediaFileName('../etc/passwd'), false);
  assert.strictEqual(isSafeMediaFileName('a/b.png'), false);
  assert.strictEqual(isSafeMediaFileName('a b.png'), false);
  assert.strictEqual(isSafeMediaFileName('a.png.exe'), false);
  assert.strictEqual(isSafeMediaFileName(''), false);
  assert.strictEqual(isSafeMediaFileName(null), false);
});

// ============ MediaStore ============
test('MediaStore: save 复制文件并写入索引，map 可读回', () => {
  const dir = tmpDir('idea-note-media-');
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, Buffer.from('png-bytes'));
  const store = new MediaStore({
    dir: path.join(dir, 'media'),
    indexFile: path.join(dir, 'media-index.json')
  });

  const name = store.save('img_1', src, '.png');
  assert.strictEqual(name, 'img_1.png');
  assert.deepStrictEqual(store.map(), { img_1: 'img_1.png' });
  // 文件真的落盘且内容一致
  const saved = path.join(dir, 'media', name);
  assert.strictEqual(fs.readFileSync(saved, 'utf8'), 'png-bytes');
  // 幂等：重复保存同一 image_id 不产生重复键
  store.save('img_1', src, '.png');
  assert.deepStrictEqual(Object.keys(store.map()), ['img_1']);
});

test('MediaStore: save 缺少 image_id 时抛错', () => {
  const dir = tmpDir('idea-note-media-');
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, Buffer.from('x'));
  const store = new MediaStore({ dir: path.join(dir, 'media'), indexFile: path.join(dir, 'media-index.json') });
  assert.throws(() => store.save('', src, '.png'), /image_id/);
});

test('MediaStore: 索引文件损坏或不存在时 map 返回空对象（不抛错）', () => {
  const dir = tmpDir('idea-note-media-');
  const indexFile = path.join(dir, 'media-index.json');
  const store = new MediaStore({ dir: path.join(dir, 'media'), indexFile });
  assert.deepStrictEqual(store.map(), {});
  fs.writeFileSync(indexFile, '{oops');
  assert.deepStrictEqual(store.map(), {});
  fs.writeFileSync(indexFile, '[]');
  assert.deepStrictEqual(store.map(), {});
});

test('MediaStore: map 过滤掉不安全文件名（防索引被篡改为路径穿越）', () => {
  const dir = tmpDir('idea-note-media-');
  const indexFile = path.join(dir, 'media-index.json');
  fs.writeFileSync(indexFile, JSON.stringify({ ok: 'ok.png', bad: '../../etc/passwd' }));
  const store = new MediaStore({ dir: path.join(dir, 'media'), indexFile });
  assert.deepStrictEqual(store.map(), { ok: 'ok.png' });
});

test('MediaStore: filePath 只返回真实存在的安全文件', () => {
  const dir = tmpDir('idea-note-media-');
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, Buffer.from('x'));
  const store = new MediaStore({ dir: path.join(dir, 'media'), indexFile: path.join(dir, 'media-index.json') });
  store.save('img_2', src, '.png');
  assert.ok(store.filePath('img_2.png'));
  assert.strictEqual(store.filePath('nope.png'), null);
  assert.strictEqual(store.filePath('../media-index.json'), null);
  assert.strictEqual(store.filePath(''), null);
});

// ============ IdeaSync.createFromText（带图）============
function makeSync(dir, captured) {
  const api = {
    isAuthed: true,
    async createNote(payload) {
      captured.push(payload);
      return {
        id: 777,
        plain_text: '带图笔记',
        tags: [],
        images: Array.isArray(payload.images) ? payload.images : [],
        image_url: '',
        create_time: 1000,
        update_time: 1000
      };
    }
  };
  return new IdeaSync({ api, cacheFile: path.join(dir, 'cache.json') });
}

test('createFromText: 传 imageIds 时 images 进入请求体，content_json 仍是字符串', async () => {
  const dir = tmpDir('idea-note-sync-');
  const captured = [];
  const sync = makeSync(dir, captured);
  const memo = await sync.createFromText('带图 #灵感', ['img_a', 'img_b']);

  assert.strictEqual(captured.length, 1);
  assert.deepStrictEqual(captured[0].images, ['img_a', 'img_b']);
  // sync 层传对象给 api，由 QzOpenApi._serializeContent 序列化成字符串（openapi.test.js 覆盖）
  assert.strictEqual(captured[0].content_json.type, 'doc');
  assert.deepStrictEqual(memo.imageIds, ['img_a', 'img_b']);
});

test('createFromText: 无图时请求体不带 images 字段', async () => {
  const dir = tmpDir('idea-note-sync-');
  const captured = [];
  const sync = makeSync(dir, captured);
  await sync.createFromText('只有文字');
  assert.strictEqual(captured[0].images, undefined);
});

test('createFromText: 过滤空值与非法 imageId', async () => {
  const dir = tmpDir('idea-note-sync-');
  const captured = [];
  const sync = makeSync(dir, captured);
  await sync.createFromText('x', ['img_a', '', null, 42]);
  assert.deepStrictEqual(captured[0].images, ['img_a']);
});

test('createFromText: 纯图片（无文字）允许；无文字且无图被拒绝', async () => {
  const dir = tmpDir('idea-note-sync-');
  const captured = [];
  const sync = makeSync(dir, captured);
  await sync.createFromText('', ['img_a']);
  assert.strictEqual(captured.length, 1);
  await assert.rejects(() => sync.createFromText('   ', []), /不能为空/);
  await assert.rejects(() => sync.createFromText(null, null), /不能为空/);
  assert.strictEqual(captured.length, 1);
});
