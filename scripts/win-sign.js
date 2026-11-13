'use strict';

/**
 * Windows 打包统一入口：签名来源解析 → （自动模式）SimplySign PIN 预热 →
 * electron-builder --win（注入签名参数）→ finalize-win.js 收尾校验。
 *
 * 签名来源五级解析（与 electron-release 技能 §4.6 一致，高优先级命中即独占）：
 *   ① 命令行 --sign-sha1 / --sign-subject / --publisher-name
 *   ② 环境变量 WIN_SIGN_SHA1（或 SIGN_SHA1）/ WIN_SIGN_SUBJECT / WIN_PUBLISHER_NAME
 *   ③ .electron-release.json → signing.windows.certificateSha1 / certificateSubjectName /
 *      certificateFile / method:"none"（显式关闭）
 *   ④ package.json#build.win.signtoolOptions
 *   ⑤ 证书存储自动发现（仅 win32）：Cert:\CurrentUser\My 的有效代码签名证书且含私钥
 *      —— 恰好一张（SimplySign 登录后挂载的即此类）→ 自动注入指纹并签名；
 *         零张（未登录/无证书）→ 默认停止并列排查清单；多张 → 停止并列候选，不替你猜
 *
 * 默认自动签名的触发条件（同时满足）：
 *   - Windows 宿主；- 未命中 ①~④ 任何显式来源且未 method:"none"/--no-sign；
 *   - 证书存储里恰好一张有效（未过期、HasPrivateKey）的代码签名证书。
 *
 * 签名失败/未登录的处理：默认停止（退出码 2），给出排查清单；要产出未签名包必须显式
 * --allow-unsigned（或 method:"none" / --no-sign），finalize 阶段会记录 SmartScreen 后果。
 *
 * PIN 预热（SimplySign）：自动签名前先对 makecab 现做的全新 CAB（合法未签名）真签一次，
 * 把 OTP/PIN 交互前置；超过 120s 视为预热失败并停止（对应技能 M7：卡在 Submitting digest for signing 的预防）。
 * --warmup 仅预热不构建。
 *
 * 用法：
 *   node scripts/win-sign.js [--sign-sha1 <指纹>] [--sign-subject <Subject>]
 *        [--publisher-name <完整DN>] [--allow-unsigned] [--no-sign] [--warmup] [--dry-run]
 *
 * 退出码：0 成功；1 构建或校验失败；2 签名来源无法确定（未登录/多证书/缺私钥）；3 预热超时。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TIMESTAMP = 'http://timestamp.digicert.com';
const MACHINE_NAMES = { 0x8664: 'x64', 0xAA64: 'arm64', 0x014c: 'x86' };

function usage() {
  console.error('用法: node scripts/win-sign.js [--sign-sha1 <指纹>] [--sign-subject <Subject>]');
  console.error('                  [--publisher-name <完整DN>] [--allow-unsigned] [--no-sign] [--warmup]');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { signSha1: '', signSubject: '', publisherName: '', allowUnsigned: false, noSign: false, warmupOnly: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sign-sha1') o.signSha1 = (argv[++i] || '').trim();
    else if (a === '--sign-subject') o.signSubject = (argv[++i] || '').trim();
    else if (a === '--publisher-name') o.publisherName = (argv[++i] || '').trim();
    else if (a === '--allow-unsigned') o.allowUnsigned = true;
    else if (a === '--no-sign') o.noSign = true;
    else if (a === '--warmup') o.warmupOnly = true;
    else if (a === '--dry-run') o.dryRun = true;
    else usage();
  }
  return o;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function loadConfig() {
  return readJsonSafe(path.join(ROOT, '.electron-release.json')) || {};
}

/** 纯函数：五级解析签名来源。certs 为 null 表示宿主无法枚举（非 Windows） */
function resolveSigning({ cli, env, config, pkgSigntool, platform, certs }) {
  const ts = (config && config.signing && config.signing.windows && config.signing.windows.timestampServer)
    || env.WIN_TIMESTAMP_URL || DEFAULT_TIMESTAMP;
  const base = { timestampServer: ts, builderArgs: [], canBuild: true, reason: '' };

  const explicitSha1 = cli.signSha1 || env.WIN_SIGN_SHA1 || env.SIGN_SHA1 || '';
  const explicitSubject = cli.signSubject || env.WIN_SIGN_SUBJECT || '';
  const explicitPublisher = cli.publisherName || env.WIN_PUBLISHER_NAME || '';
  const cfgWin = (config && config.signing && config.signing.windows) || {};

  // ①② 显式命令行 / 环境变量
  if (explicitSha1 || explicitSubject) {
    const args = explicitSha1
      ? ['--c.win.signtoolOptions.certificateSha1=' + explicitSha1]
      : ['--c.win.signtoolOptions.certificateSubjectName=' + explicitSubject];
    args.push('--c.win.signtoolOptions.rfc3161TimeStampServer=' + ts);
    if (explicitPublisher) args.push('--c.win.signtoolOptions.publisherName=' + explicitPublisher);
    return { ...base, mode: 'explicit', builderArgs: args, sha1: explicitSha1, subject: explicitSubject,
      publisherName: explicitPublisher || '', reason: '显式来源（命令行/环境变量）' };
  }

  // ③ 项目配置
  if (cfgWin.method === 'none') {
    return { ...base, mode: 'off', reason: '.electron-release.json 声明 method=none（明确不签名）' };
  }
  if (cfgWin.certificateSha1 || cfgWin.certificateSubjectName || cfgWin.certificateFile) {
    const args = [];
    if (cfgWin.certificateSha1) args.push('--c.win.signtoolOptions.certificateSha1=' + cfgWin.certificateSha1);
    if (cfgWin.certificateSubjectName) args.push('--c.win.signtoolOptions.certificateSubjectName=' + cfgWin.certificateSubjectName);
    if (cfgWin.certificateFile) args.push('--c.win.signtoolOptions.certificateFile=' + cfgWin.certificateFile);
    args.push('--c.win.signtoolOptions.rfc3161TimeStampServer=' + ts);
    if (cfgWin.publisherName) args.push('--c.win.signtoolOptions.publisherName=' + cfgWin.publisherName);
    return { ...base, mode: 'config', builderArgs: args, sha1: cfgWin.certificateSha1 || '',
      publisherName: cfgWin.publisherName || '', reason: '.electron-release.json signing.windows' };
  }

  // ④ package.json signtoolOptions
  const pkgWin = pkgSigntool || {};
  if (pkgWin.certificateSha1 || pkgWin.certificateSubjectName || pkgWin.certificateFile) {
    const args = [];
    if (pkgWin.certificateSha1) args.push('--c.win.signtoolOptions.certificateSha1=' + pkgWin.certificateSha1);
    if (pkgWin.certificateSubjectName) args.push('--c.win.signtoolOptions.certificateSubjectName=' + pkgWin.certificateSubjectName);
    if (pkgWin.certificateFile) args.push('--c.win.signtoolOptions.certificateFile=' + pkgWin.certificateFile);
    args.push('--c.win.signtoolOptions.rfc3161TimeStampServer=' + ts);
    if (pkgWin.publisherName) args.push('--c.win.signtoolOptions.publisherName=' + pkgWin.publisherName);
    return { ...base, mode: 'pkg', builderArgs: args, sha1: pkgWin.certificateSha1 || '',
      publisherName: pkgWin.publisherName || '', reason: 'package.json build.win.signtoolOptions' };
  }

  // ⑤ 证书存储自动发现（SimplySign 登录后挂载的证书即在此）
  if (certs === null) {
    return { ...base, mode: 'unavailable', canBuild: false,
      reason: '非 Windows 宿主，无法枚举证书存储（自动签名不生效，也不允许交叉构建）' };
  }
  if (certs.length === 1) {
    const cert = certs[0];
    const args = [
      '--c.win.signtoolOptions.certificateSha1=' + cert.thumbprint,
      '--c.win.signtoolOptions.rfc3161TimeStampServer=' + ts,
      '--c.win.signtoolOptions.publisherName=' + cert.subject
    ];
    return { ...base, mode: 'auto', builderArgs: args, sha1: cert.thumbprint,
      publisherName: cert.subject, cert, reason: '证书存储唯一可用证书（SimplySign 自动签名）' };
  }
  if (certs.length === 0) {
    return { ...base, mode: 'missing', canBuild: false,
      reason: '证书存储中没有可用代码签名证书（SimplySign 未登录？）' };
  }
  return { ...base, mode: 'ambiguous', canBuild: false,
    reason: '证书存储命中 ' + certs.length + ' 张可用证书，不替你猜：请用 --sign-sha1 显式指定',
    candidates: certs };
}

/** 枚举 Cert:\CurrentUser\My（结果走临时文件，适配受限沙箱；非 win32 返回 null） */
function enumerateCerts() {
  if (process.platform !== 'win32') return null;
  const out = path.join(os.tmpdir(), 'win-sign-certs-' + process.pid + '.json');
  const ps = [
    '$ErrorActionPreference="Stop";',
    '$c = @(Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | ' +
      'Where-Object { $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey } | ' +
      'Select-Object @{n="thumbprint";e={$_.Thumbprint}},@{n="subject";e={$_.Subject}},' +
      '@{n="notAfter";e={$_.NotAfter.ToString("s")}});',
    '@{certs=$c} | ConvertTo-Json -Compress | Set-Content -LiteralPath "' + out + '" -Encoding UTF8'
  ].join(' ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8', timeout: 60000 });
  try {
    if (r.status !== 0 || !fs.existsSync(out)) {
      throw new Error((r.stderr || r.stdout || 'PowerShell 执行失败').trim().split('\n')[0]);
    }
    const text = fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.certs) ? parsed.certs : [];
  } finally {
    try { fs.unlinkSync(out); } catch (e) { /* 清理失败不阻断 */ }
  }
}

/** 定位 Windows SDK 的 signtool.exe（取版本号最高的） */
function findSigntool() {
  const kitRoot = 'C:/Program Files (x86)/Windows Kits/10/bin';
  try {
    const versions = fs.readdirSync(kitRoot)
      .filter((d) => /^\d+\.\d+\.\d+(\.\d+)?$/.test(d))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const arch of ['x64', 'x86']) {
        const p = path.join(kitRoot, v, arch, 'signtool.exe');
        if (fs.existsSync(p)) return p;
      }
    }
    const legacy = path.join(kitRoot, 'x64', 'signtool.exe');
    if (fs.existsSync(legacy)) return legacy;
  } catch (e) { /* 目录不存在 */ }
  return null;
}

/** SimplySign PIN 预热：对全新 CAB 真签一次，把 OTP/PIN 交互前置。成功返回 true
 *  预热目标必须是「结构合法且未签名」的文件：手造字节流不是合法 PE 会被拒签
 *  （file format cannot be signed），微软签名文件又涉及重复签语义——
 *  makecab.exe（系统自带）现做的新 CAB 两个坑都避开 */
function prewarm(resolution, timestampServer) {
  if (process.platform !== 'win32') return true;
  if (!resolution.sha1) return true;
  const signtool = findSigntool();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-sign-prewarm-'));
  const dummy = path.join(scratchDir, 'dummy.txt');
  const scratch = path.join(scratchDir, 'prewarm.cab');
  try {
    if (!signtool) {
      console.log('▸ 未找到 Windows SDK signtool.exe，跳过预热（真实签名由 electron-builder 完成；' +
        '若卡在 Submitting digest for signing 请先在 SimplySign 客户端完成 OTP/PIN）');
      return true;
    }
    fs.writeFileSync(dummy, 'SimplySign PIN prewarm payload\n');
    const makecab = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'makecab.exe');
    const mk = spawnSync(makecab, [dummy, scratch], { encoding: 'utf8', timeout: 30000 });
    if (mk.status !== 0 || !fs.existsSync(scratch)) {
      console.log('▸ makecab 生成预热文件失败，跳过预热（真实签名由 electron-builder 完成；' +
        '若卡在 Submitting digest for signing 请先在 SimplySign 客户端完成 OTP/PIN）');
      return true;
    }
    console.log('▸ SimplySign PIN 预热（最多 120s）：' + signtool);
    const r = spawnSync(signtool, [
      'sign', '/sha1', resolution.sha1, '/fd', 'SHA256',
      '/tr', timestampServer, '/td', 'SHA256', scratch
    ], { timeout: 120000, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('✗ 预热签名失败（' + ((r.stderr || r.stdout || '').trim().split('\n')[0]) + '）');
      console.error('  排查：① SimplySign 客户端登录态 ② 手机 OTP/PIN 是否弹出待确认 ③ 指纹是否正确');
      return false;
    }
    console.log('✓ 预热成功：PIN/OTP 已缓存（约 3h），真实签名不会再卡在 Submitting digest');
    return true;
  } finally {
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不阻断 */ }
  }
}

function runBuilder(builderArgs) {
  const cliJs = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  const args = ['--win'].concat(builderArgs);
  let cmdDesc = 'node node_modules/electron-builder/cli.js ' + args.join(' ');
  let r;
  if (fs.existsSync(cliJs)) {
    console.log('▸ 构建：' + cmdDesc);
    r = spawnSync(process.execPath, [cliJs].concat(args), { stdio: 'inherit', cwd: ROOT });
  } else {
    cmdDesc = 'npx electron-builder ' + args.join(' ');
    console.log('▸ 构建：' + cmdDesc);
    r = spawnSync('npx', ['electron-builder'].concat(args), { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
  }
  if (r.status !== 0) {
    console.error('✗ electron-builder 退出码 ' + r.status);
    return false;
  }
  return true;
}

function runFinalize(allowUnsigned) {
  const script = path.join(__dirname, 'finalize-win.js');
  const args = [script];
  if (allowUnsigned) args.push('--allow-unsigned');
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  return r.status === 0;
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const pkg = readJsonSafe(path.join(ROOT, 'package.json')) || {};
  const config = loadConfig();
  const cfgWin = (config.signing && config.signing.windows) || {};
  const env = process.env;
  const cfgExplicitOff = cfgWin.method === 'none' || cli.noSign;

  console.log('[win-sign] ' + (pkg.name || '?') + ' v' + (pkg.version || '?') +
    ' · 签名来源解析（显式 > env > .electron-release.json > package.json > 证书存储自动发现）');

  // 仅预热模式
  if (cli.warmupOnly) {
    const certs = enumerateCerts();
    const resolution = resolveSigning({ cli, env, config, pkgSigntool: pkg.build && pkg.build.win && pkg.build.win.signtoolOptions, platform: process.platform, certs });
    if (!resolution.sha1) {
      console.error('✗ 无可预热证书：' + resolution.reason);
      process.exit(resolution.mode === 'missing' ? 2 : 1);
    }
    const ok = prewarm(resolution, resolution.timestampServer);
    process.exit(ok ? 0 : 3);
  }

  const certs = enumerateCerts();
  const resolution = resolveSigning({ cli, env, config, pkgSigntool: pkg.build && pkg.build.win && pkg.build.win.signtoolOptions, platform: process.platform, certs });

  console.log('▸ 签名模式：' + resolution.mode + ' —— ' + resolution.reason);
  if (resolution.sha1) console.log('▸ 证书指纹：' + resolution.sha1);
  if (resolution.candidates) {
    for (const c of resolution.candidates) {
      console.error('  候选 ' + c.thumbprint + '  ' + c.subject + '  有效期至 ' + c.notAfter);
    }
  }

  const unsignedAccepted = cli.allowUnsigned || cfgExplicitOff;
  // 硬停条件：无法确定签名来源。missing（未登录/无证书）可被 --allow-unsigned 显式绕过；
  // ambiguous（多证书）必须指定其一；unavailable（非 Windows 宿主）一律停止——
  // 原生模块交叉构建不可用（技能 §5.5），--allow-unsigned 也不放行
  const bypassable = resolution.mode === 'missing' && unsignedAccepted;
  if (!resolution.canBuild && !bypassable) {
    if (resolution.mode === 'unavailable') {
      console.error('✗ ' + resolution.reason);
      console.error('  发布用途的 Windows 安装包必须在 Windows 宿主构建：依赖含原生模块' +
        '（better-sqlite3，经 @qzhuli/qzhuli-cli 传入），交叉构建不可用（electron-release 技能 §5.5）。');
      console.error('  本机预演签名决策：node scripts/win-sign.js --dry-run（同样退出 2，仅打印不执行）');
    } else if (resolution.mode === 'ambiguous') {
      console.error('✗ ' + resolution.reason);
      console.error('  候选已列在上方：用 --sign-sha1 <指纹>（或 --sign-subject）显式指定其一，' +
        '或在 .electron-release.json signing.windows.certificateSha1 固化。--allow-unsigned 不适用于此情形。');
    } else {
      console.error('✗ ' + resolution.reason);
      console.error('  排查清单：');
      console.error('  ① SimplySign 客户端是否已登录（登录后证书挂载进 Cert:\\CurrentUser\\My）');
      console.error('  ② certmgr.msc → 个人 → 证书，确认存在有效的代码签名证书且含私钥');
      console.error('  ③ 已登录但首次签名：node scripts/win-sign.js --warmup 预热 PIN/OTP');
      console.error('  ④ 确属无证书环境：--allow-unsigned 或 .electron-release.json method="none"（SmartScreen 会拦截未签名包）');
    }
    process.exit(2);
  }
  if (bypassable) {
    console.log('▸ 已显式接受不签名（--allow-unsigned）：产物将被 SmartScreen 拦截，需手动"仍要运行"，升级推的新包同样会被拦');
  }
  if (resolution.mode === 'off') {
    console.log('▸ 签名已显式关闭（' + resolution.reason + '）');
  }

  if (cli.dryRun) {
    console.log('▸ dry-run 结束：签名决策如上，未预热、未构建、未校验');
    console.log('▸ 将执行：electron-builder ' + (resolution.builderArgs.join(' ') || '(无签名参数)'));
    process.exit(resolution.canBuild || unsignedAccepted ? 0 : 2);
  }

  // 自动模式先预热，把 SimplySign 的 OTP/PIN 交互前置（真实签名时不再阻塞）
  if (resolution.mode === 'auto') {
    if (!prewarm(resolution, resolution.timestampServer)) process.exit(3);
  }

  if (!runBuilder(resolution.builderArgs)) process.exit(1);

  const allowUnsignedFinal = unsignedAccepted || resolution.mode === 'unavailable';
  if (!runFinalize(allowUnsignedFinal)) process.exit(1);
  console.log('[win-sign] 完成');
}

module.exports = { resolveSigning, enumerateCerts, MACHINE_NAMES, DEFAULT_TIMESTAMP };
if (require.main === module) main();
