'use strict';
/**
 * check-package-files.js —— 打包前白名单复核（用户要求：每次打包前都要复核别漏文件）
 *
 * 背景（真实事故 2026-11-26）：新增 `window-controls.js` / `window-resize.js` 后忘记加进
 * `package.json` 的 `build.files` 白名单，asar 里没有这两个文件，Windows 包一启动就
 * `Cannot find module './window-controls'` 崩溃。单测与 smoke 都跑源码、发现不了。
 *
 * 本脚本是打包前的静态闸门，被三处调用：
 *   - deploy/deploy.sh（Jenkins 双端打包，win 与 mac 两路都过）
 *   - scripts/win-sign.js（本地 npm run package:win 也过）
 *   - test/package-files.test.js（单测复用同一份逻辑，避免规则漂移）
 *
 * 检查项：
 *   1. 白名单里的字面量文件必须真实存在（防拼写错误 / 已删未清）
 *   2. 从入口（main.js、preload.js 及白名单根模块）递归收集本地 require，
 *      每一个都必须被 build.files 覆盖（支持 './x'、'../x'、path.join(__dirname, 'x')）
 *   3. 根目录的 *.js 必须有归属：在白名单里，或登记在 ROOT_JS_EXEMPT（开发脚本）
 *   4. 可选 `--asar <path>`：把应打包文件集合与 asar 实际清单逐条比对
 *
 * 用法：node scripts/check-package-files.js [--asar dist/mac-arm64/灵感笔记.app/Contents/Resources/app.asar]
 * 通过输出 PACKAGE_FILES_PASS=true，退出码 0；失败列出问题，退出码 1。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 根目录里属于开发工具、明确不打进 asar 的脚本 */
const ROOT_JS_EXEMPT = ['smoke-test.js', 'gen-icon.js'];

const REQUIRE_RE = /require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
// path.join(__dirname, 'a', 'b.png') —— 只匹配“全部为字符串字面量”的形式，含变量的跳过
const DIRNAME_JOIN_RE = /path\.join\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,\s*)+['"][^'"]+['"])/g;

/** 把 path.join 的字面量参数列表拼成相对路径（如 "'assets', 'icon-mac.png'" → assets/icon-mac.png） */
function joinSegments(argList) {
  const segs = [];
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(argList))) segs.push(m[1]);
  return segs.join('/');
}

function norm(p) {
  return p.replace(/\\/g, '/');
}

function readPkg(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

/** build.files 模式匹配：支持 "dir/**" 前缀匹配与字面量精确匹配 */
function isCovered(relPath, patterns) {
  return patterns.some((pattern) => {
    if (pattern.includes('**')) {
      const prefix = pattern.slice(0, pattern.indexOf('**'));
      return relPath.startsWith(prefix);
    }
    return relPath === pattern;
  });
}

/** 把说明符解析为仓库内相对路径；返回 { rel, kind: 'file'|'dir' }，找不到返回 null */
function resolveLocal(root, fromRel, spec) {
  const base = path.resolve(root, path.dirname(fromRel), spec);
  const rel = norm(path.relative(root, base));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const candidates = [rel];
  if (!/\.(js|json)$/.test(rel)) candidates.push(rel + '.js', rel + '.json');
  for (const c of candidates) {
    const abs = path.join(root, c);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isFile()) return { rel: norm(c), kind: 'file' };
    if (st.isDirectory() && c === rel) return { rel: norm(c), kind: 'dir' };
  }
  return null;
}

/** 递归收集入口可达的本地模块；同时返回解析不到的 require 与目录依赖 */
function collectLocalModules(root, entries) {
  const seen = new Set();
  const dirs = new Set();
  const queue = entries.map(norm);
  const missingSpecs = [];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    seen.add(rel);
    if (!rel.endsWith('.js')) continue;
    const src = fs.readFileSync(abs, 'utf8');
    const specs = [];
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(src))) specs.push(m[2]);
    DIRNAME_JOIN_RE.lastIndex = 0;
    while ((m = DIRNAME_JOIN_RE.exec(src))) specs.push(joinSegments(m[1]));
    for (const spec of specs) {
      const resolved = resolveLocal(root, rel, spec);
      if (!resolved) {
        missingSpecs.push(rel + ' → ' + spec);
        continue;
      }
      if (resolved.rel.includes('node_modules')) continue;
      if (resolved.kind === 'dir') {
        dirs.add(resolved.rel);
        continue;
      }
      queue.push(resolved.rel);
    }
  }
  return { modules: Array.from(seen), dirs: Array.from(dirs), missingSpecs };
}

/** 递归列出目录内文件（跳过隐藏文件） */
function listDirFiles(root, dirRel, acc) {
  const abs = path.join(root, dirRel);
  if (!fs.existsSync(abs)) return acc;
  for (const name of fs.readdirSync(abs)) {
    if (name.startsWith('.')) continue;
    const childRel = norm(path.join(dirRel, name));
    const childAbs = path.join(root, childRel);
    const st = fs.statSync(childAbs);
    if (st.isDirectory()) listDirFiles(root, childRel, acc);
    else if (st.isFile()) acc.add(childRel);
  }
  return acc;
}

/** 按 build.files 推导「应打包进 asar 的源码文件集合」 */
function expectedFiles(root, patterns, modules) {
  const set = new Set(modules);
  for (const pattern of patterns) {
    if (pattern.includes('**')) {
      const prefix = pattern.slice(0, pattern.indexOf('**')).replace(/\/$/, '');
      if (prefix) listDirFiles(root, prefix, set);
    } else {
      set.add(norm(pattern));
    }
  }
  return set;
}

function checkStatic(root = ROOT) {
  const problems = [];
  const pkg = readPkg(root);
  const patterns = (pkg.build && pkg.build.files) || [];
  if (!patterns.length) {
    problems.push('package.json 缺少 build.files 白名单（electron-builder 会按默认规则打，容易漏/多）');
    return { problems, patterns, modules: [], rootJs: [] };
  }

  // 1. 字面量文件必须存在
  const literal = patterns.filter((p) => !p.includes('**')).map(norm);
  for (const p of literal) {
    if (!fs.existsSync(path.join(root, p))) {
      problems.push('白名单列的 ' + p + ' 在仓库里不存在（拼写错误或已被删除）');
    }
  }

  // 2. 入口依赖链必须被覆盖
  const entries = ['main.js', 'preload.js'].concat(literal);
  const { modules, dirs, missingSpecs } = collectLocalModules(root, entries);
  for (const m of modules) {
    if (!isCovered(m, patterns)) {
      problems.push('模块不在 build.files 白名单（打包后启动会 Cannot find module）：' + m);
    }
  }
  for (const d of dirs) {
    // 目录依赖（如 path.join(__dirname,'assets','x.png') 的上层 assets）：用子路径探针判断前缀覆盖
    if (!isCovered(d + '/__probe__', patterns)) {
      problems.push('代码引用的目录不在 build.files 白名单（打包后文件缺失）：' + d);
    }
  }
  for (const s of missingSpecs) {
    problems.push('require 目标不存在（代码或路径已坏）：' + s);
  }

  // 3. 根目录 *.js 必须有归属
  const rootJs = fs
    .readdirSync(root)
    .filter((n) => n.endsWith('.js') && fs.statSync(path.join(root, n)).isFile());
  for (const n of rootJs) {
    if (!isCovered(n, patterns) && !ROOT_JS_EXEMPT.includes(n)) {
      problems.push('根目录 ' + n + ' 既不在 build.files 白名单，也未在 ROOT_JS_EXEMPT 登记为开发脚本');
    }
  }

  return { problems, patterns, modules, rootJs, literal, missingSpecs };
}

function checkAsar(root, asarPath, patterns) {
  const problems = [];
  let asar;
  try {
    // electron-builder 的依赖里带 @electron/asar，打包机 npm ci 后一定可用
    asar = require('@electron/asar');
  } catch (e) {
    return { problems: ['未安装 @electron/asar，无法校验 asar 清单（跳过）'], skipped: true };
  }
  if (!fs.existsSync(asarPath)) {
    return { problems: ['asar 不存在：' + asarPath], skipped: false };
  }
  const list = new Set(asar.listPackage(asarPath).map((p) => norm(p.replace(/^[\\/]+/, ''))));
  const { modules } = collectLocalModules(root, ['main.js', 'preload.js'].concat(patterns.filter((p) => !p.includes('**'))));
  const expected = expectedFiles(root, patterns, modules);
  for (const f of expected) {
    if (!list.has(f)) problems.push('asar 里缺少文件：' + f);
  }
  return { problems, skipped: false, count: list.size, expected: expected.size };
}

function main(argv = []) {
  let asarPath = '';
  const i = argv.indexOf('--asar');
  if (i >= 0) {
    asarPath = argv[i + 1] || '';
    if (!asarPath) {
      console.error('✗ --asar 需要跟一个 asar 路径');
      return 2;
    }
  }

  const { problems, patterns, modules } = checkStatic(ROOT);
  console.log('[preflight] 打包白名单复核（' + modules.length + ' 个本地模块、' + patterns.length + ' 条白名单）');
  for (const p of problems) console.error('  ✗ ' + p);

  let asarProblems = [];
  if (asarPath) {
    const r = checkAsar(ROOT, asarPath, patterns);
    asarProblems = r.problems;
    for (const p of asarProblems) console.error('  ✗ ' + p);
    if (!r.skipped) {
      console.log('  · asar 清单 ' + r.count + ' 个条目，应打包 ' + r.expected + ' 个文件');
    }
  }

  if (problems.length || asarProblems.length) {
    console.error('PACKAGE_FILES_PASS=false');
    return 1;
  }
  console.log('PACKAGE_FILES_PASS=true');
  return 0;
}

module.exports = {
  ROOT,
  ROOT_JS_EXEMPT,
  isCovered,
  resolveLocal,
  collectLocalModules,
  expectedFiles,
  checkStatic,
  checkAsar,
  main
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
