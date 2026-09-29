/**
 * 一键起飞路由：预检 / 执行 / 状态轮询
 */
import { Router } from 'express';
import { precheck, takeoff, takeoffStatus } from '../modules/drone/services/takeoffService.js';

const router = Router();

/** 起飞前预检 */
router.post('/precheck', async (req, res) => {
  const { sn, drone_sn, wayline_uuid } = req.body || {};
  res.json({ ok: true, data: await precheck({ dockSn: sn, droneSn: drone_sn, waylineUuid: wayline_uuid }) });
});

/** 执行一键起飞 */
router.post('/', async (req, res) => {
  const { sn, drone_sn, wayline_uuid, name, rth_altitude, precision, acquire_control } = req.body || {};
  res.json(
    await takeoff({
      dockSn: sn,
      droneSn: drone_sn,
      waylineUuid: wayline_uuid,
      taskName: name,
      rthAltitude: rth_altitude,
      precision,
      acquireControl: acquire_control !== false,
    })
  );
});

/** 查询起飞任务状态 */
router.get('/:uuid/status', async (req, res) => {
  res.json({ ok: true, data: await takeoffStatus(req.params.uuid) });
});

export default router;
