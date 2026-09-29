/**
 * 统一 API 层：所有请求走 BFF(/api)，错误统一归一化
 * 后端已保证返回结构化 JSON，前端不再出现 "Unexpected non-whitespace character" 类解析异常
 */
import axios from 'axios';

const http = axios.create({ baseURL: '/api', timeout: 60000 });

http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const msg = err?.response?.data?.message || err.message || '网络异常';
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
  list: () => http.get('/model'),
  detail: (id) => http.get(`/model/${encodeURIComponent(id)}`),
  /** 模型包下载并解压，返回包内文件清单（三维渲染前调用） */
  files: (id) => http.get(`/model/${encodeURIComponent(id)}/files`),
  /** 单文件读取地址（b3dm / glb / tileset.json） */
  assetSrc: (id, p) =>
    `/api/model/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(p)}`,
  /** 预览图（走后端代理，避免签名过期/跨域裂图） */
  previewSrc: (id) => `/api/model/${encodeURIComponent(id)}/preview`,
  /** 模型包下载地址（走后端代理，带原始文件名） */
  packageSrc: (id, name) =>
    `/api/model/${encodeURIComponent(id)}/package${name ? `?name=${encodeURIComponent(name)}` : ''}`,
};
