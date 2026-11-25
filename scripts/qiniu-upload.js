#!/usr/bin/env node
'use strict';

/**
 * 七牛 Kodo 上传：把一个「已通过 sha512 校验」的产物目录整体投放到对象存储，
 * 作为 electron-updater（generic provider）的更新源。
 *
 * 用法：
 *   node scripts/qiniu-upload.js --dir dist/package
 *   node scripts/qiniu-upload.js --dir deploy/artifacts-<ts>/mac/package --dry-run
 *   node scripts/qiniu-upload.js --dir dist/package --check        # 只核对远端，不上传
 *
 * 凭据来源（优先级从高到低，均不写在代码里）：
 *   1. 环境变量：QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET
 *                可选 QINIU_PREFIX / QINIU_UPLOAD_HOST / QINIU_PUBLIC_BASE / QINIU_RS_HOST /
 *                QINIU_CDN_HOST
 *   2. .release.config.json 的 qiniu 段（已 gitignore，模板 .release.config.example.json）
 *
 * 顺序契约：先传安装包与 blockmap，最后传 latest*.yml。
 *   electron-updater 只在清单更新后感知新版本，先传包可杜绝「清单已更新但包 404」。
 *
 * 发布生效：清单传完后修正其 Content-Type（text/yaml; charset=utf-8，防浏览器按 GBK 解码乱码），
 *   再提交一次 CDN 刷新 —— 否则客户端可能继续拿到被缓存的旧清单（--no-cdn 可跳过）。
 *
 * 可重入：同 key 覆盖写（putPolicy.insertOnly=0），重复执行不残留旧对象；
 *   每个对象上传后立即 stat 校验字节数，不一致即失败退出（不会留下半套产物）。
 *
 * 退出码：0 成功；1 上传或校验失败；2 参数/配置错误。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, '.release.config.json');

const DEFAULT_PREFIX = 'autoupdates/';
const DEFAULT_UPLOAD_HOST = 'https://upload.qiniup.com';
const DEFAULT_RS_HOST = 'https://rs.qiniu.com';
const DEFAULT_CDN_HOST = 'https://fusion.qiniuapi.com';
const DEFAULT_RETRIES = 3;
const RETRY_DELAY_MS = 800;
const TOKEN_TTL_SECONDS = 3600;
// 单个对象的上传超时：120MB 在 2Mbps 上行约 8 分钟，留足余量；可用环境变量覆盖
const UPLOAD_TIMEOUT_MS = Number(process.env.QINIU_UPLOAD_TIMEOUT_MS || 600000);
const STAT_TIMEOUT_MS = 30000;

// 清单是 UTF-8（里面可能有中文文件名）。七牛对 .yml 推断 text/yaml 不带 charset，
// 浏览器会按系统码页（zh-CN 是 GBK）解码，于是「灵感笔记」显示成乱码。
// electron-updater 一律按 UTF-8 读，不受影响；这里只为人肉查看/排障服务。
const MANIFEST_CONTENT_TYPE = 'text/yaml; charset=utf-8';

// electron-builder 产出的清单名：latest-mac.yml / latest.yml / latest-linux.yml（及其 .yaml 变体）
const MANIFEST_PATTERN = /^latest(?:-[a-z]+)?\.ya?ml$/;

class ConfigError extends Error {}
class UploadError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal;
  }
}

const say = (msg) => console.log(msg);
const ok = (msg) => console.log(`  \u001b[32m\u2713\u001b[0m ${msg}`);
const warn = (msg) => console.log(`  \u001b[33m!\u001b[0m ${msg}`);
const die = (msg) => {
  console.error(`\u001b[31m\u2717 ${msg}\u001b[0m`);
  process.exit(1);
};

// ---------------------------------------------------------------- 编码与签名

/**
 * 七牛要求的 URL 安全 Base64：+ / 换成 - _，**保留尾部 padding**。
 * 2026-11-25 真机实测：去掉 padding 后上传凭证、stat 管理凭证一律返回
 * `401 {"error":"bad token","error_code":"BadToken"}`——七牛按带 padding 的
 * urlsafe base64 校验签名；官方 SDK（qiniu-python 等）同样保留 padding。
 * 以前这里是去 padding 的，导致真实链路从未上传成功过（单测只比对自算值，没连过七牛）。
 */
function urlSafeBase64(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** 对象 key 的前缀归一：去首部斜杠、补尾部斜杠；空串表示桶根 */
function normalizePrefix(prefix) {
  const trimmed = String(prefix == null ? '' : prefix).trim().replace(/^\/+/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function objectKey(prefix, name) {
  return normalizePrefix(prefix) + name;
}

/** 上传凭证：accessKey:sign:encodedPutPolicy（sign = HMAC-SHA1(secretKey, policy)） */
function uploadToken({ accessKey, secretKey, bucket, key, expiresIn = TOKEN_TTL_SECONDS, now } = {}) {
  if (!accessKey || !secretKey || !bucket) {
    throw new ConfigError('生成上传凭证需要 accessKey / secretKey / bucket');
  }
  if (!key) throw new ConfigError('生成上传凭证需要对象 key');
  const baseSeconds = now == null
    ? Math.floor(Date.now() / 1000)
    : Math.floor(now instanceof Date ? now.getTime() / 1000 : Number(now));
  // insertOnly=0：允许覆盖同名 key，这是脚本可重复执行的前提
  const policy = { scope: `${bucket}:${key}`, deadline: baseSeconds + expiresIn, insertOnly: 0 };
  const encodedPolicy = urlSafeBase64(JSON.stringify(policy));
  const sign = urlSafeBase64(crypto.createHmac('sha1', secretKey).update(encodedPolicy).digest());
  return `${accessKey}:${sign}:${encodedPolicy}`;
}

/** EncodedEntryURI = urlsafe_base64(bucket:key) */
function encodedEntry(bucket, key) {
  return urlSafeBase64(`${bucket}:${key}`);
}

/** 管理凭证：QBox accessKey:urlsafe_base64(HMAC-SHA1(secretKey, path + "\n")) */
function managementToken({ accessKey, secretKey, path: requestPath } = {}) {
  if (!accessKey || !secretKey) throw new ConfigError('生成管理凭证需要 accessKey / secretKey');
  if (!requestPath) throw new ConfigError('生成管理凭证需要请求路径');
  const sign = urlSafeBase64(crypto.createHmac('sha1', secretKey).update(`${requestPath}\n`).digest());
  return `QBox ${accessKey}:${sign}`;
}

// ---------------------------------------------------------------- 配置解析

function readConfigFile(file = CONFIG_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new ConfigError(`${path.basename(file)} 不是合法 JSON：${e.message}`);
  }
}

function stripTrailingSlash(url) {
  return String(url).trim().replace(/\/+$/, '');
}

function withScheme(host, fallback) {
  const value = String(host == null ? '' : host).trim();
  if (!value) return fallback;
  return stripTrailingSlash(/^https?:\/\//i.test(value) ? value : `https://${value}`);
}

/**
 * 解析生效配置：环境变量 > .release.config.json > 默认值。
 * 返回 from 记录每项的实际来源，便于排障时确认「到底读到了哪份配置」。
 */
function resolveConfig({ env = process.env, config = readConfigFile(env.QINIU_CONFIG_FILE), requireCredentials = true } = {}) {
  const fileQiniu = (config && config.qiniu) || {};
  const pick = (envKey, fileKey, fallback) => {
    const envValue = env[envKey];
    if (envValue != null && String(envValue).trim() !== '') {
      return { value: String(envValue).trim(), from: `env ${envKey}` };
    }
    const fileValue = fileQiniu[fileKey];
    if (fileValue != null && String(fileValue).trim() !== '') {
      return { value: String(fileValue).trim(), from: `.release.config.json qiniu.${fileKey}` };
    }
    return { value: fallback, from: '默认值' };
  };

  const accessKey = pick('QINIU_ACCESS_KEY', 'accessKey', '');
  const secretKey = pick('QINIU_SECRET_KEY', 'secretKey', '');
  const bucket = pick('QINIU_BUCKET', 'bucket', '');
  const prefix = pick('QINIU_PREFIX', 'prefix', DEFAULT_PREFIX);
  const uploadHost = pick('QINIU_UPLOAD_HOST', 'uploadHost', DEFAULT_UPLOAD_HOST);
  const rsHost = pick('QINIU_RS_HOST', 'rsHost', DEFAULT_RS_HOST);
  const cdnHost = pick('QINIU_CDN_HOST', 'cdnHost', DEFAULT_CDN_HOST);
  const publicBase = pick('QINIU_PUBLIC_BASE', 'publicBase', '');

  const missing = [
    ['QINIU_ACCESS_KEY', accessKey],
    ['QINIU_SECRET_KEY', secretKey],
    ['QINIU_BUCKET', bucket]
  ].filter(([, item]) => !item.value).map(([name]) => name);

  if (missing.length && requireCredentials) {
    throw new ConfigError(
      `缺少七牛凭据：${missing.join(' / ')}\n` +
      '  方式一（推荐，不入库）：在 .release.config.json 增加 qiniu 段\n' +
      '    { "qiniu": { "accessKey": "...", "secretKey": "...", "bucket": "...", "prefix": "autoupdates/" } }\n' +
      `    模板见 .release.config.example.json（模板入库，只有真凭据的 .release.config.json 被 gitignore）\n` +
      '  方式二（CI）：以环境变量注入，见 docs/DEPLOY.md §3.2'
    );
  }

  return {
    accessKey: accessKey.value,
    secretKey: secretKey.value,
    bucket: bucket.value,
    prefix: normalizePrefix(prefix.value),
    uploadHost: withScheme(uploadHost.value, DEFAULT_UPLOAD_HOST),
    rsHost: withScheme(rsHost.value, DEFAULT_RS_HOST),
    cdnHost: withScheme(cdnHost.value, DEFAULT_CDN_HOST),
    publicBase: publicBase.value ? stripTrailingSlash(withScheme(publicBase.value, '')) : '',
    from: { accessKey: accessKey.from, bucket: bucket.from, prefix: prefix.from, uploadHost: uploadHost.from }
  };
}

/** 凭据只以掩码形式出现在日志里，避免 CI 控制台泄漏 */
function mask(value) {
  if (!value) return '（未配置）';
  return value.length <= 4 ? '****' : `${value.slice(0, 4)}****`;
}

// ---------------------------------------------------------------- 上传计划

/**
 * 列出待上传对象：安装包/blockmap 在前，清单在最后。
 * 只取目录第一层的普通文件（stage_assets 已把产物摊平）；子目录忽略。
 */
function planUploads(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new ConfigError(`读取产物目录失败：${dir}（${e.code === 'ENOENT' ? '目录不存在' : e.message}）`);
  }
  // 跳过隐藏文件：在 Finder 里打开过产物目录就会留下 .DS_Store，绝不能传上去
  const names = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  const manifests = names.filter((name) => MANIFEST_PATTERN.test(name));
  const payload = names.filter((name) => !MANIFEST_PATTERN.test(name));

  if (manifests.length === 0) {
    throw new ConfigError(
      `目录 ${dir} 里没有 latest*.yml 清单，客户端拿不到版本信息。` +
      '请先用 npm run package（mac）或 npm run package:win（win）产出完整目录。'
    );
  }
  if (payload.length === 0) {
    throw new ConfigError(`目录 ${dir} 里只有清单没有安装包，拒绝上传（会造成清单指向 404）`);
  }
  return { payload, manifests, all: [...payload, ...manifests] };
}

/** 上传前用与线上同一套规则再校验一次 sha512/字节数，防止把对不上的清单推上去 */
function verifyLocalDigests(dir, manifests) {
  let verifyDigests;
  try {
    ({ verifyDigests } = require('./release-manifest'));
  } catch (e) {
    // 校验是发布门禁，不是可选增强：加载不到就说明依赖不全，直接判配置错误，
    // 否则会「看起来校验了、其实整批对象裸传」。
    throw new ConfigError(
      `无法完成 sha512 预校验（发布门禁，不允许裸传）：${e.code === 'MODULE_NOT_FOUND' ? '缺少 js-yaml，先 npm install' : e.message}`
    );
  }
  for (const name of manifests) {
    const manifestText = fs.readFileSync(path.join(dir, name), 'utf8');
    const lines = verifyDigests({ manifestText, dir });
    ok(`${name} 与目录内 ${lines.length} 个产物 sha512 配对`);
  }
}

// ---------------------------------------------------------------- 网络动作

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const mb = bytes / 1048576;
  if (mb >= 10) return `${Math.round(mb)}MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 把七牛的错误码翻译成能直接照做的处置建议 */
function explainFailure(reason, status) {
  const text = String(reason || '');
  if (/incorrect region/i.test(text)) return '上传区域不符：脚本会自动按七牛提示的域名重试一次；仍失败请核对 QINIU_UPLOAD_HOST';
  if (/no such bucket|631/i.test(text)) return 'bucket 不存在：核对 QINIU_BUCKET 拼写与账号归属';
  if (/file exists|614/i.test(text)) return '对象已存在且禁用了覆盖：确认 putPolicy.insertOnly=0（脚本已默认设置）';
  if (/bad token|invalid token|401|403/i.test(text)) {
    return '凭据被拒：核对 QINIU_ACCESS_KEY / QINIU_SECRET_KEY 是否同属一个账号，且对该 bucket 有写权限';
  }
  if (/expired|deadline/i.test(text)) return '上传凭证过期：检查打包机系统时间是否漂移（七牛 deadline 以秒为单位）';
  if (/no such file|612|404/i.test(text)) return '远端对象不存在：确认前缀与 bucket 正确';
  if (status >= 500 || status === 599) return '七牛服务端错误/网络抖动：脚本已自动重试，仍失败请稍后再试';
  return '查看七牛返回内容定位；凭据与桶配置见 .release.config.json 的 qiniu 段';
}

async function putObject({ cfg, dir, name, fetchImpl = globalThis.fetch, sleepImpl = defaultSleep, retries = DEFAULT_RETRIES }) {
  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('当前 Node 没有全局 fetch，需要 Node.js >= 18（或 20+ 更稳妥）');
  }
  const key = objectKey(cfg.prefix, name);
  const buffer = fs.readFileSync(path.join(dir, name));
  let lastError;
  let lastStatus = 0;
  let regionCorrected = false;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const form = new FormData();
      form.append('token', uploadToken({ ...cfg, key }));
      form.append('key', key);
      form.append('file', new Blob([buffer]), name);
      const res = await fetchImpl(`${cfg.uploadHost}/`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
      });
      const text = await res.text();
      let body = {};
      try { body = JSON.parse(text); } catch (e) { /* 非 JSON 响应用原文兜底 */ }

      if (res.ok && body.key === key) return { key, size: buffer.length, hash: body.hash };

      const reason = body.error || text.slice(0, 200) || `HTTP ${res.status}`;
      lastStatus = res.status;
      const error = new UploadError(`${key} 上传失败（HTTP ${res.status}）：${reason}`);
      // 4xx 一般是凭据/桶/策略问题，重试只会得到同样结果；唯一例外是「上传区域不符」：
      // 七牛会明文告知正确域名（如 up-z2.qiniup.com），换成它再试一次即可，别当致命错误。
      if (res.status >= 400 && res.status < 500) {
        const regionHint = /incorrect region.*?please use\s+([a-z0-9.-]+)/i.exec(reason);
        if (regionHint && !regionCorrected && cfg.uploadHost !== `https://${regionHint[1]}`) {
          regionCorrected = true;
          warn(`${key} 上传区域不符，改用七牛提示的域名 https://${regionHint[1]}（原 ${cfg.uploadHost}）重试`);
          cfg.uploadHost = `https://${regionHint[1]}`;
          attempt -= 1; // 换域名这一次不消耗重试次数
          continue;
        }
        error.fatal = true;
        error.hint = explainFailure(reason, res.status);
        throw error;
      }
      lastError = error;
    } catch (e) {
      if (e instanceof UploadError && e.fatal) throw e;
      if (e instanceof ConfigError) throw e;
      lastError = new UploadError(`${key} 上传异常：${e.message}`);
    }
    if (attempt < retries) {
      const wait = RETRY_DELAY_MS * attempt;
      warn(`${key} 第 ${attempt}/${retries} 次失败，${wait}ms 后重试（${lastError.message}）`);
      await sleepImpl(wait);
    }
  }
  lastError.hint = lastError.hint || explainFailure(lastError.message, lastStatus);
  throw lastError;
}

/** 远端 stat：存在返回 { size, hash }，不存在返回 null */
async function statObject({ cfg, key, fetchImpl = globalThis.fetch }) {
  const requestPath = `/stat/${encodedEntry(cfg.bucket, key)}`;
  const res = await fetchImpl(`${cfg.rsHost}${requestPath}`, {
    method: 'POST',
    headers: { Authorization: managementToken({ accessKey: cfg.accessKey, secretKey: cfg.secretKey, path: requestPath }) },
    signal: AbortSignal.timeout(STAT_TIMEOUT_MS)
  });
  if (res.status === 612 || res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    const error = new UploadError(`查询 ${key} 失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    error.hint = explainFailure(text, res.status);
    throw error;
  }
  const body = JSON.parse(text);
  return { size: Number(body.fsize), hash: body.hash, mime: body.mimeType };
}

/** 公网访问 URL：逐段 percent-encode（中文 dmg 名必须编码），对象 key 本身仍是原始 UTF-8 */
function publicUrlFor(cfg, key) {
  if (!cfg.publicBase) return '';
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${cfg.publicBase}/${encoded}`;
}

/** 公网可达性（可选）：HEAD 公开域名，确认 CDN 上能拿到该对象 */
async function checkPublic({ cfg, key, size, fetchImpl = globalThis.fetch }) {
  if (!cfg.publicBase) return { skipped: true };
  const url = publicUrlFor(cfg, key);
  try {
    const res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    const length = Number(res.headers.get('content-length'));
    return { url, status: res.status, length: Number.isFinite(length) ? length : null, size };
  } catch (e) {
    return { url, status: 0, error: e.message, size };
  }
}

/**
 * 修正对象 MIME：`POST /chgm/<urlsafe_b64(bucket:key)>/mime/<urlsafe_b64(mime)>`，body 为空。
 * 与官方 SDK 的 `changeMimeOp`（qiniu/storage/rs.js）同形。
 */
async function changeMime({ cfg, key, mime = MANIFEST_CONTENT_TYPE, fetchImpl = globalThis.fetch }) {
  const requestPath = `/chgm/${encodedEntry(cfg.bucket, key)}/mime/${urlSafeBase64(mime)}`;
  const res = await fetchImpl(`${cfg.rsHost}${requestPath}`, {
    method: 'POST',
    headers: {
      Authorization: managementToken({ accessKey: cfg.accessKey, secretKey: cfg.secretKey, path: requestPath })
    },
    signal: AbortSignal.timeout(STAT_TIMEOUT_MS)
  });
  const text = await res.text();
  if (!res.ok) {
    const error = new UploadError(`修正 ${key} 的 Content-Type 失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
    error.hint = explainFailure(text, res.status);
    throw error;
  }
  return { mime };
}

/**
 * 刷新 CDN：`POST /v2/tune/refresh`，body `{"urls":[...]}`。
 * 签名只覆盖 path —— 官方 SDK 这里显式用空 body 生成凭证（qiniu/cdn.js: generateAccessToken(mac, url, '')），
 * 把 JSON body 算进签名反而会被拒。
 */
async function refreshCdn({ cfg, urls, fetchImpl = globalThis.fetch }) {
  const requestPath = '/v2/tune/refresh';
  const res = await fetchImpl(`${cfg.cdnHost}${requestPath}`, {
    method: 'POST',
    headers: {
      Authorization: managementToken({ accessKey: cfg.accessKey, secretKey: cfg.secretKey, path: requestPath }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ urls }),
    signal: AbortSignal.timeout(STAT_TIMEOUT_MS)
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch (e) { /* 非 JSON 响应用原文兜底 */ }
  const reason = body.error || text;
  if (!res.ok || (body.code != null && Number(body.code) !== 200)) {
    const error = new UploadError(`刷新 CDN 失败（HTTP ${res.status}${body.code ? ` / code ${body.code}` : ''}）：${String(reason).slice(0, 200)}`);
    // 刷新接口的 403 常见是「URL 不在该域名下」，不是凭据问题，别按 explainFailure 判成密钥错误
    error.hint = /domain|域名|not in/i.test(String(reason))
      ? 'URL 不在该 CDN 域名下：核对 QINIU_PUBLIC_BASE 是否就是为该 bucket 绑定的域名（且不含 prefix）'
      : explainFailure(reason, res.status);
    throw error;
  }
  return { urls, requestId: body.requestId || body.request_id || '' };
}

// ---------------------------------------------------------------- CLI

const HELP = `用法：node scripts/qiniu-upload.js --dir <产物目录> [选项]

选项
  --dir <dir>          产物目录（必填，须含 latest*.yml 与安装包）
  --prefix <prefix>    对象 key 前缀，覆盖配置；默认 autoupdates/
  --dry-run            只打印计划，不联网、不要求凭据
  --check              不写数据，只核对远端是否已有同名同大小对象
  --skip-unchanged     远端已存在且大小一致时跳过上传（省流量，默认仍覆盖写）
  --with-manifest      同时上传 latest*.yml（开启客户端自动升级；默认只传安装包，不动清单）
  --strict-public      公网 HEAD 失败即判失败（默认仅告警，避免 CDN 缓存误伤发布）
  --no-cdn             跳过清单 Content-Type 修正与 CDN 刷新
  --strict-cdn         Content-Type / CDN 刷新失败即判失败（默认仅告警）
  --retries <n>        单文件重试次数，默认 ${DEFAULT_RETRIES}
  -h, --help           显示本帮助

凭据：QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET（环境变量或 .release.config.json）
`;

function parseArgs(argv) {
  const opts = { dir: '', prefix: null, dryRun: false, check: false, skipUnchanged: false, strictPublic: false, noCdn: false, strictCdn: false, retries: DEFAULT_RETRIES };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new ConfigError(`${arg} 缺少取值`);
      i += 1;
      return next;
    };
    if (arg === '--dir') opts.dir = value();
    else if (arg.startsWith('--dir=')) opts.dir = arg.slice(6);
    else if (arg === '--prefix') opts.prefix = value();
    else if (arg.startsWith('--prefix=')) opts.prefix = arg.slice(9);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--skip-unchanged') opts.skipUnchanged = true;
    else if (arg === '--with-manifest') opts.withManifest = true;
    else if (arg === '--strict-public') opts.strictPublic = true;
    else if (arg === '--no-cdn') opts.noCdn = true;
    else if (arg === '--strict-cdn') opts.strictCdn = true;
    else if (arg === '--retries') opts.retries = Number(value());
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new ConfigError(`未知参数：${arg}（--help 查看用法）`);
  }
  if (!opts.help && !opts.dir) throw new ConfigError('缺少 --dir（--help 查看用法）');
  if (!Number.isInteger(opts.retries) || opts.retries < 1) throw new ConfigError('--retries 需要正整数');
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    say(HELP);
    return 0;
  }

  const dir = path.resolve(opts.dir);
  const cfg = resolveConfig({ requireCredentials: !opts.dryRun });
  if (opts.prefix) cfg.prefix = normalizePrefix(opts.prefix);

  const plan = planUploads(dir);
  // 默认只传安装包与 blockmap，不上传 latest*.yml —— 清单是「自动升级开关」，
  // 由用户明确要求发自动升级时才用 --with-manifest 覆盖（2026-11-25 用户要求）。
  if (!opts.withManifest && plan.payload.length === 0) {
    throw new ConfigError(`目录 ${dir} 里只有清单没有安装包，拒绝上传（会造成清单指向 404）`);
  }
  const uploadNames = opts.withManifest ? plan.all : plan.payload;
  say(`\u001b[36m\u25b8\u001b[0m 七牛投放 · bucket=${cfg.bucket || '（未配置）'} · 前缀=${cfg.prefix || '（桶根）'} · 目标=${cfg.uploadHost}`);
  say(`  凭据 ${mask(cfg.accessKey)}（${cfg.from.accessKey}）· 共 ${uploadNames.length} 个对象 · 清单${opts.withManifest ? '最后上传（自动升级已开启）' : '不上传（自动升级未开启）'}`);

  if (!opts.dryRun) verifyLocalDigests(dir, plan.manifests);

  if (opts.dryRun) {
    for (const name of uploadNames) {
      const size = fs.statSync(path.join(dir, name)).size;
      const suffix = MANIFEST_PATTERN.test(name) ? '  （清单，最后上传）' : '';
      say(`  \u00b7 ${objectKey(cfg.prefix, name)}  ${formatSize(size)}${suffix}`);
    }
    if (!opts.withManifest) say('  \u00b7 latest*.yml 本次不上传（自动升级未开启，需 --with-manifest）');
    say('dry-run 结束：未联网、未写入');
    return 0;
  }

  const failures = [];
  for (const name of uploadNames) {
    const key = objectKey(cfg.prefix, name);
    const localSize = fs.statSync(path.join(dir, name)).size;
    try {
      const remote = await statObject({ cfg, key });
      if (remote && remote.size === localSize && (opts.check || opts.skipUnchanged)) {
        ok(`${key}  ${formatSize(localSize)}  ${opts.check ? '远端已存在且大小一致' : '远端已是最新，跳过上传'}`);
        continue;
      }
      if (opts.check) {
        failures.push(`${key} 远端${remote ? `大小 ${remote.size} ≠ 本地 ${localSize}` : '不存在'}`);
        continue;
      }
      const uploaded = await putObject({ cfg, dir, name, retries: opts.retries });
      const verified = await statObject({ cfg, key });
      if (!verified) throw new UploadError(`${key} 上传后查不到对象`);
      if (verified.size !== uploaded.size) {
        throw new UploadError(`${key} 大小校验失败：远端 ${verified.size} ≠ 本地 ${uploaded.size}`);
      }
      ok(`${key}  ${formatSize(uploaded.size)}  fsize=${verified.size}`);

      const pub = await checkPublic({ cfg, key, size: uploaded.size });
      if (!pub.skipped) {
        if (pub.status === 200 && (pub.length == null || pub.length === uploaded.size)) {
          ok(`公网可达 ${pub.url}（${pub.status}）`);
        } else if (opts.strictPublic) {
          failures.push(`公网不可达 ${pub.url}（HTTP ${pub.status || pub.error}）`);
        } else {
          warn(`公网未就绪 ${pub.url}（HTTP ${pub.status || pub.error}）——CDN 缓存/防盗链常见，stat 已验证对象落盘`);
        }
      }
    } catch (e) {
      failures.push(`${key}：${e.message}${e.hint ? `\n      处置：${e.hint}` : ''}`);
      if (e.fatal) break; // 凭据/桶级错误，继续传只会重复失败
    }
  }

  // ---- 发布生效的最后一步：清单 Content-Type + CDN 刷新
  // 上传成功不等于客户端能看到新版本：清单若被 CDN 缓存，客户端会继续拿旧版本。
  // 清单没上传时（未开启自动升级）不去动它的 MIME，只刷新本次真正上传的包。
  if (!failures.length && !opts.check && !opts.noCdn) {
    if (opts.withManifest) {
      for (const name of plan.manifests) {
      const key = objectKey(cfg.prefix, name);
      try {
        await changeMime({ cfg, key });
        ok(`${key}  Content-Type=${MANIFEST_CONTENT_TYPE}`);
      } catch (e) {
        if (opts.strictCdn) failures.push(`${key}：${e.message}`);
        else warn(`${key} 的 Content-Type 未修正（不影响 electron-updater）：${e.message}`);
      }
      }
    }

    const urls = uploadNames.map((name) => publicUrlFor(cfg, objectKey(cfg.prefix, name))).filter(Boolean);
    if (urls.length === 0) {
      warn('未配置 QINIU_PUBLIC_BASE，跳过 CDN 刷新（没有公网域名可刷新）');
    } else {
      try {
        const refreshed = await refreshCdn({ cfg, urls });
        ok(`CDN 刷新已提交（${refreshed.urls.length} 个 URL${refreshed.requestId ? `，requestId=${refreshed.requestId}` : ''}）`);
      } catch (e) {
        if (opts.strictCdn) failures.push(`CDN 刷新：${e.message}`);
        else warn(`CDN 刷新失败（对象已落盘，可稍后重跑）：${e.message}`);
      }
    }
  }

  if (failures.length) {
    console.error(`\u001b[31m\u2717 七牛投放失败 ${failures.length} 项\u001b[0m`);
    for (const line of failures) console.error(`  ${line}`);
    console.error('  已上传的对象可由下一次执行覆盖修正（脚本按 key 覆盖写，可重复执行）');
    return 1;
  }

  say(`\u001b[36m\u25b8\u001b[0m 完成：${uploadNames.length} 个对象已就位并校验（bucket=${cfg.bucket} 前缀=${cfg.prefix || '桶根'}）`);
  if (opts.withManifest) {
    say(`  更新源前缀 ${cfg.prefix || '（桶根）'} —— 客户端拉取 latest*.yml 时按清单内相对文件名取包`);
  } else {
    say('  latest*.yml 未更新：客户端自动升级不触发（用户要求只在明确“发自动升级”时才换清单）');
  }
  return 0;
}

module.exports = {
  ConfigError,
  UploadError,
  main,
  urlSafeBase64,
  normalizePrefix,
  objectKey,
  uploadToken,
  encodedEntry,
  managementToken,
  resolveConfig,
  readConfigFile,
  mask,
  planUploads,
  formatSize,
  explainFailure,
  putObject,
  statObject,
  publicUrlFor,
  checkPublic,
  changeMime,
  refreshCdn,
  MANIFEST_CONTENT_TYPE,
  parseArgs
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof ConfigError) {
        console.error(`\u001b[31m\u2717 ${e.message}\u001b[0m`);
        process.exit(2);
      }
      die(e.message);
    });
}
