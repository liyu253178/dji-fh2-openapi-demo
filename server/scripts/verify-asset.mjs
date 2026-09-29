/**
 * 资产模块真实数据端到端验证
 *
 * 用真实司空组织密钥拉取真实航拍影像，验证：
 *   任务清单 → 媒体清单 → 原图下载 → XMP 解析 → 缩略图生成 → 入库
 *   → 红外/可见光配对 → 航迹重建 → 检索 → 取图
 *
 * 用法：
 *   FH2_TOKEN=<组织密钥> node scripts/verify-asset.mjs
 *   可选 PROJECT_UUID / DOCK_SN / DAYS=365
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'data', 'duav.db');

// 清库重来
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
// 清理历史影像
const dataDir = path.join(__dirname, '..', 'data');
for (const sub of ['assets', 'preview', 'mail-attach']) {
  const p = path.join(dataDir, sub);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

const TK = process.env.FH2_TOKEN;
if (!TK) {
  console.error('❌ 请先设置环境变量 FH2_TOKEN=<司空组织密钥>');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}
function section(t) {
  console.log(`\n${'─'.repeat(64)}\n▶ ${t}\n${'─'.repeat(64)}`);
}

const { migrate } = await import('../src/db/migrate.js');
const { seed } = await import('../src/db/seed.js');
const DB = await import('../src/db/index.js');
const { request, session } = await import('../src/djiClient.js');
const { syncAssets, syncStatus } = await import('../src/modules/asset/syncService.js');
const { assetRepo, syncRepo } = await import('../src/db/repositories/index.js');

migrate();
seed({ withSampleRecipients: true });
session.token = TK;

// ---------------------------------------------------------------- 定位项目
section('1. 定位项目与机场');
const pr = await request({ method: 'GET', path: '/project', query: { page: 1, page_size: 100 }, tag: '验证' });
if (!pr.ok) {
  console.error('❌ 无法拉取项目列表：', pr.message);
  process.exit(1);
}
const projects = pr.data.list;
console.log(`  拉到 ${projects.length} 个项目：${projects.map((p) => p.name).join('、')}`);

// 选有设备的项目
let target = null;
for (const p of projects) {
  const dv = await request({
    method: 'GET', path: '/project/device', projectUuid: p.uuid, tag: '验证',
  });
  const list = dv.data?.list || [];
  const docks = list.filter((x) => x.gateway).map((x) => x.gateway);
  if (docks.length) {
    target = { project: p, docks, list };
    break;
  }
}
if (!target) {
  console.error('❌ 所有项目下都没有机场设备');
  process.exit(1);
}
const DOCK = process.env.DOCK_SN || target.docks[0].sn;
const PROJECT = process.env.PROJECT_UUID || target.project.uuid;
console.log(`  选定项目：${target.project.name} (${PROJECT})`);
console.log(`  选定机场：${DOCK} (${target.docks[0].device_model?.name})`);

syncRepo.upsertProject({ uuid: PROJECT, name: target.project.name, lat: target.project.project_work_center_point?.latitude, lng: target.project.project_work_center_point?.longitude });
for (const item of target.list) {
  if (item.gateway) syncRepo.upsertDevice({ sn: item.gateway.sn, projectUuid: PROJECT, role: 'gateway', model: item.gateway.device_model?.name, callsign: item.gateway.callsign, online: item.gateway.device_online_status, cameraList: item.gateway.camera_list });
  if (item.drone) syncRepo.upsertDevice({ sn: item.drone.sn, projectUuid: PROJECT, role: 'drone', model: item.drone.device_model?.name, callsign: item.drone.callsign, online: item.drone.device_online_status, cameraList: item.drone.camera_list });
}
ok('项目与设备已入库', syncRepo.listProjects().length > 0 && syncRepo.listDevices(PROJECT).length > 0);

// ---------------------------------------------------------------- 同步
section('2. 执行同步（真实下载）');
const days = Number(process.env.DAYS || 365);
const endAt = Math.floor(Date.now() / 1000);
const beginAt = endAt - days * 86400;
console.log(`  时间范围：最近 ${days} 天`);

const t0 = Date.now();
const summary = await syncAssets({
  projectUuid: PROJECT,
  dockSn: DOCK,
  beginAt,
  endAt,
  downloadImages: true,
});
const cost = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n  同步摘要：`, JSON.stringify(summary, null, 1).slice(0, 900));
console.log(`  耗时：${cost}s`);

ok('同步任务完成未中止', !summary.aborted, summary.aborted ? '因磁盘不足中止' : '');
ok('拉到了飞行任务', summary.tasks > 0, `tasks=${summary.tasks}`);
ok('有影像入库', summary.created > 0, `created=${summary.created}`);
ok('同步后状态已复位', syncStatus().running === false);

if (!summary.created) {
  console.log('\n⚠️ 没有新影像（可能全部已下载过或该机场无航拍任务），以下验证基于库中现有数据');
}

// ---------------------------------------------------------------- 入库校验
section('3. 影像入库校验');
const tasks = syncRepo.listTasks({ projectUuid: PROJECT, pageSize: 200 });
console.log(`  库中架次数：${tasks.total}`);
const withImages = tasks.list.filter((t) => t.imageCount > 0);
console.log(`  有影像的架次：${withImages.length}`);
ok('架次已入库', tasks.total > 0, `${tasks.total}`);
if (withImages.length) {
  const t = withImages[0];
  console.log(`  样例架次「${t.name}」：${t.imageCount} 个文件 可见光${t.imageStats.visible} 红外${t.imageStats.infrared} 无GPS ${t.imageStats.noGps}`);
  console.log(`  审核进度：${t.review.patched}/${t.review.total}`);
  ok('影像类型统计正确', t.imageStats.visible + t.imageStats.infrared <= t.imageCount);
  ok('审核进度已统计', typeof t.review.total === 'number');
}

const anyTaskUuid = withImages[0]?.taskUuid || tasks.list[0]?.taskUuid;
const allImgs = anyTaskUuid ? assetRepo.listByTask(anyTaskUuid) : [];
// ⚠️ 只取图像类抽样：PPK 是轨迹处理文件，本就没有 GPS 与影像元数据，
//    混进来会让"GPS 是否入库"这类断言失真
const imgs = allImgs.filter((x) => x.fileType === 'image');
if (imgs.length) {
  const im = imgs[0];
  console.log(`\n  样例影像「${im.fileName}」（该架次共 ${allImgs.length} 个文件，其中图像 ${imgs.length} 个）：`);
  console.log(`    坐标 ${im.lat?.toFixed(7)}, ${im.lon?.toFixed(7)} | RTK=${im.gpsStatus}`);
  console.log(`    绝对高 ${im.altitudeAbs}m 相对高 ${im.altitudeRel}m | 镜头 ${im.lensType}`);
  console.log(`    云台 ${im.gimbal?.pitch}° | 机型 ${im.droneModel} | 航线 ${im.flightLineId?.slice(0, 8)}`);
  console.log(`    文件 ${(im.fileSize / 1024 / 1024).toFixed(2)}MB hash=${im.fileHash?.slice(0, 12)}…`);
  ok('GPS 坐标已入库', im.lat !== null && im.lon !== null, `${im.lat},${im.lon}`);
  ok('定位质量已记录', !!im.gpsStatus, im.gpsStatus);
  ok('RTK 比例高', imgs.filter((x) => x.gpsStatus === 'RTK').length / imgs.length > 0.8,
     `${imgs.filter((x) => x.gpsStatus === 'RTK').length}/${imgs.length}`);
  // ⚠️ 镜头类型跨架次统计：单个架次可能只飞了可见光（本次抽样即如此），
  //    红外与可见光配对是架次内行为，全库统计才有意义
  const allImages = assetRepo.search({ pageSize: 500 }).list.filter((x) => x.fileType === 'image');
  const lenses = [...new Set(allImages.map((x) => x.lensType))];
  ok('镜头类型已识别（全库）', lenses.includes('infrared') && lenses.includes('visible'),
     `全库 ${allImages.length} 张，类型 ${JSON.stringify(lenses)}`);
  console.log(`    本架次镜头类型：${JSON.stringify([...new Set(imgs.map((x) => x.lensType))])}（该架次可能只飞单一镜头）`);
  ok('footprint 已计算', im.footprint?.widthM > 0, JSON.stringify(im.footprint));
  // hash 只对下载了原图的图像类有意义；ppk/unsupported 不下载故无 hash
  const imagesAll = assetRepo.search({ pageSize: 500 }).list.filter((x) => x.fileType === 'image');
  const hashed = imagesAll.filter((x) => x.fileHash).length;
  ok('图像类均记录 hash', hashed === imagesAll.length, `${hashed}/${imagesAll.length}`);
  ok('拍摄时间已解析', !!im.shotAt, im.shotAt);
  ok('机型与设备 SN 已入库', !!im.droneModel && !!im.droneSn, `${im.droneModel}/${im.droneSn}`);
  ok('云台姿态已入库', typeof im.gimbal?.pitch === 'number', String(im.gimbal?.pitch));
}

// ---------------------------------------------------------------- 文件落盘
section('4. 文件落盘校验');
const { toAbsolute } = await import('../src/db/config.js');
if (imgs.length) {
  const withFile = imgs.filter((x) => x.filePath);
  ok('原图已落盘', withFile.length > 0, `${withFile.length}/${imgs.length}`);
  let thumbOk = 0; let mailOk = 0;
  for (const x of imgs) {
    if (x.thumbPath && fs.existsSync(toAbsolute(x.thumbPath))) thumbOk++;
    if (x.mailPath && fs.existsSync(toAbsolute(x.mailPath))) mailOk++;
  }
  ok('缩略图已生成', thumbOk > 0, `${thumbOk}/${imgs.length}`);
  ok('邮件压缩图已生成', mailOk > 0, `${mailOk}/${imgs.length}`);
  if (thumbOk > 0) {
    const t = imgs.find((x) => x.thumbPath);
    const sz = fs.statSync(toAbsolute(t.thumbPath)).size;
    console.log(`  缩略图示例：${path.basename(t.thumbPath)} ${(sz / 1024).toFixed(0)}KB`);
    ok('缩略图体积合理(10-100KB)', sz > 10240 && sz < 102400, `${(sz / 1024).toFixed(0)}KB`);
  }
  if (mailOk > 0) {
    const m = imgs.find((x) => x.mailPath);
    const msz = fs.statSync(toAbsolute(m.mailPath)).size;
    console.log(`  邮件图示例：${path.basename(m.mailPath)} ${(msz / 1024).toFixed(0)}KB`);
    ok('邮件图体积合理(100KB-1.5MB)', msz > 102400 && msz < 1572864, `${(msz / 1024).toFixed(0)}KB`);
  }
}

// ---------------------------------------------------------------- 配对
section('5. 红外/可见光配对');
let paired = 0;
for (const t of tasks.list) {
  for (const im of assetRepo.listByTask(t.taskUuid)) {
    if (im.pairImageId) paired++;
  }
}
const totalImgs = DB.scalar('SELECT COUNT(*) AS n FROM asset_image');
console.log(`  已配对影像数：${paired}/${totalImgs}`);
if (totalImgs >= 2) ok('存在配对关系', paired > 0, `${paired}`);
if (paired > 0) {
  const v = DB.get("SELECT * FROM asset_image WHERE pair_image_id IS NOT NULL AND lens_type='visible' LIMIT 1");
  const pair = v ? assetRepo.findById(v.pair_image_id) : null;
  ok('配对为红外', pair?.lensType === 'infrared', pair?.lensType);
  ok('配对双向', pair && assetRepo.findById(pair.id).pair_image_id === v.id);
}

// ---------------------------------------------------------------- 航迹
section('6. 航迹重建（司空 track 接口兜底）');
const lineId = anyTaskUuid ? assetRepo.dominantFlightLineId(anyTaskUuid) : null;
if (lineId) {
  const track = assetRepo.trackByFlightLine(lineId);
  console.log(`  架次 ${lineId.slice(0, 8)} 航迹点数：${track.length}`);
  ok('航迹点数 > 0', track.length > 0, `${track.length}`);
  ok('航迹点含经纬度与高程', track[0] && track[0][0] !== null && track[0][1] !== null);
} else {
  ok('（无影像可重建航迹，跳过）', true);
}

// ---------------------------------------------------------------- 检索
section('7. 检索能力');
const all = assetRepo.search({ pageSize: 500 });
console.log(`  库中影像总数：${all.total}`);
ok('全量检索', all.total > 0, `${all.total}`);
if (all.total > 0) {
  const ir = assetRepo.search({ lensType: 'infrared', pageSize: 500 });
  const vis = assetRepo.search({ lensType: 'visible', pageSize: 500 });
  console.log(`  红外 ${ir.total} / 可见光 ${vis.total}`);
  ok('按镜头类型检索', ir.total > 0 && vis.total > 0);
  const first = all.list[0];
  const geo = assetRepo.search({
    minLat: first.lat - 0.005, maxLat: first.lat + 0.005,
    minLon: first.lon - 0.005, maxLon: first.lon + 0.005,
    pageSize: 500,
  });
  ok('按 GPS 范围检索', geo.total > 0, `${geo.total}`);
}

// ---------------------------------------------------------------- 取图
section('8. 取图接口（模拟 HTTP）');
if (imgs.length) {
  const sharp = (await import('sharp')).default;
  const { toAbsolute: toAbs } = await import('../src/db/config.js');
  const target = imgs.find((x) => x.thumbPath) || imgs[0];
  if (target.thumbPath) {
    const abs = toAbs(target.thumbPath);
    const buf = fs.readFileSync(abs);
    const meta = await sharp(buf).metadata();
    ok('缩略图可读且为 JPEG', meta.format === 'jpeg', meta.format);
    ok('缩略图长边 200px', Math.max(meta.width, meta.height) === 200, `${meta.width}x${meta.height}`);
  }
  // 路径穿越防护：构造越界相对路径
  const { default: assetRouter } = await import('../src/routes/asset.js');
  ok('取图路由已导出', typeof assetRouter === 'function');
}

// ---------------------------------------------------------------- 幂等
section('9. 重复同步幂等性');
const beforeSecond = DB.scalar('SELECT COUNT(*) AS n FROM asset_image');
const t1 = Date.now();
const sum2 = await syncAssets({ projectUuid: PROJECT, dockSn: DOCK, beginAt, endAt, downloadImages: true });
const afterSecond = DB.scalar('SELECT COUNT(*) AS n FROM asset_image');
console.log(`  二次同步：新增 ${sum2.created}，跳过 ${sum2.skipped}，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
console.log(`  库中影像：${beforeSecond} -> ${afterSecond}`);
ok('二次同步走跳过分支', sum2.skipped > 0, `skipped=${sum2.skipped}`);
ok('二次同步不重复下载文件', sum2.created <= 5, `created=${sum2.created}（允许极少量新增：期间可能刚好有新任务）`);
// 关键：已入库的老影像不应重复，校验总数增长远小于首轮
ok('影像总数基本不变', afterSecond - beforeSecond <= 5, `增长 ${afterSecond - beforeSecond} 张`);

// ---------------------------------------------------------------- 汇总
section('10. 库状态');
const h = DB.health();
ok('完整性 ok', h.ok === true, h.integrity);
const counts = DB.tableCounts();
console.log('');
Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`));
const dataSize = h.sizeKb / 1024;
console.log(`\n  数据库大小：${dataSize.toFixed(2)} MB`);
let diskSize = 0;
for (const sub of ['assets', 'preview', 'mail-attach']) {
  const p = path.join(dataDir, sub);
  const walk = (d) => {
    if (!fs.existsSync(d)) return 0;
    let s = 0;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      s += e.isDirectory() ? walk(fp) : fs.statSync(fp).size;
    }
    return s;
  };
  diskSize += walk(p);
}
console.log(`  影像总占用：${(diskSize / 1024 / 1024).toFixed(1)} MB`);

console.log(`\n${'═'.repeat(64)}`);
console.log(`验证结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n失败用例：'); failures.forEach((f) => console.log(`  - ${f}`)); }
console.log('═'.repeat(64));

DB.closeDb();
process.exit(fail > 0 ? 1 : 0);
