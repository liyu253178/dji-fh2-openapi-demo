/**
 * 司空 2 OpenAPI 统一网关客户端
 *
 * 严格按 Apifox 文档约定：
 *  - Base: https://es-flight-api-cn.djigate.com（国内公有云），路径前缀 /openapi/v0.1
 *  - Header: X-User-Token / X-Project-Uuid / X-Request-Id / X-Language
 *  - 控制权释放为 DELETE + JSON Body，必须走 deleteWithBody
 *  - 响应统一 safeParse：非 JSON 响应不再抛 "Unexpected non-whitespace character"，
 *    而是回传原始文本片段，便于定位问题
 */
import { randomUUID } from 'node:crypto';
import { log } from './logger.js';
import { mockResponse, mockState } from './mock.js';

const PREFIX = '/openapi/v0.1';
const DEFAULT_TIMEOUT = 20000;

/** 可选接入点：公有云国内 / 海外 / 私有云自定义 */
export const ENDPOINTS = {
  cn: 'https://es-flight-api-cn.djigate.com',
  us: 'https://es-flight-api-us.djigate.com',
  custom: process.env.FH2_BASE || '',
};

/** 会话态：当前 TK、项目 UUID 与接入点（由 routes/session 写入） */
export const session = {
  token: process.env.FH2_TOKEN || '',
  projectUuid: '',
  endpoint: 'cn', // cn | us | custom
  customBase: process.env.FH2_BASE || '',
};

export function currentBase() {
  if (session.endpoint === 'custom') return session.customBase.replace(/\/+$/, '');
  return ENDPOINTS[session.endpoint] || ENDPOINTS.cn;
}

function buildUrl(path, query) {
  const p = path.startsWith('/openapi') ? path : PREFIX + (path.startsWith('/') ? path : '/' + path);
  const url = new URL(currentBase() + p);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) url.searchParams.set(k, v.join(','));
      else url.searchParams.set(k, String(v));
    }
  }
  return url;
}

/** 安全解析：永远返回结构化结果，绝不抛 JSON 语法错误 */
function safeParse(text) {
  if (!text) return { _json: false, _text: '' };
  try {
    return { _json: true, value: JSON.parse(text) };
  } catch (e) {
    return { _json: false, _text: String(text).slice(0, 500), _error: e.message };
  }
}

/**
 * 发起一次司空 2 请求
 * @returns {Promise<{ok:boolean, code:number, message:string, data:any, status:number, duration:number, raw?:string}>}
 */
export async function request(opts) {
  const {
    method = 'GET',
    path,
    query,
    body,
    token,
    projectUuid,
    timeout = DEFAULT_TIMEOUT,
    tag = 'API',
    rawResponse = false,
  } = opts;

  const mockHit = mockResponse(method, String(path).startsWith('/openapi') ? path : PREFIX + (String(path).startsWith('/') ? path : '/' + path), query, body);
  if (mockHit) {
    log.debug(tag, `[演示模式] ${method} ${path}`);
    return mockHit;
  }
  const tk = token || session.token;
  const prj = projectUuid !== undefined ? projectUuid : session.projectUuid;
  const url = buildUrl(path, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
    'X-Language': 'zh',
  };
  if (tk) headers['X-User-Token'] = tk;
  if (prj) headers['X-Project-Uuid'] = prj;

  const started = Date.now();
  const safeHeaders = { ...headers };
  if (safeHeaders['X-User-Token']) safeHeaders['X-User-Token'] = mask(safeHeaders['X-User-Token']);

  log.debug(tag, `${method} ${url.pathname}${url.search}`, { headers: safeHeaders, body: body || undefined });

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const duration = Date.now() - started;
    const parsed = safeParse(text);

    if (rawResponse) {
      return {
        ok: res.ok,
        status: res.status,
        duration,
        text,
        json: parsed._json ? parsed.value : null,
      };
    }

    if (!parsed._json) {
      const msg = `非 JSON 响应（HTTP ${res.status}）: ${parsed._text.slice(0, 200)}`;
      log.error(tag, msg, { url: url.toString(), status: res.status });
      return { ok: false, code: -1, message: msg, data: null, status: res.status, duration, raw: parsed._text };
    }

    const value = parsed.value || {};
    const ok = Number(value.code) === 0 && res.ok;
    const result = {
      ok,
      code: Number(value.code ?? -1),
      message: value.message || '',
      data: value.data ?? null,
      status: res.status,
      duration,
    };
    if (ok) log.ok(tag, `${method} ${url.pathname} → ${duration}ms`, result.data);
    else log.error(tag, `${method} ${url.pathname} 失败 code=${result.code} ${result.message}`, result.data);
    return result;
  } catch (err) {
    const duration = Date.now() - started;
    const msg = err.name === 'AbortError' ? `请求超时（${timeout}ms）` : err.message;
    log.error(tag, `${method} ${url.pathname} 异常: ${msg}`);
    return { ok: false, code: -2, message: msg, data: null, status: 0, duration };
  } finally {
    clearTimeout(timer);
  }
}

/** DELETE 带 body（控制权释放专用） */
export const deleteWithBody = (path, body, extra = {}) =>
  request({ ...extra, method: 'DELETE', path, body });

export function mask(token = '') {
  if (!token) return '';
  if (token.length <= 16) return token.slice(0, 4) + '***';
  return token.slice(0, 12) + '...' + token.slice(-6);
}

/** 解析 TK 中的组织信息（JWT payload，不校验签名） */
export function decodeToken(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
