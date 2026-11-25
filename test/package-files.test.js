/**
 * package-files.test.js —— 打包白名单覆盖性检查
 *
 * 背景（真实事故 2026-11-26）：新增 `window-controls.js` / `window-resize.js` 后忘记加进
 * `package.json` 的 `build.files` 白名单，asar 里没有这两个文件，Windows 安装包一启动就
 * `Cannot find module './window-controls'` 崩溃。单测与 smoke 都是跑源码、发现不了，必须静态校验。
 *
 * 规则：从入口（main.js / preload.js）出发递归收集所有 `require('./x')` 本地模块，
 * 断言每一个都被 build.files 的某个模式覆盖。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FILES = pkg.build.files;

/** files 模式匹配：支持 "dir/**\/*" 前缀匹配与字面量精确匹配 */
function isCovered(relPath, patterns) {
  return patterns.some((pattern) => {
    if (pattern.indexOf('**') >= 0) {
      const prefix = pattern.slice(0, pattern.indexOf('**'));
      return relPath.startsWith(prefix);
    }
    return relPath === pattern;
  });
}

/** 递归收集入口可达的本地模块（相对仓库根的路径） */
function collectLocalModules(entries) {
  const seen = new Set();
  const queue = entries.slice();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue; // 非本地文件/不存在则跳过
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const re = /require\(\s*(['"])(\.\/[^'"]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      let target = m[2];
      if (!target.endsWith('.js') && !target.endsWith('.json')) target += '.js';
      const relTarget = path.relative(ROOT, path.resolve(path.join(ROOT, path.dirname(rel)), target));
      if (!relTarget.startsWith('..') && !relTarget.includes('node_modules')) queue.push(relTarget);
    }
  }
  return Array.from(seen);
}

test('build.files 覆盖入口依赖链里的所有本地模块', () => {
  const modules = collectLocalModules(['main.js', 'preload.js']);
  assert.ok(modules.length >= 3, '至少要收集到几个模块，否则正则/路径解析有问题');
  const missing = modules.filter((m) => !isCovered(m, FILES));
  assert.deepStrictEqual(missing, [], '以下本地模块不在 build.files 白名单里（打包后会 Cannot find module）：' + missing.join(', '));
});

test('新增的窗口控制模块必须在白名单里（事故回归）', () => {
  assert.ok(FILES.includes('window-controls.js'), 'window-controls.js 必须在 build.files');
  assert.ok(FILES.includes('window-resize.js'), 'window-resize.js 必须在 build.files');
});

test('renderer / assets / qz 目录白名单保持存在', () => {
  assert.ok(FILES.includes('renderer/**/*'));
  assert.ok(FILES.includes('assets/**/*'));
  assert.ok(FILES.includes('qz/**/*'));
});
