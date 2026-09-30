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
import {
  syncAssets,
  syncStatus,
  toEpoch,
  toIsoText,
  pauseSync,
  resumeSync,
  stopSync,
} from '../modules/asset/syncService.js';
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
  const {
    projectUuid,
    dockSn,
    dockSns,
    beginAt,
    endAt,
    downloadImages = true,
    skipEmptyTasks = false,
    limitTasks = 0,
  } = req.body || {};
  if (!projectUuid) {
    return res.status(400).json({ code: 40002, message: '缺少必填参数：projectUuid' });
  }
  if (!beginAt || !endAt) {
    return res
      .status(400)
      .json({ code: 40002, message: `缺少必填参数：${[!beginAt && 'beginAt', !endAt && 'endAt'].filter(Boolean).join(' / ')}` });
  }
  // ⚠️ 机场不再是必选：留空表示同步该项目全部机场（在线机场 + 历史同步过的机场）。
  //    项目里曾有过数据、但机场当前不在线时，强制必选会让用户根本无法再同步。
  const snList = [...(Array.isArray(dockSns) ? dockSns : []), ...(dockSn ? [dockSn] : [])]
    .map((s) => String(s).trim())
    .filter(Boolean);
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
    dockSns: snList,
    beginAt: beginTs,
    endAt: endTs,
    downloadImages: downloadImages !== false,
    skipEmptyTasks: skipEmptyTasks === true,
    limitTasks: Number(limitTasks) || 0,
  })
    .then((s) => {
      if (s && s.message) {
        log.warn('资产同步', s.message);
        return;
      }
      log.ok(
        '资产同步',
        `完成：架次 ${s.tasks}，入库 ${s.created}，跳过 ${s.skipped}，失败 ${s.failed}` +
          (s.emptyTasks ? `，剔除无影像 ${s.emptyTasks}` : '')
      );
    })
    .catch((e) => log.error('资产同步', `后台异常: ${e.message}`));

  res.json({ code: 0, message: '', data: { queued: true, docks: snList.length, skipEmptyTasks: skipEmptyTasks === true } });
});

/** 同步状态（前端轮询兜底） */
router.get('/sync/status', (req, res) => {
  res.json({ code: 0, message: '', data: syncStatus() });
});

/**
 * 暂停 / 继续 / 终止
 *
 * 暂停只是把循环挂在安全点（当前影像下完、下一个架次开始前），running 仍为 true，
 * 已入库的影像全部保留；继续从断点接着跑；终止则结束本轮，未处理的架次留给下次
 * （入库按 task+media 去重，不会重复下载）。
 */
const control = (fn, okName) => (req, res) => {
  const r = fn();
  if (!r.ok) {
    return res.status(409).json({ code: 40901, message: r.message });
  }
  log.ok('资产同步', okName);
  res.json({ code: 0, message: r.message, data: syncStatus() });
};

router.post('/sync/pause', control(pauseSync, '已暂停'));
router.post('/sync/resume', control(resumeSync, '已继续'));
router.post('/sync/stop', control(stopSync, '已终止'));

/**
 * 某项目下「历史同步出过架次」的机场清单
 *
 * 用途：同步弹窗的机场下拉数据源 = 在线设备 ∪ 这里。
 * 只取在线设备会漏掉「曾在该项目飞行、现已离线/被移出」的机场，
 * 而这些机场历史上拍的东西正是用户要找的数据。
 */
router.get('/known-docks', (req, res) => {
  const { projectUuid } = req.query || {};
  if (!projectUuid) {
    return res.status(400).json({ code: 40002, message: '缺少必填参数：projectUuid' });
  }
  const list = syncRepo.knownDocks(projectUuid).map((d) => ({
    dockSn: d.dockSn,
    tasks: d.tasks,
    lastAt: d.lastAt,
  }));
  res.json({ code: 0, message: '', data: { projectUuid, total: list.length, list } });
});

/**
 * 批量清理「没有任何影像」的存量架次
 *
 * 同步选项只管新数据，历史已经入过库的空壳架次要靠这里一次性清掉。
 * 只删数据库记录，不动磁盘——这些架次本就没有可下载的文件。
 */
router.post('/prune-empty-tasks', (req, res) => {
  const { projectUuid } = req.body || {};
  if (syncStatus().running) {
    return res.status(409).json({ code: 40901, message: '同步正在进行中，请稍后再试' });
  }
  const removed = syncRepo.deleteEmptyTasks(projectUuid || undefined);
  log.ok('资产清理', `剔除无影像架次 ${removed} 条${projectUuid ? `（项目 ${projectUuid}）` : '（全部项目）'}`);
  res.json({ code: 0, message: '', data: { removed } });
});

// ===================================================================
// 架次与影像
// ===================================================================

/** 架次列表（含影像统计与审核进度）——运营视角，跨项目看全组织数据 */
router.get('/tasks', (req, res) => {
  // 刻意不接收 projectUuid：巡检成果独立于项目，避免切了项目就「凭空丢数据」
  const { dockSn, beginAt, endAt, page = 1, pageSize = 20 } = req.query || {};
  const data = syncRepo.listTasks({
    dockSn,
    // 必须归一化成 begin_at 的文本格式再进 SQL，否则时间戳入参会静默查出 0 条（见 toIsoText 注释）
    beginAt: toIsoText(beginAt),
    endAt: toIsoText(endAt),
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
