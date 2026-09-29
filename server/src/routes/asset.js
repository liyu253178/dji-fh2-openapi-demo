/**
 * 成果资产路由
 *
 * 前端一律经此接口取图，不直接请求磁盘路径——换存储（本地/NAS/对象存储）时前端无感。
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { toAbsolute, ASSET_DIR, THUMB_DIR, MAIL_IMAGE_DIR } from '../db/config.js';
import { run } from '../db/index.js';
import { assetRepo, syncRepo } from '../db/repositories/index.js';
import { syncAssets, syncStatus, toEpoch } from '../modules/asset/syncService.js';
import { removeLocal } from '../modules/asset/downloader.js';
import { log } from '../logger.js';

const router = Router();

/** 允许取图的根目录白名单 */
const ALLOWED_ROOTS = [ASSET_DIR, THUMB_DIR, MAIL_IMAGE_DIR];

/**
 * 防路径穿越：解析后的绝对路径必须仍在白名单目录内
 */
function safeResolve(relPath) {
  if (!relPath) return null;
  const abs = path.resolve(toAbsolute(relPath));
  for (const root of ALLOWED_ROOTS) {
    const r = path.resolve(root);
    if (abs === r || abs.startsWith(r + path.sep)) return abs;
  }
  return null;
}

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** 把 repo 的 snake_case 结果转成前端契约的 camelCase */
function shapeImage(r) {
  return {
    id: r.id,
    mediaUuid: r.mediaUuid,
    taskUuid: r.taskUuid,
    fileName: r.fileName,
    fileType: r.fileType,
    lensType: r.lensType,
    imageSource: r.imageSource,
    lat: r.lat,
    lon: r.lon,
    altitudeAbs: r.altitudeAbs,
    altitudeRel: r.altitudeRel,
    gpsStatus: r.gpsStatus,
    crs: r.crs,
    isRtk: r.gpsStatus === 'RTK' || r.gpsStatus === 'RTKFloat',
    isNadir: r.isNadir,
    footprint: r.footprint,
    gimbal: r.gimbal,
    flight: r.flight,
    droneSn: r.droneSn,
    cameraSn: r.cameraSn,
    droneModel: r.droneModel,
    flightLineId: r.flightLineId,
    shotAt: r.shotAt,
    parseStatus: r.parseStatus,
    parseError: r.parseError,
    pairImageId: r.pairImageId,
    reviewState: r.reviewState,
    hasThumb: !!r.thumbPath,
    hasMail: !!r.mailPath,
    hasOriginal: !!r.filePath,
  };
}

// ===================================================================
// 同步
// ===================================================================

/** 发起同步（异步，立即返回） */
router.post('/sync', (req, res) => {
  const { projectUuid, dockSn, beginAt, endAt, downloadImages = true, limitTasks = 0 } = req.body || {};
  const missing = [];
  if (!projectUuid) missing.push('projectUuid');
  if (!dockSn) missing.push('dockSn(机场SN)');
  if (!beginAt) missing.push('beginAt');
  if (!endAt) missing.push('endAt');
  if (missing.length) {
    return res.status(400).json({
      code: 40002,
      message: `缺少必填参数：${missing.join(' / ')}`,
      data: { errors: missing },
    });
  }
  if (syncStatus().running) {
    return res.status(409).json({ code: 40901, message: '同步正在进行中，请勿重复触发' });
  }
  // 时间格式先做一次同步校验，非法直接 400，
  // 否则会带着 NaN 去问司空，表现为「同步成功但 0 个架次」的静默失败
  let beginTs;
  let endTs;
  try {
    beginTs = toEpoch(beginAt, 'beginAt');
    endTs = toEpoch(endAt, 'endAt');
  } catch (e) {
    return res.status(400).json({ code: 40002, message: e.message });
  }
  if (beginTs >= endTs) {
    return res.status(400).json({ code: 40002, message: 'beginAt 必须早于 endAt' });
  }
  // 后台执行，不阻塞响应
  syncAssets({
    projectUuid,
    dockSn,
    beginAt: beginTs,
    endAt: endTs,
    downloadImages: downloadImages !== false,
    limitTasks: Number(limitTasks) || 0,
  })
    .then((s) => {
      log.ok('资产同步', `完成：任务 ${s.tasks}，入库 ${s.created}，跳过 ${s.skipped}，失败 ${s.failed}`);
    })
    .catch((e) => log.error('资产同步', `后台异常: ${e.message}`));

  res.json({ code: 0, message: '', data: { queued: true } });
});

/** 同步状态（前端轮询兜底） */
router.get('/sync/status', (req, res) => {
  res.json({ code: 0, message: '', data: syncStatus() });
});

// ===================================================================
// 架次与影像
// ===================================================================

/** 架次列表（含影像统计与审核进度） */
router.get('/tasks', (req, res) => {
  const { projectUuid, dockSn, beginAt, endAt, page = 1, pageSize = 20 } = req.query || {};
  const data = syncRepo.listTasks({
    projectUuid,
    dockSn,
    beginAt,
    endAt,
    page: Number(page) || 1,
    pageSize: Math.min(Number(pageSize) || 20, 200),
  });
  res.json({ code: 0, message: '', data });
});

/** 某架次的影像列表（审核工作台缩略图数据源） */
router.get('/tasks/:taskUuid/images', (req, res) => {
  const imgs = assetRepo.listByTask(req.params.taskUuid);
  res.json({
    code: 0,
    message: '',
    data: { taskUuid: req.params.taskUuid, total: imgs.length, list: imgs.map(shapeImage) },
  });
});

/** 某架次的航迹（用影像 GPS 序列重建，兜底司空 track 接口不可用） */
router.get('/tasks/:taskUuid/track', (req, res) => {
  const task = syncRepo.findTask(req.params.taskUuid);
  if (!task) {
    return res.status(404).json({ code: 40401, message: '架次不存在' });
  }
  const lineId = task.flight_line_id || assetRepo.dominantFlightLineId(req.params.taskUuid);
  const track = lineId ? assetRepo.trackByFlightLine(lineId) : [];
  res.json({
    code: 0,
    message: '',
    data: {
      taskUuid: req.params.taskUuid,
      flightLineId: lineId || '',
      points: track,
      count: track.length,
      source: 'image-xmp',
    },
  });
});

/** 删除架次及其影像（清理误同步） */
router.delete('/tasks/:taskUuid', async (req, res) => {
  const imgs = assetRepo.listByTask(req.params.taskUuid);
  if (!imgs.length) {
    return res.status(404).json({ code: 40401, message: '该架次没有影像' });
  }
  for (const im of imgs) {
    await removeLocal(im.filePath);
    await removeLocal(im.thumbPath);
    await removeLocal(im.mailPath);
    run('DELETE FROM patch_image WHERE image_id = @id', { id: im.id });
  }
  run('DELETE FROM asset_image WHERE task_uuid = @t', { t: req.params.taskUuid });
  run('DELETE FROM flight_task WHERE uuid = @t', { t: req.params.taskUuid });
  res.json({ code: 0, message: '', data: { removed: imgs.length } });
});

/** 多维检索 */
router.get('/search', (req, res) => {
  const q = req.query || {};
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const data = assetRepo.search({
    projectUuid: q.projectUuid || undefined,
    taskUuid: q.taskUuid || undefined,
    lensType: q.lensType || undefined,
    reviewState: q.reviewState || undefined,
    minLat: num(q.minLat),
    maxLat: num(q.maxLat),
    minLon: num(q.minLon),
    maxLon: num(q.maxLon),
    beginAt: q.beginAt || undefined,
    endAt: q.endAt || undefined,
    page: Number(q.page) || 1,
    pageSize: Math.min(Number(q.pageSize) || 50, 500),
  });
  res.json({
    code: 0,
    message: '',
    data: { total: data.total, list: data.list.map(shapeImage) },
  });
});

// ===================================================================
// 取图
// ===================================================================

/**
 * 取图：/api/asset/images/:id/file?size=thumb|mail|original
 */
router.get('/images/:id/file', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ code: 40003, message: '非法的影像 ID' });
  }
  const img = assetRepo.findById(id);
  if (!img) {
    return res.status(404).json({ code: 40402, message: '影像不存在' });
  }
  const size = String(req.query.size || 'thumb');
  const rel = size === 'original' ? img.filePath : size === 'mail' ? img.mailPath : img.thumbPath;
  if (!rel) {
    return res.status(404).json({
      code: 40403,
      message: `该影像没有 ${size} 版本（可能同步时未下载或生成失败）`,
      data: { size },
    });
  }
  const abs = safeResolve(rel);
  if (!abs) {
    log.error('资产路由', `路径越界已被拦截: ${rel}`);
    return res.status(403).json({ code: 40301, message: '非法路径' });
  }
  if (!fs.existsSync(abs)) {
    return res.status(404).json({ code: 40404, message: '文件不存在（可能已被清理）' });
  }
  const ext = path.extname(abs).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (size === 'original') {
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(img.fileName || 'image.jpg')}"`
    );
  }
  fs.createReadStream(abs).pipe(res);
});

/** 影像元数据（前端右栏信息面板） */
router.get('/images/:id', (req, res) => {
  const img = assetRepo.findById(Number(req.params.id));
  if (!img) return res.status(404).json({ code: 40402, message: '影像不存在' });
  res.json({ code: 0, message: '', data: shapeImage(img) });
});

/** 某影像的配对影像（红外 ↔ 可见光） */
router.get('/images/:id/pair', (req, res) => {
  const img = assetRepo.findById(Number(req.params.id));
  if (!img) return res.status(404).json({ code: 40402, message: '影像不存在' });
  if (!img.pairImageId) {
    return res.json({ code: 0, message: '', data: { hasPair: false, pair: null } });
  }
  const pair = assetRepo.findById(img.pairImageId);
  res.json({ code: 0, message: '', data: { hasPair: !!pair, pair: pair ? shapeImage(pair) : null } });
});

export default router;
