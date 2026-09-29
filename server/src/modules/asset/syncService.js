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
import { emit } from '../../events.js';
import { assetRepo, syncRepo, alertRepo } from '../../db/repositories/index.js';
import { parseDjiMeta, estimateFootprint } from './djiXmp.js';
import { downloadImage, readLocal, taskDir, DiskFullError } from './downloader.js';
import { generateDerivatives } from './thumbnail.js';

/** 同步运行状态（内存态，一期单机够用） */
let running = false;
/**
 * 暂停 / 终止的控制原语。
 *
 * 设计：同步主体是一个两层 for 循环（架次 → 影像），没有可中断点。
 * 这里用「检查点 + Promise 闸门」实现控制，而不是粗暴 kill：
 *   - checkpoint() 只在安全点（每张影像前、每个架次前）调用，
 *     暂停时 await 一个永不 resolve 的 Promise，直到 resume 才放行；
 *   - 终止时 resolve 成 'stop'，由调用方 break 出循环，已入库的数据全部保留
 *     （下次同步靠 task+media 幂等跳过，不会重复下载）。
 * 这样「暂停」不会把一张图下到一半，也不会丢已经入过库的成果。
 */
let paused = false;
let stopped = false;
let gateResolvers = [];
let stopError = null;

class SyncStopped extends Error {
  constructor() {
    super('同步已被终止');
    this.name = 'SyncStopped';
  }
}

/** 放行所有等待中的检查点（resume 传 'go'，stop 传 'stop'） */
function releaseGate(action) {
  const rs = gateResolvers;
  gateResolvers = [];
  rs.forEach((r) => r(action));
}

/** 同步检查点：暂停时挂起，终止时抛错跳出循环 */
async function checkpoint() {
  if (stopped) throw new SyncStopped();
  if (!paused) return;
  const action = await new Promise((resolve) => {
    gateResolvers.push(resolve);
  });
  if (action === 'stop') throw new SyncStopped();
}

let current = { running: false, paused: false, processedTasks: 0, totalTasks: 0, downloaded: 0, skipped: 0, failed: 0, currentTask: '' };

export function syncStatus() {
  return { ...current };
}

/**
 * 暂停 / 继续 / 终止
 *
 * ⚠️ 暂停状态下 running 仍为 true（只是被挂起，不是结束），
 *    所以 /sync 的「同步进行中」判断要把 paused 也算进去，否则能在暂停期间再起一轮。
 */
export function pauseSync() {
  if (!running) return { ok: false, message: '当前没有正在进行的同步' };
  if (paused) return { ok: false, message: '同步已处于暂停状态' };
  paused = true;
  current.paused = true;
  pushProgress();
  log.warn('资产同步', '已暂停（在当前架次/影像的安全点停下，点「继续」可接着跑）');
  return { ok: true, message: '已暂停' };
}

export function resumeSync() {
  if (!running) return { ok: false, message: '当前没有正在进行的同步' };
  if (!paused) return { ok: false, message: '同步未处于暂停状态' };
  paused = false;
  current.paused = false;
  pushProgress();
  releaseGate('go');
  log.ok('资产同步', '已继续');
  return { ok: true, message: '已继续' };
}

export function stopSync() {
  if (!running) return { ok: false, message: '当前没有正在进行的同步' };
  stopped = true;
  paused = false;
  current.paused = false;
  pushProgress();
  releaseGate('stop');
  log.warn('资产同步', '已终止（已入库的影像保留，下次同步自动跳过）');
  return { ok: true, message: '已终止' };
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

/**
 * 逐个机场拉任务清单并去重合并
 *
 * ⚠️ 实测坑：司空 /flight-task/list 的 sn 是必填且只能传一个，
 *    想在项目级别「全量同步」就必须按机场逐个拉再合并。
 *
 * ⚠️ 另一个坑：某些机场现已离线/被移出项目，但仍曾在该项目飞行过。
 *    逐个拉时若其中一台报 200403，不应中断整批（否则一个坏机场就全盘失败），
 *    记录错误后继续拉其余机场。
 *
 * @returns {Promise<{tasks: object[], perDock: object[], errors: object[]}>}
 */async function fetchAllTasks({ projectUuid, dockSns, beginAt, endAt }) {
  const perDock = [];
  const errors = [];
  const seen = new Set();
  const tasks = [];
  for (const sn of dockSns) {
    try {
      const list = await fetchTasks({ projectUuid, dockSn: sn, beginAt, endAt });
      perDock.push({ dockSn: sn, tasks: list.length });
      for (const t of list) {
        if (!t.uuid || seen.has(t.uuid)) continue;
        seen.add(t.uuid);
        // 记住来源机场：后续入库用各自的 sn，串味会让筛查/统计对不上
        tasks.push({ ...t, _dockSn: sn });
      }
    } catch (e) {
      errors.push({ dockSn: sn, error: e.message });
      log.warn('资产同步', `机场 ${sn} 拉取失败（已跳过继续其它机场）: ${e.message}`);
    }
  }
  return { tasks, perDock, errors };
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

/**
 * 把查询入参归一化成 flight_task.begin_at 的存储格式（ISO UTC 文本）
 *
 * ⚠️ 该表的 begin_at 存的是文本（如 2026-08-04T08:19:34.096212Z），SQL 里做的是文本比较。
 *    若把「秒级时间戳」直接透传进 SQL，数字与文本比较恒为 false（SQLite 中数字 < 文本），
 *    查询静默返回 0 条，表现为「选了日期就一条架次都查不到」。
 *    统一走 toEpoch 归一后，时间戳 / ISO 字符串 / YYYY-MM-DD 三种入参都能正确比较。
 *
 * @returns {string|undefined} 归一化后的 ISO UTC 文本；入参为空或非法时返回 undefined（不参与过滤）
 */
export function toIsoText(v) {
  if (v === undefined || v === null || v === '') return undefined;
  try {
    return new Date(toEpoch(v) * 1000).toISOString();
  } catch {
    return undefined;
  }
}

export async function syncAssets({
  projectUuid,
  dockSn,
  dockSns,
  beginAt,
  endAt,
  downloadImages = true,
  skipEmptyTasks = false,
  limitTasks = 0,
  onProgress,
} = {}) {
  if (running) {
    return { ok: false, message: '同步正在进行中，请勿重复触发' };
  }
  // 时间统一成秒级时间戳（见 toEpoch 说明：不转会静默同步 0 个架次）
  const beginTs = toEpoch(beginAt, 'beginAt');
  const endTs = toEpoch(endAt, 'endAt');
  if (beginTs >= endTs) {
    return { ok: false, message: `beginAt 必须早于 endAt（${beginTs} >= ${endTs}）` };
  }

  /**
   * 机场清单：兼容单个 dockSn 与多个 dockSns。
   * 两者都为空时，回落到「该项目历史同步出过的机场」——项目里明明有数据、
   * 但机场当前不在线/不在设备树里时，不能因为拿不到在线机场就直接判 0 架次。
   */
  const snList = (Array.isArray(dockSns) ? dockSns : dockSns ? [dockSns] : [])
    .concat(dockSn ? [dockSn] : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const docks = [...new Set(snList)];
  const autoFromHistory = docks.length === 0;
  if (autoFromHistory) {
    const known = syncRepo.knownDocks(projectUuid).map((d) => d.dockSn);
    docks.push(...known);
  }
  if (!docks.length) {
    return {
      ok: false,
      message:
        '未指定机场，且该项目下没有任何历史同步记录可推断机场。请至少选择一个机场再同步。',
    };
  }
  running = true;
  paused = false;
  stopped = false;
  gateResolvers = [];
  current = {
    running: true,
    paused: false,
    processedTasks: 0,
    totalTasks: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    emptyTasks: 0,
    emptySkipped: skipEmptyTasks,
    currentTask: '',
    docks: docks.length,
    autoDocks: autoFromHistory,
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
    emptyTasks: 0,
    skipEmptyTasks,
    docks,
    autoDocks: autoFromHistory,
    perDock: [],
    dockErrors: [],
    errors: [],
    aborted: false,
    stopped: false,
  };

  /**
   * 把 summary 的实时计数同步到进度对象
   * ⚠️ 实测缺陷：current.downloaded/skipped/failed 只在初始化时置 0，之后从未累加，
   *    前端同步弹窗的「已下载 / 跳过 / 失败」永远显示 0。这里统一回写。
   */
  const syncCounters = () => {
    current.downloaded = summary.created;
    current.skipped = summary.skipped;
    current.failed = summary.failed;
    current.emptyTasks = summary.emptyTasks;
  };

  try {
    // 1. 任务清单（按机场逐个拉，项目中合集去重）
    const { tasks: all, perDock, errors: dockErrors } = await fetchAllTasks({
      projectUuid,
      dockSns: docks,
      beginAt: beginTs,
      endAt: endTs,
    });
    summary.perDock = perDock;
    summary.dockErrors = dockErrors;
    dockErrors.forEach((e) => summary.errors.push({ dockSn: e.dockSn, error: e.error }));

    const list = limitTasks > 0 ? all.slice(0, limitTasks) : all;
    // 摘要里的 tasks 记最终真正处理的架次数（剔除掉的不再计入）
    current.totalTasks = list.length;
    pushProgress();

    if (!list.length) {
      log.warn('资产同步', '该时间范围内没有飞行任务');
    }

    // 2. 逐架次处理
    for (const t of list) {
      // 检查点：暂停时在这里挂起，终止时在这里跳出（架次级别）
      await checkpoint();
      const taskDockSn = t._dockSn || dockSn || docks[0];
      current.currentTask = t.name || t.uuid;
      pushProgress();

      // 任务入库的公共字段（失败也要留下痕迹便于排查）
      const upsertMeta = {
        uuid: t.uuid,
        projectUuid,
        dockSn: taskDockSn,
        name: t.name,
        taskType: t.task_type,
        status: t.status,
        waylineUuid: t.wayline_uuid,
        beginAt: t.begin_at,
        endAt: t.end_at,
        mediaTotal: 0,
      };

      try {
        const { media, noMedia, error } = await fetchMedia(t.uuid, projectUuid);
        if (error) {
          syncRepo.upsertTask(upsertMeta);
          syncRepo.markTaskSync(t.uuid, { status: 'failed', error });
          summary.failed++;
          syncCounters();
          summary.errors.push({ task: t.name || t.uuid, error });
          log.error('资产同步', `媒体清单拉取失败 ${t.name}: ${error}`);
          continue;
        }

        /**
         * 「自动剔除无图片航线」：媒体清单里没有一条是真正的照片时整条航线不要。
         *
         * 依据：司空会把 FlyToTask_* 定点飞行、纯 PPK 辅助下载等也算成一个架次，
         * 但它们没有任何影像可看——混在列表里既占名额又让审核工作台默认选中空壳。
         * 这里在下载之前就判定，避免白下载一轮再删。
         */
        const photoCount = media.filter((m) => fileTypeOf(m) === 'image').length;
        if (skipEmptyTasks && photoCount === 0) {
          // 同时清掉可能存在的历史空壳记录（存量数据也要一并剔除）
          syncRepo.deleteTask(t.uuid);
          summary.emptyTasks++;
          if (noMedia) summary.noMedia++;
          syncCounters();
          pushProgress();
          log.info(
            '资产同步',
            `${t.name}: 无影像成果（${noMedia ? '无媒体清单' : `仅 ${media.length} 个非图片文件`}），已自动剔除`
          );
          continue;
        }

        syncRepo.upsertTask(upsertMeta);

        if (noMedia) {
          syncRepo.markTaskSync(t.uuid, { status: 'ok' });
          summary.noMedia++;
          log.info('资产同步', `${t.name}: 无航拍成果（可能是 FlyToTask 定点飞行）`);
        } else {
          const shotDate = (t.begin_at || '').slice(0, 10) || 'nodate';
          const dir = await taskDir({ projectUuid, shotDate, taskName: t.name || t.uuid });

          for (const m of media) {
            // 检查点：影像级别。一张图下完才停，绝不把文件写一半
            await checkpoint();
            if (!downloadImages && fileTypeOf(m) === 'image') {
              // 只同步元数据模式：仍解析清单，但不下载
              summary.skipped++;
              syncCounters();
              continue;
            }
            try {
              const r = await processOne(m, { task: t, projectUuid, dockSn: taskDockSn, dir });
              summary.images++;
              if (r.skipped) summary.skipped++;
              else summary.created++;
              if (r.parseStatus === 'no_gps') summary.noGps++;
              if (!r.ok && r.error) {
                summary.failed++;
                summary.errors.push({ image: m.name, error: r.error });
              }
              syncCounters();
              pushProgress();
            } catch (e) {
              if (e instanceof DiskFullError) throw e; // 磁盘不足需中止整批
              summary.failed++;
              summary.errors.push({ image: m.name, error: e.message });
              syncCounters();
              pushProgress();
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
        summary.tasks++;
      } catch (e) {
        // 终止不是失败：不能计进 failed，也不能继续跑下一个架次
        if (e instanceof DiskFullError || e instanceof SyncStopped) throw e;
        summary.failed++;
        syncCounters();
        summary.errors.push({ task: t.name || t.uuid, error: e.message });
        log.error('资产同步', `处理架次失败 ${t.name}: ${e.message}`);
      }

      current.processedTasks++;
      syncCounters();
      pushProgress();
    }
  } catch (e) {
    if (e instanceof SyncStopped) {
      // 用户主动终止：已入库的保留，未处理的留给下次（task+media 幂等，不会重复下载）
      summary.stopped = true;
      // 注意：这里用 current.totalTasks 而不是 list.length —— list 声明在 try 内，catch 里取不到
      log.warn(
        '资产同步',
        `已终止：处理 ${summary.tasks} 个架次，入库 ${summary.created} 张，未处理 ${Math.max(0, current.totalTasks - current.processedTasks)} 个架次`
      );
    } else if (e instanceof DiskFullError) {
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
    // 控制态复位：无论正常结束 / 终止 / 异常，都不能把 paused/stopped 留到下一轮
    running = false;
    paused = false;
    stopped = false;
    releaseGate('stop'); // 兜底放行可能还挂着的检查点，避免协程永久挂起
    current.running = false;
    current.paused = false;
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
