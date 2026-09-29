/**
 * 会话与组织项目路由：TK 切换 → 项目选择 → 设备加载
 */
import { Router } from 'express';
import { request, session, decodeToken, mask, currentBase, ENDPOINTS } from '../djiClient.js';
import * as store from '../modules/system/services/store.js';
import { log } from '../logger.js';
import { mockState } from '../mock.js';
import { invalidate as invalidateTelemetry } from '../modules/drone/services/telemetry.js';
import { clear as clearCache } from '../cache.js';

const router = Router();

/**
 * 组织/项目切换后必须丢掉设备与遥测缓存。
 * 原先只清了遥测，设备树（device:tree）还留着上一个组织的设备，
 * 表现为「切换 TK 后设备列表串味 / 找不到刚绑定的设备」。
 */
function invalidateOrgScoped() {
  invalidateTelemetry();
  clearCache('device:');
  clearCache('state:');
  clearCache('wayline');
  clearCache('task');
}

/** 当前会话快照（GET /api/session） */
router.get('/', (req, res) => {
  const token = session.token;
  res.json({
    ok: true,
    data: {
      connected: !!token,
      masked: mask(token),
      decoded: token ? decodeToken(token) : null,
      projectUuid: session.projectUuid,
      base: currentBase(),
      endpoint: session.endpoint,
      endpoints: ENDPOINTS,
      customBase: session.customBase,
      activeTokenId: store.getActiveId(),
      mock: mockState.enabled,
    },
  });
});

/** TK 列表 */
router.get('/tokens', (req, res) => res.json({ ok: true, data: store.listTokens() }));

/** 新增并激活 TK */
router.post('/tokens', async (req, res) => {
  const { name, token } = req.body || {};
  if (!token) return res.json({ ok: false, message: 'TK 不能为空' });
  const decoded = decodeToken(token);
  if (!decoded) return res.json({ ok: false, message: 'TK 不是合法 JWT，请检查是否复制完整' });
  const item = store.addToken(name || `组织 ${decoded.organization_uuid?.slice(0, 8)}`, token);
  session.token = token;
  session.projectUuid = '';
  store.setActiveProject('');
  invalidateOrgScoped();
  log.ok('SESSION', `切换 TK → ${item.name}（组织 ${decoded.organization_uuid}）`);
  res.json({ ok: true, data: { id: item.id, decoded } });
});

router.delete('/tokens/:id', (req, res) => {
  store.removeToken(req.params.id);
  const t = store.getToken();
  session.token = t;
  session.projectUuid = '';
  store.setActiveProject('');
  invalidateOrgScoped();
  res.json({ ok: true });
});

/** 激活已有 TK（快速切换组织） */
router.post('/tokens/:id/activate', (req, res) => {
  store.setActive(req.params.id);
  session.token = store.getToken(req.params.id);
  session.projectUuid = '';
  store.setActiveProject('');
  invalidateOrgScoped();
  log.ok('SESSION', `已切换到组织 TK ${mask(session.token)}`);
  res.json({ ok: true, data: { decoded: decodeToken(session.token) } });
});

/** 项目列表（切换 TK 后第一步） */
router.get('/projects', async (req, res) => {
  if (!session.token) return res.json({ ok: false, message: '未配置 OpenAPI TK' });
  // 注意：usage=simple 会漏项目，改用分页全量拉取
  const r = await request({
    method: 'GET',
    path: '/project',
    query: { page: 1, page_size: 100, sort_column: 'created_at', sort_type: 'DESC' },
    tag: '组织项目',
  });
  res.json(r);
});

/** 选择项目（进入组织）——持久化，服务重启后不丢 */
router.post('/project', (req, res) => {
  const { uuid } = req.body || {};
  session.projectUuid = uuid || '';
  store.setActiveProject(session.projectUuid);
  invalidateOrgScoped();
  log.ok('SESSION', `选择项目 ${uuid || '(清空)'}`);
  res.json({ ok: true, data: { projectUuid: session.projectUuid } });
});

/** 切换接入点：公有云国内 / 海外 / 私有云自定义 */
router.post('/endpoint', (req, res) => {
  const { endpoint, customBase } = req.body || {};
  if (!['cn', 'us', 'custom'].includes(endpoint)) {
    return res.json({ ok: false, message: '接入点只能是 cn / us / custom' });
  }
  if (endpoint === 'custom' && !customBase) {
    return res.json({ ok: false, message: '私有云接入点需要填写自定义地址，例如 https://your-domain.com' });
  }
  session.endpoint = endpoint;
  invalidateOrgScoped();
  if (customBase) session.customBase = String(customBase).replace(/\/+$/, '');
  log.ok('SESSION', `切换接入点 → ${currentBase()}`);
  res.json({ ok: true, data: { endpoint: session.endpoint, base: currentBase() } });
});

/** 组织下的设备列表（机场 + 飞行器） */
router.get('/devices', async (req, res) => {
  const r = await request({ method: 'GET', path: '/device', tag: '组织项目' });
  res.json(r);
});

/** 项目下的设备列表 */
router.get('/project/devices', async (req, res) => {
  const r = await request({ method: 'GET', path: '/project/device', tag: '组织项目' });
  res.json(r);
});

/**
 * 设备绑定项目（设备未绑定项目时，物模型/地图位置取不到）
 * PUT /openapi/v1.0/manage/api/v1/organizations/{org_uuid}/manage-devices/active-project
 */
router.post('/bind-device', async (req, res) => {
  const { device_sn, project_uuid } = req.body || {};
  if (!device_sn) return res.json({ ok: false, message: '缺少 device_sn' });
  const orgUuid = decodeToken(session.token)?.organization_uuid;
  if (!orgUuid) return res.json({ ok: false, message: 'TK 解析失败，无法获取组织 UUID' });
  const r = await request({
    method: 'PUT',
    path: `/openapi/v1.0/manage/api/v1/organizations/${orgUuid}/manage-devices/active-project`,
    body: {
      device_sn,
      active_project_uuid: project_uuid || session.projectUuid,
    },
    projectUuid: '',
    tag: '组织项目',
  });
  res.json(r);
});

/** 按项目聚合设备：标注每个设备所属项目，物模型请求需携带对应项目头 */
router.get('/devices-with-project', async (req, res) => {
  const prj = await request({ method: 'GET', path: '/project', query: { page: 1, page_size: 100 }, tag: '组织项目' });
  const projects = (prj.ok && prj.data?.list) || [];
  const list = [];
  for (const p of projects) {
    const d = await request({ method: 'GET', path: '/project/device', projectUuid: p.uuid, tag: '组织项目' });
    for (const item of d.ok && d.data?.list ? d.data.list : []) {
      list.push({ ...item, projectUuid: p.uuid, projectName: p.name });
    }
  }
  // 兜底：组织设备列表（可能不含项目归属）
  if (!list.length) {
    const all = await request({ method: 'GET', path: '/device', tag: '组织项目' });
    for (const item of all.ok && all.data?.list ? all.data.list : []) {
      list.push({ ...item, projectUuid: '', projectName: '' });
    }
  }
  res.json({ ok: true, code: 0, message: '', data: { list, projects } });
});

/** 连通性体检：系统状态 + 项目列表 */
router.get('/health', async (req, res) => {
  const started = Date.now();
  const status = await request({ method: 'GET', path: '/system_status', tag: '系统服务' }).catch(() => null);
  const projects = await request({ method: 'GET', path: '/project', query: { page: 1, page_size: 100 }, tag: '组织项目' });
  res.json({
    ok: !!projects.ok,
    data: {
      base: currentBase(),
      tokenOk: !!projects.ok,
      code: projects.code,
      message: projects.message,
      projectCount: projects.data?.list?.length ?? 0,
      latency: Date.now() - started,
      statusApi: status ? { ok: status.ok, code: status.code } : null,
    },
  });
});

export default router;
