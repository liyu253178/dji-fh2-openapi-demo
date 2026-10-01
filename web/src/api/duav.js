/**
 * DUAV 一期业务接口封装
 *
 * 与存量 api/dji.js 保持同样的风格：统一 base、safeParse、错误归一化。
 * 响应约定：{ code: 0, message, data }，code===0 且HTTP 2xx 视为成功。
 */

const BASE = '';

async function request(path, { method = 'GET', query, body, timeout = 20000, raw = false } = {}) {
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非JSON（网关错误页/登录页）——不抛异常，归一化为可读错误
      return {
        ok: false,
        code: -1,
        message: `服务返回非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 120)}`,
        data: null,
      };
    }
    const ok = Number(json.code) === 0 && res.ok;
    return { ok, code: Number(json.code ?? -1), message: json.message || '', data: json.data ?? null, status: res.status };
  } catch (e) {
    let msg = e.name === 'AbortError' ? `请求超时（${timeout}ms）` : e.message;
    // fetch 的 Failed to fetch = 连接层失败（后端未启动 / 正在重启），给出可行动的指引
    if (/Failed to fetch/i.test(String(e.message || ''))) {
      msg = '无法连接后端服务（可能正在重启或未启动），请稍候刷新页面重试';
    }
    return { ok: false, code: -2, message: msg, data: null };
  } finally {
    clearTimeout(timer);
  }
}

const get = (p, query) => request(p, { query });
const post = (p, body) => request(p, { method: 'POST', body });
const put = (p, body) => request(p, { method: 'PUT', body });
const patch = (p, body) => request(p, { method: 'PATCH', body });
const del = (p) => request(p, { method: 'DELETE' });

export const assetApi = {
  syncStatus: () => get('/api/asset/sync/status'),
  sync: (body) => post('/api/asset/sync', body),
  // 暂停 / 继续 / 终止：暂停只是把循环挂在安全点，已入库的保留
  pauseSync: () => post('/api/asset/sync/pause'),
  resumeSync: () => post('/api/asset/sync/resume'),
  stopSync: () => post('/api/asset/sync/stop'),
  tasks: (query) => get('/api/asset/tasks', query),
  // 历史同步出过架次的机场（用于同步弹窗下拉：在线设备 ∪ 历史机场）
  knownDocks: (projectUuid) => get('/api/asset/known-docks', { projectUuid }),
  // 批量清理存量无影像架次
  pruneEmptyTasks: (projectUuid) => post('/api/asset/prune-empty-tasks', { projectUuid }),
  taskImages: (taskUuid) => get(`/api/asset/tasks/${encodeURIComponent(taskUuid)}/images`),
  taskTrack: (taskUuid) => get(`/api/asset/tasks/${encodeURIComponent(taskUuid)}/track`),
  removeTask: (taskUuid) => del(`/api/asset/tasks/${encodeURIComponent(taskUuid)}`),
  search: (query) => get('/api/asset/search', query),
  imageUrl: (id, size = 'thumb') => `/api/asset/images/${id}/file?size=${size}`,
  image: (id) => get(`/api/asset/images/${id}`),
  imagePair: (id) => get(`/api/asset/images/${id}/pair`),
};

export const reviewApi = {
  queue: (query) => get('/api/review/queue', query),
  // 影像坐标 → 具体地址（服务端代理高德，前端不接触 Key）
  reverseGeocode: (query) => get('/api/review/reverse-geocode', query),
  geoConfig: () => get('/api/review/geo-config'),
  saveGeoConfig: (key) => put('/api/review/geo-config', { key }),
  patch: (id) => get(`/api/review/patches/${id}`),
  create: (body) => post('/api/review/patches', body),
  update: (id, body) => put(`/api/review/patches/${id}`, body),
  remove: (id) => del(`/api/review/patches/${id}`),
  attach: (id, imageIds, primaryImageId) => post(`/api/review/patches/${id}/images`, { imageIds, primaryImageId }),
  detach: (id, imageId) => del(`/api/review/patches/${id}/images/${imageId}`),
  setPrimary: (id, imageId) => post(`/api/review/patches/${id}/primary`, { imageId }),
  areaEstimate: (geometry) => post('/api/review/area-estimate', { geometry }),
  suggestImages: (body) => post('/api/review/suggest-images', body),
  issueTypes: () => get('/api/review/issue-types'),
};

export const ticketApi = {
  list: (query) => get('/api/tickets', query),
  detail: (id) => get(`/api/tickets/${id}`),
  create: (body) => post('/api/tickets', body),
  send: (id) => post(`/api/tickets/${id}/send`),
  transition: (id, to, remark) => patch(`/api/tickets/${id}/status`, { to, remark }),
  setRecipient: (id, body) => put(`/api/tickets/${id}/recipient`, body),
  remark: (id, remark) => post(`/api/tickets/${id}/remark`, { remark }),
  logs: (id) => get(`/api/tickets/${id}/logs`),
  statsSummary: (query) => get('/api/tickets/stats/summary', query),
  statsByRegion: () => get('/api/tickets/stats/by-region'),
  statsByType: () => get('/api/tickets/stats/by-type'),
};

export const notifyApi = {
  config: () => get('/api/notify/config'),
  saveConfig: (body) => put('/api/notify/config', body),
  verify: () => post('/api/notify/verify'),
  sendTest: (to) => post('/api/notify/test', { to }),
  sendTicket: (id) => post(`/api/notify/send-ticket/${id}`),
  preview: (id) => get(`/api/notify/preview/${id}`),
  queue: () => get('/api/notify/queue'),
  runQueue: () => post('/api/notify/queue/run'),
  mailLogs: (query) => get('/api/notify/mail-logs', query),
  alerts: (query) => get('/api/notify/alerts', query),
  ackAlert: (id) => post(`/api/notify/alerts/${id}/ack`),
};

export const dictApi = {
  issueTypes: (query) => get('/api/review/issue-types', query),
  recipients: () => get('/api/recipients'),
  createRecipient: (body) => post('/api/recipients', body),
  updateRecipient: (id, body) => put(`/api/recipients/${id}`, body),
  removeRecipient: (id) => del(`/api/recipients/${id}`),
  createIssueType: (body) => post('/api/dict/issue-types', body),
  updateIssueType: (code, body) => put(`/api/dict/issue-types/${code}`, body),
  removeIssueType: (code) => del(`/api/dict/issue-types/${code}`),
};

export const systemApi = {
  dbStatus: () => get('/api/admin/db-status'),
};

export default { assetApi, reviewApi, ticketApi, notifyApi, dictApi, systemApi };
