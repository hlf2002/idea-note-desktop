'use strict';

/**
 * Windows 产物收尾 + 校验（对齐 electron-release 技能 §3.2 的三条断言）：
 *   ① dist/latest.yml 已生成          —— 缺失说明更新链路无从谈起
 *   ② 清单 version == 本次构建版本     —— 不一致客户端不会触发升级
 *   ③ 每个 files[].url 对应产物存在且 sha512/size 配对 —— 否则客户端下载后校验失败
 *
 * 收尾动作与 mac 侧 release.sh 对齐：
 *   - 中文产物改名 ASCII（灵感笔记-Setup-x.y.z.exe → idea-note-Setup-x.y.z.exe）
 *   - 清单 YAML 解析后改写 url（禁止逐行文本替换，见技能铁律 2）
 *   - 逐条校验 sha512 / 字节数
 *
 * 附加断言：
 *   - NSIS 引导 exe 恒为 x86，不对其比对架构；改校验 win-unpacked 载荷的 PE machine 字段
 *     （缺 win-unpacked 时记 SKIP，不得把「没校验」写成通过）
 *   - 签名状态：Windows 宿主上用 PowerShell 查 Authenticode；非 Windows 宿主记 SKIP。
 *     未签名默认 FAIL，--allow-unsigned 显式接受后记 SKIP
 *
 * 用法：
 *   node scripts/finalize-win.js [--dist dist] [--out dist/package-win]
 *        [--expect-version 1.2.3] [--expect-arch x64|arm64]
 *        [--allow-unsigned] [--strict] [--skip-sign]
 *
 * 退出码：0 通过；1 有 FAIL；2 用法错误；3 --strict 下存在 SKIP
 * 产物目录默认 dist/package-win（与 mac 的 dist/package 隔离，避免互相覆盖）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  asciiName,
  buildRelativeManifest,
  verifyDigests
} = require('./release-manifest');

const ROOT = path.resolve(__dirname, '..');

function usage() {
  console.error('用法: node scripts/finalize-win.js [--dist dist] [--out dist/package-win]');
  console.error('                   [--expect-version <v>] [--expect-arch x64|arm64]');
  console.error('                   [--allow-unsigned] [--strict] [--skip-sign]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    dist: path.join(ROOT, 'dist'),
    out: path.join(ROOT, 'dist', 'package-win'),
    expectVersion: null,
    expectArch: 'x64',
    allowUnsigned: false,
    strict: false,
    skipSign: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') opts.dist = path.resolve(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--expect-version') opts.expectVersion = argv[++i];
    else if (a === '--expect-arch') opts.expectArch = argv[++i];
    else if (a === '--allow-unsigned') opts.allowUnsigned = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--skip-sign') opts.skipSign = true;
    else usage();
  }
  return opts;
}

const results = [];
function pass(msg) { results.push(['PASS', msg]); console.log('  \u2713 ' + msg); }
function skip(msg) { results.push(['SKIP', msg]); console.log('  ! ' + msg + '（SKIP）'); }
function fail(msg) { results.push(['FAIL', msg]); console.error('  \u2717 ' + msg); }

/** 读 PE 头 machine 字段，判断载荷架构 */
function peMachine(exePath) {
  const fd = fs.openSync(exePath, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read < 64 || head.readUInt16LE(0) !== 0x5A4D) throw new Error('不是 PE 文件（缺 MZ）');
    const eLfanew = head.readUInt32LE(0x3c);
    if (eLfanew + 6 > read || head.readUInt32LE(eLfanew) !== 0x00004550) {
      throw new Error('缺 PE 签名');
    }
    return head.readUInt16LE(eLfanew + 4);
  } finally {
    fs.closeSync(fd);
  }
}

const MACHINE_NAMES = { 0x8664: 'x64', 0xAA64: 'arm64', 0x014c: 'x86' };

function checkPayloadArch(distDir, productName, expectArch) {
  const payload = path.join(distDir, 'win-unpacked', productName + '.exe');
  if (!fs.existsSync(payload)) {
    skip('载荷架构未确认，需补验：win-unpacked/' + productName + '.exe 不存在');
    return;
  }
  const machine = peMachine(payload);
  const actual = MACHINE_NAMES[machine] || '0x' + machine.toString(16);
  if (actual === expectArch) {
    pass('NSIS 引导 x86（正常）+ 载荷 ' + actual + '（期望 ' + expectArch + '）');
  } else {
    fail('载荷架构 ' + actual + ' ≠ 期望 ' + expectArch + '（win-unpacked/' + productName + '.exe）');
  }
}

function checkSignature(opts) {
  if (opts.skipSign) { skip('签名检查已按要求跳过（--skip-sign）'); return; }
  if (process.platform !== 'win32') {
    skip('签名未确认：Authenticode 校验需在 Windows 宿主执行（当前 ' + process.platform + '）');
    return;
  }
  const exe = fs.readdirSync(opts.out).find((f) => f.endsWith('.exe'));
  if (!exe) { skip('产物目录里没有 exe，签名未确认'); return; }
  const target = path.join(opts.out, exe);
  let info;
  try {
    const json = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
      `(Get-AuthenticodeSignature -LiteralPath "${target}" | ` +
      'Select-Object Status,StatusMessage,@{n="Signer";e={$_.SignerCertificate.Subject}},' +
      '@{n="Timestamp";e={$_.TimeStamperCertificate.Subject}} | ConvertTo-Json -Compress)'
    ], { encoding: 'utf8', timeout: 60000, windowsVerbatimArguments: true });
    info = JSON.parse(json);
  } catch (e) {
    skip('签名校验未能执行（PowerShell 失败：' + String(e.message).split('\n')[0] + '）');
    return;
  }
  if (info.Status === 'Valid') {
    pass('Authenticode 有效 · 签发者 ' + (info.Signer || '(未知)') +
      ' · 时间戳 ' + (info.Timestamp ? '有' : '无（证书过期即失效）'));
  } else if (info.Status === 'NotSigned') {
    if (opts.allowUnsigned) {
      skip('未签名（--allow-unsigned 已显式接受）：首次安装会被 SmartScreen 拦截，需手动"仍要运行"，升级推的新包同样会被拦');
    } else {
      fail('产物未签名：构建成功 ≠ 能分发。确属无证书环境请加 --allow-unsigned 或在 .electron-release.json 声明 method=none');
    }
  } else {
    fail('签名状态异常：' + info.Status + ' ' + (info.StatusMessage || ''));
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const productName = pkg.build.productName;
  const expectVersion = opts.expectVersion || pkg.version;
  const manifestSrc = path.join(opts.dist, 'latest.yml');

  console.log('[finalize-win] ' + pkg.name + ' v' + expectVersion + '（win 收尾 + 校验）');

  // 断言① 清单已生成
  if (!fs.existsSync(manifestSrc)) {
    fail('断言① ' + manifestSrc + ' 不存在：electron-builder 未产出更新清单，先构建（npm run build:win）');
    finish(opts);
    return;
  }
  pass('断言① dist/latest.yml 已生成');

  fs.mkdirSync(opts.out, { recursive: true });

  // 收集本版本产物并 ASCII 改名
  const wanted = [
    productName + '-Setup-' + expectVersion + '.exe',
    productName + '-Setup-' + expectVersion + '.exe.blockmap'
  ];
  const zipName = fs.readdirSync(opts.dist)
    .find((f) => f.endsWith('-' + expectVersion + '-win.zip'));
  if (zipName) wanted.push(zipName);

  let copied = 0;
  for (const name of wanted) {
    const src = path.join(opts.dist, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(opts.out, asciiName(name)));
    copied++;
  }
  const exeExpected = productName + '-Setup-' + expectVersion + '.exe';
  if (!fs.existsSync(path.join(opts.dist, exeExpected))) {
    fail('dist/ 里没有 ' + exeExpected + '：产物版本与期望版本不符，或构建未成功');
    finish(opts);
    return;
  }
  pass('已收齐 ' + copied + ' 个产物（ASCII 名：' + wanted.map(asciiName).join(', ') + '）');

  // 断言② + 改写清单（YAML 解析改写，非文本替换）
  let manifestText;
  try {
    manifestText = buildRelativeManifest(
      fs.readFileSync(manifestSrc, 'utf8'), { version: expectVersion });
  } catch (e) {
    fail('断言② 清单校验失败：' + e.message);
    finish(opts);
    return;
  }
  const manifestOut = path.join(opts.out, 'latest.yml');
  fs.writeFileSync(manifestOut, manifestText);
  pass('断言② 清单版本与发布版本一致（v' + expectVersion + '），已改写为 ASCII 相对地址 → ' + path.relative(ROOT, manifestOut));

  // 断言③ sha512 / size 逐条配对
  try {
    const lines = verifyDigests({ manifestText, dir: opts.out });
    pass('断言③ 清单与产物配对：\n    ' + lines.join('\n    '));
  } catch (e) {
    fail('断言③ ' + e.message);
  }

  // 附加：载荷架构
  checkPayloadArch(opts.dist, productName, opts.expectArch);

  // 附加：签名状态
  checkSignature(opts);

  finish(opts);
}

function finish(opts) {
  const nFail = results.filter((r) => r[0] === 'FAIL').length;
  const nSkip = results.filter((r) => r[0] === 'SKIP').length;
  const nPass = results.filter((r) => r[0] === 'PASS').length;
  console.log('\n[finalize-win 结果] PASS ' + nPass + ' · SKIP ' + nSkip + ' · FAIL ' + nFail +
    '（脚本确实执行到此处，成功必有本行输出）');
  if (nFail > 0) process.exit(1);
  if (opts.strict && nSkip > 0) {
    console.error('[finalize-win] --strict：存在 SKIP，按发布门禁视为失败');
    process.exit(3);
  }
  console.log('[finalize-win] 产物目录 ' + path.relative(ROOT, opts.out) + '/ 可直接投放');
}

module.exports = { peMachine, MACHINE_NAMES };
if (require.main === module) main();
