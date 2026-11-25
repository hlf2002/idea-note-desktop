'use strict';

/**
 * scripts/cleanup-artifacts.js 单元测试：
 *   - 中文/ASCII/多架构/预发布版本号提取与非产物排除
 *   - SemVer 2.0.0 排序（多位数版本号与预发布顺序）
 *   - 仅保留最近 2 个版本，清理更早版本及其所有衍生文件（.dmg/.zip/.exe/.blockmap）
 *   - 受保护版本（--protect）在回溯打包旧版本时不被误删
 *   - dry-run、目录缺失、删除异常隔离（不抛错、返回非阻断摘要与退出码 0）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseSemver,
  compareSemver,
  extractVersion,
  planCleanup,
  cleanupDirectory,
  cleanupOldArtifacts,
  parseArgs,
  main
} = require('../scripts/cleanup-artifacts');

function makeTempTree(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-note-cleanup-'));
  for (const [name, value] of Object.entries(entries)) {
    const full = path.join(dir, name);
    if (value && value.dir) {
      fs.mkdirSync(full, { recursive: true });
    } else {
      fs.writeFileSync(full, typeof value === 'string' ? value : 'payload');
    }
  }
  return dir;
}

function captureLogger() {
  const logs = [];
  const warns = [];
  return {
    logs,
    warns,
    logger: {
      log: (msg) => logs.push(msg),
      warn: (msg) => warns.push(msg)
    }
  };
}

// ============ extractVersion ============

test('extractVersion: 兼容 macOS 中文与 ASCII 双架构产物及 blockmap', () => {
  assert.equal(extractVersion('灵感笔记-1.2.4.dmg'), '1.2.4');
  assert.equal(extractVersion('灵感笔记-1.2.4.dmg.blockmap'), '1.2.4');
  assert.equal(extractVersion('灵感笔记-1.2.4-arm64.dmg'), '1.2.4');
  assert.equal(extractVersion('灵感笔记-1.2.4-arm64.dmg.blockmap'), '1.2.4');
  assert.equal(extractVersion('灵感笔记-1.2.4-mac.zip'), '1.2.4');
  assert.equal(extractVersion('灵感笔记-1.2.4-arm64-mac.zip.blockmap'), '1.2.4');
  assert.equal(extractVersion('idea-note-1.2.4-mac.zip'), '1.2.4');
  assert.equal(extractVersion('idea-note-1.2.4-arm64-mac.zip.blockmap'), '1.2.4');
});

test('extractVersion: 兼容 Windows Setup / zip 中文与 ASCII 产物', () => {
  assert.equal(extractVersion('灵感笔记-Setup-1.2.4.exe'), '1.2.4');
  assert.equal(extractVersion('灵感笔记-Setup-1.2.4.exe.blockmap'), '1.2.4');
  assert.equal(extractVersion('idea-note-Setup-1.2.4.exe'), '1.2.4');
  assert.equal(extractVersion('idea-note-Setup-1.2.4.exe.blockmap'), '1.2.4');
  assert.equal(extractVersion('灵感笔记-1.2.4-win.zip'), '1.2.4');
  assert.equal(extractVersion('idea-note-1.2.4-win.zip'), '1.2.4');
});

test('extractVersion: 正确保留 SemVer 预发布后缀且不把架构名当预发布', () => {
  assert.equal(extractVersion('灵感笔记-1.2.5-beta.1-arm64.dmg'), '1.2.5-beta.1');
  assert.equal(extractVersion('idea-note-1.2.5-beta.1-arm64-mac.zip.blockmap'), '1.2.5-beta.1');
  assert.equal(extractVersion('idea-note-Setup-1.2.5-rc.2.exe'), '1.2.5-rc.2');
  assert.equal(extractVersion('灵感笔记-1.2.5-alpha-win.zip'), '1.2.5-alpha');
});

test('extractVersion: 排除清单、日志、隐藏文件与非包文件', () => {
  assert.equal(extractVersion('latest.yml'), null);
  assert.equal(extractVersion('latest-mac.yml'), null);
  assert.equal(extractVersion('latest-linux.yaml'), null);
  assert.equal(extractVersion('builder-debug.yml'), null);
  assert.equal(extractVersion('package-mac.log'), null);
  assert.equal(extractVersion('.DS_Store'), null);
  assert.equal(extractVersion('backup-1.2.3.json'), null);
  assert.equal(extractVersion('灵感笔记-1.2.3.4.dmg'), null);
});

// ============ compareSemver ============

test('compareSemver: 数值比较（1.10.0 > 1.2.9）与预发布比较', () => {
  const unsorted = ['1.10.0', '1.2.4', '1.2.10', '1.2.4-rc.1', '1.2.4-beta.10', '1.2.4-beta.2', '1.2.4-alpha', '2.0.0'];
  const sorted = unsorted.slice().sort(compareSemver);
  assert.deepEqual(sorted, [
    '1.2.4-alpha',
    '1.2.4-beta.2',
    '1.2.4-beta.10',
    '1.2.4-rc.1',
    '1.2.4',
    '1.2.10',
    '1.10.0',
    '2.0.0'
  ]);
  assert.equal(parseSemver('not-a-ver'), null);
});

// ============ planCleanup & cleanupDirectory ============

test('cleanupDirectory: 多版本产物仅保留最近 2 个版本，旧版全量衍生文件联动删除，清单与子目录不受影响', () => {
  const dir = makeTempTree({
    // 1.2.2（最旧，应全部清理）
    '灵感笔记-1.2.2.dmg': 'dmg-122',
    '灵感笔记-1.2.2.dmg.blockmap': 'bm-122',
    '灵感笔记-1.2.2-arm64.dmg': 'arm-dmg-122',
    'idea-note-1.2.2-mac.zip': 'zip-122',
    'idea-note-1.2.2-mac.zip.blockmap': 'zbm-122',
    // 1.2.3（次旧，应全部清理）
    '灵感笔记-1.2.3.dmg': 'dmg-123',
    '灵感笔记-1.2.3-arm64-mac.zip': 'zip-123',
    // 1.2.4（保留）
    '灵感笔记-1.2.4.dmg': 'dmg-124',
    'idea-note-1.2.4-mac.zip': 'zip-124',
    // 1.2.10（最新，保留 —— 验证按 SemVer 而非字典序排序）
    '灵感笔记-1.2.10.dmg': 'dmg-1210',
    'idea-note-1.2.10-arm64-mac.zip': 'zip-1210',
    // 清单、日志、目录（应原样保留）
    'latest-mac.yml': 'version: 1.2.10',
    'builder-debug.yml': 'debug',
    'package-mac.log': 'log',
    '.DS_Store': 'ds',
    'package': { dir: true },
    'mac-arm64': { dir: true }
  });

  const cap = captureLogger();
  const res = cleanupDirectory(dir, { keepCount: 2, logger: cap.logger });

  assert.equal(res.ok, true);
  assert.deepEqual(res.sortedVersions, ['1.2.2', '1.2.3', '1.2.4', '1.2.10']);
  assert.deepEqual(res.keepVersions, ['1.2.4', '1.2.10']);
  assert.deepEqual(res.removeVersions, ['1.2.2', '1.2.3']);
  assert.equal(res.removedFiles.length, 7);
  assert.equal(res.failedFiles.length, 0);

  const remaining = fs.readdirSync(dir).sort();
  assert.deepEqual(remaining, [
    '.DS_Store',
    'builder-debug.yml',
    'idea-note-1.2.10-arm64-mac.zip',
    'idea-note-1.2.4-mac.zip',
    'latest-mac.yml',
    'mac-arm64',
    'package',
    'package-mac.log',
    '灵感笔记-1.2.10.dmg',
    '灵感笔记-1.2.4.dmg'
  ]);
  assert.ok(cap.logs.some((l) => l.includes('保留 [1.2.4, 1.2.10]')));
  assert.ok(cap.logs.some((l) => l.includes('清理完成')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupDirectory: Windows 产物目录清理保留最近 2 个版本并跳过 latest.yml 与 win-unpacked', () => {
  const dir = makeTempTree({
    'idea-note-Setup-1.2.1.exe': 'exe1',
    'idea-note-Setup-1.2.1.exe.blockmap': 'bm1',
    'idea-note-1.2.1-win.zip': 'zip1',
    'idea-note-Setup-1.2.2.exe': 'exe2',
    'idea-note-Setup-1.2.3.exe': 'exe3',
    'latest.yml': 'version: 1.2.3',
    'win-unpacked': { dir: true }
  });

  const cap = captureLogger();
  const res = cleanupDirectory(dir, { keepCount: 2, logger: cap.logger });
  assert.equal(res.ok, true);
  assert.deepEqual(res.keepVersions, ['1.2.2', '1.2.3']);
  assert.deepEqual(res.removeVersions, ['1.2.1']);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'idea-note-Setup-1.2.2.exe',
    'idea-note-Setup-1.2.3.exe',
    'latest.yml',
    'win-unpacked'
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupDirectory: 版本数不超过 2 个时跳过删除', () => {
  const dir = makeTempTree({
    '灵感笔记-1.2.4.dmg': '1',
    '灵感笔记-1.2.5.dmg': '2',
    'latest-mac.yml': 'yml'
  });
  const cap = captureLogger();
  const res = cleanupDirectory(dir, { keepCount: 2, logger: cap.logger });
  assert.equal(res.ok, true);
  assert.equal(res.removedFiles.length, 0);
  assert.ok(fs.existsSync(path.join(dir, '灵感笔记-1.2.4.dmg')));
  assert.ok(fs.existsSync(path.join(dir, '灵感笔记-1.2.5.dmg')));
  assert.ok(cap.logs.some((l) => l.includes('无需清理')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('planCleanup: protectVersions 保护回溯打包的旧版本不被删除', () => {
  const dir = makeTempTree({
    '灵感笔记-1.2.2.dmg': 'a',
    '灵感笔记-1.2.3.dmg': 'b',
    '灵感笔记-1.2.4.dmg': 'c',
    '灵感笔记-1.2.5.dmg': 'd'
  });
  const plan = planCleanup(dir, { keepCount: 2, protectVersions: ['1.2.3'] });
  assert.deepEqual(plan.keepVersions, ['1.2.3', '1.2.5']);
  assert.deepEqual(plan.removeVersions, ['1.2.2', '1.2.4']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupDirectory: dryRun 仅打印计划，不删除任何文件', () => {
  const dir = makeTempTree({
    '灵感笔记-1.2.1.dmg': 'a',
    '灵感笔记-1.2.2.dmg': 'b',
    '灵感笔记-1.2.3.dmg': 'c'
  });
  const cap = captureLogger();
  const res = cleanupDirectory(dir, { keepCount: 2, dryRun: true, logger: cap.logger });
  assert.equal(res.ok, true);
  assert.equal(res.removedFiles.length, 1);
  assert.ok(fs.existsSync(path.join(dir, '灵感笔记-1.2.1.dmg')));
  assert.ok(cap.logs.some((l) => l.includes('[dry-run]')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============ 异常处理与非阻断隔离 ============

test('cleanupOldArtifacts: 目录不存在或路径为文件时记录日志/告警，不抛异常', () => {
  const tmpFile = path.join(os.tmpdir(), `cleanup-not-a-dir-${process.pid}`);
  fs.writeFileSync(tmpFile, 'x');
  const cap = captureLogger();
  const missingDir = path.join(os.tmpdir(), `cleanup-missing-${process.pid}-${Date.now()}`);

  const outcome = cleanupOldArtifacts([missingDir, tmpFile], { logger: cap.logger });
  assert.equal(outcome.results[0].skipped, true);
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.results[1].ok, false);
  assert.ok(cap.warns.some((w) => w.includes('处理目录异常')));
  fs.rmSync(tmpFile, { force: true });
});

test('cleanupDirectory: 单文件删除抛出 EPERM/EBUSY 时仅记警告并继续清理其余文件，不抛出异常', () => {
  const dir = makeTempTree({
    '灵感笔记-1.2.1.dmg': 'locked',
    '灵感笔记-1.2.1-arm64.dmg': 'removable',
    '灵感笔记-1.2.2.dmg': 'keep1',
    '灵感笔记-1.2.3.dmg': 'keep2'
  });

  const cap = captureLogger();
  const res = cleanupDirectory(dir, {
    keepCount: 2,
    logger: cap.logger,
    rmImpl: (target) => {
      if (target.endsWith('1.2.1.dmg')) {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      fs.rmSync(target, { force: true });
    }
  });

  assert.equal(res.ok, false);
  assert.equal(res.failedFiles.length, 1);
  assert.equal(res.removedFiles.length, 1);
  assert.ok(fs.existsSync(path.join(dir, '灵感笔记-1.2.1.dmg')));
  assert.ok(!fs.existsSync(path.join(dir, '灵感笔记-1.2.1-arm64.dmg')));
  assert.ok(cap.warns.some((w) => w.includes('删除失败（已忽略，不影响本次打包）')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI parseArgs & main: 正常解析参数；异常参数或错误默认退出码 0（非阻断）', () => {
  const parsed = parseArgs(['--dir', 'dist', '--dir=dist/package-win', '--keep', '2', '--protect', '1.2.5', '--dry-run']);
  assert.deepEqual(parsed.dirs, ['dist', 'dist/package-win']);
  assert.equal(parsed.keepCount, 2);
  assert.deepEqual(parsed.protectVersions, ['1.2.5']);
  assert.equal(parsed.dryRun, true);

  // 非法参数在非严格 CLI 下也返回 0，避免阻断构建脚本
  assert.equal(main(['--unknown-flag']), 0);
  assert.equal(main(['--help']), 0);
});
