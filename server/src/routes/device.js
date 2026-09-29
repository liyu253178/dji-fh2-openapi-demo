/**
 * 设备管理路由（薄）：委托给领域服务
 */
import { Router } from 'express';
import { request } from '../djiClient.js';
import * as controlService from '../modules/drone/services/controlService.js';
import * as telemetry from '../modules/drone/services/telemetry.js';

const router = Router();

/** 物模型（含机场/飞行器经纬度，地图定位的数据来源） */
router.get('/:sn/state', async (req, res) => {
  const r = await telemetry.deviceState(req.params.sn, req.query.project_uuid || '', req.query.force === '1');
  res.json(r);
});

/** HMS 健康信息 */
router.get('/hms', async (req, res) => {
  const { device_sn_list, language } = req.query;
  const list = Array.isArray(device_sn_list) ? device_sn_list : String(device_sn_list || '').split(',').filter(Boolean);
  const r = await request({
    method: 'GET',
    path: '/device/hms',
    query: { device_sn_list: list, language: language || 'zh' },
    tag: '设备管理',
  });
  res.json(r);
});

/** 控制权获取：payload_index 为空时自动解析（飞行器 → 所属机场 → 兜底） */
router.post('/control', async (req, res) => {
  const { drone_sn, payload_index } = req.body || {};
  res.json(await controlService.takeControl(drone_sn, payload_index));
});

/** 控制权释放：DELETE + JSON Body */
router.delete('/control', async (req, res) => {
  const { drone_sn, payload_index } = req.body || {};
  res.json(await controlService.releaseControl(drone_sn, payload_index));
});

/** 机场相机切换：indoor 舱内 / outdoor 舱外 */
router.post('/change-camera', async (req, res) => {
  const { sn, camera_index, camera_position } = req.body || {};
  const r = await request({
    method: 'POST',
    path: '/device/change-camera',
    body: { sn, camera_index, camera_position },
    tag: '设备管理',
  });
  res.json(r);
});

/** 飞行器镜头切换：wide / zoom / ir */
router.post('/change-lens', async (req, res) => {
  const { sn, camera_index, lens_type } = req.body || {};
  const r = await request({
    method: 'POST',
    path: '/device/change-lens',
    body: { sn, camera_index, lens_type },
    tag: '设备管理',
  });
  res.json(r);
});

/** 图传清晰度 adaptive / smooth / ultra_high_definition */
router.put('/stream/quality', async (req, res) => {
  const { sn, camera_index, quality_type } = req.body || {};
  const r = await request({
    method: 'PUT',
    path: '/device/stream/quality',
    body: { sn, camera_index, quality_type },
    tag: '设备管理',
  });
  res.json(r);
});

/** 实时控制指令：返航 / 取消返航 / 暂停 / 恢复 */
router.post('/command', async (req, res) => {
  const { device_sn, device_command } = req.body || {};
  if (!device_sn || !device_command) return res.json({ ok: false, message: '缺少 device_sn 或 device_command' });
  const r = await request({
    method: 'POST',
    path: '/device/' + encodeURIComponent(device_sn) + '/command',
    body: { device_command },
    tag: '设备管理',
  });
  res.json(r);
});

export default router;
