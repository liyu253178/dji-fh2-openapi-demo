/**
 * 司空管理路由：日志输出 + 通用 API 调试代理（快速排查项目问题）
 */
import { Router } from 'express';
import { request, session, currentBase, mask } from '../djiClient.js';
import { getLogs, clearLogs, log } from '../logger.js';
import { mockState, setMock } from '../mock.js';

const router = Router();

/** 日志查询 */
router.get('/logs', (req, res) => {
  const { level, keyword, limit } = req.query;
  res.json({ ok: true, data: getLogs(level, keyword, Number(limit) || 300) });
});

router.delete('/logs', (req, res) => {
  clearLogs();
  res.json({ ok: true });
});

/** 通用代理：任意 method + path + body 直连司空 2，用于 API 测试 */
router.post('/proxy', async (req, res) => {
  const { method = 'GET', path = '', query, body, useProject = true, timeout } = req.body || {};
  if (!path) return res.json({ ok: false, message: '请填写接口路径，例如 /openapi/v0.1/project' });
  const started = Date.now();
  const r = await request({
    method: method.toUpperCase(),
    path,
    query,
    body,
    projectUuid: useProject ? session.projectUuid : '',
    timeout: Number(timeout) || 20000,
    tag: 'API测试',
    rawResponse: true,
  });
  res.json({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    duration: r.duration,
    json: r.json,
    text: r.text,
    request: {
      method: method.toUpperCase(),
      url: currentBase() + (path.startsWith('/openapi') ? path : '/openapi/v0.1' + path),
      token: mask(session.token),
      projectUuid: session.projectUuid,
      body,
    },
    elapsed: Date.now() - started,
  });
});

/** 预置接口清单（API 测试器下拉） */
router.get('/catalog', (req, res) => {
  res.json({ ok: true, data: CATALOG });
});

const CATALOG = [
  { group: '组织项目', name: '获取组织下的项目列表', method: 'GET', path: '/openapi/v0.1/project', body: '' },
  { group: '组织项目', name: '获取组织下的设备列表', method: 'GET', path: '/openapi/v0.1/device', body: '' },
  { group: '组织项目', name: '获取项目下的设备列表', method: 'GET', path: '/openapi/v0.1/project/device', body: '' },
  { group: '组织项目', name: '获取存储上传凭证', method: 'GET', path: '/openapi/v0.1/project/sts-token', body: '' },
  { group: '系统服务', name: '查询司空2系统状态', method: 'GET', path: '/openapi/v0.1/system_status', body: '' },
  {
    group: '设备管理',
    name: '物模型获取',
    method: 'GET',
    path: '/openapi/v0.1/device/{device_sn}/state',
    body: '',
  },
  { group: '设备管理', name: 'HMS信息获取', method: 'GET', path: '/openapi/v0.1/device/hms', body: '' },
  {
    group: '设备管理',
    name: '控制权获取',
    method: 'POST',
    path: '/openapi/v0.1/device/control',
    body: '{"drone_sn":"飞行器SN","payload_index":["81-0-0"]}',
  },
  {
    group: '设备管理',
    name: '控制权释放(DELETE)',
    method: 'DELETE',
    path: '/openapi/v0.1/device/control',
    body: '{"drone_sn":"飞行器SN","payload_index":["81-0-0"]}',
  },
  {
    group: '设备管理',
    name: '机场相机切换',
    method: 'POST',
    path: '/openapi/v0.1/device/change-camera',
    body: '{"sn":"机场SN","camera_index":"165-0-7","camera_position":"indoor"}',
  },
  {
    group: '设备管理',
    name: '飞行器镜头切换',
    method: 'POST',
    path: '/openapi/v0.1/device/change-lens',
    body: '{"sn":"飞行器SN","camera_index":"81-0-0","lens_type":"wide"}',
  },
  {
    group: '设备管理',
    name: '图传清晰度设置',
    method: 'PUT',
    path: '/openapi/v0.1/device/stream/quality',
    body: '{"sn":"飞行器SN","camera_index":"81-0-0","quality_type":"adaptive"}',
  },
  {
    group: '设备管理',
    name: '实时控制指令下发',
    method: 'POST',
    path: '/openapi/v0.1/device/{device_sn}/command',
    body: '{"device_command":"return_home"}',
  },
  {
    group: '直播管理',
    name: '开启直播',
    method: 'POST',
    path: '/openapi/v0.1/live-stream/start',
    body: '{"sn":"机场SN","camera_index":"165-0-7","video_expire":7200,"quality_type":"adaptive"}',
  },
  { group: '航线管理', name: '获取项目下的航线列表', method: 'GET', path: '/openapi/v0.1/wayline', body: '' },
  {
    group: '航线管理',
    name: '获取航线详情',
    method: 'GET',
    path: '/openapi/v0.1/wayline/{wayline_id}',
    body: '',
  },
  {
    group: '航线管理',
    name: '航线上传完成通知',
    method: 'POST',
    path: '/openapi/v0.1/wayline/finish-upload',
    body: '{"object_key":"前缀/wayline.kmz","name":"wayline_01"}',
  },
  {
    group: '任务管理',
    name: '创建飞行任务',
    method: 'POST',
    path: '/openapi/v0.1/flight-task',
    body: '{"name":"任务名","wayline_uuid":"航线UUID","sn":"机场SN","task_type":"immediate","rth_mode":"optimal","rth_altitude":100,"wayline_precision_type":"rtk"}',
  },
  { group: '任务管理', name: '获取飞行任务列表', method: 'GET', path: '/openapi/v0.1/flight-task/list', body: '' },
  {
    group: '任务管理',
    name: '获取飞行任务信息',
    method: 'GET',
    path: '/openapi/v0.1/flight-task/{task_uuid}',
    body: '',
  },
  {
    group: '任务管理',
    name: '更新飞行任务状态',
    method: 'PUT',
    path: '/openapi/v0.1/flight-task/{task_uuid}/status',
    body: '{"status":"suspended"}',
  },
  {
    group: '任务管理',
    name: '获取任务媒体资源',
    method: 'GET',
    path: '/openapi/v0.1/flight-task/{task_uuid}/media',
    body: '',
  },
  {
    group: '任务管理',
    name: '获取任务轨迹信息',
    method: 'GET',
    path: '/openapi/v0.1/flight-task/{task_uuid}/track',
    body: '',
  },
];

/** 演示数据模式：TK 未打通时用于验证全部界面 */
router.get('/mock', (req, res) => {
  res.json({ ok: true, data: { enabled: mockState.enabled } });
});

router.post('/mock', (req, res) => {
  const enabled = setMock(req.body?.enabled);
  log[enabled ? 'warn' : 'ok']('ADMIN', `演示模式已${enabled ? '开启（接口返回演示数据）' : '关闭（请求真实司空 2）'}`);
  res.json({ ok: true, data: { enabled } });
});

export default router;
