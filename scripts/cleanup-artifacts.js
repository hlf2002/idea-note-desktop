#!/usr/bin/env node
'use strict';

/**
 * 打包机历史产物清理：每次打包完成后自动识别历史包版本并按 SemVer 排序，
 * 仅保留最近 N 个版本（默认 2），清理更早版本的安装包及其衍生产物（.dmg/.zip/.exe/.blockmap 等）。
 *
 * 设计约束：
 *   1. 非阻断隔离：所有文件/目录/参数异常均在内部捕获并打印告警日志，默认退出码恒为 0，
 *      确保清理失败不会影响本次打包结果（仅 --strict 模式才将清理失败升级为非 0 退出）。
 *   2. 安全边界：跳过 latest*.yml、builder-*.yml、*.log、隐藏文件及子目录（dist/package、
 *      dist/package-win、mac、win-unpacked 等），只清理带明确 SemVer 的构建包文件。
 *   3. 当前版本保护：支持 --protect <version>，即使在已有更高版本产物的机器上回溯打包旧 tag，
 *      也绝不会误删本次刚打出的版本。
 *
 * 用法：
 *   node scripts/cleanup-artifacts.js --dir dist --dir dist/package --keep 2 --protect 1.2.5
 *   node scripts/cleanup-artifacts.js --dir dist --dir dist/package-win --keep 2 --dry-run
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_KEEP_COUNT = 2;

// 清单、构建日志、调试配置等非版本包文件一律排除
const IGNORED_FILE_PATTERNS = [
  /^\./,
  /^latest(?:-[a-z0-9_-]+)?\.ya?ml$/i,
  /^builder-[^/\\]+\.ya?ml$/i,
  /\.log$/i
];

// 先剥离构建产物扩展名（仅认明确的打包产物/校验衍生扩展名，避免误伤其他文件）
const ARTIFACT_EXT_RE = /(?:\.dmg|\.zip|\.exe|\.msi|\.nsis\.7z|\.7z|\.nupkg|\.AppImage|\.deb|\.rpm|\.tar\.gz|\.tar\.xz)(?:\.blockmap|\.sha256|\.sha512|\.sig|\.asc)?$/i;

// 剥离构建平台/架构后缀，避免把 `-arm64-mac` 当成 SemVer 预发布标签
const QUALIFIER_SUFFIX_RE = /-(?:mac|win|linux|arm64|x64|amd64|ia32|x86|universal|nsis|portable)$/i;

// 匹配版本段：位于前缀分隔符（- 或 _ 或起始）之后、直到剥离后文件名末尾
const VERSION_TAIL_RE = /(?:^|[-_])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 解析 SemVer 2.0.0 版本串；非法返回 null */
function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').filter(Boolean) : null;
  if (m[4] && (!pre || pre.length === 0)) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: pre,
    raw: version.trim()
  };
}

/** SemVer 2.0.0 升序比较：a > b 返回 1，a < b 返回 -1，相等返回 0 */
function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a;
  const pb = typeof b === 'string' ? parseSemver(b) : b;
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (const field of ['major', 'minor', 'patch']) {
    if (pa[field] !== pb[field]) return pa[field] > pb[field] ? 1 : -1;
  }
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1; // 正式版 > 预发布版
  if (!pb.prerelease) return -1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) > Number(y) ? 1 : -1;
    if (xNum) return -1; // SemVer 规定数字标识优先级低于字母标识
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 从产物文件名提取版本号（兼容中文前缀 `灵感笔记-*` 与 ASCII `idea-note-*`）。
 * 非产物文件（latest*.yml、日志、隐藏文件等）返回 null。
 */
function extractVersion(filename) {
  if (typeof filename !== 'string' || !filename) return null;
  const base = path.basename(filename);
  if (IGNORED_FILE_PATTERNS.some((re) => re.test(base))) return null;

  const extMatch = ARTIFACT_EXT_RE.exec(base);
  if (!extMatch) return null;

  let stem = base.slice(0, extMatch.index);
  while (QUALIFIER_SUFFIX_RE.test(stem)) {
    stem = stem.replace(QUALIFIER_SUFFIX_RE, '');
  }

  const verMatch = VERSION_TAIL_RE.exec(stem);
  if (!verMatch) return null;
  const ver = verMatch[1];
  return parseSemver(ver) ? ver : null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0B';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)}GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${bytes}B`;
}

/**
 * 计算某个目录的清理计划（纯扫描，不修改磁盘）。
 * 返回 { exists, sortedVersions, keepVersions, removeVersions, filesToRemove }
 */
function planCleanup(dir, { keepCount = DEFAULT_KEEP_COUNT, protectVersions = [], fsImpl = fs } = {}) {
  const absDir = path.resolve(String(dir));
  if (!fsImpl.existsSync(absDir)) {
    return { dir: absDir, exists: false, sortedVersions: [], keepVersions: [], removeVersions: [], filesToRemove: [] };
  }

  const stat = fsImpl.statSync(absDir);
  if (!stat.isDirectory()) {
    throw new Error(`路径不是目录: ${absDir}`);
  }

  const entries = fsImpl.readdirSync(absDir, { withFileTypes: true });
  const versionMap = new Map(); // version -> Array<{ name, path, size }>

  for (const entry of entries) {
    // 只清理第一层普通文件或符号链接，绝不删除 dist/package、mac、win-unpacked 等目录
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const version = extractVersion(entry.name);
    if (!version) continue;

    const fullPath = path.join(absDir, entry.name);
    let size = 0;
    try {
      size = fsImpl.lstatSync(fullPath).size || 0;
    } catch (e) {
      size = 0;
    }
    if (!versionMap.has(version)) versionMap.set(version, []);
    versionMap.get(version).push({ name: entry.name, path: fullPath, size });
  }

  const sortedVersions = Array.from(versionMap.keys()).sort(compareSemver);
  const safeKeep = Number.isInteger(keepCount) && keepCount >= 1 ? keepCount : DEFAULT_KEEP_COUNT;

  if (sortedVersions.length <= safeKeep) {
    return {
      dir: absDir,
      exists: true,
      sortedVersions,
      keepVersions: sortedVersions.slice(),
      removeVersions: [],
      filesToRemove: []
    };
  }

  // 默认保留最新的 safeKeep 个版本；若受保护版本（本次刚构建的版本）不在其中，
  // 优先保住受保护版本，再从其余版本里取最新的补齐到 safeKeep 个。
  const protectSet = new Set(
    (Array.isArray(protectVersions) ? protectVersions : [protectVersions])
      .map((v) => String(v || '').trim())
      .filter((v) => v && versionMap.has(v))
  );

  const keepSet = new Set(protectSet);
  for (let i = sortedVersions.length - 1; i >= 0 && keepSet.size < safeKeep; i -= 1) {
    keepSet.add(sortedVersions[i]);
  }

  const keepVersions = sortedVersions.filter((v) => keepSet.has(v));
  const removeVersions = sortedVersions.filter((v) => !keepSet.has(v));
  const filesToRemove = [];
  for (const ver of removeVersions) {
    const items = versionMap.get(ver) || [];
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      filesToRemove.push({ ...item, version: ver });
    }
  }

  return {
    dir: absDir,
    exists: true,
    sortedVersions,
    keepVersions,
    removeVersions,
    filesToRemove
  };
}

/**
 * 清理单个目录的旧版本产物。所有异常均内部捕获，保证不抛出错误中断打包流程。
 */
function cleanupDirectory(dir, options = {}) {
  const {
    keepCount = DEFAULT_KEEP_COUNT,
    protectVersions = [],
    dryRun = false,
    logger = console,
    fsImpl = fs,
    rmImpl
  } = options;

  const log = (msg) => (logger && typeof logger.log === 'function' ? logger.log(msg) : console.log(msg));
  const warn = (msg) => (logger && typeof logger.warn === 'function' ? logger.warn(msg) : console.warn(msg));
  const removeFile = rmImpl || ((target) => fsImpl.rmSync(target, { force: true }));

  const summary = {
    dir: String(dir),
    ok: true,
    skipped: false,
    sortedVersions: [],
    keepVersions: [],
    removeVersions: [],
    removedFiles: [],
    failedFiles: [],
    freedBytes: 0,
    error: null
  };

  try {
    const safeKeep = Number.isInteger(keepCount) && keepCount >= 1 ? keepCount : DEFAULT_KEEP_COUNT;
    const plan = planCleanup(dir, { keepCount: safeKeep, protectVersions, fsImpl });
    summary.dir = plan.dir;
    summary.sortedVersions = plan.sortedVersions;
    summary.keepVersions = plan.keepVersions;
    summary.removeVersions = plan.removeVersions;

    if (!plan.exists) {
      summary.skipped = true;
      log(`[cleanup] 目录不存在，跳过清理: ${plan.dir}`);
      return summary;
    }

    if (plan.sortedVersions.length === 0) {
      log(`[cleanup] ${dir}: 未识别到带版本号的历史产物，无需清理`);
      return summary;
    }

    if (plan.removeVersions.length === 0) {
      log(
        `[cleanup] ${dir}: 识别到 ${plan.sortedVersions.length} 个版本 [${plan.sortedVersions.join(', ')}] <= 保留阈值 ${safeKeep}，无需清理`
      );
      return summary;
    }

    log(
      `[cleanup] ${dir}: 识别到 ${plan.sortedVersions.length} 个版本 [${plan.sortedVersions.join(', ')}]；保留 [${plan.keepVersions.join(', ')}]；准备清理旧版本 [${plan.removeVersions.join(', ')}]（共 ${plan.filesToRemove.length} 个文件）`
    );

    for (const file of plan.filesToRemove) {
      if (dryRun) {
        log(`[cleanup]   [dry-run] 将删除: ${file.name} (${formatBytes(file.size)})`);
        summary.removedFiles.push(file.path);
        summary.freedBytes += file.size;
        continue;
      }
      try {
        removeFile(file.path);
        summary.removedFiles.push(file.path);
        summary.freedBytes += file.size;
        log(`[cleanup]   已删除: ${file.name} (${formatBytes(file.size)})`);
      } catch (fileErr) {
        summary.ok = false;
        summary.failedFiles.push({ path: file.path, error: fileErr.message });
        warn(`[cleanup][WARN] 删除失败（已忽略，不影响本次打包）: ${file.path} -> ${fileErr.message}`);
      }
    }

    const prefix = dryRun ? '[dry-run] 预演完成' : '清理完成';
    log(
      `[cleanup] ${dir}: ${prefix}，${dryRun ? '预计释放' : '释放'} ${formatBytes(summary.freedBytes)}，成功 ${summary.removedFiles.length} 项，失败 ${summary.failedFiles.length} 项`
    );
  } catch (dirErr) {
    summary.ok = false;
    summary.error = dirErr && dirErr.message ? dirErr.message : String(dirErr);
    warn(`[cleanup][WARN] 处理目录异常（已忽略，不影响本次打包结果）: ${dir} -> ${summary.error}`);
  }

  return summary;
}

/**
 * 批量清理多个产物目录。即使入参或个别目录出错也绝不抛出异常。
 */
function cleanupOldArtifacts(targetDirs = ['dist', 'dist/package'], options = {}) {
  const logger = (options && options.logger) || console;
  const warn = (msg) => (logger && typeof logger.warn === 'function' ? logger.warn(msg) : console.warn(msg));
  const results = [];

  try {
    const dirs = Array.isArray(targetDirs) ? targetDirs : [targetDirs];
    for (const dir of dirs) {
      if (!dir) continue;
      results.push(cleanupDirectory(dir, options));
    }
  } catch (err) {
    warn(`[cleanup][WARN] 清理流程意外异常（已忽略，不影响本次打包结果）: ${err && err.message ? err.message : err}`);
  }

  const hasFailure = results.some((r) => !r.ok);
  return { ok: !hasFailure, results };
}

function parseArgs(argv) {
  const opts = {
    dirs: [],
    keepCount: DEFAULT_KEEP_COUNT,
    protectVersions: [],
    dryRun: false,
    strict: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') {
      if (i + 1 >= argv.length) throw new Error('--dir 缺少目录参数');
      opts.dirs.push(argv[++i]);
    } else if (a.startsWith('--dir=')) {
      opts.dirs.push(a.slice('--dir='.length));
    } else if (a === '--keep') {
      if (i + 1 >= argv.length) throw new Error('--keep 缺少数值参数');
      opts.keepCount = Number(argv[++i]);
    } else if (a.startsWith('--keep=')) {
      opts.keepCount = Number(a.slice('--keep='.length));
    } else if (a === '--protect') {
      if (i + 1 >= argv.length) throw new Error('--protect 缺少版本号参数');
      opts.protectVersions.push(argv[++i]);
    } else if (a.startsWith('--protect=')) {
      opts.protectVersions.push(a.slice('--protect='.length));
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--strict') {
      opts.strict = true;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }

  if (!Number.isInteger(opts.keepCount) || opts.keepCount < 1) {
    throw new Error(`--keep 必须是正整数，当前: ${opts.keepCount}`);
  }
  if (opts.dirs.length === 0) {
    opts.dirs = ['dist', 'dist/package'];
  }
  return opts;
}

function printHelp() {
  console.log(
    '用法: node scripts/cleanup-artifacts.js [--dir <目录>]... [--keep <N>] [--protect <版本>]... [--dry-run] [--strict]\n' +
    '\n' +
    '选项:\n' +
    '  --dir <目录>       要清理的产物目录，可重复指定（默认 dist 和 dist/package）\n' +
    `  --keep <N>         保留最近 N 个版本（默认 ${DEFAULT_KEEP_COUNT}）\n` +
    '  --protect <版本>   受保护版本号（例如当前刚打包的版本），绝不删除\n' +
    '  --dry-run          只输出计划，不实际删除文件\n' +
    '  --strict           清理发生错误时返回非 0 退出码（默认告警并退出 0，不阻断打包）\n' +
    '  -h, --help         显示本帮助'
  );
}

function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.warn(`[cleanup][WARN] 参数异常（已忽略，不影响本次打包结果）: ${err.message}`);
    return 0;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  const outcome = cleanupOldArtifacts(opts.dirs, {
    keepCount: opts.keepCount,
    protectVersions: opts.protectVersions,
    dryRun: opts.dryRun
  });
  return opts.strict && !outcome.ok ? 1 : 0;
}

module.exports = {
  DEFAULT_KEEP_COUNT,
  parseSemver,
  compareSemver,
  extractVersion,
  formatBytes,
  planCleanup,
  cleanupDirectory,
  cleanupOldArtifacts,
  parseArgs,
  main
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.warn(`[cleanup][WARN] 未预期异常（已忽略，不影响本次打包结果）: ${err && err.message ? err.message : err}`);
    process.exitCode = 0;
  }
}
