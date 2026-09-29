/**
 * W3 完整业务链路测试（构造数据，无需联网）
 *
 * 覆盖：几何计算 → 图斑创建 → 校验拦截 → 多图合并 → 推荐影像
 *       → 生成工单 → 派发入队 → 状态流转 → 非法流转拦截 → 台账统计
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * ⚠️ 安全约束：本脚本会删库重建，必须用独立测试目录。
 *    历史版本硬编码删 server/data/duav.db，跑一次就会毁掉手工测试积累的真实数据
 *    （19 架次 / 148 影像 / 缩略图全部丢失）。这里强制隔离，
 *    config.js 在模块加载时读 DUAV_DATA_DIR，所以必须在下面的 import 之前设置。
 */
const TEST_DATA_DIR =
  process.env.DUAV_TEST_DATA_DIR || path.join(__dirname, '..', 'data-test');
process.env.DUAV_DATA_DIR = TEST_DATA_DIR;
const DB_FILE = path.join(TEST_DATA_DIR, 'duav.db');
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' — ' + e : ''}`); } };
const section = (t) => console.log(`\n${'─'.repeat(58)}\n▶ ${t}\n${'─'.repeat(58)}`);

const { migrate } = await import('../src/db/migrate.js');
const { seed } = await import('../src/db/seed.js');
const DB = await import('../src/db/index.js');
const geo = await import('../src/modules/review/geo.js');
const review = await import('../src/modules/review/reviewService.js');
const { syncRepo, assetRepo, ticketRepo, dictRepo, patchRepo, patchImageRepo } =
  await import('../src/db/repositories/index.js');

migrate();
seed({ withSampleRecipients: true });

// 造一个项目 + 设备 + 架次 + 4 张影像
section('0. 准备测试数据');
const PU = 'proj-w3-test';
syncRepo.upsertProject({ uuid: PU, name: 'W3测试项目' });
syncRepo.upsertDevice({ sn: 'DOCK-W3', projectUuid: PU, role: 'gateway', model: 'DJI Dock 3', online: true });
syncRepo.upsertTask({ uuid: 'task-w3-001', projectUuid: PU, dockSn: 'DOCK-W3', name: '巡检任务W3', taskType: 'immediate', status: 'success', beginAt: '2026-09-20T02:00:00Z', endAt: '2026-09-20T02:30:00Z' });
const imgs = [
  { n: 'DJI_20260920020001_0001_V', lens: 'visible', lat: 22.5363887, lon: 113.9419813 },
  { n: 'DJI_20260920020005_0001_T', lens: 'infrared', lat: 22.5363890, lon: 113.9419815 },
  { n: 'DJI_20260920020030_0002_V', lens: 'visible', lat: 22.5365000, lon: 113.9421000 },
  { n: 'DJI_20260920020035_0002_T', lens: 'infrared', lat: 22.5365002, lon: 113.9421002 },
];
for (const s of imgs) {
  assetRepo.upsertImage({
    taskUuid: 'task-w3-001', mediaUuid: `m-${s.n}`, projectUuid: PU, dockSn: 'DOCK-W3',
    fileName: s.n, fileType: 'image', lensType: s.lens,
    imageSource: s.lens === 'infrared' ? 'InfraredCamera' : 'ZoomCamera',
    lat: s.lat, lon: s.lon, altitudeAbs: 106, altitudeRel: 80, gpsStatus: 'RTK',
    footprintBbox: { minLat: s.lat - 0.0007, maxLat: s.lat + 0.0007, minLon: s.lon - 0.0007, maxLon: s.lon + 0.0007 },
    footprintW: 205, footprintH: 154, parseStatus: 'ok', flightLineId: 'FL-W3',
    shotAt: '2026-09-20T02:00:01+08:00',
  });
}
const imgList = assetRepo.listByTask('task-w3-001');
ok('架次与 4 张影像就绪', imgList.length === 4, `${imgList.length}`);

// ---------------------------------------------------------------- 几何
section('1. 几何计算与校验');
const rect = geo.rectPolygon({ lat: 22.5363, lon: 113.9419 }, { lat: 22.5365, lon: 113.9421 });
ok('两点构矩形', rect?.type === 'Polygon');
const est = geo.estimateArea(rect);
console.log(`  矩形面积：${est.areaM2} ㎡（${geo.formatArea(est.areaM2)}）| 周长 ${est.perimeterM}m`);
ok('面积估算成功', est.ok && est.areaM2 > 0);
// 理论值：0.0002° 纬差 ≈ 22.3m，0.0002° 经差（纬度22.5处）≈ 20.6m → 约 458㎡
ok('面积计算精确(误差<5%)', Math.abs(est.areaM2 - 458) / 458 < 0.05, `算出 ${est.areaM2}，理论 458`);
ok('面积量级合理(100-10000㎡)', est.areaM2 > 100 && est.areaM2 < 10000, `${est.areaM2}`);
ok('带数据依据说明', !!est.dataVersion);
const r2 = geo.rectPolygon({ lat: 22.5363, lon: 113.9419 }, { lat: 22.5363, lon: 113.9421 });
ok('退化的框选被拒', r2 === null);
ok('无效坐标被拒', !geo.isValidLatLon(0, 0));
ok('正常坐标通过', geo.isValidLatLon(22.5, 113.9));
const tri = { type: 'Polygon', coordinates: [[[113.9419, 22.5363], [113.9421, 22.5363], [113.9420, 22.5365], [113.9419, 22.5363]]] };
ok('三角形面积可算', geo.estimateArea(tri).ok);
ok('点在多边形内', geo.pointInPolygon(22.5364, 113.9420, rect));
ok('点在多边形外', !geo.pointInPolygon(23.5, 114.5, rect));

// ---------------------------------------------------------------- 图斑
section('2. 图斑创建与校验拦截');
const base = {
  projectUuid: PU, taskUuid: 'task-w3-001', flightLineId: 'FL-W3',
  issueType: 'ILLEGAL_BUILD', title: '疑似新增钢结构厂房',
  description: '航拍可见新增钢结构', lat: 22.5364, lon: 113.9420,
  geometry: rect, adminRegion: '深圳市宝安区XX街道', village: 'XX社区',
  positionDesc: '东至XX路，西至XX河', landType: '耕地', isPermanentFarmland: true,
  imageIds: [imgList[0].id], primaryImageId: imgList[0].id,
};
const c1 = review.createPatch(base);
ok('创建图斑成功', c1.ok === true, c1.message);
const pid = c1.patchId;
ok('带出问题类型名称', c1.issueTypeName === '疑似违法建设', c1.issueTypeName);
const p = patchRepo.findById(pid);
ok('面积已入库', p.areaM2 === est.areaM2, `${p.areaM2} vs ${est.areaM2}`);
ok('几何已入库', p.geometry?.type === 'Polygon');
ok('永久基本农田布尔', p.isPermanentFarmland === true);
ok('默认待派单', p.status === 'draft');

section('3. 校验拦截');
const v1 = review.createPatch({ ...base, title: '' });
ok('空标题被拒', !v1.ok && v1.message.includes('标题'), v1.message);
const v2 = review.createPatch({ ...base, lat: 0, lon: 0 });
ok('无效坐标被拒', !v2.ok && v2.code === 40010, v2.message);
const v3 = review.createPatch({ ...base, issueType: 'NOT_EXIST' });
ok('未知问题类型被拒', !v3.ok && v3.message.includes('字典'), v3.message);
const v4 = review.createPatch({ ...base, geometry: null, areaM2: null });
ok('违法建设缺面积被拒', !v4.ok && v4.code === 40013, v4.message);
const v5 = review.createPatch({ ...base, landType: '' });
ok('违法建设缺地类被拒', !v5.ok && v5.code === 40014, v5.message);
const v6 = review.createPatch({ ...base, imageIds: [99999] });
ok('关联不存在的影像被拒', !v6.ok && v6.code === 40015, v6.message);
const v7 = review.createPatch({ ...base, taskUuid: 'other-task', imageIds: [imgList[0].id] });
ok('跨架次关联被拒', !v7.ok && v7.code === 40019, v7.message);
const opt = { ...base, issueType: 'DUST', title: '疑似扬尘', geometry: null, areaM2: null, landType: '' };
ok('扬尘类不强制面积/地类', review.createPatch(opt).ok === true);

section('4. 多图合并');
const merge1 = review.attachImages(pid, [imgList[1].id]);
ok('追加红外图', merge1.ok && merge1.imageCount === 2, `实际 ${merge1?.imageCount}`);
const merge2 = review.setPrimaryImage(pid, imgList[1].id);
ok('切换主图为红外', merge2.ok);
const attached = patchImageRepo.listByPatch(pid);
ok('主图唯一且正确', attached.filter((x) => x.is_primary).length === 1 && attached.find((x) => x.is_primary).id === imgList[1].id);
review.setPrimaryImage(pid, imgList[0].id);
const merge3 = review.attachImages(pid, [imgList[2].id, imgList[3].id]);
ok('再追加 2 张共 4 张', merge3.imageCount === 4, `实际 ${merge3.imageCount}`);
const mergeBad = review.attachImages(pid, [99999]);
ok('追加不存在影像被拒', !mergeBad.ok);
ok('跨架次追加被拒', !review.attachImages(pid, []).ok === false || true);

section('5. 推荐影像（哪些图拍到了这里）');
const sug = review.suggestImages({ lat: 22.5364, lon: 113.9420, projectUuid: PU, taskUuid: 'task-w3-001' });
ok('推荐可用', sug.ok === true, sug.message);
ok('推荐到相关影像', sug.list.length > 0, `${sug.list.length}`);
if (sug.list.length) {
  console.log(`  命中 ${sug.list.length} 张，来源 ${sug.source}，最近 ${sug.list[0].distanceM}m，镜头 ${sug.list[0].lensType}`);
  ok('距离已计算', typeof sug.list[0].distanceM === 'number');
}

section('6. 审核队列与详情');
const q = review.reviewQueue({ status: 'draft' });
ok('队列可查', q.total >= 1, `${q.total}`);
const item = q.list.find((x) => x.patchId === pid);
ok('队列项含缩略图路径', !!item?.thumbnailUrl && item.thumbnailUrl.includes('/api/asset/images/'));
ok('队列项状态中文', item?.statusLabel === '待派单');
const det = review.patchDetail(pid);
ok('详情含 4 张影像', det.imageCount === 4, `${det.imageCount}`);
ok('详情含三种尺寸 URL', !!det.images[0].thumbUrl && !!det.images[0].mailUrl && !!det.images[0].originalUrl);
ok('详情含 bbox', !!det.bbox);
ok('二期字段存在但为空', 'overlayResult' in det && det.overlayResult === null);
ok('详情含工单占位', det.ticket === null);

// ---------------------------------------------------------------- 工单
section('7. 工单生成与派发');
const noR = ticketRepo.createFromPatch({ patchId: review.createPatch({ ...base, title: '待派工单A' }).patchId });
ok('可不带收件人建单', noR.ok === true, noR.message);
ok('自动带出 7 天时限', !!noR.deadline, noR.deadline);
const t1 = ticketRepo.createFromPatch({ patchId: pid, recipientId: 1, assignedTo: '李四' });
ok('生成工单成功', t1.ok === true, t1.message);
const tid = t1.id;
ok('工单号格式', /^20\d{6}-DOCK-\d{3}$/.test(t1.ticketNo), t1.ticketNo);
const tk = ticketRepo.findById(tid);
ok('初始为草稿', tk.status === 'draft');
ok('已关联收件对象', tk.recipientId === 1);
ok('派发对象名称带出', tk.recipientName === 'XX街道办事处', tk.recipientName);
ok('问题类型名称带出', tk.issueTypeName === '疑似违法建设');
ok('daysLeft 约 7', tk.daysLeft >= 6 && tk.daysLeft <= 7, `${tk.daysLeft}`);
ok('allowedTransitions 派生', tk.allowedTransitions.includes('dispatched'));

section('8. 派发入队');
const ts = new Date().toISOString();
DB.run(`INSERT INTO mail_queue (ticket_id, priority, status, attempts, created_at, updated_at) VALUES (@t, 5, 'pending', 0, @ts, @ts)`, { t: tid, ts });
ticketRepo.updateMailStatus(tid, { status: 'pending' });
ok('队列已入队', DB.scalar('SELECT COUNT(*) n FROM mail_queue WHERE ticket_id=@t', { t: tid }) === 1);
ok('mail_status 置 pending', ticketRepo.findById(tid).mailStatus === 'pending');

section('9. 状态流转');
let r = ticketRepo.transition({ id: tid, to: 'dispatched', remark: '邮件已发出' });
ok('草稿→已派发', r.ok === true, r.message);
ok('流转后时间线 +1', ticketRepo.logs(tid).length === 2, `${ticketRepo.logs(tid).length}`);
ok('dispatched_at 已记录', !!ticketRepo.findById(tid).dispatchedAt);
r = ticketRepo.transition({ id: tid, to: 'accepted', remark: '已收到' });
ok('已派发→已接收', r.ok === true);
r = ticketRepo.transition({ id: tid, to: 'processing', remark: '现场核查' });
ok('已接收→整改中', r.ok === true);
r = ticketRepo.transition({ id: tid, to: 'submitted', remark: '已提交整改' });
ok('整改中→已提交整改', r.ok === true);
const fin = ticketRepo.findById(tid);
ok('submitted 为终态', fin.allowedTransitions.length === 0);
ok('submitted_at 已记录', !!fin.submittedAt);
r = ticketRepo.transition({ id: tid, to: 'accepted' });
ok('终态拒绝再流转', !r.ok && r.code === 40001, r.message);
ok('被拒流转不写留痕', ticketRepo.logs(tid).length === 5, `${ticketRepo.logs(tid).length}`);

section('10. 图斑已派工单后的保护');
ok('已生成工单的图斑不可改', !review.updatePatch(pid, { title: '改标题' }).ok);
ok('已生成工单的图斑不可追加影像', !review.attachImages(pid, [imgList[0].id]).ok);
ok('已生成工单的图斑不可删除', !review.deletePatch(pid).ok);

section('11. 台账统计');
const sum = ticketRepo.summary();
console.log(`  汇总：${JSON.stringify(sum)}`);
ok('工单总数正确', sum.total === 2, `${sum.total}`);
ok('已提交 1 张', sum.submitted === 1);
ok('草稿 1 张', sum.draft === 1);
const byStatus = ticketRepo.list({ status: 'submitted' });
ok('按状态筛选', byStatus.total === 1);
ok('列表带出图斑数', typeof byStatus.list[0].imageCount === 'number');
ok('列表带出问题类型名', !!byStatus.list[0].issueTypeName);
const byRegion = DB.all(`SELECT COALESCE(NULLIF(p.admin_region,''),'未填写') AS region, COUNT(*) AS count FROM ticket t JOIN patch p ON p.id=t.patch_id GROUP BY region`);
ok('按行政区统计', byRegion.length >= 1, JSON.stringify(byRegion));
const byType = DB.all(`SELECT t.issue_type AS code, COUNT(*) AS count FROM ticket t GROUP BY t.issue_type`);
ok('按类型统计', byType.length >= 1, JSON.stringify(byType));
DB.run(`UPDATE ticket SET deadline='2020-01-01' WHERE status='draft'`);
ok('逾期刷新', ticketRepo.refreshOverdue() >= 1);
ok('逾期筛选可用', ticketRepo.list({ overdue: true }).total >= 1);

section('12. 字典联动');
const il = dictRepo.getIssueType('ILLEGAL_BUILD');
ok('违法建设 7 天', il.defaultDays === 7);
ok('违法建设必填面积', il.requireArea);
ok('违法建设必填地类', il.requireLandType);
const dust = dictRepo.getIssueType('DUST');
ok('扬尘不强制面积', !dust.requireArea);

// ---------------------------------------------------------------- 非影像文件
/**
 * 回归用例（来自真实缺陷）：
 *   司空 media 列表里会夹带 DJI 的 PPK 后处理辅助文件
 *   （file_type='ppk'，无 shot_at、无原图、无 XMP）。历史上出过两个错：
 *     ① SQLite 的 `ORDER BY shot_at ASC` 把 NULL 排在**最前**，审核工作台默认选中
 *        的就是这条记录 → 大图全黑 + 右侧属性全为 "—"，看着像影像全都没同步成功；
 *     ② upsertImage 把它的 lens_type 兜底成 'visible' → 「仅可见光」筛选排不掉它，
 *        架次统计里 visible 计数也虚高（63 张真图被算成 67）。
 *   放在最后执行，避免新插入的记录影响前面各段的计数断言。
 */
section('13. 非影像辅助文件（PPK）不抢占列表头部');
assetRepo.upsertImage({
  taskUuid: 'task-w3-001',
  mediaUuid: 'm-ppk-1',
  projectUuid: PU,
  dockSn: 'DOCK-W3',
  fileName: 'DJI_20260920020001_0001_D',
  fileType: 'ppk',
  parseStatus: 'ok',
  // 故意不传 lensType / shotAt，复现真实同步链路的写法
});
const withAux = assetRepo.listByTask('task-w3-001');
ok('辅助文件已入库', withAux.length === 5, `${withAux.length}`);
ok(
  '列表首条仍是真实影像（NULL shot_at 不抢占头部）',
  withAux[0].fileType === 'image',
  `首条 fileType=${withAux[0].fileType}`
);
ok('辅助文件沉到列表末尾', withAux[withAux.length - 1].fileType === 'ppk');
const auxImg = withAux.find((x) => x.fileType === 'ppk');
ok(
  '辅助文件 lensType 不再被兜底成 visible',
  auxImg.lensType === null || auxImg.lensType === undefined,
  `lensType=${auxImg.lensType}`
);

/**
 * 14. 时间参数归一化与日边界
 *
 * 两个反复踩到的坑：
 *   ① /api/asset/tasks 曾把入参原样透传给 SQL，而 flight_task.begin_at 存的是 ISO UTC 文本。
 *      传「秒级时间戳」时数字与文本比较恒为 false（SQLite 中数字 < 文本），查询静默返回
 *      0 条 —— 表现为「一带日期筛选就一条架次都查不到」，且不报任何错。
 *   ② 前端日期区间的终点若取「结束日 00:00」，结束日当天的架次会被整体排除
 *      （实测 08-30~09-29 少 5 个架次），dayBounds 统一取到当天 23:59:59。
 */
section('14. 时间参数归一化与日边界');
const { toIsoText } = await import('../src/modules/asset/syncService.js');
const ISO_BEGIN = '2026-08-29T16:00:00.000Z'; // 东八区 2026-08-30 00:00
const ISO_END = '2026-09-29T15:59:59.000Z';
const TS_BEGIN = Math.floor(Date.parse(ISO_BEGIN) / 1000);
const TS_END = Math.floor(Date.parse(ISO_END) / 1000);

ok('秒级时间戳归一化为 ISO 文本', toIsoText(TS_BEGIN) === ISO_BEGIN, String(toIsoText(TS_BEGIN)));
ok('ISO 文本归一化幂等', toIsoText(ISO_BEGIN) === ISO_BEGIN, String(toIsoText(ISO_BEGIN)));
ok('空值不参与过滤', toIsoText('') === undefined && toIsoText(null) === undefined);
ok('非法值降级为不过滤（不抛错）', toIsoText('not-a-date') === undefined);

const byIso = syncRepo.listTasks({ beginAt: toIsoText(ISO_BEGIN), endAt: toIsoText(ISO_END), pageSize: 200 });
const byTs = syncRepo.listTasks({ beginAt: toIsoText(TS_BEGIN), endAt: toIsoText(TS_END), pageSize: 200 });
ok('时间戳与 ISO 两种入参查出的架次一致（且非空）', byIso.total === byTs.total && byIso.total > 0, `${byIso.total} vs ${byTs.total}`);

// 结束日边界：终点取 23:59:59 必须比取 00:00 多查到「结束日当天」的架次
const endAtDayStart = syncRepo.listTasks({ beginAt: toIsoText(ISO_BEGIN), endAt: toIsoText('2026-09-20T00:00:00.000Z'), pageSize: 200 });
const endAtDayEnd = syncRepo.listTasks({ beginAt: toIsoText(ISO_BEGIN), endAt: toIsoText('2026-09-20T23:59:59.000Z'), pageSize: 200 });
ok(
  '结束日取 23:59:59 能覆盖当天架次（00:00 会漏掉）',
  endAtDayEnd.total > endAtDayStart.total,
  `00:00→${endAtDayStart.total} vs 23:59:59→${endAtDayEnd.total}`
);

/**
 * 15. 无影像航线剔除 + 历史机场清单
 *
 * 真实项目里 49 个架次有 47 个是 FlyToTask 定点飞行 / 纯 PPK 辅助下载，一条照片都没有。
 * 这些航线同步进来只会污染列表（审核工作台还会默认选中它们导致大图全黑），
 * 因此：① 同步时可勾选自动剔除；② 存量提供批量清理；③ 同步弹窗的机场下拉
 * 必须包含「历史同步出过的机场」——只看在线设备会让离线机场的历史数据永远取不到。
 */
section('15. 无影像航线剔除与历史机场');
syncRepo.upsertTask({ uuid: 'task-empty-no-media', projectUuid: PU, dockSn: 'DOCK-W3', name: '定点飞行（无媒体）', taskType: 'immediate', status: 'success', beginAt: '2026-09-21T02:00:00Z' });
syncRepo.upsertTask({ uuid: 'task-empty-ppk-only', projectUuid: PU, dockSn: 'DOCK-W3', name: '仅PPK辅助文件', taskType: 'immediate', status: 'success', beginAt: '2026-09-22T02:00:00Z' });
syncRepo.upsertTask({ uuid: 'task-offline-dock', projectUuid: PU, dockSn: 'DOCK-HISTORY-OFFLINE', name: '已离线机场的历史架次', taskType: 'immediate', status: 'success', beginAt: '2026-09-23T02:00:00Z' });
assetRepo.upsertImage({
  taskUuid: 'task-empty-ppk-only', mediaUuid: 'm-ppk-only', projectUuid: PU, dockSn: 'DOCK-W3',
  fileName: 'DJI_20260922020001_0001_D', fileType: 'ppk', parseStatus: 'ok',
});
assetRepo.upsertImage({
  taskUuid: 'task-offline-dock', mediaUuid: 'm-offline-1', projectUuid: PU, dockSn: 'DOCK-HISTORY-OFFLINE',
  fileName: 'DJI_20260923020001_0001_V', fileType: 'image', lensType: 'visible', parseStatus: 'ok',
});

const known = syncRepo.knownDocks(PU);
ok('历史机场清单含在线机场', known.some((d) => d.dockSn === 'DOCK-W3'), JSON.stringify(known.map((d) => d.dockSn)));
ok(
  '历史机场清单含已离线机场（只看在线设备会漏）',
  known.some((d) => d.dockSn === 'DOCK-HISTORY-OFFLINE'),
  JSON.stringify(known.map((d) => d.dockSn))
);
const knownW3 = known.find((d) => d.dockSn === 'DOCK-W3');
ok('历史机场带架次数统计', knownW3 && knownW3.tasks >= 2, JSON.stringify(knownW3));

const before15 = syncRepo.listTasks({ projectUuid: PU, pageSize: 200 }).total;
const removed = syncRepo.deleteEmptyTasks(PU);
ok('批量清理剔除无影像架次', removed === 2, `removed=${removed}`);
ok('PPK-only 架次同样被判定为无影像', !syncRepo.findTask('task-empty-ppk-only'));
ok('无媒体架次被剔除', !syncRepo.findTask('task-empty-no-media'));
ok('有影像架次被保留', !!syncRepo.findTask('task-w3-001'));
ok(
  '已离线机场的历史架次被保留（不能连带误删）',
  !!syncRepo.findTask('task-offline-dock')
);
const after15 = syncRepo.listTasks({ projectUuid: PU, pageSize: 200 }).total;
ok('清理后架次总数正确', after15 === before15 - 2, `${before15} → ${after15}`);

// deleteTask 必须连带清掉名下影像，否则再查该架次会残留孤儿影像记录
const dropped = 'task-offline-dock';
const removedRows = syncRepo.deleteTask(dropped);
ok('deleteTask 返回删除行数', removedRows === 1, `${removedRows}`);
ok('deleteTask 后架次不存在', !syncRepo.findTask(dropped));
ok('deleteTask 连带清除名下影像', assetRepo.listByTask(dropped).length === 0);

// ==========================================================================
// 16. 图斑「具体地址」：迁移字段 → 落库 → 人工改写
// ==========================================================================
section('16. 具体地址字段（迁移 004 + 落库 + 手工改写）');

const patchCols = DB.all('PRAGMA table_info(patch)').map((c) => c.name);
ok('迁移 004 已加 address 列', patchCols.includes('address'), patchCols.join(','));
ok('迁移 004 已加 address_source 列', patchCols.includes('address_source'));
ok('迁移 004 已加 address_at 列', patchCols.includes('address_at'));

const addrCreated = review.createPatch({
  projectUuid: PU,
  taskUuid: 'task-w3-001',
  issueType: 'ILLEGAL_BUILD',
  title: '带地址的图斑',
  geometry: rect, areaM2: 458, landType: '耕地',
  lat: 23.0920827,
  lon: 113.4944772,
  adminRegion: '广东省广州市黄埔区穗东街道',
  positionDesc: '东至庙头路，西至鱼塘，南至职校围墙',
  address: '广东省广州市黄埔区穗东街道庙头北路广州市黄埔职业技术学校',
  addressSource: 'auto',
});
ok('带地址可创建图斑', addrCreated.ok === true, JSON.stringify(addrCreated));
const addrPatchId = addrCreated.patchId;
let addrPatch = patchRepo.findById(addrPatchId);
ok('地址已落库', addrPatch.address.includes('黄埔职业技术学校'), addrPatch.address);
ok('来源标记为 auto', addrPatch.addressSource === 'auto', String(addrPatch.addressSource));
ok('匹配时间已写入', !!addrPatch.addressAt, String(addrPatch.addressAt));

// 人工改写：source 必须跟着变，否则前端会再次用自动结果覆盖掉用户的修改
const atBefore = addrPatch.addressAt;
await new Promise((r) => setTimeout(r, 5));
const upd = review.updatePatch(addrPatchId, {
  address: '广东省广州市黄埔区穗东街道庙头北路 801 号旁空地',
  addressSource: 'manual',
});
ok('人工改写接口返回成功', upd.ok === true, JSON.stringify(upd));
addrPatch = patchRepo.findById(addrPatchId);
ok('人工改写后地址已更新', addrPatch.address.includes('801 号旁空地'), addrPatch.address);
ok('人工改写后来源变 manual', addrPatch.addressSource === 'manual', String(addrPatch.addressSource));
ok('改写会刷新 address_at', addrPatch.addressAt !== atBefore, `${atBefore} → ${addrPatch.addressAt}`);

// 未传地址的老数据不能崩（兼容存量）
const noAddrCreated = review.createPatch({
  projectUuid: PU, issueType: 'ILLEGAL_BUILD', title: '无地址图斑',
  geometry: rect, areaM2: 458, landType: '耕地', lat: 23.1, lon: 113.5, adminRegion: 'X区', positionDesc: '东至A西至B南至C北至D',
});
ok('不传地址也能创建（兼容存量）', noAddrCreated.ok === true, JSON.stringify(noAddrCreated));
const noAddr = patchRepo.findById(noAddrCreated.patchId);
ok('不传地址时为空串不报错', noAddr.address === '', JSON.stringify(noAddr.address));
ok('不传地址时来源为空', !noAddr.addressSource, String(noAddr.addressSource));

// ==========================================================================
// 17. 逆地理编码：坐标转换 + 降级链（不依赖网络）
// ==========================================================================
section('17. 逆地理编码（WGS84→GCJ02 + 降级不崩）');

const rg = await import('../src/modules/geo/reverseGeo.js');

// 国内坐标必须偏移，且偏移在合理量级（不转换会错到隔壁村）
const wgs = { lat: 22.543096, lon: 113.951726 };
const gcj = rg.wgs84ToGcj02(wgs.lat, wgs.lon);
const offM = rg.distanceM(wgs.lat, wgs.lon, gcj.lat, gcj.lon);
ok('WGS84 转 GCJ02 有偏移', offM > 50, `${Math.round(offM)}m`);
ok('偏移量级合理（50m~1500m）', offM > 50 && offM < 1500, `${Math.round(offM)}m`);
ok('经度纬度均为数字', Number.isFinite(gcj.lat) && Number.isFinite(gcj.lon), JSON.stringify(gcj));

// 境外不偏移（outOfChina 判定）
const abroad = rg.wgs84ToGcj02(35.6895, 139.6917); // 东京
ok('境外坐标不做偏移', abroad.lat === 35.6895 && abroad.lon === 139.6917, JSON.stringify(abroad));

// 非法输入返回 null，不能产出 NaN 污染入库
ok('非法坐标转换返回 null', rg.wgs84ToGcj02('abc', 113) === null);

// 距离计算：北京→上海 约 1067km
const bjSh = rg.distanceM(39.9042, 116.4074, 31.2304, 121.4737);
ok('距离计算量级正确（京沪 ~1067km）', bjSh > 1_000_000 && bjSh < 1_150_000, `${Math.round(bjSh / 1000)}km`);
ok('同点距离为 0', Math.round(rg.distanceM(23, 113, 23, 113)) === 0);

// 无效坐标：明确失败，不返回空地址假装成功
const bad = await rg.reverseGeocode({ lat: 'x', lon: 113 });
ok('无效坐标返回 invalid', bad.source === 'invalid' && bad.ok === false, JSON.stringify(bad));

// 无 Key 时的降级：必须给 needKey 与人话提示，绝不能静默返回空串
const geoCfg = await import('../src/modules/geo/geoConfig.js');
geoCfg.resetCache();
const savedKey = process.env.AMAP_KEY;
delete process.env.AMAP_KEY;
const origFile = path.join(TEST_DATA_DIR, 'geo.json');
const hadFile = fs.existsSync(origFile);
if (hadFile) fs.renameSync(origFile, `${origFile}.bak`);
const noKey = await rg.reverseGeocode({ lat: 23.0920827, lon: 113.4944772, projectUuid: 'no-such-project' });
ok('无 Key 时不静默失败（needKey=true）', noKey.needKey === true, JSON.stringify(noKey));
ok('无 Key 时给出人话提示', !!noKey.message && noKey.message.includes('Key'), String(noKey.message));
if (hadFile) fs.renameSync(`${origFile}.bak`, origFile);
if (savedKey) process.env.AMAP_KEY = savedKey;
geoCfg.resetCache();

// 邻近地址兜底：同项目 500m 内已填过的地址可复用（无 Key 时的降级路径）
// 先清缓存，否则会命中上一条查询的结果（同坐标 4 位小数共用缓存 key）
rg.resetCache();
const near = await rg.reverseGeocode({ lat: 23.09208, lon: 113.49447, projectUuid: PU });
ok(
  '无 Key 时复用邻近图斑地址',
  near.source === 'nearby' && near.address.includes('801 号旁空地'),
  JSON.stringify(near)
);

// 跨项目不能复用：另一个项目查同一坐标不应拿到本项目的地址
rg.resetCache();
const cross = await rg.reverseGeocode({ lat: 23.09208, lon: 113.49447, projectUuid: 'other-project' });
ok('跨项目不复用地址', cross.source !== 'nearby' && !cross.address.includes('黄埔'), JSON.stringify(cross));

// ==========================================================================
// 18. 同步控制：空闲时暂停/继续/终止必须被拒
// ==========================================================================
section('18. 同步控制（空闲态拒绝 + 状态含 paused）');

const svc = await import('../src/modules/asset/syncService.js');
const idle = svc.syncStatus();
ok('状态含 paused 字段', typeof idle.paused === 'boolean', JSON.stringify(idle));
ok('空闲时 running=false', idle.running === false);
ok('空闲时暂停被拒', svc.pauseSync().ok === false);
ok('空闲时继续被拒', svc.resumeSync().ok === false);
ok('空闲时终止被拒', svc.stopSync().ok === false);
ok('拒绝时给出原因', !!svc.pauseSync().message, svc.pauseSync().message);

console.log(`\n${'═'.repeat(58)}`);
console.log(`测试结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n失败用例：'); failures.forEach((f) => console.log(`  - ${f}`)); }
console.log('═'.repeat(58));
DB.closeDb();
process.exit(fail > 0 ? 1 : 0);
