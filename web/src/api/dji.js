/**
 * 统一 API 层：所有请求走 BFF(/api)，错误统一归一化
 * 后端已保证返回结构化 JSON，前端不再出现 "Unexpected non-whitespace character" 类解析异常
 */
import axios from 'axios';

const http = axios.create({ baseURL: '/api', timeout: 60000 });

http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    let msg = err?.response?.data?.message || err.message || '网络异常';
    // axios 的 "Network Error" 是连接层失败（后端未启动 / 正在重启 / 代理断开），
    // 对用户来说等于「服务不在线」，要给出可行动的指引而不是天书
    if (err?.code === 'ERR_NETWORK' || /Network Error/i.test(String(err?.message || ''))) {
      msg = '无法连接后端服务（可能正在重启或未启动），请稍候刷新页面重试';
    }
    return Promise.resolve({ ok: false, message: msg, data: null });
  }
);

/** 统一错误信息 */
export function errMsg(r, fallback = '操作失败') {
  if (!r) return fallback;
  if (r.ok) return '';
  return r.message || (r.code ? `错误码 ${r.code}` : fallback);
}

export const sessionApi = {
  info: () => http.get('/session'),
  health: () => http.get('/session/health'),
  tokens: () => http.get('/session/tokens'),
  addToken: (name, token) => http.post('/session/tokens', { name, token }),
  removeToken: (id) => http.delete(`/session/tokens/${id}`),
  activateToken: (id) => http.post(`/session/tokens/${id}/activate`),
  setEndpoint: (endpoint, customBase) => http.post('/session/endpoint', { endpoint, customBase }),
  projects: () => http.get('/session/projects'),
  selectProject: (uuid) => http.post('/session/project', { uuid }),
  devices: () => http.get('/session/devices'),
  projectDevices: () => http.get('/session/project/devices'),
  /** 按项目聚合设备（标注设备所属项目，物模型需对应项目头） */
  devicesWithProject: () => http.get('/session/devices-with-project'),
  bindDevice: (sn, projectUuid) => http.post('/session/bind-device', { device_sn: sn, project_uuid: projectUuid }),
};

export const deviceApi = {
  /** 物模型：需携带设备所属项目，否则返回空或 403 */
  state: (sn, projectUuid) =>
    http.get(`/device/${encodeURIComponent(sn)}/state`, {
      params: projectUuid ? { project_uuid: projectUuid } : {},
    }),
  hms: (snList) => http.get('/device/hms', { params: { device_sn_list: snList.join(',') } }),
  takeControl: (droneSn, payloadIndex) =>
    http.post('/device/control', { drone_sn: droneSn, payload_index: payloadIndex }),
  releaseControl: (droneSn, payloadIndex) =>
    http.delete('/device/control', { data: { drone_sn: droneSn, payload_index: payloadIndex } }),
  changeCamera: (sn, cameraIndex, position) =>
    http.post('/device/change-camera', { sn, camera_index: cameraIndex, camera_position: position }),
  changeLens: (sn, cameraIndex, lensType) =>
    http.post('/device/change-lens', { sn, camera_index: cameraIndex, lens_type: lensType }),
  setQuality: (sn, cameraIndex, qualityType) =>
    http.put('/device/stream/quality', { sn, camera_index: cameraIndex, quality_type: qualityType }),
  command: (sn, cmd) => http.post('/device/command', { device_sn: sn, device_command: cmd }),
};

export const liveApi = {
  start: (payload) => http.post('/live/start', payload),
  /**
   * 无人机直播自动开机链路：
   * 获取控制权 → 未上电则创建立即任务让机场开舱上电 → 轮询 task_uuid 直到出画面
   */
  drone: (payload) => http.post('/live/drone', payload),
};

export const waylineApi = {
  list: (params) => http.get('/wayline', { params }),
  detail: (id) => http.get(`/wayline/${encodeURIComponent(id)}`),
  /** 航线库 + 机型可飞性标注（36 条里哪几条能飞） */
  libraryMatch: (params) => http.get('/wayline/library-match', { params }),
  /** 本机队机型（闸 1 的数据来源） */
  aircraft: (force) => http.get('/wayline/aircraft', { params: force ? { force: '1' } : {} }),
  /** 规划预览：只算不存 */
  plan: (body) => http.post('/wayline/plan', body),
  /** 生成并提交司空 2 验证 */
  generate: (body) => http.post('/wayline/generate', body, { timeout: 120000 }),
  /** 本地自研航线草稿 */
  local: (status) => http.get('/wayline/local', { params: status ? { status } : {} }),
  /** 重新回查验证 */
  verify: (id) => http.post(`/wayline/local/${id}/verify`, {}, { timeout: 60000 }),
  /** 闸 3：下发前机型再校验 */
  dispatchCheck: (modelKey, waylineId) => http.post('/wayline/dispatch-check', { modelKey, waylineId }),
  upload: (file, name) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', name || file.name.replace(/\.(kmz|kml)$/i, ''));
    return http.post('/wayline/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 180000 });
  },
};

export const taskApi = {
  create: (body) => http.post('/task', body),
  list: (params) => http.get('/task/list', { params }),
  detail: (uuid) => http.get(`/task/${encodeURIComponent(uuid)}`),
  updateStatus: (uuid, status) => http.put(`/task/${encodeURIComponent(uuid)}/status`, { status }),
  media: (uuid) => http.get(`/task/${encodeURIComponent(uuid)}/media`),
  track: (uuid) => http.get(`/task/${encodeURIComponent(uuid)}/track`),
  /**
   * 单张媒体的显示地址（走后端代理）
   * 直链带 auth_key 签名会过期，且跨域直连可能被拦，所以统一走 /api 同域代理
   */
  mediaSrc: (uuid, mediaUuid, type = 'preview') =>
    `/api/task/${encodeURIComponent(uuid)}/media/${encodeURIComponent(mediaUuid)}?type=${type}`,
};

export const takeoffApi = {
  /** 起飞前预检 */
  precheck: (sn, waylineUuid, droneSn) =>
    http.post('/takeoff/precheck', { sn, wayline_uuid: waylineUuid, drone_sn: droneSn }),
  /** 执行一键起飞 */
  takeoff: (sn, waylineUuid, opts = {}) =>
    http.post('/takeoff', { sn, wayline_uuid: waylineUuid, ...opts }),
  /** 查询起飞任务状态 */
  status: (uuid) => http.get(`/takeoff/${encodeURIComponent(uuid)}/status`),
};

export const adminApi = {
  logs: (params) => http.get('/admin/logs', { params }),
  clearLogs: () => http.delete('/admin/logs'),
  proxy: (payload) => http.post('/admin/proxy', payload),
  catalog: () => http.get('/admin/catalog'),
  setMock: (enabled) => http.post('/admin/mock', { enabled }),
};

export default http;

export const opsApi = {
  /** 统一遥测快照（监控/座舱/大屏复用） */
  snapshot: (force) => http.get('/ops/snapshot', { params: force ? { force: '1' } : {} }),
  refreshSnapshot: () => http.post('/ops/snapshot/refresh'),
  /** 监管总览 */
  overview: (force) => http.get('/ops/overview', { params: force ? { force: '1' } : {} }),
  /** 最优机巢推荐 */
  recommendNest: (lat, lng, minBattery) => http.post('/ops/recommend-nest', { lat, lng, minBattery }),
  plan: (targets, minBattery) => http.post('/ops/plan', { targets, minBattery }),
  cache: () => http.get('/ops/cache'),
  clearCache: () => http.delete('/ops/cache'),
};

/** 模型库（司空 2 开放建模） */
export const modelApi = {
  /** 组织全量模型（跨项目聚合）；refresh=1 绕过服务端 60s 缓存 */
  list: (refresh) => http.get('/model', refresh ? { params: { refresh: 1 } } : undefined),
  detail: (id) => http.get(`/model/${encodeURIComponent(id)}`),
  /**
   * 模型包下载并解压，返回包内文件清单（三维渲染 / 二维叠加前调用）
   *
   * 全局 timeout 是 60s，但首次打开某个模型要走「CDN 下载整包 + 落盘解压」，
   * 动辄几分钟——超时后 axios 抛的是没有响应体的 Network Error，
   * 用户只看到一个「Network Error」弹窗，完全不知道是慢还是坏了。
   * 这里单独放宽到 15 分钟，配合界面上的进度文案；命中本地缓存时本来就是秒回。
   */
  files: (id) => http.get(`/model/${encodeURIComponent(id)}/files`, { timeout: 900000 }),
  /** 单文件读取地址（b3dm / glb / tileset.json） */
  assetSrc: (id, p) =>
    `/api/model/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(p)}`,
  /**
   * 瓦片模板地址（二维影像金字塔用）
   *
   * 不能直接复用 assetSrc：它对整个 path 做 encodeURIComponent，
   * 会把 {z}/{x}/{y} 变成 %7Bz%7D…，Leaflet 的模板替换就失效了（请求 404）。
   * 所以这里只编码「前缀 + 根目录」，占位符原样保留。
   */
  tileSrc: (id, template) => {
    const i = template.indexOf('{z}');
    const prefix = i >= 0 ? template.slice(0, i) : template;
    const tpl = i >= 0 ? template.slice(i) : '';
    // 前缀末尾的 '/' 由 {z} 接管，避免拼出 double slash
    return `/api/model/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(prefix)}${tpl}`;
  },
  /** 预览图（走后端代理，避免签名过期/跨域裂图） */
  previewSrc: (id) => `/api/model/${encodeURIComponent(id)}/preview`,
  /** 模型包下载地址（走后端代理，带原始文件名） */
  packageSrc: (id, name) =>
    `/api/model/${encodeURIComponent(id)}/package${name ? `?name=${encodeURIComponent(name)}` : ''}`,
  /**
   * 可用性预检：只取 1 字节，判断源文件还在不在 / 是否超浏览器预览上限。
   * 避免用户点「三维预览」等半天才弹一个 404。
   */
  check: (id) => http.get(`/model/${encodeURIComponent(id)}/check`),
};
