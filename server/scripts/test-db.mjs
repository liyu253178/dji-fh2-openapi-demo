/**
 * db 模块端到端自测
 *
 * 运行：node scripts/test-db.mjs
 *
 * 覆盖：建库 → 迁移 → 种子 → 影像入库 → 配对 → 图斑 → 工单 → 状态机
 *       → 非法流转拒绝 → 逾期 → 统计 → 告警
 *
 * 用法：会重建 data/duav.db（仅测试环境安全）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'data', 'duav.db');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(60)}\n▶ ${title}\n${'─'.repeat(60)}`);
}

// 清理测试库
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log('🧹 已清理旧测试库');

const { migrate, schemaInfo } = await import('../src/db/migrate.js');
const { seed, dictReady } = await import('../src/db/seed.js');
const DB = await import('../src/db/index.js');
const { syncRepo, assetRepo, dictRepo, alertRepo, patchRepo, patchImageRepo, ticketRepo, canTransit, TICKET_STATUS } =
  await import('../src/db/repositories/index.js');

// ---------------------------------------------------------------- 1. 建库
section('1. 建库与迁移');
const mig = migrate();
ok('基线迁移执行', mig.baseline > 0, `baseline=${mig.baseline}`);
ok('版本已记录', mig.versions === 1);
const info = schemaInfo();
ok('表数量 = 14', info.tableCount === 14, `实际 ${info.tableCount}`);
ok('索引数量 >= 26', info.indexCount >= 26, `实际 ${info.indexCount}`);

section('2. 迁移幂等性');
const before = DB.scalar('SELECT COUNT(*) AS n FROM schema_version');
migrate();
migrate();
const after = DB.scalar('SELECT COUNT(*) AS n FROM schema_version');
ok('重复执行不新增版本记录', before === after, `${before} -> ${after}`);

// ---------------------------------------------------------------- 3. 种子
section('3. 种子数据');
const s1 = seed();
ok('首次插入 8 个问题类型', s1.issueTypes === 8, `实际 ${s1.issueTypes}`);
ok('首次插入 3 个派发对象', s1.recipients === 3, `实际 ${s1.recipients}`);
const s2 = seed();
ok('二次执行不重复插入', s2.issueTypes === 0 && s2.recipients === 0, JSON.stringify(s2));
const ready = dictReady();
ok('字典就绪 (8 类型 / 3 对象)', ready.issueTypes === 8 && ready.recipients === 3, JSON.stringify(ready));
const il = dictRepo.getIssueType('ILLEGAL_BUILD');
ok('违法建设默认 7 天', il.defaultDays === 7);
ok('违法建设必填面积与地类', il.requireArea && il.requireLandType);

// ---------------------------------------------------------------- 4. 司空同步缓存
section('4. 司空同步缓存');
syncRepo.upsertProject({ uuid: 'proj-test-001', name: '金华威', lat: 22.53, lng: 113.94 });
syncRepo.upsertProject({ uuid: 'proj-test-001', name: '金华威(改名)', lat: 22.53, lng: 113.94 });
ok('项目 upsert 不重复', DB.scalar('SELECT COUNT(*) AS n FROM project') === 1);
ok('项目名已更新', syncRepo.listProjects()[0].name === '金华威(改名)');

syncRepo.upsertDevice({ sn: 'DOCK-TEST-01', projectUuid: 'proj-test-001', role: 'gateway', model: 'DJI Dock 3', callsign: '测试机场', online: true, cameraList: [{ cameraIndex: '165-0-7', position: 'indoor' }] });
syncRepo.upsertDevice({ sn: 'DRONE-TEST-01', projectUuid: 'proj-test-001', role: 'drone', model: 'Matrice 4TD', online: false, cameraList: null });
const devs = syncRepo.listDevices('proj-test-001');
ok('设备入库 2 台', devs.length === 2, `实际 ${devs.length}`);
ok('飞行器离线时 camera_list 为 NULL', devs.find((d) => d.role === 'drone').camera_list === null);

syncRepo.upsertTask({ uuid: 'task-test-001', projectUuid: 'proj-test-001', dockSn: 'DOCK-TEST-01', name: '巡检任务', taskType: 'immediate', status: 'terminated', beginAt: '2026-07-14T06:43:05Z', endAt: '2026-07-14T06:47:01Z', mediaTotal: 4 });
ok('任务入库', !!syncRepo.findTask('task-test-001'));
syncRepo.markTaskSync('task-test-001', { status: 'ok', mediaTotal: 4, flightLineId: 'FL-test-01' });
ok('任务同步状态与架次已更新', syncRepo.findTask('task-test-001').flight_line_id === 'FL-test-01');

// ---------------------------------------------------------------- 5. 影像入库（模拟 XMP 解析结果）
section('5. 影像资产（模拟 XMP 解析结果）');
// 复用真实实测数据：4 张，2 组红外/可见光配对
const samples = [
  { n: 'DJI_20260714140727_0001_V', lens: 'visible', src: 'ZoomCamera', lat: 22.5363887, lon: 113.9419813, g: -44.4 },
  { n: 'DJI_20260714140727_0001_T', lens: 'infrared', src: 'InfraredCamera', lat: 22.5363889, lon: 113.9419827, g: -44.4 },
  { n: 'DJI_20260714140751_0004_V', lens: 'visible', src: 'ZoomCamera', lat: 22.5363656, lon: 113.9411150, g: -32.6 },
  { n: 'DJI_20260714140751_0004_T', lens: 'infrared', src: 'InfraredCamera', lat: 22.5363667, lon: 113.9411142, g: -32.6 },
];
let created = 0;
for (const s of samples) {
  const r = assetRepo.upsertImage({
    taskUuid: 'task-test-001',
    mediaUuid: `media-${s.n}`,
    projectUuid: 'proj-test-001',
    dockSn: 'DOCK-TEST-01',
    fileName: s.n,
    fileSize: 4550000,
    filePath: `assets/test/${s.n}`,
    thumbPath: `preview/${s.n}.jpg`,
    mailPath: `mail-attach/${s.n}.jpg`,
    fileType: 'image',
    lensType: s.lens,
    imageSource: s.src,
    lat: s.lat,
    lon: s.lon,
    altitudeAbs: 106.387,
    altitudeRel: 79.978,
    gpsStatus: 'RTK',
    footprintBbox: { minLat: s.lat - 0.0007, maxLat: s.lat + 0.0007, minLon: s.lon - 0.0007, maxLon: s.lon + 0.0007 },
    footprintW: 205.8,
    footprintH: 154.4,
    isNadir: false,
    gimbalPitch: s.g,
    droneSn: 'DRONE-TEST-01',
    cameraSn: 'CAM-TEST-001',
    droneModel: 'M4TD',
    flightLineId: 'FL-test-01',
    shotAt: s.n.slice(4, 22).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00'),
    parseStatus: 'ok',
  });
  if (r.created) created++;
}
ok('首次入库 4 张', created === 4, `实际 ${created}`);
const again = assetRepo.upsertImage({ taskUuid: 'task-test-001', mediaUuid: 'media-DJI_20260714140727_0001_V', projectUuid: 'proj-test-001', fileName: 'DJI_20260714140727_0001_V', lat: 22.5, lon: 113.9 });
ok('重复入库不新增（幂等）', again.created === false);
ok('影像总数 = 4', DB.scalar('SELECT COUNT(*) AS n FROM asset_image') === 4);

const img0 = assetRepo.listByTask('task-test-001')[0];
ok('XMP 字段回读正确 (RTK)', img0.gpsStatus === 'RTK');
ok('footprint 解析正确', img0.footprint?.widthM === 205.8);
ok('云台俯角回读', img0.gimbal.pitch === -44.4);

section('6. 红外/可见光配对');
const pairs = assetRepo.pairByFlightLine('FL-test-01');
ok('配对 2 组', pairs === 2, `实际 ${pairs}`);
const v = DB.get("SELECT * FROM asset_image WHERE file_name LIKE '%_V' LIMIT 1");
const pairImg = assetRepo.findById(v.pair_image_id);
ok('可见光已指向红外', pairImg?.lensType === 'infrared', `实际 ${pairImg?.lensType}`);
ok('配对是双向的', assetRepo.findById(pairImg.id).pair_image_id === v.id);

section('7. 航迹重建（司空 track 不可用的兜底）');
const track = assetRepo.trackByFlightLine('FL-test-01');
ok('航迹点数 = 4', track.length === 4, `实际 ${track.length}`);
ok('轨迹点含经纬度与高程', track[0][0] !== null && track[0][1] !== null);

section('8. 图斑创建');
const p1 = patchRepo.create({
  projectUuid: 'proj-test-001',
  taskUuid: 'task-test-001',
  flightLineId: 'FL-test-01',
  issueType: 'ILLEGAL_BUILD',
  title: '疑似新增钢结构厂房',
  description: '航拍可见新增钢结构覆盖约 300 ㎡',
  lat: 22.5363887,
  lon: 113.9419813,
  geometryType: 'rect',
  geometry: { type: 'Polygon', coordinates: [[[113.9419, 22.5363], [113.9420, 22.5363], [113.9420, 22.5364], [113.9419, 22.5364], [113.9419, 22.5363]]] },
  areaM2: 312,
  adminRegion: '深圳市宝安区XX街道',
  village: 'XX社区',
  positionDesc: '东至XX路，西至XX河，南至XX鱼塘',
  landType: '耕地',
  isPermanentFarmland: true,
  reviewedBy: 'local_user',
  reviewRemark: '连续两张可见光显示同一建筑',
});
ok('图斑创建', p1.id > 0);
const patchA = patchRepo.findById(p1.id);
ok('GeoJSON 字段正确解析', patchA.geometry?.type === 'Polygon');
ok('永久基本农田布尔转换', patchA.isPermanentFarmland === true);
ok('二期预留字段存在', 'overlayResult' in patchA && 'dataVersion' in patchA);
ok('二期字段默认为空', patchA.overlayResult === null);

section('9. 多图关联');
const imgIds = DB.all("SELECT id FROM asset_image WHERE file_name LIKE '%_V'").map((r) => r.id);
patchImageRepo.attach(p1.id, imgIds, imgIds[0]);
ok('关联 2 张影像', patchImageRepo.countByPatch(p1.id) === 2, `实际 ${patchImageRepo.countByPatch(p1.id)}`);
const attached = patchImageRepo.listByPatch(p1.id);
ok('主图排在最前', attached[0].isPrimary === true);
ok('影像状态冗余更新为 patched', DB.get('SELECT review_state FROM asset_image WHERE id = @id', { id: imgIds[0] }).review_state === 'patched');

// ---------------------------------------------------------------- 10. 工单
section('10. 工单创建与派发校验');
const bad1 = ticketRepo.createFromPatch({ patchId: p1.id, recipientId: 1 });
ok('创建成功', bad1.ok === true, bad1.message || '');
ok('工单号格式正确', /^20\d{6}-DOCK-\d{3}$/.test(bad1.ticketNo || ''), bad1.ticketNo);
ok('自动带出时限 7 天', bad1.deadline === new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), bad1.deadline);
const ticket = ticketRepo.findById(bad1.id);
ok('状态为草稿', ticket.status === 'draft');
ok('状态中文标签', ticket.statusLabel === TICKET_STATUS.draft);
ok('带出责任层级', bad1.defaultOrg === '乡镇 → 执法大队');
ok('allowedTransitions 已派生', Array.isArray(ticket.allowedTransitions) && ticket.allowedTransitions.includes('dispatched'));
ok('创建工单已写留痕', ticketRepo.logs(bad1.id).length === 1);
ok('图斑状态变为 ticketed', patchRepo.findById(p1.id).status === 'ticketed');
const dup = ticketRepo.createFromPatch({ patchId: p1.id, recipientId: 1 });
ok('重复建单被拒绝', dup.ok === false, dup.message);

section('11. 缺少必填项时拒绝派发');
// p2 故意「什么都不填」，逐项补齐验证每道校验都真的生效
const p2 = patchRepo.create({ projectUuid: 'proj-test-001', issueType: 'OCCUPY_ROAD', title: '逐步补齐用例', lat: 22.5, lon: 113.9, areaM2: 50 });
const r2a = ticketRepo.createFromPatch({ patchId: p2.id, recipientId: 1 });
ok('全空时首先拦行政区', r2a.ok === false && r2a.message.includes('行政区'), r2a.message);
patchRepo.update(p2.id, { adminRegion: 'XX街道' });
const r2b = ticketRepo.createFromPatch({ patchId: p2.id, recipientId: 1 });
ok('补齐行政区后拦位置描述', r2b.ok === false && r2b.message.includes('位置描述'), r2b.message);
patchRepo.update(p2.id, { positionDesc: '东至XX路' });
const r2c = ticketRepo.createFromPatch({ patchId: p2.id, recipientId: 1 });
ok('补齐后拦影像（无证据不可派单）', r2c.ok === false && r2c.message.includes('影像'), r2c.message);
// 关联一张影像后才应放行
patchImageRepo.attach(p2.id, [imgIds[0]], imgIds[0]);
const r3 = ticketRepo.createFromPatch({ patchId: p2.id, recipientId: 1 });
ok('全部补齐后可建单', r3.ok === true, r3.message);
const p3 = patchRepo.create({ projectUuid: 'proj-test-001', issueType: 'ILLEGAL_BUILD', title: '无影像', lat: 22.5, lon: 113.9, areaM2: 50, adminRegion: 'X', positionDesc: 'Y' });
const r4 = ticketRepo.createFromPatch({ patchId: p3.id, recipientId: 1 });
ok('无关联影像被拒绝（无证据不可派单）', r4.ok === false && r4.message.includes('影像'), r4.message);
// 必填面积校验（ILLEGAL_BUILD 的 require_area 为真）
const p4 = patchRepo.create({ projectUuid: 'proj-test-001', issueType: 'ILLEGAL_BUILD', title: '缺面积', lat: 22.5, lon: 113.9, adminRegion: 'X', positionDesc: 'Y' });
patchImageRepo.attach(p4.id, [imgIds[0]], imgIds[0]);
const r5 = ticketRepo.createFromPatch({ patchId: p4.id, recipientId: 1 });
ok('违法建设缺面积被拒绝', r5.ok === false && r5.message.includes('面积'), r5.message);

// ---------------------------------------------------------------- 12. 状态机
section('12. 工单状态机');
ok('草稿→已派发 合法', canTransit('draft', 'dispatched').ok);
ok('草稿→整改中 非法', canTransit('draft', 'processing').ok === false);
const badMsg = canTransit('draft', 'processing');
ok('非法流转给出可选目标', (badMsg.allowed || []).includes('dispatched'), JSON.stringify(badMsg.allowed));
ok('非法流转提示可读', badMsg.message.includes('不允许流转到'), badMsg.message);

const t = ticketRepo.transition({ id: bad1.id, to: 'dispatched', remark: '邮件发送成功' });
ok('流转到已派发', t.ok === true, t.message);
ticketRepo.transition({ id: bad1.id, to: 'accepted', remark: '已收到' });
ticketRepo.transition({ id: bad1.id, to: 'processing', remark: '现场核查中' });
ticketRepo.transition({ id: bad1.id, to: 'submitted', remark: '已提交整改结果' });
const final = ticketRepo.findById(bad1.id);
ok('流转到已提交整改', final.status === 'submitted');
ok('终态无可用流转', final.allowedTransitions.length === 0);
const back = ticketRepo.transition({ id: bad1.id, to: 'accepted', remark: '试图回退' });
ok('终态拒绝再流转', back.ok === false && back.code === 40001, back.message);
ok('流转留痕 5 条', ticketRepo.logs(bad1.id).length === 5, `实际 ${ticketRepo.logs(bad1.id).length}`);
ok('终态后影像标记已派单', DB.get('SELECT review_state FROM asset_image WHERE id = @id', { id: imgIds[0] }).review_state === 'dispatched');

section('13. 非法流转不产生副作用');
const logsBefore = ticketRepo.logs(bad1.id).length;
ticketRepo.transition({ id: bad1.id, to: 'processing' });
ok('被拒绝的流转不写留痕', ticketRepo.logs(bad1.id).length === logsBefore);

// ---------------------------------------------------------------- 14. 逾期
section('14. 逾期标记');
DB.run("UPDATE ticket SET deadline = '2020-01-01' WHERE id = @id", { id: r3.id });
const n = ticketRepo.refreshOverdue();
ok('逾期标记刷新', n >= 1, `标记 ${n} 张`);
ok('已提交的工单不标逾期', ticketRepo.findById(bad1.id).overdue === 0);

// ---------------------------------------------------------------- 15. 统计
section('15. 统计与检索');
const sum = ticketRepo.summary();
// 成功建成 2 张：bad1（submitted）与 r3（draft）；p3/p4 因校验未过未建单
ok('工单总数正确', sum.total === 2, `实际 ${sum.total}`);
ok('已提交 1 张', sum.submitted === 1, `实际 ${sum.submitted}`);
ok('草稿 1 张', sum.draft === 1, `实际 ${sum.draft}`);
ok('逾期数正确', sum.overdue === 1, `实际 ${sum.overdue}`);
const tl = ticketRepo.list({ status: 'submitted' });
ok('按状态筛选', tl.total === 1);
const tl2 = ticketRepo.list({ overdue: true });
ok('按逾期筛选', tl2.total === 1);
const q = ticketRepo.list({});
ok('工单带出图斑数', typeof tl.list[0].imageCount === 'number');
const search = assetRepo.search({ lensType: 'infrared' });
ok('按镜头类型检索影像', search.total === 2, `实际 ${search.total}`);
const geoSearch = assetRepo.search({ minLat: 22.53636, maxLat: 22.53640, minLon: 113.94111, maxLon: 113.94112 });
ok('按 GPS 范围检索', geoSearch.total === 2, `实际 ${geoSearch.total}`);

// ---------------------------------------------------------------- 16. 字典维护
section('16. 字典与派发对象维护');
const ut = dictRepo.upsertIssueType({ code: 'CUSTOM_TEST', name: '自定义测试', defaultDays: 2, requireArea: true });
ok('新增自定义问题类型', ut.created === true);
dictRepo.upsertIssueType({ code: 'CUSTOM_TEST', name: '自定义测试(改名)', defaultDays: 4 });
ok('已存在则更新', dictRepo.getIssueType('CUSTOM_TEST').name === '自定义测试(改名)');
ok('更新时限生效', dictRepo.getIssueType('CUSTOM_TEST').defaultDays === 4);
const del1 = dictRepo.deleteIssueType('ILLEGAL_BUILD');
ok('被引用的问题类型不可删', del1.ok === false, del1.message);
const del2 = dictRepo.deleteIssueType('CUSTOM_TEST');
ok('未引用的可删', del2.ok === true);
const rid = dictRepo.createRecipient({ name: 'XX派出所', contact: '王五', email: 'a@b.gov.cn', adminRegion: '宝安区' });
ok('新增派发对象', rid > 0);
const del3 = dictRepo.deleteRecipient(1);
ok('被工单引用的对象不可删', del3.ok === false, del3.message);
const del4 = dictRepo.deleteRecipient(rid);
ok('未引用的对象可删', del4.ok === true);

// ---------------------------------------------------------------- 17. 告警
section('17. 告警');
alertRepo.push({ level: 'error', category: 'mail', title: '邮件发送失败', detail: 'SMTP 认证失败', refType: 'ticket', refId: String(bad1.id) });
alertRepo.push({ level: 'warn', category: 'sync', title: '3 张影像无 GPS' });
alertRepo.push({ level: 'info', category: 'system', title: '同步完成' });
ok('告警入库 3 条', alertRepo.list().length === 3);
ok('未确认计数', alertRepo.unacknowledgedCount() === 3);
alertRepo.acknowledge(1);
ok('确认后计数减少', alertRepo.unacknowledgedCount() === 2);
ok('按级别筛选', alertRepo.list({ level: 'error' }).length === 1);
ok('未确认优先排序', alertRepo.list()[0].acknowledged === true ? alertRepo.list()[1].acknowledged === false : true);

// ---------------------------------------------------------------- 18. 健康检查
section('18. 健康检查');
const h = DB.health();
ok('完整性检查通过', h.ok === true, h.integrity);
ok('WAL 模式生效', h.journalMode === 'wal', h.journalMode);
const counts = DB.tableCounts();
ok('各表可计数', counts.ticket === 2, JSON.stringify(counts));
// ---------------------------------------------------------------- 汇总
console.log(`\n${'═'.repeat(60)}`);
console.log(`测试结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败用例：');
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log('═'.repeat(60));

DB.closeDb();
process.exit(fail > 0 ? 1 : 0);
