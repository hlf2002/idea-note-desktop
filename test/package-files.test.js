/**
 * package-files.test.js —— 打包白名单覆盖性检查（复用 scripts/check-package-files.js）
 *
 * 背景（真实事故 2026-11-26）：新增 `window-controls.js` / `window-resize.js` 后忘记加进
 * `package.json` 的 `build.files` 白名单，asar 里没有这两个文件，Windows 安装包一启动就
 * `Cannot find module './window-controls'` 崩溃。单测与 smoke 都是跑源码、发现不了，必须静态校验。
 *
 * 规则逻辑只维护一份：scripts/check-package-files.js（打包前闸门与单测共用）。
 * 本文件只做「真实仓库断言」与「解析器能力回归」。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ROOT,
  ROOT_JS_EXEMPT,
  isCovered,
  collectLocalModules,
  checkStatic
} = require('../scripts/check-package-files');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FILES = pkg.build.files;

test('真实仓库：checkStatic 无问题（白名单覆盖入口依赖链）', () => {
  const r = checkStatic(ROOT);
  assert.deepStrictEqual(r.problems, [], r.problems.join('\n'));
});

test('build.files 覆盖入口依赖链里的所有本地模块', () => {
  const { modules } = collectLocalModules(ROOT, ['main.js', 'preload.js']);
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

test('根目录 .js 全部有归属：白名单或开发脚本豁免', () => {
  const rootJs = fs.readdirSync(ROOT).filter((n) => n.endsWith('.js'));
  const orphans = rootJs.filter((n) => !isCovered(n, FILES) && !ROOT_JS_EXEMPT.includes(n));
  assert.deepStrictEqual(orphans, [], '根目录这些 .js 既没进 build.files 也没登记豁免：' + orphans.join(', '));
});

test('解析器能力：../、path.join(__dirname, a, b) 与目录依赖都能收集', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkginspect-'));
  const write = (rel, body) => {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  try {
    write('main.js', "require('./lib/a');\nconst p = path.join(__dirname, 'assets', 'icon.png');\n");
    write('lib/a.js', "require('../b');\n");
    write('b.js', 'module.exports = {};\n');
    write('assets/icon.png', '');
    write('package.json', JSON.stringify({ build: { files: ['main.js', 'assets/**/*'] } }));

    const { modules, dirs, missingSpecs } = collectLocalModules(tmp, ['main.js']);
    assert.deepStrictEqual(missingSpecs, []);
    assert.ok(modules.includes('lib/a.js'), '应收集到 lib/a.js');
    assert.ok(modules.includes('b.js'), '应通过 ../ 收集到 b.js');
    assert.ok(modules.includes('assets/icon.png'), '应收集到 path.join(__dirname, assets, icon.png) 引用的资源文件');
    assert.ok(dirs.length === 0, '资源文件存在时不应误判为目录依赖');

    // lib/a.js 与 b.js 不在白名单 → checkStatic 必须报出来（证明漏检真的会被拦）
    const r = checkStatic(tmp);
    const joined = r.problems.join('\n');
    assert.match(joined, /lib\/a\.js/);
    assert.match(joined, /b\.js/);
    assert.ok(!joined.includes('assets/icon.png'), '被 assets/**/* 覆盖的资源文件不应误报');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
