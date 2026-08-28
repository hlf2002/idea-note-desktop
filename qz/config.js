/**
 * qz/config.js —— Q助理接入配置
 */
'use strict';

module.exports = {
  // 生产/测试网关（文档：agent.md / user.md）
  BASE_URL: 'https://client.qzhuli.com',
  TEST_BASE_URL: 'https://test.client.qzhuli.com',

  // 扫码登录渠道：3 = PC 客户端（user.md）
  API_CLIENT_TYPE_PC: 3,

  // 轮询扫码状态间隔（ms）
  QR_POLL_INTERVAL_MS: 3000,

  // 灵感笔记分页（最大 20，idea_note.md）
  PAGE_SIZE: 20,

  // 灵感笔记标签最大长度（idea_note.md「服务端处理建议」）
  TAG_MAX_LEN: 10
};
