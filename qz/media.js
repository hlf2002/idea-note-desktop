/**
 * qz/media.js —— 图片上传的本地辅助逻辑（纯函数，主进程与单测共用）
 *
 * 职责：
 *  1. validateImage：按扩展名 + 大小校验图片是否可上传（返回 mime，失败抛带中文提示的错误）
 *  2. mediaFileName / isSafeMediaFileName：本地媒体缓存文件名（image_id + 扩展名）与安全校验
 *
 * 背景：开放平台 /open/idea_note/* 只返回 image_id，不返回图片 URL，
 * 所以客户端要把上传成功的原图留在本地 <dataDir>/media/ 下，用于本机展示。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IMAGE_MAX_BYTES } = require('./config');

/** 允许的扩展名 -> MIME */
const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

/** 本地媒体文件名白名单：安全字符 + 2~5 位扩展名，杜绝路径穿越 */
const MEDIA_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.[a-z0-9]{2,5}$/;

/**
 * 由文件路径推断 MIME（不支持的类型返回 ''）
 * @param {string} filePath
 * @returns {string}
 */
function mimeFromPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  return EXT_MIME[path.extname(filePath).toLowerCase()] || '';
}

/**
 * 校验图片文件，返回 { mime, ext }；不合法时抛出中文错误。
 * @param {string} filePath
 * @param {number} size 字节数
 * @returns {{mime: string, ext: string}}
 */
function validateImage(filePath, size) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('请选择图片文件');
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gif' || ext === '.bmp') {
    throw new Error('平台不支持 GIF / BMP，请转成 JPG、PNG 或 WEBP');
  }
  const mime = EXT_MIME[ext];
  if (!mime) throw new Error('仅支持 JPG / PNG / WEBP 图片');
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) throw new Error('图片文件为空');
  if (n > IMAGE_MAX_BYTES) {
    throw new Error('图片超过 ' + Math.floor(IMAGE_MAX_BYTES / 1024 / 1024) + 'MB，请压缩后重试');
  }
  return { mime, ext };
}

/**
 * image_id -> 本地媒体缓存文件名。
 * image_id 里的非安全字符会被去掉；清洗前后不一致时追加短哈希，避免不同 id 清洗后撞名；
 * 若清洗后为空则直接用内容哈希兜底。
 * @param {string} imageId
 * @param {string} ext 带点扩展名，如 '.png'
 * @returns {string}
 */
function mediaFileName(imageId, ext) {
  const safeExt = EXT_MIME[String(ext || '').toLowerCase()] ? String(ext).toLowerCase() : '.jpg';
  const raw = String(imageId == null ? '' : imageId).trim();
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '');
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  let base;
  if (!cleaned) base = 'img_' + hash;
  else if (cleaned === raw) base = cleaned;
  else base = cleaned + '_' + hash;
  return (base.slice(0, 60) + safeExt);
}

/**
 * 校验媒体文件名是否安全（只允许白名单字符，禁止路径分隔符与 ..）
 * @param {string} name
 * @returns {boolean}
 */
function isSafeMediaFileName(name) {
  return typeof name === 'string' && MEDIA_NAME_RE.test(name);
}

/**
 * MediaStore —— 本地图片缓存（image_id -> 本机文件）。
 *
 * 平台不返回图片 URL，上传成功的原图必须留在本地才能在本机展示。
 * 目录：<dataDir>/media/<image_id>.<ext>；索引：<dataDir>/media-index.json（原子写）。
 */
class MediaStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir 媒体文件目录
   * @param {string} opts.indexFile 索引文件
   */
  constructor({ dir, indexFile }) {
    this.dir = dir;
    this.indexFile = indexFile;
  }

  /** 读取 image_id -> 文件名 映射；文件损坏时返回空映射（不抛错） */
  map() {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      const out = {};
      for (const key of Object.keys(data)) {
        if (isSafeMediaFileName(data[key])) out[key] = data[key];
      }
      return out;
    } catch (e) {
      return {};
    }
  }

  /**
   * 把已上传成功的原图存入本地缓存并登记映射。
   * @param {string} imageId 平台返回的 image_id
   * @param {string} srcPath 源文件绝对路径
   * @param {string} ext 带点扩展名
   * @returns {string} 本地文件名
   */
  save(imageId, srcPath, ext) {
    if (!imageId) throw new Error('缺少 image_id，无法缓存图片');
    const name = mediaFileName(imageId, ext);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.copyFileSync(srcPath, path.join(this.dir, name));
    const map = this.map();
    map[String(imageId)] = name;
    this._writeMap(map);
    return name;
  }

  /** 安全解析本地媒体文件绝对路径；不存在或名字不安全返回 null */
  filePath(name) {
    if (!isSafeMediaFileName(name)) return null;
    const p = path.join(this.dir, name);
    try {
      return fs.statSync(p).isFile() ? p : null;
    } catch (e) {
      return null;
    }
  }

  _writeMap(map) {
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    fs.renameSync(tmp, this.indexFile);
  }
}

module.exports = {
  mimeFromPath,
  validateImage,
  mediaFileName,
  isSafeMediaFileName,
  EXT_MIME,
  MediaStore
};
