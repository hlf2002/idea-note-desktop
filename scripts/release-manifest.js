'use strict';

/**
 * 发布清单改写：把 electron-builder 产出的 latest-mac.yml 中指向本地中文文件名的
 * files[].url，改写为 GitHub Release 的绝对下载地址（ASCII 资产名）。
 * 必须整体走 YAML 解析再序列化，逐行文本替换会让缩进错位的字段被并入 url 字符串。
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

function releaseAssetUrl(repo, tag, name) {
  if (!repo || !tag) throw new Error('缺少 repo 或 tag');
  return `https://github.com/${repo}/releases/download/${tag}/${asciiName(name)}`;
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
  if (typeof manifest.path === 'string') manifest.path = asciiName(manifest.path);

  const output = yaml.dump(manifest, { lineWidth: -1, noRefs: true });
  const reparsed = yaml.load(output);
  if (reparsed.files.length !== manifest.files.length) throw new Error('清单序列化后 files 数量变化');
  reparsed.files.forEach(assertCompleteFile);
  return output;
}

/** 相对地址清单：产物与清单落在同一目录，可直接挂到任意静态服务器 */
function buildRelativeManifest(manifestText, { version } = {}) {
  return rewriteManifest({ manifestText, version, urlFor: asciiName });
}

/** GitHub 绝对地址清单：安装包放 GitHub Release，清单单独放更新服务器时用 */
function buildDeployManifest({ manifestText, repo, tag, version }) {
  return rewriteManifest({
    manifestText,
    version,
    urlFor: (name) => releaseAssetUrl(repo, tag, name),
  });
}

/** 校验目录里的产物与清单记录的 sha512 / size 是否一致 */
function verifyDigests({ manifestText, dir }) {
  const manifest = yaml.load(manifestText);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('清单缺少 files 数组');
  return manifest.files.map((file, index) => {
    assertCompleteFile(file, index);
    const name = asciiName(file.url.split('/').pop());
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
  releaseAssetUrl,
  buildDeployManifest,
  buildRelativeManifest,
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
  } else if (mode === 'relative' && inPath && arg2) {
    const output = buildRelativeManifest(fs.readFileSync(inPath, 'utf8'), { version: arg3 });
    fs.mkdirSync(path.dirname(arg2), { recursive: true });
    fs.writeFileSync(arg2, output);
    console.log(`已生成同目录分发清单 ${arg2}`);
  } else {
    console.error('用法:');
    console.error('  node scripts/release-manifest.js github   <构建清单> <输出> <owner/repo> <tag> [version]');
    console.error('  node scripts/release-manifest.js relative <构建清单> <输出> [version]');
    console.error('  node scripts/release-manifest.js verify   <清单> <产物目录>');
    process.exit(2);
  }
}
