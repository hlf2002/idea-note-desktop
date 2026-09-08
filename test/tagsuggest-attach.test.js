/**
 * tagsuggest-attach.test.js —— 标签联想 attach 链路测试（最小 DOM stub，不依赖浏览器）
 * 验证：输入 # 打开下拉 → 字符筛选 → ↑/↓ 移动 → Enter 调用 replaceText → Esc 关闭 → detach 清理
 * 运行：npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ---- 最小 DOM stub ----
function makeEl() {
  const el = {
    className: '',
    style: {},
    dataset: {},
    _html: '',
    childNodes: [],
    parentNode: null,
    _listeners: {},
    classList: {
      add(c) { if (!el.className.split(/\s+/).includes(c)) el.className = (el.className + ' ' + c).trim(); },
      remove(c) { el.className = el.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle(c, on) { if (on === undefined) on = !el.classList.contains(c); on ? el.classList.add(c) : el.classList.remove(c); },
      contains(c) { return el.className.split(/\s+/).includes(c); }
    },
    setAttribute() {},
    appendChild(c) { c.parentNode = el; el.childNodes.push(c); return c; },
    removeChild(c) { const i = el.childNodes.indexOf(c); if (i >= 0) el.childNodes.splice(i, 1); return c; },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const arr = el._listeners[t] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    querySelectorAll(sel) {
      if (sel === '.tag-suggest-item') {
        return el.childNodes.filter((c) => c.className && c.className.indexOf('tag-suggest-item') !== -1);
      }
      return [];
    },
    contains(node) {
      if (node === el) return true; // 真实 DOM：element.contains(element) === true
      return el.childNodes.some((c) => c === node || (c.contains && c.contains(node)));
    },
    getBoundingClientRect() { return { left: 100, bottom: 200, width: 400, height: 80 }; }
  };
  // innerHTML 赋值模拟真实 DOM：清空子节点（render 依赖此行为重置内容）
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = v;
      if (v === '') el.childNodes.length = 0;
    }
  });
  return el;
}

// 注入全局 stub（tagsuggest.js 的 attach 使用 document/window）
const docEl = makeEl();
const bodyEl = makeEl();
bodyEl.appendChild = function (c) { c.parentNode = bodyEl; bodyEl.childNodes.push(c); return c; };
bodyEl.removeChild = function (c) { const i = bodyEl.childNodes.indexOf(c); if (i >= 0) bodyEl.childNodes.splice(i, 1); return c; };
globalThis.document = {
  createElement: () => makeEl(),
  body: bodyEl,
  activeElement: null
};
globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {}
};

const { attach } = require('../renderer/tagsuggest.js');

function makeComposer(initialText) {
  let text = initialText || '';
  let offset = text.length;
  const calls = [];
  const el = makeEl();
  return {
    el,
    rawValue: () => text,
    caretOffset: () => offset,
    replaceText(start, end, replacement) {
      calls.push({ start, end, replacement });
      text = text.slice(0, start) + replacement + text.slice(end);
      offset = start + replacement.length;
    },
    focus() {},
    _calls: calls,
    _set(textVal, off) { text = textVal; offset = off === undefined ? textVal.length : off; }
  };
}

function fire(el, type, ev) {
  (el._listeners[type] || []).forEach((fn) => fn(ev || { isComposing: false }));
}

const ALL_TAGS = ['工作', '灵感', '读书计划'];

// 每个测试前清空全局 body，避免浮层泄漏到下一个用例
function resetBody() { bodyEl.childNodes.length = 0; }

test('attach: 无 # 输入不打开下拉', () => {
  resetBody();
  const composer = makeComposer('你好');
  attach(composer, { getTags: () => ALL_TAGS.slice() });
  fire(composer.el, 'input');
  // 未创建浮层（refresh 检测不到标签输入态即 close，不 ensureBox）
  // 此时 body 无 .tag-suggest 子节点
  assert.strictEqual(bodyEl.childNodes.length, 0);
});

test('attach: 输入 # 打开下拉并显示全部标签；输入字符后筛选', () => {
  resetBody();
  const composer = makeComposer('你好 ');
  attach(composer, { getTags: () => ALL_TAGS.slice() });
  composer._set('你好 #', 4);
  fire(composer.el, 'input');
  assert.strictEqual(bodyEl.childNodes.length, 1); // 浮层已创建
  const box = bodyEl.childNodes[0];
  assert.ok(box.classList.contains('tag-suggest'), '浮层有 tag-suggest 类');
  assert.ok(!box.classList.contains('hidden'), '浮层可见');
  assert.strictEqual(box.querySelectorAll('.tag-suggest-item').length, 3, '显示全部标签');

  // 输入一个字 → 筛选
  composer._set('你好 #工', 5);
  fire(composer.el, 'input');
  const items = box.querySelectorAll('.tag-suggest-item');
  assert.strictEqual(items.length, 1, '筛出 1 个');
  assert.strictEqual(items[0].dataset.tag, '工作');

  // 输入无匹配字 → 空态提示
  composer._set('你好 #zzz', 6);
  fire(composer.el, 'input');
  assert.strictEqual(box.querySelectorAll('.tag-suggest-item').length, 0);
  assert.ok(box.childNodes.some((c) => c.className.indexOf('tag-suggest-empty') !== -1), '显示无匹配提示');
});

test('attach: Enter 确认 → replaceText 替换 #query 为 #标签', () => {
  resetBody();
  const composer = makeComposer('你好 #工');
  attach(composer, { getTags: () => ALL_TAGS.slice() });
  fire(composer.el, 'input');
  const ev = { key: 'Enter', preventDefault() { this.pd = true; }, stopPropagation() { this.sp = true; } };
  fire(composer.el, 'keydown', ev);
  assert.strictEqual(ev.pd, true, '拦截默认行为');
  assert.strictEqual(ev.sp, true, '阻止冒泡（不触发编辑器换行）');
  assert.deepStrictEqual(composer._calls[0], { start: 3, end: 5, replacement: '#工作 ' });
  // 替换后关闭
  const box = bodyEl.childNodes[0];
  assert.ok(box.classList.contains('hidden'), '确认后关闭');
});

test('attach: ↑/↓ 移动高亮，Enter 选中高亮项', () => {
  resetBody();
  const composer = makeComposer('#');
  attach(composer, { getTags: () => ALL_TAGS.slice() });
  fire(composer.el, 'input');
  const box = bodyEl.childNodes[0];
  const key = (k) => ({ key: k, preventDefault() { this.pd = true; }, stopPropagation() { this.sp = true; } });
  fire(composer.el, 'keydown', key('ArrowDown'));
  fire(composer.el, 'keydown', key('ArrowDown'));
  const items = box.querySelectorAll('.tag-suggest-item');
  assert.ok(items[2].classList.contains('active'), '↓ 两次高亮第 3 项');
  fire(composer.el, 'keydown', key('ArrowUp'));
  assert.ok(items[1].classList.contains('active'), '↑ 一次回到第 2 项');
  fire(composer.el, 'keydown', key('Enter'));
  assert.deepStrictEqual(composer._calls[0], { start: 0, end: 1, replacement: '#灵感 ' });
});

test('attach: Esc 关闭且不触发编辑器行为', () => {
  resetBody();
  const composer = makeComposer('#');
  attach(composer, { getTags: () => ALL_TAGS.slice() });
  fire(composer.el, 'input');
  const box = bodyEl.childNodes[0];
  const ev = { key: 'Escape', preventDefault() { this.pd = true; }, stopPropagation() { this.sp = true; } };
  fire(composer.el, 'keydown', ev);
  assert.strictEqual(ev.pd, true);
  assert.strictEqual(ev.sp, true);
  assert.ok(box.classList.contains('hidden'), 'Esc 关闭下拉');
});

test('attach: 标签数据为空时显示「暂无标签」空态', () => {
  resetBody();
  const composer = makeComposer('#');
  attach(composer, { getTags: () => [] });
  fire(composer.el, 'input');
  const box = bodyEl.childNodes[0];
  assert.ok(box.childNodes.some((c) => c.className.indexOf('tag-suggest-empty') !== -1), '显示暂无标签');
});

test('attach: blur 后焦点回到输入框（工具栏按钮场景）不关闭下拉', async () => {
  resetBody();
  const composer = makeComposer('你好 ');
  attach(composer, { getTags: () => ALL_TAGS.slice() });
  composer._set('你好 #', 4);
  fire(composer.el, 'input');
  const box = bodyEl.childNodes[0];
  assert.ok(!box.classList.contains('hidden'));
  // 模拟点击工具栏按钮：blur 时 activeElement 暂为按钮，click 后回到输入框
  globalThis.document.activeElement = composer.el;
  fire(composer.el, 'blur');
  await new Promise((r) => setTimeout(r, 150)); // 等待延迟关闭回调
  assert.ok(!box.classList.contains('hidden'), '焦点回到输入框则保持打开');
});

test('attach: blur 后焦点移出（点击别处）关闭下拉', async () => {
  resetBody();
  const composer = makeComposer('你好 #');
  attach(composer, { getTags: () => ALL_TAGS.slice() });
  fire(composer.el, 'input');
  const box = bodyEl.childNodes[0];
  assert.ok(!box.classList.contains('hidden'));
  globalThis.document.activeElement = bodyEl; // 焦点移到输入框外
  fire(composer.el, 'blur');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(box.classList.contains('hidden'), '焦点移出则关闭');
});

test('attach: detach 移除浮层与监听', () => {
  resetBody();
  const composer = makeComposer('#');
  const detach = attach(composer, { getTags: () => ALL_TAGS.slice() });
  fire(composer.el, 'input');
  assert.strictEqual(bodyEl.childNodes.length, 1);
  const before = composer.el._listeners.input.length;
  detach();
  assert.strictEqual(bodyEl.childNodes.length, 0, '浮层已移除');
  assert.strictEqual(composer.el._listeners.input.length, before - 1, 'input 监听已移除');
  // 卸载后再 input 不重建
  fire(composer.el, 'input');
  assert.strictEqual(bodyEl.childNodes.length, 0);
});
