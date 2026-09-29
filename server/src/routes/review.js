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
