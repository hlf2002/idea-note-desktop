/**
 * qz/openapi.js —— Q助理【开放平台】客户端
 *
 * 与旧 qz/api.js 的区别：
 *   旧：内部接口（/user/qr_login_create + /h5/jump 换 Vue token）—— 已废弃
 *   新：开放平台 OAuth（app_key 扫码授权 → 用户 access_token）+ 签名请求头
 *
 * 架构（AppSecret 只在服务端）：
 *   客户端 --(start/poll/refresh)--> https://ideanote.7373.com.cn/oauth/*  --(签名+AppSecret)--> open.qzhuli.com
 *   业务接口直连 open.qzhuli.com，带 X-QZ-* 签名头 + Authorization: Bearer <access_token>
 *   （业务签名只用 HmacSHA256(app_key/timestamp/nonce/access_token)，不需要 AppSecret）
 *
 * 登录态永续策略：
 *   access_token 2 小时有效；refresh_token 90 天且每次刷新轮换。
 *   只要应用在 90 天内运行过一次，refresh 就会把两个窗口一起续期 → 用户无需再扫码。
 *   刷新成功必须立即持久化（onTokens），否则轮换后的旧 refresh_token 失效会导致掉登录。
 *
 * 设计：可注入 fetch / relayUrl / baseUrl，便于单元测试。
 */
'use strict';

/** 业务 API 基址（实际请求经中转服务转发，此常量仅用于日志/诊断） */
const OPEN_BASE_URL = 'https://open.qzhuli.com';
/** 中转服务基址（AppSecret 只在服务端） */
const RELAY_BASE_URL = 'https://ideanote.7373.com.cn';
/** 刷新提前量：access_token 剩余不足 5 分钟就换新 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;
/** refresh_token 剩余不足 7 天时也强制刷新（滚动续期） */
const REFRESH_ROTATE_AHEAD_MS = 7 * 24 * 3600 * 1000;
/** 单请求超时 */
const REQUEST_TIMEOUT_MS = 20000;

class QzApiError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.name = 'QzApiError';
    this.code = code;
    this.payload = payload;
  }
}

function nowMs() {
  return Date.now();
}

class QzOpenApi {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl] 开放平台基址
   * @param {string} [opts.relayUrl] 中转服务基址
   * @param {string} [opts.appKey] 开放平台 AppKey（请求头用）
   * @param {string} [opts.clientPin] 中转服务共享密钥
   * @param {Function} [opts.fetchImpl]
   * @param {Function} [opts.onTokens] token 变化回调（必须落盘，返回 Promise 亦可）
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || OPEN_BASE_URL).replace(/\/+$/, '');
    this.relayUrl = (opts.relayUrl || RELAY_BASE_URL).replace(/\/+$/, '');
    this.appKey = opts.appKey || '';
    this.clientPin = opts.clientPin || '';
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    this.onTokens = opts.onTokens || null;
    this.auth = null;
  }

  /** 设置登录态；会补齐 expires_at（毫秒） */
  setAuth(auth) {
    if (!auth || !auth.access_token) {
      this.auth = null;
      return;
    }
    this.auth = {
      q_uid: auth.q_uid || '',
      nickname: auth.nickname || '',
      avatar: auth.avatar || '',
      access_token: auth.access_token,
      refresh_token: auth.refresh_token || '',
      expires_at: Number(auth.expires_at) || nowMs() + 2 * 3600 * 1000,
      refresh_expires_at: Number(auth.refresh_expires_at) || 0,
      authorized_at: Number(auth.authorized_at) || nowMs()
    };
  }

  get isAuthed() {
    return !!(this.auth && this.auth.access_token);
  }

  /** 公开的登录态快照（不含 token） */
  profile() {
    if (!this.auth) return null;
    return {
      q_uid: this.auth.q_uid,
      nickname: this.auth.nickname,
      avatar: this.auth.avatar,
      expires_at: this.auth.expires_at,
      refresh_expires_at: this.auth.refresh_expires_at
    };
  }

  // ---------- 登录流程（经中转服务） ----------
  /**
   * 开始授权：从中转服务拿 state 与授权地址。
   * @returns {Promise<{state:string, authorizeUrl:string}>}
   */
  async startLogin() {
    const data = await this._relay('GET', '/oauth/start');
    if (!data || !data.state || !data.authorizeUrl) {
      throw new QzApiError('授权服务返回异常', -1, data);
    }
    return data;
  }

  /**
   * 轮询授权结果。
   * @returns {Promise<{status:'pending'|'ok'|'error'|'expired', error?:string}>}
   */
  async pollLogin(state) {
    if (!state) throw new QzApiError('缺少 state', -1);
    const data = await this._relay('GET', '/oauth/poll?state=' + encodeURIComponent(state));
    return data || { status: 'expired' };
  }

  /** 把中转服务返回的登录结果转成本地登录态并落盘 */
  async acceptLoginResult(result) {
    if (!result || result.status !== 'ok' || !result.access_token) {
      throw new QzApiError('授权结果无效', -1, result);
    }
    const auth = {
      q_uid: result.q_uid || '',
      nickname: result.nickname || '',
      avatar: result.avatar || '',
      access_token: result.access_token,
      refresh_token: result.refresh_token || '',
      expires_at: nowMs() + (Number(result.expires_in) || 7200) * 1000,
      refresh_expires_at: result.refresh_expires_in
        ? nowMs() + Number(result.refresh_expires_in) * 1000
        : 0,
      authorized_at: nowMs()
    };
    this.setAuth(auth);
    if (this.onTokens) await this.onTokens(this.auth);
    return this.auth;
  }

  // ---------- token 续期 ----------
  /**
   * 用 refresh_token 换新 token（经中转服务，AppSecret 不出服务器）。
   * 只有中转服务明确返回 401 + invalid 才判定登录失效；网络/5xx 一律按瞬时故障抛错，不踢登录。
   */
  async refresh() {
    if (!this.isAuthed) throw new QzApiError('未登录', 401);
    if (!this.auth.refresh_token) {
      const err = new QzApiError('缺少 refresh_token，需要重新授权', 401);
      err.authExpired = true;
      throw err;
    }
    const res = await this._rawRelay('POST', '/oauth/refresh', { refresh_token: this.auth.refresh_token });
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    if (res.status === 200 && json && json.code === 0 && json.data && json.data.access_token) {
      const d = json.data;
      this.auth = {
        ...this.auth,
        q_uid: d.q_uid || this.auth.q_uid,
        access_token: d.access_token,
        refresh_token: d.refresh_token || this.auth.refresh_token,
        expires_at: nowMs() + (Number(d.expires_in) || 7200) * 1000,
        refresh_expires_at: d.refresh_expires_in
          ? nowMs() + Number(d.refresh_expires_in) * 1000
          : this.auth.refresh_expires_at
      };
      if (this.onTokens) await this.onTokens(this.auth);
      return this.auth;
    }
    if (res.status === 401 && json && json.invalid) {
      const err = new QzApiError('登录凭证已失效，需要重新扫码授权', 401, json);
      err.authExpired = true;
      throw err;
    }
    throw new QzApiError(
      '刷新登录凭证失败(HTTP ' + res.status + ')' + (json && json.message ? ': ' + json.message : ''),
      res.status >= 500 ? -3 : -1,
      json
    );
  }

  /**
   * 保证 access_token 新鲜：
   *  - 剩余不足 5 分钟 → 刷新
   *  - refresh_token 剩余不足 7 天 → 主动滚动续期
   */
  async ensureFresh() {
    if (!this.isAuthed) throw new QzApiError('未登录', 401);
    const a = this.auth;
    const accessFresh = a.expires_at - nowMs() > REFRESH_AHEAD_MS;
    const refreshFresh = !a.refresh_expires_at || a.refresh_expires_at - nowMs() > REFRESH_ROTATE_AHEAD_MS;
    if (accessFresh && refreshFresh) return a;
    return this.refresh();
  }

  /** 后台保鲜：运行期间每 intervalMs 检查一次（只做本地判断，需要时才发请求） */
  startKeepAlive(intervalMs = 30 * 60 * 1000) {
    this.stopKeepAlive();
    this._keepAliveTimer = setInterval(() => {
      if (!this.isAuthed) return;
      this.ensureFresh().catch(() => { /* 单次失败不致命，下个周期再试 */ });
    }, intervalMs);
    if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
  }

  stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  /**
   * 鉴权探测：判断持久化登录态是否还能用（不改变登录态）。
   * 拿不到网络结果时返回 network，调用方不得据此登出。
   */
  async probeAuth() {
    if (!this.isAuthed) return { ok: false, reason: 'no_auth' };
    try {
      await this.refresh();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err && err.authExpired ? 'token_invalid' : 'network',
        code: err && err.code
      };
    }
  }

  // ---------- 中转服务请求 ----------
  _relayHeaders(json) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.clientPin) h['x-ideanote-pin'] = this.clientPin;
    return h;
  }

  async _rawRelay(method, path, body) {
    const url = this.relayUrl + path;
    const init = { method, headers: this._relayHeaders(body !== undefined) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    init.signal = ctrl.signal;
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.code === 20);
      throw new QzApiError(
        aborted ? '登录服务响应超时，请检查网络后重试' : '无法连接登录服务: ' + ((err && err.message) || err),
        -1
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async _relay(method, path, body) {
    const res = await this._rawRelay(method, path, body);
    let json = null;
    try {
      json = await res.json();
    } catch (err) {
      throw new QzApiError('登录服务响应异常(HTTP ' + res.status + ')', res.status);
    }
    if (res.status !== 200 || !json || json.code !== 0) {
      throw new QzApiError(
        (json && json.message) || '登录服务错误(HTTP ' + res.status + ')',
        res.status,
        json
      );
    }
    return json.data;
  }

  // ---------- 开放平台业务接口（经中转服务代签名） ----------
  /**
   * 调用开放平台业务接口。
   * 所有请求都经中转服务签名转发：开放平台的业务接口同样用 AppSecret 做 HMAC，
   * 客户端拿不到 AppSecret，因此不能直连 open.qzhuli.com。
   */
  async _open(method, apiPath, { query, body } = {}) {
    if (!this.isAuthed) throw new QzApiError('未登录', 401);
    await this.ensureFresh();

    const res = await this._rawRelay('POST', '/api/open', {
      method,
      path: apiPath,
      query: query || undefined,
      body: body === undefined ? undefined : body,
      access_token: this.auth.access_token
    });

    let json = null;
    try {
      json = await res.json();
    } catch (err) {
      throw new QzApiError('响应解析失败(HTTP ' + res.status + ')', res.status);
    }

    if (res.status === 403) {
      throw new QzApiError('登录服务拒绝访问（客户端密钥不匹配）', -1, json);
    }
    if (res.status >= 500) {
      // 网关/上游瞬时故障：绝不能当成登录失效
      throw new QzApiError('服务暂时不可用(HTTP ' + res.status + ')', -3, json);
    }
    if (json && json.code === 40003) {
      // access_token 失效：交给 _authRetryOnce 用 refresh_token 自愈重试；
      // 只有 refresh 本身被明确判死才真正登出（避免误踢登录）
      throw new QzApiError('登录凭证已过期', 401, json);
    }
    if (json && json.code !== undefined && json.code !== 200) {
      throw new QzApiError(json.msg || '业务错误 ' + json.code, json.code, json);
    }
    if (res.status !== 200) {
      throw new QzApiError('请求失败(HTTP ' + res.status + ')', res.status, json);
    }
    return json ? json.data : null;
  }

  /** 401 自愈：refresh 后重试一次；凭证明确失效则直接抛 */
  async _authRetryOnce(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof QzApiError && err.code === 401 && !err.authExpired) {
        await this.refresh();
        return fn();
      }
      throw err;
    }
  }

  /** 笔记列表（按更新时间倒序） */
  async listNotes({ page = 1, pageSize = 20 } = {}) {
    return this._authRetryOnce(() => this._open('GET', '/open/idea_note/list', {
      query: { page, page_size: pageSize }
    }));
  }

  /** 笔记详情 */
  async getNote(id) {
    return this._authRetryOnce(() => this._open('GET', '/open/idea_note/detail', { query: { id } }));
  }

  /**
   * 笔记正文序列化。
   * 重要：开放平台文档示例给的是嵌套对象，但实测必须传 **JSON 字符串**，
   * 传对象会返回 40002「签名参数无效」（平台把 content_json 当字符串参与签名）。
   */
  _serializeContent(contentJson) {
    if (typeof contentJson === 'string') return contentJson;
    if (!contentJson || typeof contentJson !== 'object') {
      throw new QzApiError('笔记正文格式错误', -1);
    }
    return JSON.stringify(contentJson);
  }

  /** 新建笔记：content_json 必传（对象或字符串），images 为已上传完成的 image_id 数组 */
  async createNote({ content_json, images, record_time }) {
    const body = { content_json: this._serializeContent(content_json) };
    if (Array.isArray(images) && images.length) body.images = images;
    if (record_time) body.record_time = Math.floor(Number(record_time));
    return this._authRetryOnce(() => this._open('POST', '/open/idea_note/create', { body }));
  }

  /** 修改笔记：必须传 id 与完整 content_json；images 不传等于清空 */
  async updateNote({ id, content_json, images }) {
    if (id === undefined || id === null || id === '') throw new QzApiError('修改笔记缺少 id', -1);
    return this._authRetryOnce(() => this._open('POST', '/open/idea_note/update', {
      body: {
        id,
        content_json: this._serializeContent(content_json),
        images: Array.isArray(images) ? images : []
      }
    }));
  }

  /** 删除笔记（软删除） */
  async deleteNote(id) {
    return this._authRetryOnce(() => this._open('POST', '/open/idea_note/delete', { body: { id } }));
  }

  /** 申请图片上传凭证（七牛直传用） */
  async requestUpload({ mime_type, size }) {
    return this._authRetryOnce(() => this._open('POST', '/open/media/upload', {
      body: { mime_type, size }
    }));
  }
}

module.exports = { QzOpenApi, QzApiError, OPEN_BASE_URL, RELAY_BASE_URL, REFRESH_AHEAD_MS };
