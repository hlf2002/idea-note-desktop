#!/usr/bin/env node
'use strict';

/**
 * 灵感笔记桌面端 —— IPA 平台发布器（对齐 q_assistant 的 build-and-publish-win.py）。
 *
 * 把已构建好的安装包发布到 ipa.qzhuli.cn 内部分发平台，并在完成后触发飞书公告。
 * 仅负责「IPA 上传 + 飞书公告」这一个发布面，不碰 electron-updater 自动更新仓
 * （七牛由 scripts/qiniu-upload.js 独立负责，与本脚本互斥、互不包含）。
 *
 * 与 q_assistant 契约逐项对齐（触发条件 / 参数传递 / 执行顺序 / 日志输出 / 失败处理）：
 *   ① policy   POST {base}/open-api/v1/uploads/policy   {appId, filename}
 *   ② upload   multipart/form-data 流式上传到 policy 返回的 uploadUrl
 *              字段 key / token / file（纯内置模块，不缓冲整包进内存）
 *   ③ complete POST {base}/open-api/v1/versions/complete（上传后 sleep 3s，重试 3 次）
 *               {appId, key, version, buildNumber, displayName, releaseNotes}
 *               status=pending_review 是「人工审核」而非失败
 *   ④ feishu   POST {base}/open-api/v1/versions/{versionId}/publish-feishu
 *
 * 鉴权：X-IPA-TOKEN 请求头（不是 Authorization: Bearer）。
 * 失败处理：4xx 立即失败并完整打印错误体；非 4xx 重试；complete 失败重试 3 次；
 *           飞书公告失败但版本已发布时，提示用 --uploaded-key 只补公告。
 * 日志输出：每个 API 调用的完整响应逐行缩进打印，失败体不打码，便于不回放即定位。
 *
 * 用法：
 *   node scripts/publish-ipa.js --platform win --app-id <id> --token <t>
 *   node scripts/publish-ipa.js --platform mac --file dist/package/灵感笔记-1.2.4-arm64.dmg
 *   node scripts/publish-ipa.js --platform mac --uploaded-key <key>   # 只补飞书公告
 *   node scripts/publish-ipa.js --platform win --dry-run             # 只演练不联网
 *
 * 凭据来源（优先级从高到低，不写死在代码里）：
 *   appId：--app-id > 环境变量 IPA_APP_ID > .release.config.json 的 ipa.appId
 *   token：--token   > 环境变量 IPA_TOKEN（或 PUBLISH_TOKEN，兼容 q_assistant）>
 *          .release.config.json 的 ipa.token
 *
 * 退出码：0 成功；1 上传/发布失败；2 参数或配置错误。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, '.release.config.json');

// ---------------------------------------------------------------- 常量（对齐 q_assistant）
const DEFAULT_BASE_URL = 'https://ipa.qzhuli.cn';
const DEFAULT_POLICY_PATH = '/open-api/v1/uploads/policy';
const DEFAULT_COMPLETE_PATH = '/open-api/v1/versions/complete';
const DEFAULT_FEISHU_PATH = '/open-api/v1/versions/%s/publish-feishu';
const DISTRIBUTION_BASE = 'https://ipadistribution.qzhuli.cn';

// q助理开放平台群消息 webhook（独立于 IPA 的 publish-feishu 渠道）
const DEFAULT_QZHULI_WEBHOOK_URL = 'https://open.qzhuli.com/open/webhook/message/push';

const REQUEST_TIMEOUT_MS = 60 * 1000;          // 普通 JSON 请求
const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;      // 上传大文件
const COMPLETE_RETRY_DELAY_MS = 3 * 1000;      // 上传后到 complete 之间留 3s
const RETRY_DELAY_MS = 3 * 1000;               // 非 4xx 重试间隔
const COMPLETE_ATTEMPTS = 3;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

class PublishError extends Error {}

// ---------------------------------------------------------------- 基础工具

const say = (msg) => console.log(msg);
const die = (msg, code = EXIT_FAIL) => {
  console.error(`\u001b[31m\u2717 ${msg}\u001b[0m`);
  process.exit(code);
};

function usage() {
  console.error(
    '用法: node scripts/publish-ipa.js --platform <win|mac> [--app-id <id>] [--token <t>]\n' +
    '                 [--mode <publish-feishu|publish-qzhuli|publish-both>]\n' +
    '                 （默认 publish-feishu 只发飞书；publish-qzhuli 只发 q助理；publish-both 两者都发）\n' +
    '                 [--file <安装包路径> | --dir <产物目录>]\n' +
    '                 [--architecture <intel|apple_silicon>]（mac 专用，默认 intel/x64）\n' +
    '                 [--version <v>] [--build-number <n>] [--display-name <名>]\n' +
    '                 [--release-notes <说明>] [--uploaded-key <key>] [--dry-run]\n' +
    '                 [--base-url <url>] [--policy-path <path>] [--complete-path <path>]\n' +
    '                 [--feishu-path <path>]\n' +
    '                 [--qzhuli-conversation-id <群会话ID>] [--qzhuli-token <t>]'
  );
  process.exit(EXIT_USAGE);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function readPackageJson() {
  return readJsonSafe(path.join(ROOT, 'package.json')) || {};
}

/** 读 .release.config.json 的 ipa 段（不存在时返回空对象，不报错）。 */
function readIpaConfig() {
  const cfg = readJsonSafe(CONFIG_FILE) || {};
  return cfg.ipa || {};
}

/** 读 .release.config.json 的 qzhuli 段（q助理群通知凭据，不存在时返回空对象）。 */
function readQzhuliConfig() {
  const cfg = readJsonSafe(CONFIG_FILE) || {};
  return cfg.qzhuli || {};
}

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const o = {
    platform: '',
    file: '',
    dir: '',
    appId: '',
    token: '',
    architecture: '',
    version: '',
    buildNumber: '',
    displayName: '',
    releaseNotes: '',
    uploadedKey: '',
    qzhuliConversationId: '',
    qzhuliToken: '',
    mode: 'publish-feishu',
    dryRun: false,
    baseUrl: DEFAULT_BASE_URL,
    policyPath: DEFAULT_POLICY_PATH,
    completePath: DEFAULT_COMPLETE_PATH,
    feishuPath: DEFAULT_FEISHU_PATH
  };

  const take = (i) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) {
      console.error(`参数 ${argv[i]} 缺少取值`);
      usage();
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') o.platform = take(i++).toLowerCase();
    else if (a === '--file') o.file = take(i++);
    else if (a === '--dir') o.dir = take(i++);
    else if (a === '--app-id') o.appId = take(i++);
    else if (a === '--token') o.token = take(i++);
    else if (a === '--architecture') o.architecture = take(i++).toLowerCase();
    else if (a === '--version') o.version = take(i++);
    else if (a === '--build-number') o.buildNumber = take(i++);
    else if (a === '--display-name') o.displayName = take(i++);
    else if (a === '--release-notes') o.releaseNotes = take(i++);
    else if (a === '--uploaded-key') o.uploadedKey = take(i++);
    else if (a === '--mode') o.mode = take(i++).toLowerCase();
    else if (a === '--qzhuli-conversation-id') o.qzhuliConversationId = take(i++);
    else if (a === '--qzhuli-token') o.qzhuliToken = take(i++);
    else if (a === '--base-url') o.baseUrl = take(i++);
    else if (a === '--policy-path') o.policyPath = take(i++);
    else if (a === '--complete-path') o.completePath = take(i++);
    else if (a === '--feishu-path') o.feishuPath = take(i++);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') usage();
    else {
      console.error(`未知参数：${a}`);
      usage();
    }
  }
  return o;
}

// ---------------------------------------------------------------- 响应解析（对齐 q_assistant）

/** 取多个候选点路径里第一个非空值；支持 data./result. 前缀（点号分层访问）。 */
function firstApiValue(response, paths) {
  for (const p of paths) {
    let cur = response;
    let hit = true;
    for (const seg of p.split('.')) {
      if (cur == null || typeof cur !== 'object' || !(seg in cur)) {
        cur = null;
        hit = false;
        break;
      }
      cur = cur[seg];
    }
    if (hit && cur != null && cur !== '') return cur;
  }
  return null;
}

function statusIsOk(value) {
  if (value == null) return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 200)) return true;
  return String(value).trim().toLowerCase() === '0' || String(value).trim().toLowerCase() === '200'
    || String(value).trim().toLowerCase() === 'ok';
}

function successIsTrue(value) {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && value === 1) return true;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1';
}

function decodeJson(raw, context) {
  const text = raw.toString('utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new PublishError(`${context} returned invalid JSON: ${text}`);
  }
}

/** 打印完整 API 响应，缩进对齐其它细节（对齐 q_assistant 的 print_api_response）。 */
function printApiResponse(context, response) {
  if (response == null) {
    say(`    ${context} response: <empty>`);
    return;
  }
  const rendered = typeof response === 'string'
    ? response
    : JSON.stringify(response, null, 2);
  say(`    ${context} response:`);
  for (const line of rendered.split('\n')) {
    say(`      ${line}`);
  }
}

// ---------------------------------------------------------------- HTTP

function joinUrl(baseUrl, p) {
  if (/^https?:\/\//i.test(p)) return p;
  return baseUrl.replace(/\/+$/, '') + '/' + String(p).replace(/^\/+/, '');
}

function httpRequest(url, { method = 'POST', headers = {}, body = null, timeout = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method,
      headers,
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, raw: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeout}ms`)));
    req.on('error', (e) => reject(e));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * POST JSON，带 X-IPA-TOKEN。4xx 立即失败并完整打印错误体；非 4xx 按 attempts 重试。
 * body 为 null 时发空 POST（对齐 q_assistant 的 post_json 语义）。
 */
async function postJson(url, token, body, attempts = 1) {
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const headers = { 'X-IPA-TOKEN': token, Accept: 'application/json' };
  if (body != null) headers['Content-Type'] = 'application/json; charset=utf-8';

  let lastFailure = 'unknown error';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let status;
    let raw;
    try {
      ({ status, raw } = await httpRequest(url, { headers, body: payload }));
    } catch (e) {
      // 网络层错误（连接失败/超时/DNS）—— 可重试
      lastFailure = e.message;
      if (attempt < attempts) {
        console.error(`WARNING: Request failed (attempt ${attempt}/${attempts}); retrying in ${RETRY_DELAY_MS / 1000} seconds.`);
        await sleep(RETRY_DELAY_MS);
      }
      continue;
    }

    // 4xx：不可重试，立即失败并完整打印错误体
    if (status >= 400 && status < 500) {
      throw new PublishError(`POST ${url} failed with status ${status}: ${raw.toString('utf8').trim()}`);
    }
    // 5xx：可重试
    if (status >= 500) {
      lastFailure = `status ${status}: ${raw.toString('utf8').trim()}`;
      if (attempt < attempts) {
        console.error(`WARNING: Request failed (attempt ${attempt}/${attempts}); retrying in ${RETRY_DELAY_MS / 1000} seconds.`);
        await sleep(RETRY_DELAY_MS);
      }
      continue;
    }
    // 2xx/3xx：成功
    return decodeJson(raw, url);
  }
  throw new PublishError(`POST ${url} failed: ${lastFailure}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- 上传（multipart 流式）

/**
 * multipart/form-data 流式上传安装包，不把整包读进内存。
 * 字段顺序对齐 q_assistant：key → token → file。
 */
function uploadInstaller(uploadUrl, uploadKey, uploadToken, filePath, { onProgress, dryRun } = {}) {
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const boundary = `----ideanote${crypto.randomUUID().replace(/-/g, '')}`;

  const fieldPart = (name, value) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const prefix = Buffer.from(fieldPart('key', uploadKey) + fieldPart('token', uploadToken), 'utf8');
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n',
    'utf8'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const total = prefix.length + fileHeader.length + fileSize + suffix.length;

  if (dryRun) {
    say(`    [dry-run] would upload ${filename} (${fileSize} bytes) to ${uploadUrl}`);
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      timeout: UPLOAD_TIMEOUT_MS,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': total,
        Accept: 'application/json'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          reject(new PublishError(`Installer upload failed with status ${res.statusCode}: ${raw.toString('utf8').trim()}`));
        } else {
          // 对齐 q_assistant：上传成功后把响应解析成 JSON（七牛返回 {hash, key}）
          resolve(decodeJson(raw, 'Installer upload'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`upload timeout after ${UPLOAD_TIMEOUT_MS}ms`)));
    req.on('error', (e) => reject(new PublishError(`Installer upload failed: ${e.message}`)));

    req.write(prefix);
    req.write(fileHeader);
    const fileStream = fs.createReadStream(filePath);
    let sent = prefix.length + fileHeader.length;
    let lastPercent = -1;
    fileStream.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress(sent, total);
      else {
        const percent = total ? Math.floor((sent * 100) / total) : 100;
        if (percent !== lastPercent) {
          lastPercent = percent;
          process.stdout.write(`\r    uploading: ${String(percent).padStart(3)}%`);
        }
      }
    });
    fileStream.on('error', (e) => {
      req.destroy(e);
      reject(new PublishError(`Installer upload failed: ${e.message}`));
    });
    // pipe 自动处理背压；end:false 以便在文件结束后再写 suffix
    fileStream.pipe(req, { end: false });
    fileStream.on('end', () => {
      if (!onProgress) process.stdout.write(`\r    uploading: 100%\n`);
      req.end(suffix);
    });
  });
}

// ---------------------------------------------------------------- 飞书公告

function buildFeishuUrl(baseUrl, feishuPath, versionId) {
  const resolved = String(feishuPath)
    .replace('%s', String(versionId))
    .replace('{versionId}', String(versionId));
  return joinUrl(baseUrl, resolved);
}

async function publishToFeishu(baseUrl, feishuPath, versionId, token, { dryRun } = {}) {
  const feishuUrl = buildFeishuUrl(baseUrl, feishuPath, versionId);
  if (!/^https?:\/\//i.test(feishuUrl)) {
    throw new PublishError(
      'Feishu publish is enabled, but the URL is unresolved. ' +
      'Set --base-url or --feishu-path.'
    );
  }
  say('==> Announcing the version in Feishu');
  say(`    feishu-url: ${feishuUrl}`);
  if (dryRun) {
    say('    [dry-run] would POST (empty body) to feishu endpoint');
    return null;
  }
  const response = await postJson(feishuUrl, token);
  printApiResponse('IPA feishu', response);
  return response;
}

// ---------------------------------------------------------------- q助理群通知

/**
 * 构造发往 q助理群聊的消息内容（纯函数，便于测试）。
 * url 用 IPA 下载地址 https://ipadistribution.qzhuli.cn/{key}。
 */
function buildQzhuliMessage({ displayName, platform, version, buildNumber, policyKey }) {
  const platformLabel = platform === 'win' ? 'Windows' : 'macOS';
  return {
    title: `📱 新版本发布 — ${displayName}（${platformLabel}）`,
    content: `**Version / Build**: ${version} / ${buildNumber}`,
    url: `${DISTRIBUTION_BASE}/${policyKey}`
  };
}

/**
 * 通过 q助理开放平台 webhook 把发布消息发到指定群聊。
 * 接口：POST https://open.qzhuli.com/open/webhook/message/push
 * 鉴权：Authorization: Bearer <token>（与 IPA 的 X-IPA-TOKEN 不同）
 * 与 IPA 的 publish-feishu 是两条独立通知渠道，互不影响。
 */
async function sendQzhuliMessage(token, conversationId, { title, content, url }, { dryRun } = {}) {
  say('==> Notifying q助理 group');
  say(`    webhook:   ${DEFAULT_QZHULI_WEBHOOK_URL}`);
  say(`    conversation-id: ${conversationId}`);
  say(`    title:     ${title}`);
  say(`    content:   ${content}`);
  say(`    url:       ${url}`);

  const body = { conversation_id: conversationId, title, content, url };
  if (dryRun) {
    say(`    [dry-run] would POST ${JSON.stringify(body)}`);
    return null;
  }

  const { status, raw } = await httpRequest(DEFAULT_QZHULI_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: Buffer.from(JSON.stringify(body), 'utf8')
  });
  if (status >= 400) {
    throw new PublishError(`q助理 webhook failed with status ${status}: ${raw.toString('utf8').trim()}`);
  }
  const response = decodeJson(raw, 'q助理 webhook');
  printApiResponse('q助理 webhook', response);
  return response;
}

// ---------------------------------------------------------------- 产物定位

/**
 * 定位要上传的安装包：
 *   --file 显式指定时直接使用（basename 作为 policy 的 filename）；
 *   否则在 --dir（默认 win→dist/package-win，mac→dist/package）里按平台/架构匹配：
 *     win：*Setup*.exe（排除 .blockmap）
 *     mac：按 o.architecture 选包 —— apple_silicon 匹配 *-arm64.dmg，intel（默认）匹配其余 .dmg
 */
function locateInstaller(o) {
  if (o.file) {
    const abs = path.resolve(ROOT, o.file);
    if (!fs.existsSync(abs)) throw new PublishError(`--file 指定的安装包不存在：${abs}`);
    return abs;
  }
  const dir = path.resolve(ROOT, o.dir || (o.platform === 'win' ? 'dist/package-win' : 'dist/package'));
  if (!fs.existsSync(dir)) {
    throw new PublishError(
      `产物目录不存在：${dir}。请先完成打包（win: npm run package:win / mac: npm run package:mac），或用 --file 指定安装包。`
    );
  }
  const files = fs.readdirSync(dir);
  let candidates;
  if (o.platform === 'win') {
    candidates = files.filter((f) => /Setup.*\.exe$/.test(f));
  } else {
    const wantArm = o.architecture === 'apple_silicon';
    candidates = files.filter((f) => {
      if (!/\.dmg$/.test(f)) return false;
      const isArm = /-arm64\.dmg$/.test(f);
      return wantArm ? isArm : !isArm;
    });
  }
  candidates = candidates
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (candidates.length === 0) {
    const label = o.platform === 'win'
      ? '*.exe'
      : (o.architecture === 'apple_silicon' ? 'arm64 架构的 *.dmg' : 'x64 架构的 *.dmg');
    throw new PublishError(`目录 ${dir} 里没有可发布的安装包（${label}）。`);
  }
  if (candidates.length > 1 && !o.dryRun) {
    console.error(`WARNING: 发现多个候选安装包，按修改时间取最新：`);
    candidates.forEach((c) => console.error(`    - ${path.relative(ROOT, c)}`));
  }
  return candidates[0];
}

/**
 * 从产物文件名推断 mac 架构（对齐 IPA 服务端枚举 intel|apple_silicon）：
 *   含 arm64 → apple_silicon；否则（x64 / 无后缀）→ intel。
 * win 平台不需要 architecture（返回空串）。
 */
function inferArchitecture(platform, filename) {
  if (platform !== 'mac') return '';
  return /arm64/i.test(filename) ? 'apple_silicon' : 'intel';
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const o = parseArgs(process.argv.slice(2));

  // ---- 平台归一化：显式 > 宿主推断 ----
  if (!o.platform) {
    o.platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : '';
  }
  if (o.platform !== 'win' && o.platform !== 'mac') {
    console.error('--platform 仅支持 win/mac，且当前宿主无法推断。请显式传 --platform win|mac');
    usage();
  }

  // ---- 凭据：CLI > 环境变量 > 配置文件 ----
  const cfg = readIpaConfig();
  const env = process.env;
  const appId = o.appId || env.IPA_APP_ID || cfg.appId || '';
  const token = o.token || env.IPA_TOKEN || env.PUBLISH_TOKEN || cfg.token || '';
  if (!appId) {
    die('缺少 IPA appId：传 --app-id，或设环境变量 IPA_APP_ID，或在 .release.config.json 的 ipa.appId 配置', EXIT_USAGE);
  }
  if (!token) {
    die('缺少 IPA 发布令牌：传 --token，或设环境变量 IPA_TOKEN（或 PUBLISH_TOKEN），或在 .release.config.json 的 ipa.token 配置', EXIT_USAGE);
  }

  // ---- 发布模式：独立控制飞书 / q助理两条通知渠道 ----
  // publish-feishu（默认）只发飞书；publish-qzhuli 只发 q助理；publish-both 两者都发。
  const mode = o.mode;
  if (mode !== 'publish-feishu' && mode !== 'publish-qzhuli' && mode !== 'publish-both') {
    die(`未知 --mode：${mode}（仅支持 publish-feishu / publish-qzhuli / publish-both）`, EXIT_USAGE);
  }
  const feishuEnabled = mode === 'publish-feishu' || mode === 'publish-both';
  const qzhuliEnabled = mode === 'publish-qzhuli' || mode === 'publish-both';

  // ---- q助理群通知凭据（仅 qzhuliEnabled 时必填）：CLI > 环境变量 > 配置文件 ----
  const qzhuliCfg = readQzhuliConfig();
  const qzhuliConversationId = o.qzhuliConversationId || env.QZHULI_CONVERSATION_ID || qzhuliCfg.conversationId || '';
  const qzhuliToken = o.qzhuliToken || env.QZHULI_PUSH_TOKEN || env.qzhuli_push || qzhuliCfg.token || '';
  if (qzhuliEnabled && !qzhuliConversationId) {
    die('--mode 需要 q助理群会话ID：传 --qzhuli-conversation-id，或设环境变量 QZHULI_CONVERSATION_ID，或在 .release.config.json 的 qzhuli.conversationId 配置', EXIT_USAGE);
  }
  if (qzhuliEnabled && !qzhuliToken) {
    die('--mode 需要 q助理 push token：传 --qzhuli-token，或设环境变量 QZHULI_PUSH_TOKEN，或在 .release.config.json 的 qzhuli.token 配置', EXIT_USAGE);
  }

  // ---- 架构确定（mac 专用）----
  // 优先级：显式 --architecture > --file 指定包时从文件名推断 > --dir 默认 x64/intel。
  let architecture = '';
  if (o.platform === 'mac') {
    if (o.architecture) {
      if (o.architecture !== 'intel' && o.architecture !== 'apple_silicon') {
        die(`--architecture 仅支持 intel|apple_silicon（mac 专用），当前收到：${o.architecture}`, EXIT_USAGE);
      }
      architecture = o.architecture;
    } else if (o.file) {
      architecture = inferArchitecture('mac', path.basename(o.file));
    } else {
      architecture = 'intel'; // 默认 x64
    }
  }

  // ---- 安装包定位（mac 按 architecture 确定性选包）----
  const installer = locateInstaller({ ...o, architecture });
  const filename = path.basename(installer);

  // 防御性校验：--file 显式指定时，包的实际架构必须与确定的 architecture 一致
  if (o.platform === 'mac') {
    const actual = inferArchitecture('mac', filename);
    if (actual !== architecture) {
      die(`产物 ${filename} 实际是 ${actual}，与指定架构 ${architecture} 不一致；请改用 --architecture ${actual} 或换正确的包`, EXIT_USAGE);
    }
  }

  // ---- 元数据默认值（对齐 q_assistant）----
  const pkg = readPackageJson();
  const build = pkg.build || {};
  const version = o.version || pkg.version || '';
  const displayName = o.displayName || build.productName || pkg.name || '';
  if (!version) die('缺少版本号：传 --version，或设置 package.json 的 version', EXIT_USAGE);
  if (!displayName) die('缺少显示名：传 --display-name，或设置 package.json 的 build.productName', EXIT_USAGE);

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const buildNumber = o.buildNumber || `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const releaseNotes = o.releaseNotes || `Auto upload ${filename}`;

  const policyUrl = joinUrl(o.baseUrl, o.policyPath);
  const completeUrl = joinUrl(o.baseUrl, o.completePath);

  say(`==> ${o.platform} installer -> IPA (${o.dryRun ? 'dry-run' : 'publish'})`);
  say(`    platform:   ${o.platform}`);
  if (o.platform === 'mac') say(`    architecture: ${architecture}`);
  say(`    app-id:     ${appId}`);
  say(`    version:    ${version}`);
  say(`    build:      ${buildNumber}`);
  say(`    name:       ${displayName}`);
  say(`    installer:  ${installer}`);
  say(`    size:       ${fs.statSync(installer).size} bytes`);
  say(`    resume-key: ${o.uploadedKey || '(new upload)'}`);
  say(`    mode:      ${mode} (feishu=${feishuEnabled ? 'yes' : 'no'}, qzhuli=${qzhuliEnabled ? 'yes' : 'no'})`);
  if (qzhuliEnabled) say(`    qzhuli-notify: ${qzhuliConversationId}`);

  // ---- ① policy（续传时跳过）----
  let policyKey = o.uploadedKey;
  let versionId = null;
  let versionStatus = null;

  if (policyKey) {
    say('==> Resuming an existing IPA upload');
    say(`    upload-key: ${policyKey}`);
  } else {
    say('==> Requesting IPA upload policy');
    const policyBody = o.platform === 'mac'
      ? { appId, filename, architecture }
      : { appId, filename };
    if (o.dryRun) {
      say(`    [dry-run] would POST ${policyUrl} ${JSON.stringify(policyBody)}`);
    } else {
      const policyResponse = await postJson(policyUrl, token, policyBody);
      printApiResponse('IPA policy', policyResponse);

      const status = firstApiValue(policyResponse, ['code', 'status', 'result.code', 'data.code']);
      const success = firstApiValue(policyResponse, ['success', 'ok', 'result.success', 'data.success']);
      if (!statusIsOk(status) && !successIsTrue(success)) {
        const message = firstApiValue(policyResponse, ['message', 'msg', 'error', 'result.message', 'data.message']);
        throw new PublishError(`IPA policy request failed: status=${status} message=${message}`);
      }
      const uploadUrl = firstApiValue(policyResponse, ['uploadUrl', 'data.uploadUrl', 'result.uploadUrl']);
      const uploadToken = firstApiValue(policyResponse, ['uploadToken', 'data.uploadToken', 'result.uploadToken']);
      policyKey = firstApiValue(policyResponse, ['key', 'data.key', 'result.key']);
      if (!policyKey || !uploadUrl || !uploadToken) {
        throw new PublishError('IPA policy response did not include key, uploadUrl, and uploadToken.');
      }
      say(`    upload-key: ${policyKey}`);

      // ---- ② upload ----
      say('==> Uploading installer');
      const uploadResponse = await uploadInstaller(uploadUrl, policyKey, uploadToken, installer, { dryRun: o.dryRun });
      if (!o.dryRun) printApiResponse('IPA upload', uploadResponse);
    }
  }

  // ---- ③ complete（上传后 sleep 3s，重试 3 次）----
  // mac 的 complete 同样要求 architecture 字段（服务端 422 实测），与 policy 一致。
  const completeBody = {
    appId,
    key: policyKey,
    version,
    buildNumber,
    displayName,
    releaseNotes
  };
  if (o.platform === 'mac') completeBody.architecture = architecture;
  say('==> Completing IPA version');
  if (o.dryRun) {
    say(`    [dry-run] would POST ${completeUrl} ${JSON.stringify(completeBody)}`);
  } else {
    await sleep(COMPLETE_RETRY_DELAY_MS);
    const completeResponse = await postJson(completeUrl, token, completeBody, COMPLETE_ATTEMPTS);
    printApiResponse('IPA complete', completeResponse);

    versionId = firstApiValue(completeResponse, ['id', 'data.id', 'result.id']);
    versionStatus = firstApiValue(completeResponse, ['status', 'data.status', 'result.status']);

    say(`==> ${o.platform} installer published to IPA`);
    if (versionId) say(`    version-id: ${versionId}`);
    if (versionStatus) say(`    status:     ${versionStatus}`);
    say(`    admin:      ${o.baseUrl.replace(/\/+$/, '')}/admin/apps`);
  }

  // ---- ④ feishu（feishuEnabled 时执行）----
  if (feishuEnabled) {
    if (o.dryRun) {
      say(`==> Feishu announce (dry-run)`);
    } else {
      if (!versionId) {
        throw new PublishError('Feishu publish is enabled, but the complete response did not include a version id.');
      }
      try {
        await publishToFeishu(o.baseUrl, o.feishuPath, versionId, token);
      } catch (e) {
        throw new PublishError(
          `${e.message} The version itself is already published; retry only the Feishu announce with --uploaded-key ${policyKey}.`
        );
      }
    }
  }

  // ---- ⑤ q助理群通知（qzhuliEnabled 时执行，独立渠道，失败不阻断发布结果）----
  if (qzhuliEnabled) {
    const qzhuliMsg = buildQzhuliMessage({
      displayName,
      platform: o.platform,
      version,
      buildNumber,
      policyKey: policyKey || '{key}'
    });
    if (o.dryRun) {
      await sendQzhuliMessage(qzhuliToken, qzhuliConversationId, qzhuliMsg, { dryRun: true });
    } else {
      try {
        await sendQzhuliMessage(qzhuliToken, qzhuliConversationId, qzhuliMsg);
      } catch (e) {
        console.error(`WARNING: 发送 q助理群消息失败（IPA 版本已发布，不影响发布结果）: ${e.message}`);
      }
    }
  }

  say(`==> ${o.platform} installer published successfully`);
  if (!o.dryRun) say(`download_url: ${DISTRIBUTION_BASE}/${policyKey}`);
  return EXIT_OK;
}

// ---------------------------------------------------------------- 入口

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof PublishError) {
        console.error(`ERROR: ${e.message}`);
        process.exit(EXIT_FAIL);
      }
      console.error(e && e.stack ? e.stack : String(e));
      process.exit(EXIT_FAIL);
    });
}

// 导出纯函数，便于单元测试（不触发网络）
module.exports = {
  joinUrl,
  firstApiValue,
  statusIsOk,
  successIsTrue,
  decodeJson,
  buildFeishuUrl,
  buildQzhuliMessage,
  sendQzhuliMessage,
  parseArgs,
  locateInstaller,
  inferArchitecture,
  DEFAULT_BASE_URL,
  DEFAULT_POLICY_PATH,
  DEFAULT_COMPLETE_PATH,
  DEFAULT_FEISHU_PATH,
  DEFAULT_QZHULI_WEBHOOK_URL,
  DISTRIBUTION_BASE,
  PublishError
};
