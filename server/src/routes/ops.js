/**
 * 一网统飞运营路由：遥测快照 / 监管总览 / 最优机巢调度 / 缓存运维
 */
import { Router } from 'express';
import * as telemetry from '../modules/drone/services/telemetry.js';
import * as statsService from '../modules/drone/services/statsService.js';
import * as scheduler from '../modules/drone/services/scheduler.js';
import { stats, clear } from '../cache.js';

const router = Router();

/** 统一遥测快照（监控页/座舱/地图/大屏复用） */
router.get('/snapshot', async (req, res) => {
  const force = req.query.force === '1';
  try {
    const snap = await telemetry.snapshot(force);
    telemetry.detectChanges(snap);
    res.json({ ok: true, data: snap });
  } catch (e) {
    res.json({ ok: false, message: e.message, data: null });
  }
});

/** 强制刷新遥测 */
router.post('/snapshot/refresh', async (req, res) => {
  telemetry.invalidate();
  const snap = await telemetry.snapshot(true);
  res.json({ ok: true, data: snap });
});

/** 单设备物模型（走缓存） */
router.get('/device-state/:sn', async (req, res) => {
  const r = await telemetry.deviceState(req.params.sn, req.query.project_uuid || '', req.query.force === '1');
  res.json(r);
});

/** 监管总览（大屏 / 总览看板） */
router.get('/overview', async (req, res) => {
  const r = await statsService.overview(req.query.force === '1');
  res.json(r);
});

/** 最优机巢推荐 */
router.post('/recommend-nest', async (req, res) => {
  const { lat, lng, minBattery } = req.body || {};
  res.json(await scheduler.recommendNest({ lat: Number(lat), lng: Number(lng) }, { minBattery: Number(minBattery) || 30 }));
});

/** 批量巡检计划编排 */
router.post('/plan', async (req, res) => {
  const { targets = [], minBattery } = req.body || {};
  res.json(await scheduler.planForTargets(targets, { minBattery: Number(minBattery) || 30 }));
});

/** 缓存运维 */
router.get('/cache', (req, res) => res.json({ ok: true, data: stats() }));
router.delete('/cache', (req, res) => {
  clear();
  telemetry.invalidate();
  res.json({ ok: true });
});

export default router;
