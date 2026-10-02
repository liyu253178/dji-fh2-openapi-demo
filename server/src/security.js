/**
 * 安全基线（P0-3）
 *
 * 三件事：
 * 1. 可选的接口访问令牌 —— 未配置时不改变现有本地/局域网用法，
 *    一旦暴露到不可信网络，设个 API_TOKEN 即可全站上锁（含 SSE 的 query 兜底）。
 * 2. SSRF 防线 —— 上行地址禁止内网/本机/云元数据地址。这条无条件生效：
 *    司空 2 接入点本来就只可能是公网域名，放行内网只会给 /api/admin/proxy
 *    这类调试代理开一条打进内网的通道。
 * 3. 代理路径白名单 —— 调试代理只允许 /openapi/ 前缀。
 */

/**
 * 环境变量里的可选访问令牌。
 * 不配置 → 放行（保持既有本地部署行为）；配置 → 全站校验。
 */
const API_TOKEN = (process.env.API_TOKEN || '').trim();

export const authEnabled = () => API_TOKEN.length > 0;

/**
 * 接口访问令牌中间件。
 * 接受三种携带方式（分别适配 fetch、EventSource 无法自定义头的场景）：
 *   X-Access-Token: <token>
 *   Authorization: Bearer <token>
 *   ?access_token=<token>
 */
export function requireToken(req, res, next) {
  if (!authEnabled()) return next();

  const fromHeader = req.get('X-Access-Token') || '';
  const authz = req.get('Authorization') || '';
  const bearer = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  // 从原始 URL 取 query：app.use('/api', ...) 挂载会剥掉 req.url 里的前缀，
  // 连 query string 一起弄丢，这里必须用 originalUrl
  const fromQuery = queryParam(req, 'access_token');
  const got = fromHeader || bearer || fromQuery;

  if (got && got.length === API_TOKEN.length && timingSafeEqualStr(got, API_TOKEN)) {
    req.authenticated = true;
    return next();
  }
  res.status(401).json({ ok: false, code: 401, message: '未授权：缺少或错误的访问令牌', data: null });
}

/** 从原始请求 URL 取查询参数（不依赖 Express 挂载后的 req.query） */
function queryParam(req, key) {
  try {
    const u = new URL(req.originalUrl || req.url || '/', 'http://duav.invalid');
    return u.searchParams.get(key) || '';
  } catch {
    return '';
  }
}

/** 定长比较，避免通过响应耗时逐字节试探令牌 */
function timingSafeEqualStr(a, b) {
  let diff = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ===================================================================
// SSRF 防线
// ===================================================================

/** 一眼就是内部资源的主机名（含各云厂商元数据服务） */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  if (oct.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // 畸形 IPv4，一律当作可疑
  const [a, b] = oct;
  if (a === 0 || a === 10 || a === 127) return true; // 本机 / 私有
  if (a === 169 && b === 254) return true; // link-local，云元数据就是这个段
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true; // 私有
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播/保留
  return false;
}

function isPrivateIPv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true; // link-local / ULA
  // IPv4-mapped 有两种写法：URL 解析后会规范化成十六进制形式 ::ffff:7f00:1，
  // 原始形式是 ::ffff:127.0.0.1，两种都要还原成 IPv4 再判
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isPrivateIPv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isMetadataIPv4(host) {
  // 链路本地段：各家云的元数据服务都在这个段，没有任何正常业务会用
  return /^169\.254\./.test(host) || /^100\.100\.100\.200$/.test(host);
}

/**
 * 上行地址是否可以请求。
 *
 * @param {string} rawBase 形如 https://host 或 https://host:port/prefix
 * @param {{allowPrivate?: boolean}} [opts]
 *   allowPrivate：放行 RFC1918 私网地址。司空 2 **私有云版本**本来就部署在客户内网，
 *   这类环境需要显式设置 PROXY_ALLOW_PRIVATE=1 才能用调试代理；
 *   默认拒绝，因为默认开放等于把服务器上的真实 TK 变成一个内网探测入口。
 *   注意：即使放行私网，链路本地（云元数据）段仍无条件拦截。
 * @returns {{ok: true, host: string} | {ok: false, reason: string}}
 */
export function checkUpstream(rawBase, { allowPrivate = false } = {}) {
  const base = String(rawBase || '').trim();
  if (!base) return { ok: false, reason: '上行地址为空' };

  let u;
  try {
    u = new URL(base);
  } catch {
    return { ok: false, reason: '上行地址不是合法 URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `不支持的协议：${u.protocol}` };
  }
  // 注意：这里不做 DNS 解析，因此只能拦住「地址本身就写成内网 IP」的情况。
  // 域名指向内网的场景需要出网侧防火墙兜，超出一个 BFF 的能力边界。
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: '上行地址缺少主机名' };

  // 链路本地 / 云元数据段：无条件拦截，allowPrivate 也不放行
  const isBlockedHost = BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal');
  if (isBlockedHost || (!host.includes(':') && isMetadataIPv4(host))) {
    return { ok: false, reason: `内部或元数据地址不允许：${host}` };
  }
  if (allowPrivate) return { ok: true, host };

  if (host.includes(':')) {
    if (isPrivateIPv6(host)) return { ok: false, reason: `内网 IPv6 不允许：${host}` };
  } else if (isPrivateIPv4(host)) {
    return { ok: false, reason: `内网 IPv4 不允许：${host}` };
  }
  return { ok: true, host };
}

/**
 * 调试代理允许的路径。
 * 调试代理的定位是「快速试司空 2 的接口」，没有任何理由接受 /openapi 之外的路径。
 */
export function checkProxyPath(p) {
  const path = String(p || '');
  if (!path.startsWith('/openapi/')) return { ok: false, reason: '只允许 /openapi/ 前缀的接口路径' };
  if (path.includes('..')) return { ok: false, reason: '路径不允许包含 ..' };
  if (/[\s"<>\\^`{|}]/.test(path)) return { ok: false, reason: '路径包含非法字符' };
  return { ok: true, path };
}
