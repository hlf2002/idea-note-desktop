'use strict';

/**
 * 发布清单改写：把 electron-builder 产出的 latest-mac.yml 中指向本地文件名的
 * files[].url，改写为投放用的文件名或 GitHub Release 的绝对下载地址。
 * 必须整体走 YAML 解析再序列化，逐行文本替换会让缩进错位的字段被并入 url 字符串。
 *
 * 命名策略（两套名字，各有原因）：
 *   - .dmg        保留中文原名（灵感笔记-*.dmg）。dmg 只供人工下载，electron-updater
 *                 在 mac 上只消费 zip，不碰 dmg，所以中文名不影响更新链路。
 *   - 其余（zip/exe/blockmap）强制 ASCII（idea-note-*）。这些走自动更新，
 *                 URL 会经过 CDN / GitHub / 客户端 URL 解析，中文需要 percent-encode，
 *                 任一环不一致就是静默 404，不值得为文件名美观冒这个险。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PRODUCT_PREFIX = '灵感笔记';
const ASCII_PREFIX = 'idea-note';
const REQUIRED_FILE_FIELDS = ['url', 'sha512', 'size'];

function asciiName(name) {
  if (typeof name !== 'string' || !name) throw new Error('资产名不能为空');
  if (name.startsWith(PRODUCT_PREFIX)) return ASCII_PREFIX + name.slice(PRODUCT_PREFIX.length);
  return name;
}

/** 投放/清单里实际使用的名字：dmg 保留中文，更新链路上的资产转 ASCII */
function assetName(name) {
  if (typeof name !== 'string' || !name) throw new Error('资产名不能为空');
  return name.endsWith('.dmg') ? name : asciiName(name);
}

function releaseAssetUrl(repo, tag, name) {
  if (!repo || !tag) throw new Error('缺少 repo 或 tag');
  return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName(name))}`;
}

/** 从清单 url 还原磁盘上的文件名（绝对地址取其最后一段并解码） */
function diskNameOf(url) {
  const raw = String(url).split('/').pop();
  try {
    return decodeURIComponent(raw);
  } catch (e) {
    return raw;
  }
}

function assertCompleteFile(file, index) {
  for (const field of REQUIRED_FILE_FIELDS) {
    const value = file && file[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(`清单 files[${index}] 缺少 ${field}`);
    }
  }
}

function rewriteManifest({ manifestText, version, urlFor }) {
  const manifest = yaml.load(manifestText);
  if (!manifest || typeof manifest !== 'object') throw new Error('清单不是 YAML 对象');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('清单缺少 files 数组');
  }
  if (version && String(manifest.version) !== String(version)) {
    throw new Error(`清单版本 ${manifest.version} 与发布版本 ${version} 不一致`);
  }

  manifest.files.forEach(assertCompleteFile);
  manifest.files = manifest.files.map((file) => ({ ...file, url: urlFor(file.url) }));
  if (typeof manifest.path === 'string') manifest.path = assetName(manifest.path);

  const output = yaml.dump(manifest, { lineWidth: -1, noRefs: true });
  const reparsed = yaml.load(output);
  if (reparsed.files.length !== manifest.files.length) throw new Error('清单序列化后 files 数量变化');
  reparsed.files.forEach(assertCompleteFile);
  return output;
}

/** 相对地址清单：产物与清单落在同一目录，可直接挂到任意静态服务器 */
function buildRelativeManifest(manifestText, { version } = {}) {
  return rewriteManifest({ manifestText, version, urlFor: assetName });
}

/** GitHub 绝对地址清单：安装包放 GitHub Release，清单单独放更新服务器时用 */
function buildDeployManifest({ manifestText, repo, tag, version }) {
  return rewriteManifest({
    manifestText,
    version,
    urlFor: (name) => releaseAssetUrl(repo, tag, name),
  });
}

/**
 * 按磁盘实际内容重算 sha512 / size。
 * 必须的场景：dmg 先被 staple（票据写进文件尾部）再发清单，字节已变，
 * electron-builder 生成的 sha512 作废；不重算会让 electron-updater 拒绝更新。
 */
function refreshDigests({ manifestText, dir }) {
  const manifest = yaml.load(manifestText);
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('清单缺少 files 数组');
  }
  manifest.files = manifest.files.map((file, index) => {
    assertCompleteFile(file, index);
    const name = diskNameOf(file.url);
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) throw new Error(`清单里的 ${name} 在 ${dir} 中不存在`);
    const buffer = fs.readFileSync(target);
    return {
      ...file,
      sha512: crypto.createHash('sha512').update(buffer).digest('base64'),
      size: buffer.length
    };
  });
  return yaml.dump(manifest, { lineWidth: -1, noRefs: true });
}

/** 校验目录里的产物与清单记录的 sha512 / size 是否一致 */
function verifyDigests({ manifestText, dir }) {
  const manifest = yaml.load(manifestText);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('清单缺少 files 数组');
  return manifest.files.map((file, index) => {
    assertCompleteFile(file, index);
    const name = diskNameOf(file.url);
    const buffer = fs.readFileSync(path.join(dir, name));
    if (buffer.length !== file.size) {
      throw new Error(`${name} 实际 ${buffer.length} 字节，清单记录 ${file.size}`);
    }
    const sha512 = crypto.createHash('sha512').update(buffer).digest('base64');
    if (sha512 !== file.sha512) throw new Error(`${name} sha512 与清单不一致`);
    return `${name}  ${Math.round(buffer.length / 1048576)}MB`;
  });
}

module.exports = {
  asciiName,
  assetName,
  diskNameOf,
  releaseAssetUrl,
  buildDeployManifest,
  buildRelativeManifest,
  refreshDigests,
  verifyDigests
};

if (require.main === module) {
  const [mode, ...args] = process.argv.slice(2);
  const [inPath, arg2, arg3, arg4, arg5] = args;

  if (mode === 'verify') {
    console.log(verifyDigests({ manifestText: fs.readFileSync(inPath, 'utf8'), dir: arg2 }).join('\n'));
  } else if (mode === 'github' && inPath && arg2 && arg3 && arg4) {
    const output = buildDeployManifest({
      manifestText: fs.readFileSync(inPath, 'utf8'),
      repo: arg3,
      tag: arg4,
      version: arg5
    });
    fs.mkdirSync(path.dirname(arg2), { recursive: true });
    fs.writeFileSync(arg2, output);
    console.log(`已生成部署清单 ${arg2}`);
  } else if (mode === 'refresh' && inPath && arg2) {
    const output = refreshDigests({ manifestText: fs.readFileSync(inPath, 'utf8'), dir: arg2 });
    fs.writeFileSync(inPath, output);
    console.log(`已按实际产物重算清单 ${inPath}`);
  } else if (mode === 'relative' && inPath && arg2) {
    const output = buildRelativeManifest(fs.readFileSync(inPath, 'utf8'), { version: arg3 });
    fs.mkdirSync(path.dirname(arg2), { recursive: true });
    fs.writeFileSync(arg2, output);
    console.log(`已生成同目录分发清单 ${arg2}`);
  } else {
    console.error('用法:');
    console.error('  node scripts/release-manifest.js github   <构建清单> <输出> <owner/repo> <tag> [version]');
    console.error('  node scripts/release-manifest.js relative <构建清单> <输出> [version]');
    console.error('  node scripts/release-manifest.js refresh  <清单> <产物目录>');
    console.error('  node scripts/release-manifest.js verify   <清单> <产物目录>');
    process.exit(2);
  }
}
