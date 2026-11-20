#!/usr/bin/env node
'use strict';

/**
 * 七牛「产物单传」：把指定的构建 / 生成产物（截图、报告、QA 包、临时归档……）
 * 单独投放到对象存储，用于分发或留档。
 *
 * 与发布链路的边界（这条是设计前提，不要混）：
 *   - `scripts/qiniu-upload.js` = 发版链路：整目录投放、必须含 latest*.yml、
 *     sha512 门禁、清单 MIME 修正 + CDN 刷新。客户端靠它升级。
 *   - 本脚本 = 旁路链路：按文件投放、不读清单、不校验 sha512、默认不刷 CDN。
 *     只复用 qiniu-upload.js 的纯函数（签名 / 配置解析 / stat / 上传），不 import 它的流程。
 *   - 因此本脚本永远不改变 electron-updater 的可见状态；产物前缀默认独立为 artifacts/。
 *
 * 用法：
 *   npm run upload:artifact -- screenshot.png
 *   npm run upload:artifact -- dist/package/灵感笔记-1.2.4-arm64.dmg --subdir qa --dated
 *   node scripts/qiniu-artifact.js --dir reports --prefix tmp/ --dry-run
 *   node scripts/qiniu-artifact.js shot.png --check --json
 *
 * 对象 key 与命名规则：
 *   key = <prefix><subdir><[YYYY-MM-DD]/><name>
 *     prefix  默认 artifacts/（配置 qiniu.artifactPrefix 或 QINIU_ARTIFACT_PREFIX）
 *     subdir  来自 --subdir（多级用 /，去首尾斜杠）
 *     日期     仅 --dated 时追加当天日期目录（本地时区）
 *     name    默认取源文件名：去路径、空白折叠为 `-`、去控制字符；--name 可改（仅单文件）
 *   例：artifacts/2026-11-20/screenshot.png
 *       artifacts/qa/2026-11-20/灵感笔记-1.2.4-arm64.dmg
 *
 * 重复上传处理（幂等）：
 *   默认先 stat 远端，用七牛 etag 比对内容：
 *     - 内容一致   → 跳过（不重传），--force 可强制重传
 *     - 同名不同内容 → 覆盖写并告警（putPolicy insertOnly=0）
 *     - --skip-existing → 远端同名即跳过，不比内容
 *   `--check` 只核对不写；`--dry-run` 只打印计划，不联网、不要求凭据。
 *
 * 退出码：0 成功（含跳过 / dry-run / check 通过）；1 上传或校验失败；2 参数/配置错误。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const qiniu = require('./qiniu-upload');

const DEFAULT_ARTIFACT_PREFIX = 'artifacts/';
const DEFAULT_RETRIES = 3;
const RETRY_DELAY_MS = 800;
// 单对象上传超时：与发布链路共用同一环境变量，默认 10 分钟
const UPLOAD_TIMEOUT_MS = Number(process.env.QINIU_UPLOAD_TIMEOUT_MS || 600000);

// 七牛 etag 的分块大小固定 4MB（小于等于该值走 md5 分支）
const ETAG_BLOCK_SIZE = 4 * 1024 * 1024;
// 现实现整文件读入内存（Blob 还会再复制一份）：超过上限直接拒绝，避免 Node 在打包机上 OOM
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const LARGE_FILE_WARN_BYTES = 256 * 1024 * 1024;

// 发布清单绝不从这条链路走：混进来只会让人误以为更新源已更新
const MANIFEST_PATTERN = /^latest(?:-[a-z]+)?\.ya?ml$/i;

const { ConfigError, UploadError } = qiniu;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 日志里展示路径：在工作区内用相对路径，工作区外保留绝对路径（避免 ../../.. 噪音） */
function displayPath(file, cwd = process.cwd()) {
  if (!file) return '';
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

function createLogger({ json = false } = {}) {
  const skipHuman = json ? () => {} : null;
  const say = skipHuman || ((msg) => console.log(msg));
  return {
    say,
    ok: skipHuman || ((msg) => console.log(`  \u001b[32m\u2713\u001b[0m ${msg}`)),
    skip: skipHuman || ((msg) => console.log(`  \u001b[36m\u21b7\u001b[0m ${msg}`)),
    warn: skipHuman || ((msg) => console.log(`  \u001b[33m!\u001b[0m ${msg}`)),
    fail: skipHuman || ((msg) => console.error(`  \u001b[31m\u2717\u001b[0m ${msg}`))
  };
}

// ---------------------------------------------------------------- 配置

/**
 * 产物前缀与更新源前缀必须互不包含：
 * 产物落进 autoupdates/ 会污染更新源（例如误传一个同名 latest-mac.yml）。
 */
function prefixOverlaps(a, b) {
  const x = qiniu.normalizePrefix(a);
  const y = qiniu.normalizePrefix(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * 解析生效配置：凭据复用 qiniu-upload 的优先级（env > .release.config.json > 默认值），
 * 再叠加产物专属前缀 qiniu.artifactPrefix / QINIU_ARTIFACT_PREFIX。
 */
function resolveArtifactConfig({
  env = process.env,
  config = qiniu.readConfigFile(),
  requireCredentials = true,
  prefixOverride = null
} = {}) {
  const base = qiniu.resolveConfig({ env, config, requireCredentials });
  const fileQiniu = (config && config.qiniu) || {};

  const pickPrefix = () => {
    const envValue = env.QINIU_ARTIFACT_PREFIX;
    if (envValue != null && String(envValue).trim() !== '') {
      return { value: String(envValue).trim(), from: 'env QINIU_ARTIFACT_PREFIX' };
    }
    const fileValue = fileQiniu.artifactPrefix;
    if (fileValue != null && String(fileValue).trim() !== '') {
      return { value: String(fileValue).trim(), from: '.release.config.json qiniu.artifactPrefix' };
    }
    return { value: DEFAULT_ARTIFACT_PREFIX, from: '默认值' };
  };

  const picked = prefixOverride != null
    ? { value: prefixOverride, from: '--prefix' }
    : pickPrefix();
  const prefix = qiniu.normalizePrefix(picked.value);

  return {
    ...base,
    updatePrefix: base.prefix,
    prefix,
    prefixFrom: picked.from,
    prefixExplicit: prefixOverride != null,
    overlap: prefixOverlaps(prefix, base.prefix)
  };
}

// ---------------------------------------------------------------- 输入收集

function collapseWhitespace(value) {
  return String(value).trim().replace(/\s+/g, '-');
}

/** 对象名：去路径、空白折叠、去控制字符；拒绝隐藏文件与发布清单 */
function sanitizeName(input, { allowManifest = false } = {}) {
  const raw = String(input == null ? '' : input).trim();
  const base = path.basename(raw);
  if (!base || base === '.' || base === '..') throw new ConfigError('对象名不能为空');
  if (base.startsWith('.')) throw new ConfigError(`隐藏文件不参与上传：${base}`);
  const cleaned = collapseWhitespace(base).replace(/[\u0000-\u001f\u007f]/g, '');
  if (!cleaned) throw new ConfigError(`对象名清洗后为空：${input}`);
  if (!allowManifest && MANIFEST_PATTERN.test(cleaned)) {
    throw new ConfigError(
      `拒绝单传发布清单 ${cleaned}：客户端更新源只认 scripts/qiniu-upload.js 的整目录投放。\n` +
      '  需要更新版本请用 npm run upload:qiniu -- --dir <产物目录>；确需把清单当普通文件留档，加 --allow-manifest'
    );
  }
  return cleaned;
}

/** 子目录：按 / 分段，去空段，拒绝 . / ..（防 key 穿越） */
function normalizeSubdir(subdir) {
  const raw = String(subdir == null ? '' : subdir).replace(/\\/g, '/');
  const parts = raw
    .split('/')
    .map((part) => collapseWhitespace(part))
    .filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') throw new ConfigError(`--subdir 不允许包含 . 或 ..：${subdir}`);
  }
  return parts.length ? `${parts.join('/')}/` : '';
}

/** 本地日期目录 YYYY-MM-DD（本地时区，便于对照构建日志） */
function dateDir(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 收集待上传文件：
 *   - `sources` 每项 { value, kind }，kind = auto | file | dir
 *   - 目录只取第一层普通文件（不递归），跳过隐藏文件
 *   - 同一路径重复传入会去重；不同路径同名文件直接报错（避免静默覆盖）
 */
function collectInputs({ sources = [], cwd = process.cwd(), allowManifest = false } = {}) {
  const collected = [];
  const seen = new Map();

  const addFile = (abs) => {
    if (seen.has(abs)) return;
    seen.set(abs, true);
    collected.push({ source: abs, name: sanitizeName(path.basename(abs), { allowManifest }) });
  };

  for (const entry of sources) {
    const raw = String(entry && entry.value != null ? entry.value : '').trim();
    if (!raw) throw new ConfigError('输入路径为空');
    const abs = path.resolve(cwd, raw);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      const hint = /[*?[\]]/.test(raw)
        ? '\n  通配符应交给 shell 展开（zsh/bash 默认会展开）；若被引号包住请自行展开或改用 --dir'
        : '';
      throw new ConfigError(`找不到输入：${raw}（${e.code === 'ENOENT' ? '路径不存在' : e.message}）${hint}`);
    }

    const kind = entry.kind || 'auto';
    if (kind === 'dir' && !stat.isDirectory()) throw new ConfigError(`--dir 需要目录：${raw}`);
    if (kind === 'file' && !stat.isFile()) throw new ConfigError(`--file 需要普通文件：${raw}`);

    if (stat.isDirectory()) {
      const names = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((item) => item.isFile() && !item.name.startsWith('.'))
        .map((item) => item.name)
        .sort();
      if (!names.length) throw new ConfigError(`目录里没有可上传的普通文件：${raw}（不递归子目录）`);
      for (const name of names) addFile(path.join(abs, name));
      continue;
    }
    if (!stat.isFile()) throw new ConfigError(`不是普通文件：${raw}`);
    addFile(abs);
  }

  if (!collected.length) throw new ConfigError('没有可上传的文件（--help 查看用法）');

  // 同名不同路径会让两个源文件争同一个 key，静默覆盖是事故，直接拒绝
  const byName = new Map();
  for (const item of collected) {
    const prev = byName.get(item.name);
    if (prev) {
      throw new ConfigError(
        `多个输入清洗后同名：${item.name}\n  ${prev}\n  ${item.source}\n` +
        '  处置：分批上传并用 --subdir 区分，或先重命名源文件'
      );
    }
    byName.set(item.name, item.source);
  }
  return collected;
}

/** key = prefix + subdir + [YYYY-MM-DD/] + name */
function buildKey({ prefix, subdir = '', dated = false, date = new Date(), name }) {
  const parts = [qiniu.normalizePrefix(prefix), normalizeSubdir(subdir)];
  if (dated) parts.push(`${dateDir(date)}/`);
  parts.push(name);
  return parts.join('');
}

// ---------------------------------------------------------------- etag 与去重判定

const urlSafe = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * 七牛返回的 hash 与本地计算在 padding 上可能不一致（Go URLEncoding 带 `=`），
 * 比对时统一去掉尾部 padding，避免「内容其实一样却判成不一致」。
 */
const normalizeHash = (hash) => String(hash || '').replace(/=+$/, '');

/**
 * 七牛 Kodo etag（与 stat 返回的 hash 同构）：
 *   ≤ 4MB：urlsafe_base64(0x16 + md5(body))
 *   > 4MB：urlsafe_base64(0x16 + sha1(concat(sha1(每个 4MB 块))))
 * 用它做「内容是否已存在」的判定，比只比大小可靠。
 */
function qiniuEtag(buffer) {
  if (buffer.length <= ETAG_BLOCK_SIZE) {
    return urlSafe(Buffer.concat([Buffer.from([0x16]), crypto.createHash('md5').update(buffer).digest()]));
  }
  const digests = [];
  for (let offset = 0; offset < buffer.length; offset += ETAG_BLOCK_SIZE) {
    digests.push(crypto.createHash('sha1').update(buffer.subarray(offset, offset + ETAG_BLOCK_SIZE)).digest());
  }
  const joined = Buffer.concat(digests);
  return urlSafe(Buffer.concat([Buffer.from([0x16]), crypto.createHash('sha1').update(joined).digest()]));
}

/**
 * 重复上传判定：返回 { action: 'upload' | 'skip', reason }。
 * force 优先级最高；skipExisting 次之（不比内容，用于「只补缺」场景）。
 */
function decideAction({ remote, etag, size, force = false, skipExisting = false } = {}) {
  if (!remote) return { action: 'upload', reason: '远端不存在' };
  if (force) return { action: 'upload', reason: '--force 强制重传' };
  if (skipExisting) return { action: 'skip', reason: '远端同名对象已存在（--skip-existing）' };
  if (Number(remote.size) === Number(size) && remote.hash && normalizeHash(remote.hash) === normalizeHash(etag)) {
    return { action: 'skip', reason: '远端已存在且内容一致' };
  }
  if (Number(remote.size) !== Number(size)) {
    return { action: 'upload', reason: `同名不同大小（远端 ${remote.size} ≠ 本地 ${size}），覆盖` };
  }
  return { action: 'upload', reason: '同名同大小但内容不同（etag 不一致），覆盖' };
}

// ---------------------------------------------------------------- 网络动作

/** 上传单个产物：本地路径与远端 key 解耦（--name 需要），重试语义与发布链路一致 */
async function putArtifact({ cfg, file, key, etag, retries = DEFAULT_RETRIES, fetchImpl = globalThis.fetch, sleepImpl = defaultSleep } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ConfigError('当前 Node 没有全局 fetch，需要 Node.js >= 18（或 20+ 更稳妥）');
  }
  const buffer = fs.readFileSync(file);
  const size = buffer.length;
  const localEtag = etag || qiniuEtag(buffer);
  let lastError;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const form = new FormData();
      form.append('token', qiniu.uploadToken({ ...cfg, key }));
      form.append('key', key);
      form.append('file', new Blob([buffer]), path.basename(file));
      const res = await fetchImpl(`${cfg.uploadHost}/`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
      });
      const text = await res.text();
      let body = {};
      try { body = JSON.parse(text); } catch (e) { /* 非 JSON 响应用原文兜底 */ }

      if (res.ok && body.key === key) return { key, size, hash: body.hash, etag: localEtag };

      const reason = body.error || text.slice(0, 200) || `HTTP ${res.status}`;
      lastStatus = res.status;
      const error = new UploadError(`${key} 上传失败（HTTP ${res.status}）：${reason}`);
      if (res.status >= 400 && res.status < 500) {
        error.fatal = true;
        error.hint = qiniu.explainFailure(reason, res.status);
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
      if (typeof sleepImpl === 'function') await sleepImpl(wait);
    }
  }
  lastError.hint = lastError.hint || qiniu.explainFailure(lastError.message, lastStatus);
  throw lastError;
}

// ---------------------------------------------------------------- CLI

const HELP = `用法：node scripts/qiniu-artifact.js <文件|目录>… [选项]

输入（至少一项，可混用；位置参数是文件或目录，自动识别）
  --file <path>        指定文件，可重复
  --dir <dir>          指定目录（只取第一层普通文件，跳过隐藏文件），可重复
  --                 之后的参数一律当路径

对象 key（默认 artifacts/<文件名>）
  --prefix <p>         覆盖前缀（默认配置 qiniu.artifactPrefix 或 artifacts/）
  --subdir <s>         前缀下的子目录，多级用 /，如 --subdir qa/1.2.4
  --dated              追加当天日期子目录 YYYY-MM-DD/
  --name <n>           重命名对象（仅单文件时可用；子目录请用 --subdir）

重复与校验
  --force              远端内容一致也重传
  --skip-existing      远端同名对象存在即跳过（不比内容）
  --check              只核对远端，不写数据
  --dry-run            只打印计划，不联网、不要求凭据

其它
  --cdn                上传后刷新这些对象的 CDN（默认不刷新，避免与发版链路耦合）
  --json               以 JSON 输出结果（stdout 只有 JSON）
  --allow-manifest     允许上传 latest*.yml（默认拒绝，防误当发布）
  --retries <n>        单文件重试次数，默认 ${DEFAULT_RETRIES}
  -h, --help           显示本帮助

凭据：QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET
      前缀：QINIU_ARTIFACT_PREFIX（或 .release.config.json 的 qiniu.artifactPrefix）
`;

function parseArgs(argv) {
  const opts = {
    sources: [],
    prefix: null,
    subdir: '',
    dated: false,
    name: '',
    force: false,
    skipExisting: false,
    check: false,
    dryRun: false,
    cdn: false,
    json: false,
    allowManifest: false,
    retries: DEFAULT_RETRIES,
    help: false
  };

  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (literal) {
      opts.sources.push({ value: arg, kind: 'auto' });
      continue;
    }
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new ConfigError(`${arg} 缺少取值`);
      i += 1;
      return next;
    };

    if (arg === '--') literal = true;
    else if (arg === '--file') opts.sources.push({ value: value(), kind: 'file' });
    else if (arg.startsWith('--file=')) opts.sources.push({ value: arg.slice(7), kind: 'file' });
    else if (arg === '--dir') opts.sources.push({ value: value(), kind: 'dir' });
    else if (arg.startsWith('--dir=')) opts.sources.push({ value: arg.slice(6), kind: 'dir' });
    else if (arg === '--prefix') opts.prefix = value();
    else if (arg.startsWith('--prefix=')) opts.prefix = arg.slice(9);
    else if (arg === '--subdir') opts.subdir = value();
    else if (arg.startsWith('--subdir=')) opts.subdir = arg.slice(9);
    else if (arg === '--dated') opts.dated = true;
    else if (arg === '--name') opts.name = value();
    else if (arg.startsWith('--name=')) opts.name = arg.slice(7);
    else if (arg === '--force') opts.force = true;
    else if (arg === '--skip-existing') opts.skipExisting = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--cdn') opts.cdn = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--allow-manifest') opts.allowManifest = true;
    else if (arg === '--retries') opts.retries = Number(value());
    else if (arg.startsWith('--retries=')) opts.retries = Number(arg.slice(10));
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('-')) throw new ConfigError(`未知参数：${arg}（--help 查看用法）`);
    else opts.sources.push({ value: arg, kind: 'auto' });
  }

  if (!opts.help && !opts.sources.length) throw new ConfigError('缺少要上传的文件或目录（--help 查看用法）');
  if (!Number.isInteger(opts.retries) || opts.retries < 1) throw new ConfigError('--retries 需要正整数');
  if (opts.check && opts.dryRun) throw new ConfigError('--check 与 --dry-run 互斥（前者要连远端，后者不联网）');
  if (opts.check && opts.cdn) throw new ConfigError('--check 只核对不上传，不能与 --cdn 同用');
  if (opts.name && String(opts.name).includes('/')) {
    throw new ConfigError('--name 只改文件名，不支持子目录；请改用 --subdir');
  }
  return opts;
}

// ---------------------------------------------------------------- 主流程

async function main(argv, {
  env = process.env,
  cwd = process.cwd(),
  now = new Date(),
  config,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep
} = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const log = createLogger({ json: opts.json });

  const inputs = collectInputs({ sources: opts.sources, cwd, allowManifest: opts.allowManifest });
  if (opts.name && inputs.length !== 1) {
    throw new ConfigError(`--name 只适用于单文件，本次有 ${inputs.length} 个输入；请分批上传或用 --subdir`);
  }

  const cfg = resolveArtifactConfig({
    env,
    config,
    requireCredentials: !opts.dryRun,
    prefixOverride: opts.prefix
  });

  if (cfg.overlap) {
    if (cfg.prefixExplicit) {
      log.warn(`产物前缀 ${cfg.prefix || '（桶根）'} 与更新源前缀 ${cfg.updatePrefix || '（桶根）'} 重叠（--prefix 显式指定，按你的意图执行）`);
    } else {
      throw new ConfigError(
        `产物前缀与更新源前缀重叠：artifact=${cfg.prefix || '（桶根）'} / update=${cfg.updatePrefix || '（桶根）'}\n` +
        '  产物默认不得落在 electron-updater 的前缀下，避免污染更新源。\n' +
        '  处置：在 .release.config.json 配 qiniu.artifactPrefix（默认 artifacts/），或用 --prefix 指定独立前缀'
      );
    }
  }
  if (opts.cdn && !cfg.publicBase) {
    throw new ConfigError('--cdn 需要 QINIU_PUBLIC_BASE（桶的公开域名）才能拼出刷新 URL');
  }

  const items = inputs.map((input) => {
    const name = opts.name ? sanitizeName(opts.name, { allowManifest: opts.allowManifest }) : input.name;
    const key = buildKey({ prefix: cfg.prefix, subdir: opts.subdir, dated: opts.dated, date: now, name });
    const stat = fs.statSync(input.source);
    if (stat.size > MAX_FILE_BYTES) {
      throw new ConfigError(
        `${input.source} 为 ${qiniu.formatSize(stat.size)}，超过单文件 ${qiniu.formatSize(MAX_FILE_BYTES)} 上限（整文件读入内存）。\n` +
        '  大文件请用七牛 qsctl 分片上传，或先切片再单传'
      );
    }
    return {
      source: input.source,
      name,
      key,
      size: stat.size,
      etag: qiniuEtag(fs.readFileSync(input.source)),
      url: qiniu.publicUrlFor(cfg, key)
    };
  });

  const keys = new Set();
  for (const item of items) {
    if (keys.has(item.key)) throw new ConfigError(`本次多个输入落到同一个 key：${item.key}（用 --subdir 分批）`);
    keys.add(item.key);
  }

  log.say(`\u001b[36m\u25b8\u001b[0m 七牛产物单传 · bucket=${cfg.bucket || '（未配置）'} · 前缀=${cfg.prefix || '（桶根）'} · 目标=${cfg.uploadHost}`);
  const credLine = cfg.accessKey
    ? `凭据 ${qiniu.mask(cfg.accessKey)}（${cfg.from.accessKey}）`
    : '凭据 未配置（dry-run 不读取）';
  log.say(`  ${credLine} · 前缀来源 ${cfg.prefixFrom} · ${items.length} 个文件`);
  if (!cfg.publicBase) log.say('  未配置 QINIU_PUBLIC_BASE：不展示公网 URL，--cdn 也不可用');

  if (opts.dryRun) {
    for (const item of items) {
      log.say(`  \u00b7 ${item.key}  ${qiniu.formatSize(item.size)}  \u2190 ${displayPath(item.source, cwd)}`);
      if (item.size >= LARGE_FILE_WARN_BYTES) log.warn(`${item.key} 较大（${qiniu.formatSize(item.size)}），上传期间内存占用约等于文件大小`);
    }
    log.say('dry-run 结束：未联网、未写入');
    return 0;
  }

  const results = [];
  let fatal = null;

  for (const item of items) {
    if (fatal) {
      results.push({ ...item, status: 'aborted', reason: '前序文件因凭据/桶级错误中断，未执行' });
      continue;
    }
    try {
      const remote = await qiniu.statObject({ cfg, key: item.key, fetchImpl });
      const decision = decideAction({
        remote,
        etag: item.etag,
        size: item.size,
        force: opts.check ? false : opts.force,
        skipExisting: opts.skipExisting
      });

      if (opts.check) {
        if (decision.action === 'skip') {
          log.ok(`${item.key}  远端已存在且内容一致  ${qiniu.formatSize(item.size)}`);
          results.push({ ...item, status: 'skipped', reason: decision.reason });
        } else {
          log.fail(`${item.key}  远端${remote ? '内容与本地不一致' : '不存在'}`);
          results.push({ ...item, status: 'failed', error: remote ? '远端内容与本地不一致' : '远端不存在' });
        }
        continue;
      }

      if (decision.action === 'skip') {
        log.skip(`${item.key}  ${decision.reason}（--force 可强制重传）`);
        results.push({ ...item, status: 'skipped', reason: decision.reason });
        continue;
      }

      if (decision.reason.startsWith('同名')) log.warn(`${item.key}  ${decision.reason}`);
      const uploaded = await putArtifact({
        cfg,
        file: item.source,
        key: item.key,
        etag: item.etag,
        retries: opts.retries,
        fetchImpl,
        sleepImpl
      });
      const verified = await qiniu.statObject({ cfg, key: item.key, fetchImpl });
      if (!verified) throw new UploadError(`${item.key} 上传后查不到对象`);
      if (Number(verified.size) !== uploaded.size) {
        throw new UploadError(`${item.key} 大小校验失败：远端 ${verified.size} ≠ 本地 ${uploaded.size}`);
      }
      if (verified.hash && normalizeHash(verified.hash) !== normalizeHash(uploaded.etag)) {
        throw new UploadError(`${item.key} 内容校验失败：远端 etag ${verified.hash} ≠ 本地 ${uploaded.etag}`);
      }
      log.ok(`${item.key}  ${qiniu.formatSize(uploaded.size)}  etag=${verified.hash || uploaded.etag}`);
      if (item.url) log.say(`    ${item.url}`);
      results.push({ ...item, status: 'uploaded', reason: decision.reason });
    } catch (e) {
      log.fail(`${item.key}  ${e.message}`);
      if (e.hint) log.say(`    处置：${e.hint}`);
      results.push({ ...item, status: 'failed', error: e.message, hint: e.hint || '' });
      if (e.fatal) fatal = e;
    }
  }

  // 可选：刷新本次上传对象的 CDN。默认不做——产物单传不应产生发布副作用。
  if (opts.cdn && cfg.publicBase) {
    const uploadedNow = results.filter((r) => r.status === 'uploaded');
    if (!uploadedNow.length) {
      log.say('  本次没有新上传对象，跳过 CDN 刷新');
    } else {
      try {
        const refreshed = await qiniu.refreshCdn({ cfg, urls: uploadedNow.map((r) => r.url), fetchImpl });
        log.ok(`CDN 刷新已提交（${refreshed.urls.length} 个 URL${refreshed.requestId ? `，requestId=${refreshed.requestId}` : ''}）`);
      } catch (e) {
        log.fail(`CDN 刷新失败：${e.message}`);
        if (e.hint) log.say(`    处置：${e.hint}`);
        results.push({
          source: '',
          name: '',
          key: '（CDN 刷新）',
          size: 0,
          etag: '',
          url: '',
          status: 'failed',
          error: e.message,
          hint: e.hint || ''
        });
      }
    }
  }

  const uploaded = results.filter((r) => r.status === 'uploaded');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'failed');
  const aborted = results.filter((r) => r.status === 'aborted');
  const bytes = uploaded.reduce((sum, r) => sum + r.size, 0);

  if (opts.json) {
    const report = {
      ok: failed.length === 0,
      bucket: cfg.bucket,
      prefix: cfg.prefix,
      updatePrefix: cfg.updatePrefix,
      publicBase: cfg.publicBase,
      items: results.map((r) => ({
        source: displayPath(r.source, cwd),
        name: r.name,
        key: r.key,
        size: r.size,
        etag: r.etag,
        url: r.url,
        status: r.status,
        reason: r.reason || '',
        error: r.error || null,
        hint: r.hint || null
      })),
      summary: {
        total: results.length,
        uploaded: uploaded.length,
        skipped: skipped.length,
        failed: failed.length,
        aborted: aborted.length,
        bytes
      }
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return failed.length ? 1 : 0;
  }

  if (failed.length) {
    console.error(`\u001b[31m\u2717 产物上传失败 ${failed.length} 项\u001b[0m`);
    for (const item of failed) {
      console.error(`  ${item.key}：${item.error}`);
      if (item.hint) console.error(`    处置：${item.hint}`);
    }
    if (aborted.length) console.error(`  另有 ${aborted.length} 个文件因中断未执行`);
    console.error('  重跑同一命令即可：同 key 覆盖写，已一致的对象会自动跳过');
    return 1;
  }

  log.say(`\u001b[36m\u25b8\u001b[0m 完成：${uploaded.length} 上传 / ${skipped.length} 跳过 / 0 失败 · 合计 ${qiniu.formatSize(bytes)}`);
  if (aborted.length) log.warn(`${aborted.length} 个文件未执行`);
  return 0;
}

module.exports = {
  DEFAULT_ARTIFACT_PREFIX,
  MAX_FILE_BYTES,
  LARGE_FILE_WARN_BYTES,
  createLogger,
  prefixOverlaps,
  resolveArtifactConfig,
  sanitizeName,
  normalizeSubdir,
  dateDir,
  collectInputs,
  buildKey,
  qiniuEtag,
  normalizeHash,
  decideAction,
  putArtifact,
  parseArgs,
  main
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof ConfigError) {
        console.error(`\u001b[31m\u2717 ${e.message}\u001b[0m`);
        process.exit(2);
      }
      console.error(`\u001b[31m\u2717 ${e.message}\u001b[0m`);
      process.exit(1);
    });
}
