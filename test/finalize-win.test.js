'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { signatureVerdict } = require('../scripts/finalize-win');

test('签名状态：PowerShell 输出枚举名 Valid', () => {
  assert.equal(signatureVerdict('Valid'), 'valid');
});

test('签名状态：ConvertTo-Json 把枚举序列化成数字 0（打包机实测回归）', () => {
  // 2026-11-24 实测：签名真实通过，Status 输出 0、StatusMessage「签名已通过验证。」，
  // 旧代码比字符串 'Valid' 失败，报「签名状态异常：0 签名已通过验证。」并 exit 1
  assert.equal(signatureVerdict(0), 'valid');
  assert.equal(signatureVerdict('0'), 'valid');
});

test('签名状态：NotSigned 的枚举名与数字 2', () => {
  assert.equal(signatureVerdict('NotSigned'), 'notsigned');
  assert.equal(signatureVerdict(2), 'notsigned');
});

test('签名状态：未知值不乐观放行（HashMismatch 等必须走 fail）', () => {
  assert.equal(signatureVerdict('HashMismatch'), 'unknown');
  assert.equal(signatureVerdict('NotTrusted'), 'unknown');
  assert.equal(signatureVerdict(3), 'unknown');
  assert.equal(signatureVerdict(null), 'unknown');
  assert.equal(signatureVerdict(''), 'unknown');
});
