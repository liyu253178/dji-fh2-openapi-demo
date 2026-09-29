/**
 * 资产同步编排
 *
 * 流程：拉任务清单 → 逐架次拉媒体清单 → 下载原图 → XMP 解析 → 生成派生图 → 入库
 *      → 架次内红外/可见光配对 → 航迹重建兜底数据入库
 *
 * 设计要点：
 *   1. 签名即时消费：司空媒体 URL 约 24h 过期，所以拿到就下载，绝不缓存 URL
 *   2. 幂等：同 task+media 只入库一次；本地已存在文件跳过下载
 *   3. 可中断：磁盘不足抛 DiskFullError 中止整批，已下载部分保留
 *   4. 进度实时推送：走 events 事件总线，前端 SSE 订阅 sync_progress
 *   5. 逐张容错：单张失败不中断整批，错误记到任务上
 */

import { request } from '../../djiClient.js';
import { log } from '../../logger.js';
import { emit } from '../../events.js';import { assetRepo, syncRepo, alertRepo } from '../../db/repositories/index.js';
import { parseDjiMeta, estimateFootprint } from './djiXmp.js';
import { downloadImage, readLocal, taskDir, DiskFullError } from './downloader.js';
import { generateDerivatives } from './thumbnail.js';

/** 同步运行状态（内存态，一期单机够用） */
let running = false;
let current = { running: false, processedTasks: 0, totalTasks: 0, downloaded: 0, skipped: 0, failed: 0, currentTask: '' };

export function syncStatus() {
  return { ...current };
}

function pushProgress(patch = {}) {
  current = { ...current, ...patch };
  emit('sync_progress', { ...current });
}

/**
 * 拉取飞行任务清单
 * ⚠️ 实测坑：sn / begin_at / end_at 为必填，缺参时司空不报错、只返回 code=0 + 空 list，
 *    极易被误判成"从没飞过"，因此这里主动校验并给出明确错误。
 *
 * ⚠️ 另一个坑：projectUuid 必须显式传入。djiClient 的 session.projectUuid 是全局单例，
 *    不同项目并发同步时会串味，且未选项目时会因缺 X-Project-Uuid 头返回 200403。
 */
async function fetchTasks({ projectUuid, dockSn, beginAt, endAt }) {
  const missing = ['dockSn', 'beginAt', 'endAt'].filter((k) => !({ dockSn, beginAt, endAt })[k]);
  if (missing.length) {
    const names = { dockSn: 'sn(机场SN)', beginAt: 'begin_at', endAt: 'end_at' };
    throw new Error(`缺少必填参数：${missing.map((m) => names[m]).join(' / ')}`);
  }
  const r = await request({
    method: 'GET',
    path: '/flight-task/list',
    query: { sn: dockSn, begin_at: beginAt, end_at: endAt },
    projectUuid,
    tag: '资产同步',
  });
  if (!r.ok) {
    if (Number(r.code) === 200403) {
      throw new Error(`code=200403 Forbidden：项目 ${projectUuid} 无权限或该项目下不存在该机场（确认机场 SN 与项目是否匹配）`);
    }
    throw new Error(`拉取任务列表失败 code=${r.code} ${r.message}`);
  }
  return Array.isArray(r.data?.list) ? r.data.list : [];
}

/** 拉取某任务的媒体清单 */
async function fetchMedia(taskUuid, projectUuid) {
  const r = await request({
    method: 'GET',
    path: `/flight-task/${encodeURIComponent(taskUuid)}/media`,
    projectUuid,
    tag: '资产同步',
  });
  if (!r.ok) {
    // 219021 = 该任务本来就没有航拍照片（FlyToTask_* 定点飞行），属正常
    if (Number(r.code) === 219021) return { media: [], noMedia: true };
    return { media: [], error: `code=${r.code} ${r.message}` };
  }
  const list = Array.isArray(r.data?.list) ? r.data.list : [];
  return { media: list, noMedia: list.length === 0 };
}

/** 判断镜头类型 */
function lensOf(item) {
  const src = item.image_source || '';
  if (src === 'IRCamera' || src === 'InfraredCamera') return 'infrared';
  if (src === 'ZoomCamera' || src === 'WideCamera') return 'visible';
  // 兜底：DJI 文件名后缀 _T=红外 _V=可见光
  if (/_T$/.test(item.name || '')) return 'infrared';
  if (/_V$/.test(item.name || '')) return 'visible';
  return 'visible';
}

/** file_type 归一 */
function fileTypeOf(item) {
  const t = item.file_type;
  if (t === 'ppk') return 'ppk';
  if (t === 'image') return 'image';
  return 'unsupported';
}

/**
 * 处理单个影像：下载 → 解析 → 生成派生图 → 入库
 */
async function processOne(mediaItem, ctx) {
  const { task, projectUuid, dockSn, dir } = ctx;
  const fileName = mediaItem.name;
  const fileType = fileTypeOf(mediaItem);

  // PPK 等非图像类不下载，但可记录（用于轨迹重建）
  if (fileType !== 'image') {
    const r = assetRepo.upsertImage({
      taskUuid: task.uuid,
      mediaUuid: mediaItem.uuid,
      projectUuid,
      dockSn,
      fileName,
      fileSize: mediaItem.size,
      fileType,
      parseStatus: 'ok',
    });
    return { ...r, skipped: true, reason: '非图像文件' };
  }

  // 下载（幂等：已存在则跳过）
  const dl = await downloadImage(mediaItem.original_url, { fileName, dir });
  if (!dl.ok) {
    return { ok: false, error: dl.error };
  }

  // 解析 XMP（必须读原图，缩略图已被剥离 EXIF）
  let meta = null;
  let parseStatus = 'ok';
  let parseError = null;
  let foot = null;
  if (!dl.skipped) {
    try {
      const buf = await readLocal(dl.filePath);
      meta = parseDjiMeta(buf);
      if (!meta) {
        parseStatus = 'failed';
        parseError = '未找到 XMP（可能非 DJI 机型或格式异常）';
      } else if (meta.lat === null) {
        parseStatus = 'no_gps';
        parseError = 'XMP 中无 GPS 坐标';
      } else {
        foot = estimateFootprint(meta);
      }
    } catch (e) {
      parseStatus = 'failed';
      parseError = e.message;
    }
  } else {
    // 已下载过：读本地文件补解析（数据库可能因手工清理丢失）
    try {
      const buf = await readLocal(dl.filePath);
      meta = parseDjiMeta(buf);
      parseStatus = meta ? (meta.lat === null ? 'no_gps' : 'ok') : 'failed';
      if (meta && meta.lat !== null) foot = estimateFootprint(meta);
      if (!meta) parseError = '未找到 XMP';
      else if (meta.lat === null) parseError = 'XMP 中无 GPS 坐标';
    } catch (e) {
      parseStatus = 'failed';
      parseError = e.message;
    }
  }

  // 生成派生图（红外做可视化增强）
  let thumbPath = null;
  let mailPath = null;
  if (meta) {
    const lens = lensOf({ ...mediaItem, image_source: meta.imageSource });
    try {
      const buf = await readLocal(dl.filePath);
      const d = await generateDerivatives(buf, {
        baseName: `${task.uuid}_${String(mediaItem.name).replace(/[^\w.-]/g, '_')}`,
        infrared: lens === 'infrared',
      });
      thumbPath = d.thumbPath;
      mailPath = d.mailPath;
      if (d.error) log.warn('资产同步', `派生图生成失败 ${mediaItem.name}: ${d.error}`);
    } catch (e) {
      log.warn('资产同步', `派生图生成异常 ${mediaItem.name}: ${e.message}`);
    }
  }

  const lens = meta ? lensOf({ ...mediaItem, image_source: meta.imageSource }) : lensOf(mediaItem);
  const r = assetRepo.upsertImage({
    taskUuid: task.uuid,
    mediaUuid: mediaItem.uuid,
    projectUuid,
    dockSn,
    fileName,
    fileHash: dl.fileHash ?? null,
    fileSize: dl.fileSize ?? mediaItem.size ?? null,
    filePath: dl.filePath,
    thumbPath,
    mailPath,
    fileType,
    lensType: lens,
    imageSource: meta?.imageSource ?? null,
    lat: meta?.lat ?? null,
    lon: meta?.lon ?? null,
    altitudeAbs: meta?.altitudeAbs ?? null,
    altitudeRel: meta?.altitudeRelative ?? null,
    gpsStatus: meta?.gpsStatus ?? null,
    crs: 'EPSG:4326',
    footprintBbox: foot?.bbox ? foot.bbox : null,
    footprintW: foot?.widthM ?? null,
    footprintH: foot?.heightM ?? null,
    isNadir: foot?.isNadir ?? false,
    gimbalRoll: meta?.gimbal?.roll ?? null,
    gimbalYaw: meta?.gimbal?.yaw ?? null,
    gimbalPitch: meta?.gimbal?.pitch ?? null,
    flightRoll: meta?.flight?.roll ?? null,
    flightYaw: meta?.flight?.yaw ?? null,
    flightPitch: meta?.flight?.pitch ?? null,
    droneSn: meta?.droneSn ?? null,
    cameraSn: meta?.cameraSn ?? null,
    droneModel: meta?.droneModel ?? null,
    flightLineId: meta?.flightLineId ?? null,
    shotAt: meta?.shootTime ?? null,
    parseStatus,
    parseError,
  });
  return { ...r, skipped: !!dl.skipped, lens, parseStatus };
}

/**
 * 同步主入口
 * @param {object} opts
 * @param {string} opts.projectUuid
 * @param {string} opts.dockSn 机场 SN
 * @param {number} opts.beginAt 秒级时间戳
 * @param {number} opts.endAt 秒级时间戳
 * @param {boolean} [opts.downloadImages=true] 是否下载原图（false 只同步元数据）
 * @param {number} [opts.limitTasks] 限制架次数（调试用）
 * @param {(p:object)=>void} [opts.onProgress]
 */
/**
 * 把入参时间统一成「秒级 Unix 时间戳」
 *
 * ⚠️ 实测坑：司空 /flight-task/list 的 begin_at / end_at 必须是秒级时间戳。
 *    若直接对 "2026-08-30 08:41:11" 这类字符串做 Number() 会得到 NaN，
 *    而司空对 NaN 不报错、只返回 code=0 + 空 list —— 表现为「同步成功但 0 个架次」，
 *    极易被误判成"这段时间没飞过"。这里同时接受三种输入并显式报错。
 *
 * @param {number|string} v 秒级时间戳 / 毫秒级时间戳 / "YYYY-MM-DD HH:mm:ss" / "YYYY-MM-DD" / ISO 串
 * @param {'begin'|'end'} which 用于错误提示
 * @returns {number} 秒级时间戳
 */
export function toEpoch(v, which = 'time') {
  if (v === undefined || v === null || v === '') {
    throw new Error(`${which} 不能为空`);
  }
  // 纯数字：区分秒级与毫秒级（毫秒级 13 位）
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${which} 不是合法时间戳：${v}`);
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  }
  const s = String(v).trim();
  // 把 "YYYY-MM-DD HH:mm:ss" 转成 ISO（Safari/Node 对空格分隔的解析不一致）
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + (s.length === 10 ? 'T00:00:00' : '');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`${which} 不是合法时间：${v}（支持秒级时间戳或 YYYY-MM-DD HH:mm:ss）`);
  return Math.floor(ms / 1000);
}

export async function syncAssets({ projectUuid, dockSn, beginAt, endAt, downloadImages = true, limitTasks = 0, onProgress } = {}) {
  if (running) {
    return { ok: false, message: '同步正在进行中，请勿重复触发' };
  }
  // 时间统一成秒级时间戳（见 toEpoch 说明：不转会静默同步 0 个架次）
  const beginTs = toEpoch(beginAt, 'beginAt');
  const endTs = toEpoch(endAt, 'endAt');
  if (beginTs >= endTs) {
    return { ok: false, message: `beginAt 必须早于 endAt（${beginTs} >= ${endTs}）` };
  }
  running = true;
  current = {
    running: true,
    processedTasks: 0,
    totalTasks: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    currentTask: '',
    startedAt: new Date().toISOString(),
  };
  pushProgress();

  const summary = {
    ok: true,
    tasks: 0,
    images: 0,
    created: 0,
    skipped: 0,
    failed: 0,
    noMedia: 0,
    noGps: 0,
    errors: [],
    aborted: false,
  };

  try {
    // 1. 任务清单
    const tasks = await fetchTasks({ projectUuid, dockSn, beginAt: beginTs, endAt: endTs });
    const list = limitTasks > 0 ? tasks.slice(0, limitTasks) : tasks;
    summary.tasks = list.length;
    current.totalTasks = list.length;
    pushProgress();

    if (!list.length) {
      log.warn('资产同步', '该时间范围内没有飞行任务');
    }

    // 2. 逐架次处理
    for (const t of list) {
      current.currentTask = t.name || t.uuid;
      pushProgress();

      // 任务入库（先记，即使后续失败也留下痕迹）
      syncRepo.upsertTask({
        uuid: t.uuid,
        projectUuid,
        dockSn,
        name: t.name,
        taskType: t.task_type,
        status: t.status,
        waylineUuid: t.wayline_uuid,
        beginAt: t.begin_at,
        endAt: t.end_at,
        mediaTotal: 0,
      });

      try {
        const { media, noMedia, error } = await fetchMedia(t.uuid, projectUuid);
        if (error) {
          syncRepo.markTaskSync(t.uuid, { status: 'failed', error });
          summary.failed++;
          summary.errors.push({ task: t.name || t.uuid, error });
          log.error('资产同步', `媒体清单拉取失败 ${t.name}: ${error}`);
        } else if (noMedia) {
          syncRepo.markTaskSync(t.uuid, { status: 'ok' });
          summary.noMedia++;
          log.info('资产同步', `${t.name}: 无航拍成果（可能是 FlyToTask 定点飞行）`);
        } else {
          const shotDate = (t.begin_at || '').slice(0, 10) || 'nodate';
          const dir = await taskDir({ projectUuid, shotDate, taskName: t.name || t.uuid });

          for (const m of media) {
            if (!downloadImages && fileTypeOf(m) === 'image') {
              // 只同步元数据模式：仍解析清单，但不下载
              summary.skipped++;
              continue;
            }
            try {
              const r = await processOne(m, { task: t, projectUuid, dockSn, dir });
              summary.images++;
              if (r.skipped) summary.skipped++;
              else summary.created++;
              if (r.parseStatus === 'no_gps') summary.noGps++;
              if (!r.ok && r.error) {
                summary.failed++;
                summary.errors.push({ image: m.name, error: r.error });
              }
            } catch (e) {
              if (e instanceof DiskFullError) throw e; // 磁盘不足需中止整批
              summary.failed++;
              summary.errors.push({ image: m.name, error: e.message });
              log.error('资产同步', `处理影像失败 ${m.name}: ${e.message}`);
            }
          }

          // 架次内配对（红外 ↔ 可见光）
          const lineId = assetRepo.dominantFlightLineId(t.uuid);
          let pairs = 0;
          if (lineId) pairs = assetRepo.pairByFlightLine(lineId);

          const stored = assetRepo.listByTask(t.uuid).length;
          syncRepo.markTaskSync(t.uuid, { status: 'ok', mediaTotal: stored, flightLineId: lineId });
          log.ok(
            '资产同步',
            `${t.name}: 入库 ${stored} 个文件${pairs ? `，配对 ${pairs} 组` : ''}`
          );
        }
      } catch (e) {
        if (e instanceof DiskFullError) throw e;
        summary.failed++;
        summary.errors.push({ task: t.name || t.uuid, error: e.message });
        log.error('资产同步', `处理架次失败 ${t.name}: ${e.message}`);
      }

      current.processedTasks++;
      pushProgress();
    }
  } catch (e) {
    if (e instanceof DiskFullError) {
      summary.aborted = true;
      summary.ok = false;
      summary.errors.push({ scope: 'disk', error: e.message });
      alertRepo.push({ level: 'error', category: 'storage', title: '磁盘空间不足，同步已暂停', detail: e.message });
      log.error('资产同步', e.message);
    } else {
      summary.ok = false;
      summary.errors.push({ scope: 'sync', error: e.message });
      alertRepo.push({ level: 'error', category: 'sync', title: '影像同步失败', detail: e.message });
      log.error('资产同步', `同步异常: ${e.message}`);
    }
  } finally {
    running = false;
    current.running = false;
    current.currentTask = '';
    current.finishedAt = new Date().toISOString();
    pushProgress();
    if (onProgress) onProgress(current);
  }

  // 同步完成后对无 GPS 影像告警
  if (summary.noGps > 0) {
    alertRepo.push({
      level: 'warn',
      category: 'sync',
      title: `${summary.noGps} 张影像无 GPS 坐标`,
      detail: '需人工在地图上打点，或检查拍摄时设备是否开机',
    });
  }

  return summary;
}
