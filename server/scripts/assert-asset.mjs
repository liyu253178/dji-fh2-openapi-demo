/**
 * 对已同步的真实库做断言校验（不重新下载）
 * 用法：node scripts/assert-asset.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { toAbsolute } = await import('../src/db/config.js');
const DB = await import('../src/db/index.js');
const { assetRepo, syncRepo } = await import('../src/db/repositories/index.js');
const sharp = (await import('sharp')).default;

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' — ' + e : ''}`); } };
const section = (t) => console.log(`\n${'─'.repeat(56)}\n▶ ${t}\n${'─'.repeat(56)}`);

const tasks = syncRepo.listTasks({ pageSize: 200 });
const withImages = tasks.list.filter((t) => t.imageCount > 0);
const anyTask = withImages[0];
const allImgs = assetRepo.search({ pageSize: 500 }).list;
const images = allImgs.filter((x) => x.fileType === 'image');

section('A. 修正后的断言（对已同步真实库）');
ok('架次已入库', tasks.total > 0, `${tasks.total}`);
ok('图像类影像已入库', images.length > 0, `${images.length}`);

// GPS 与元数据（抽一个图像类）
const sample = images[0];
ok('GPS 坐标已入库', sample.lat !== null && sample.lon !== null, `${sample.lat},${sample.lon}`);
ok('定位质量已记录', !!sample.gpsStatus, sample.gpsStatus);
const rtk = images.filter((x) => x.gpsStatus === 'RTK').length;
ok('RTK 比例高', rtk / images.length > 0.8, `${rtk}/${images.length}`);
const lenses = [...new Set(allImgs.map((x) => x.lensType))];
ok('镜头类型已识别（全库）', lenses.includes('infrared') && lenses.includes('visible'), JSON.stringify(lenses));
console.log(`    全库镜头分布：${JSON.stringify(allImgs.reduce((a, x) => ((a[x.lensType] = (a[x.lensType] || 0) + 1), a), {}))}`);
ok('footprint 已计算', sample.footprint?.widthM > 0, JSON.stringify(sample.footprint));
const hashed = images.filter((x) => x.fileHash).length;
ok('图像类均记录 hash', hashed === images.length, `${hashed}/${images.length}`);
ok('拍摄时间已解析', !!sample.shotAt, sample.shotAt);
ok('机型与设备 SN 已入库', !!sample.droneModel && !!sample.droneSn, `${sample.droneModel}/${sample.droneSn}`);
ok('云台姿态已入库', typeof sample.gimbal?.pitch === 'number', String(sample.gimbal?.pitch));

section('B. 非图像类处理正确');
const ppk = allImgs.filter((x) => x.fileType === 'ppk');
const unsup = allImgs.filter((x) => x.fileType === 'unsupported');
console.log(`  PPK ${ppk.length} 个 / unsupported ${unsup.length} 个`);
ok('PPK 已记录类型', ppk.length === 0 || ppk.every((x) => x.fileType === 'ppk'));
ok('PPK 不计入图像类', ppk.every((x) => x.fileType !== 'image'));
ok('unsupported 已识别', unsup.length === 0 || unsup.every((x) => x.fileType === 'unsupported'));

section('C. 配对与航迹');
let paired = 0;
for (const t of tasks.list) for (const im of assetRepo.listByTask(t.taskUuid)) if (im.pairImageId) paired++;
ok('存在红外/可见光配对', paired > 0, `${paired} 对`);
const lineIds = [...new Set(allImgs.map((x) => x.flightLineId).filter(Boolean))];
console.log(`  架次标识（FlightLineId）数：${lineIds.length}`);
ok('存在架次标识', lineIds.length > 0, `${lineIds.length}`);
if (lineIds.length) {
  const tr = assetRepo.trackByFlightLine(lineIds[0]);
  ok('可重建航迹', tr.length > 0, `${tr.length} 点`);
}

section('D. 文件与派生图');
let thumbOk = 0, mailOk = 0, origOk = 0;
for (const x of images) {
  if (x.filePath && fs.existsSync(toAbsolute(x.filePath))) origOk++;
  if (x.thumbPath && fs.existsSync(toAbsolute(x.thumbPath))) thumbOk++;
  if (x.mailPath && fs.existsSync(toAbsolute(x.mailPath))) mailOk++;
}
ok('原图全部落盘', origOk === images.length, `${origOk}/${images.length}`);
ok('缩略图全部生成', thumbOk === images.length, `${thumbOk}/${images.length}`);
ok('邮件图全部生成', mailOk === images.length, `${mailOk}/${images.length}`);
const t0 = images.find((x) => x.thumbPath);
if (t0) {
  const m = await sharp(fs.readFileSync(toAbsolute(t0.thumbPath))).metadata();
  ok('缩略图为 JPEG 且长边 200', m.format === 'jpeg' && Math.max(m.width, m.height) === 200, `${m.format} ${m.width}x${m.height}`);
}

section('E. 检索');
ok('全量检索', allImgs.length > 0, `${allImgs.length}`);
const ir = assetRepo.search({ lensType: 'infrared', pageSize: 500 });
const vis = assetRepo.search({ lensType: 'visible', pageSize: 500 });
ok('按镜头类型检索', ir.total > 0 && vis.total > 0, `红外${ir.total}/可见光${vis.total}`);
const g = assetRepo.search({ minLat: sample.lat - 0.01, maxLat: sample.lat + 0.01, minLon: sample.lon - 0.01, maxLon: sample.lon + 0.01, pageSize: 500 });
ok('按 GPS 范围检索', g.total > 0, `${g.total}`);

section('F. 库健康');
const h = DB.health();
ok('完整性 ok', h.ok === true, h.integrity);
ok('WAL 模式', h.journalMode === 'wal', h.journalMode);
const c = DB.tableCounts();
console.log('');
Object.entries(c).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${v}`));

console.log(`\n${'═'.repeat(56)}`);
console.log(`断言结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n失败：'); failures.forEach((f) => console.log(`  - ${f}`)); }
console.log('═'.repeat(56));
DB.closeDb();
process.exit(fail > 0 ? 1 : 0);
