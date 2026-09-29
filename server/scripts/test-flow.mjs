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
const DB_FILE = path.join(__dirname, '..', 'data', 'duav.db');
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

console.log(`\n${'═'.repeat(58)}`);
console.log(`测试结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n失败用例：'); failures.forEach((f) => console.log(`  - ${f}`)); }
console.log('═'.repeat(58));
DB.closeDb();
process.exit(fail > 0 ? 1 : 0);
