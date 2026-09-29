/**
 * 审核路由：审核队列 · 图斑 CRUD · 多图合并 · 面积估算 · 推荐影像
 */
import { Router } from 'express';
import { estimateArea, rectPolygon, isValidLatLon, formatArea } from '../modules/review/geo.js';
import {
  createPatch, updatePatch, deletePatch,
  attachImages, detachImage, setPrimaryImage,
  suggestImages, reviewQueue, patchDetail,
} from '../modules/review/reviewService.js';
import { dictRepo, assetRepo } from '../db/repositories/index.js';
import { reverseGeocode } from '../modules/geo/reverseGeo.js';
import { getPublicConfig as getGeoConfig, saveConfig as saveGeoConfig } from '../modules/geo/geoConfig.js';

const router = Router();

/** 统一错误响应 */
function fail(res, r, httpStatus = 400) {
  return res.status(r.code === 40400 ? 404 : httpStatus).json({
    code: r.code ?? 40000,
    message: r.message || '操作失败',
    data: { allowed: r.allowed },
  });
}

// ================================================================
// 面积估算
// ================================================================

/**
 * POST /api/review/area-estimate
 * body: { geometry } 或 { p1:{lat,lon}, p2:{lat,lon} }
 */
router.post('/area-estimate', (req, res) => {
  const { geometry, p1, p2 } = req.body || {};
  let geom = geometry;
  if (!geom && p1 && p2) geom = rectPolygon(p1, p2);
  if (!geom) {
    return res.status(400).json({ code: 40011, message: '请提供范围（geometry 或 p1/p2 两点）' });
  }
  const est = estimateArea(geom);
  if (!est.ok) {
    return res.status(400).json({ code: 40011, message: est.message });
  }
  res.json({
    code: 0,
    message: '',
    data: { ...est, areaText: formatArea(est.areaM2) },
  });
});

// ================================================================
// 地址：坐标 → 具体地址（逆地理编码）
// ================================================================

/**
 * GET /api/review/reverse-geocode?lat=&lon=&projectUuid=
 *
 * 影像的 WGS84 坐标来自 DJI XMP，查国内地图服务前必须转 GCJ-02（见 reverseGeo 注释）。
 * 无 Key 时不静默失败：返回 needKey=true + 人话提示，前端照旧允许手填。
 */
router.get('/reverse-geocode', async (req, res) => {
  const { lat, lon, projectUuid } = req.query || {};
  const nLat = Number(lat);
  const nLon = Number(lon);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) {
    return res.status(400).json({ code: 40002, message: '缺少或非法的 lat / lon' });
  }
  const r = await reverseGeocode({ lat: nLat, lon: nLon, projectUuid: projectUuid || undefined });
  // 服务不可用不算业务失败：仍返回 200，由前端按 ok/needKey 决定怎么提示
  res.json({ code: 0, message: r.message || '', data: r });
});

/** 地址服务配置：只回「是否已配置 + Key 末 4 位」，不吐明文 */
router.get('/geo-config', (req, res) => {
  res.json({ code: 0, message: '', data: getGeoConfig() });
});

/** 保存地址服务配置（Key 写进 data/geo.json，不进 Git） */
router.put('/geo-config', (req, res) => {
  const { key } = req.body || {};
  if (key !== undefined && typeof key !== 'string') {
    return res.status(400).json({ code: 40002, message: 'key 必须是字符串' });
  }
  res.json({ code: 0, message: '已保存', data: saveGeoConfig({ key }) });
});

// ================================================================
// 审核队列
// ================================================================

/** GET /api/review/queue?status=draft|ticketed&projectUuid=&issueType=&page=&pageSize= */
router.get('/queue', (req, res) => {
  const { status, projectUuid, issueType, page = 1, pageSize = 20 } = req.query || {};
  const data = reviewQueue({
    status: status || undefined,
    projectUuid: projectUuid || undefined,
    issueType: issueType || undefined,
    page: Number(page) || 1,
    pageSize: Math.min(Number(pageSize) || 20, 200),
  });
  res.json({ code: 0, message: '', data });
});

// ================================================================
// 图斑
// ================================================================

/** POST /api/review/patches —— 创建图斑 */
router.post('/patches', (req, res) => {
  const r = createPatch(req.body || {});
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: { patchId: r.patchId, issueTypeName: r.issueTypeName } });
});

/** GET /api/review/patches/:id */
router.get('/patches/:id', (req, res) => {
  const d = patchDetail(Number(req.params.id));
  if (!d) return res.status(404).json({ code: 40400, message: '图斑不存在' });
  res.json({ code: 0, message: '', data: d });
});

/** PUT /api/review/patches/:id */
router.put('/patches/:id', (req, res) => {
  const r = updatePatch(Number(req.params.id), req.body || {});
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: { patchId: r.patchId } });
});

/** DELETE /api/review/patches/:id */
router.delete('/patches/:id', (req, res) => {
  const r = deletePatch(Number(req.params.id));
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: { deleted: true } });
});

/** POST /api/review/patches/:id/images —— 追加关联影像（多图合并） */
router.post('/patches/:id/images', (req, res) => {
  const { imageIds, primaryImageId } = req.body || {};
  const r = attachImages(Number(req.params.id), imageIds, primaryImageId);
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: r });
});

/** DELETE /api/review/patches/:id/images/:imageId */
router.delete('/patches/:id/images/:imageId', (req, res) => {
  const r = detachImage(Number(req.params.id), Number(req.params.imageId));
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: r });
});

/** POST /api/review/patches/:id/primary —— 设主图 */
router.post('/patches/:id/primary', (req, res) => {
  const r = setPrimaryImage(Number(req.params.id), Number(req.body?.imageId));
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: r });
});

/**
 * POST /api/review/suggest-images —— 框选后推荐"哪些影像拍到了这里"
 * body: { lat, lon, projectUuid, taskUuid }
 */
router.post('/suggest-images', (req, res) => {
  const { lat, lon, projectUuid, taskUuid } = req.body || {};
  const r = suggestImages({ lat, lon, projectUuid, taskUuid });
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: r });
});

/**
 * GET /api/review/issue-types —— 供表单联动（默认责任层级 / 时限 / 必填项）
 * 放在 review 下方便前端一个入口拿全
 */
router.get('/issue-types', (req, res) => {
  res.json({ code: 0, message: '', data: dictRepo.listIssueTypes() });
});

export default router;
