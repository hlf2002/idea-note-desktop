/**
 * qz/config.js —— Q助理【开放平台】接入配置
 *
 * 内部接口（client.qzhuli.com + /h5/jump 换 Vue token）已废弃，全部改走开放平台。
 * AppSecret 不在客户端，只在服务器 /etc/ideanote/ideanote.env。
 */
'use strict';

module.exports = {
  // 开放平台基址（业务请求经中转服务代签名，此值用于展示/诊断）
  OPEN_BASE_URL: 'https://open.qzhuli.com',

  // 登录/签名中转服务（同域部署在官网服务器，nginx 反代 127.0.0.1:3100）
  RELAY_BASE_URL: 'https://ideanote.7373.com.cn',

  // 开放平台应用标识（AppKey 属公开信息，可入客户端）
  QZ_APP_KEY: 'qz_16a0c1f945b411fd44e9feb57b2e7aac',

  // 中转服务客户端密钥（防第三方白嫖代签名；服务端 CLIENT_PIN 可轮换）
  RELAY_CLIENT_PIN: 'ea5c23ed300841528bf5af639a0fa14f',

  // 授权轮询间隔 / 单次登录等待上限
  LOGIN_POLL_INTERVAL_MS: 2000,
  LOGIN_POLL_TIMEOUT_MS: 10 * 60 * 1000,

  // 灵感笔记分页（开放平台 page_size 最大 20）
  PAGE_SIZE: 20,

  // 灵感笔记标签最大长度（服务端处理建议）
  TAG_MAX_LEN: 10,

  // 图片上传限制（/open/media/upload）
  IMAGE_MAX_BYTES: 10 * 1024 * 1024,
  IMAGE_MIME_ALLOWED: ['image/jpeg', 'image/png', 'image/webp']
};
