/**
 * qz/api.js —— Q助理 API 客户端
 *
 * 覆盖：
 *  - 扫码登录（公开接口，user.md）：qr_login_create / qr_login_status
 *  - 灵感笔记（Header token/uid/tk 鉴权，idea_note.md）：get_list / save / delete
 *
 * 灵感笔记走 H5 接口（H5TokenAuthMiddleware），需要 Vue H5 token：
 *   扫码登录拿到的是扩展端（PC）token/tk，需通过 /h5/jump 换取 Vue token（24h 有效）。
 *   getH5Access() 负责换取与缓存；灵感笔记方法自动使用 Vue token 鉴权。
 *
 * 设计：可注入 fetch 与 baseUrl，便于单元测试用 mock 验证。
 */
'use strict';

const crypto = require('crypto');

const { BASE_URL, API_CLIENT_TYPE_PC, PAGE_SIZE } = require('./config');

/** /h5/jump 换取超时：网关/上游抖动时该接口可能长时间无响应（曾实测 127s 才返回 502） */
const H5_EXCHANGE_TIMEOUT_MS = 20000;

class QzApiError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.name = 'QzApiError';
    this.code = code;
    this.payload = payload;
  }
}

class QzApi {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl 默认生产网关
   * @param {Function} opts.fetchImpl 默认为全局 fetch
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || BASE_URL;
    this.fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    this.auth = null; // { uid, token, tk } —— 扫码登录（PC 渠道）凭证
    this._h5 = null;  // { uid, token, tk, expiresAt } —— Vue H5 token 缓存
  }

  /** 设置登录态（uid/token/tk） */
  setAuth(auth) {
    this.auth = auth ? { uid: auth.uid, token: auth.token, tk: auth.tk } : null;
    this._h5 = null; // 登录态变化后旧的 Vue token 失效
  }

  get isAuthed() {
    return !!(this.auth && this.auth.uid && this.auth.token);
  }

  _authHeaders() {
    if (!this.auth) return {};
    const h = { token: this.auth.token, uid: this.auth.uid };
    if (this.auth.tk) h.tk = this.auth.tk;
    return h;
  }

  // ---------- Vue H5 token 换取（灵感笔记 H5 接口鉴权） ----------
  /**
   * 用扫码登录（扩展端）凭证换取 Vue H5 token，带 24h 缓存。
   * /h5/jump 校验 md5(rawToken + "qzhuli_v1")，故 token 参数需传 md5(token+"qzhuli_v1")，
   * 且需携带扩展端 tk（p_xxx）走 isTokenOkByTk 渠道校验。
   * @returns {Promise<{uid:string, token:string, tk:string, expiresAt:number}>}
   */
  async getH5Access() {
    if (!this.isAuthed) throw new QzApiError('未登录', 401);
    if (this._h5 && this._h5.expiresAt > Date.now() + 60000) {
      return this._h5;
    }
    const h5Token = crypto.createHash('md5').update(this.auth.token + 'qzhuli_v1').digest('hex');
    const query = new URLSearchParams({
      uid: this.auth.uid,
      token: h5Token,
      tk: this.auth.tk || ''
    }).toString();
    let res;
    try {
      // 网关/上游抖动时 /h5/jump 可能长时间不返回，加超时避免界面长时间无响应；
      // 超时按服务异常处理，不误判为凭证失效
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), H5_EXCHANGE_TIMEOUT_MS);
      try {
        res = await this.fetchImpl(`${this.baseUrl}/h5/jump/idea_note?${query}`, {
          method: 'GET',
          redirect: 'manual',
          signal: ctrl.signal
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.code === 20);
      throw new QzApiError(
        aborted ? '换取 H5 访问凭证超时，请稍后重试' : ('换取 H5 访问凭证失败: ' + ((err && err.message) || err)),
        aborted ? -2 : -1
      );
    }
    const location = res.headers.get('location') || '';
    const hash = location.split('#')[1] || '';
    const params = new URLSearchParams(hash);
    const vToken = params.get('token') || '';
    const vTk = params.get('tk') || '';
    const expire = parseInt(params.get('expire') || '0', 10);
    if (!vToken || !vTk) {
      // 仅当服务端明确跳回登录页（302 重定向）时才判定凭证已失效；
      // 网关 5xx / 超时 / 其它异常响应同样拿不到 token，但那属于瞬时故障，
      // 误判为失效会把用户踢回登录页（曾因 /h5/jump 502 误触发，导致登录后看不到笔记）
      if (res.status === 302) {
        const err = new QzApiError('登录凭证已失效', 401, { location, reason: 'h5_exchange_rejected' });
        err.authExpired = true;
        throw err;
      }
      throw new QzApiError('换取 H5 访问凭证失败(HTTP ' + (res.status || 'unknown') + ')', res.status || -1);
    }
    const ttlMs = expire > 0 ? expire * 1000 : 24 * 3600 * 1000;
    this._h5 = {
      uid: this.auth.uid,
      token: vToken,
      tk: vTk,
      ttlMs,
      expiresAt: Date.now() + ttlMs
    };
    return this._h5;
  }

  /** 丢弃缓存的 Vue token，强制下次请求重新换取（鉴权失败自愈用） */
  invalidateH5() {
    this._h5 = null;
  }

  /**
   * 主动保鲜：Vue token 剩余有效期不足 30% 时强制重换一次，
   * 保证应用长时间运行时手里始终有新鲜 token，避免过期瞬间才被动刷新。
   */
  async ensureH5Fresh() {
    if (!this.isAuthed) throw new QzApiError('未登录', 401);
    if (!this._h5) return this.getH5Access();
    const ttl = this._h5.ttlMs || 24 * 3600 * 1000;
    const age = Date.now() - (this._h5.expiresAt - ttl);
    if (age < ttl * 0.7) return this._h5;
    this._h5 = null; // 已用掉 70% 以上寿命，主动重换
    return this.getH5Access();
  }

  /** 后台保鲜定时器：应用运行期间每 intervalMs 主动刷新一次 Vue token */
  startH5KeepAlive(intervalMs = 12 * 3600 * 1000) {
    this.stopH5KeepAlive();
    this._keepAliveTimer = setInterval(() => {
      if (this.isAuthed) {
        this.ensureH5Fresh().catch(() => { /* 单次保鲜失败不致命，下个周期再试 */ });
      }
    }, intervalMs);
    if (this._keepAliveTimer.unref) this._keepAliveTimer.unref();
  }

  stopH5KeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  /**
   * 鉴权探测：强制重换一次 Vue token，判断当前登录态是否还能通过服务端校验。
   * @returns {Promise<{ok:boolean, reason?:string, code?:number}>}
   */
  async probeAuth() {
    if (!this.isAuthed) return { ok: false, reason: 'no_auth' };
    this._h5 = null;
    try {
      await this.getH5Access();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err && err.authExpired ? 'token_invalid' : 'network', code: err && err.code };
    }
  }

  /**
   * 鉴权失败自愈包装：业务接口返回 401（Vue token 被拒）时，
   * 丢弃缓存 → 强制重换 → 重试一次；扩展端凭证被判死（authExpired）则不重试直接抛。
   */
  async _authRetryOnce(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof QzApiError && err.code === 401 && !err.authExpired) {
        this._h5 = null;
        return fn();
      }
      throw err;
    }
  }

  /** 灵感笔记 H5 接口所需的鉴权头（Vue token） */
  async _ideaHeaders() {
    const h5 = await this.getH5Access();
    return { token: h5.token, uid: h5.uid, tk: h5.tk };
  }

  async _request(method, path, { query, body, json, headers } = {}) {
    let url = this.baseUrl + path;
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
      ).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    const mergedHeaders = { ...this._authHeaders(), ...(headers || {}) };
    const init = { method, headers: mergedHeaders };
    if (body !== undefined) {
      mergedHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(body).toString();
    } else if (json !== undefined) {
      mergedHeaders['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }

    let res;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      throw new QzApiError('网络请求失败: ' + (err && err.message || err), -1);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new QzApiError('响应解析失败(HTTP ' + res.status + ')', res.status);
    }
    if (data && data.code !== undefined && data.code !== 200) {
      throw new QzApiError(data.msg || ('业务错误 ' + data.code), data.code, data);
    }
    return data ? data.data : null;
  }

  // ---------- 扫码登录（公开） ----------
  /** 创建扫码会话（api_client_type=3 PC），返回 { scene_id, expires_in } */
  async qrLoginCreate(apiClientType = API_CLIENT_TYPE_PC) {
    return this._request('POST', '/user/qr_login_create/' + apiClientType);
  }

  /** 轮询扫码状态，返回 { status, login_data } */
  async qrLoginStatus(sceneId) {
    return this._request('POST', '/user/qr_login_status', { body: { scene_id: sceneId } });
  }

  // ---------- 灵感笔记（需登录，走 H5 Vue token） ----------
  /** 分页拉取灵感笔记列表 */
  async getIdeaList({ page = 1, pageSize = PAGE_SIZE, keyword } = {}) {
    return this._authRetryOnce(async () => this._request('GET', '/h5/idea_note/get_list', {
      query: { page, page_size: pageSize, keyword: keyword || undefined },
      headers: await this._ideaHeaders()
    }));
  }

  /** 新建/编辑灵感笔记；id 不传=新建，传=编辑 */
  async saveIdea({ id, content_json, plain_text, tags }) {
    return this._authRetryOnce(async () => this._request('POST', '/h5/idea_note/save', {
      json: { id, content_json, plain_text, tags },
      headers: await this._ideaHeaders()
    }));
  }

  /** 删除灵感笔记（软删除，仅置 delete_time） */
  async deleteIdea(id) {
    return this._authRetryOnce(async () => this._request('POST', '/h5/idea_note/delete', {
      json: { id },
      headers: await this._ideaHeaders()
    }));
  }

  /** 分页拉取回收站列表（已软删除的笔记，含 delete_time） */
  async getRecycleList({ page = 1, pageSize = PAGE_SIZE } = {}) {
    return this._authRetryOnce(async () => this._request('GET', '/h5/idea_note/get_recycle_list', {
      query: { page, page_size: pageSize },
      headers: await this._ideaHeaders()
    }));
  }

  /** 恢复回收站中的笔记（服务端仅清 delete_time，不改 update_time） */
  async restoreIdea(id) {
    return this._authRetryOnce(async () => this._request('POST', '/h5/idea_note/restore', {
      json: { id },
      headers: await this._ideaHeaders()
    }));
  }

  /** 获取七牛上传凭证（H5 公共接口，返回 { token, domain, expired }） */
  async getQiniuUploadToken(bucket = '') {
    return this._authRetryOnce(async () => this._request('GET', '/h5/sys/get_qiniu_token', {
      query: bucket ? { bucket } : undefined,
      headers: await this._ideaHeaders()
    }));
  }
}

module.exports = { QzApi, QzApiError };
