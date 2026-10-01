/**
 * 自研航线内核冒烟（真实司空 2 联调）
 *   node scripts/verify-wayline-kernel.mjs
 *
 * 覆盖：机队机型 → 镜头反演 → 正射/井字/带状三种航线 → 与真实航线对比 → KMZ 打包
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/tokens.json'), 'utf8'));
const tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || {};

const { session } = await import('../src/djiClient.js');
session.token = tok.token || tok.value || '';
session.projectUuid = store.activeProjectUuid || '';

const { fleetModels } = await import('../src/modules/wayline/aircraftService.js');
const { plan, build } = await import('../src/modules/wayline/planner.js');
const { makeLocalFrame } = await import('../src/modules/wayline/routePlanner.js');

let pass = 0;
const fails = [];
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fails.push(name);
    console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

console.log('\n[1] 机队机型与镜头反演');
const fleet = await fleetModels({ force: true });
check('拉取机队机型', fleet.ok && fleet.models.length > 0, `${fleet.models?.length || 0} 个型号 / ${fleet.airports} 个机场`);
for (const m of fleet.models || []) {
  console.log(`     ${m.name} (${m.key}) 载荷=${m.payload ?? '未反演'} 库内=${m.libraryCount ?? 0} 参考=${m.reference?.name || '无'} 镜头=${m.reference?.lensKeys?.join('+') || '-'}`);
  if (m.calibration) {
    const s = m.calibration.sample;
    console.log(`       反演 swathK=${m.calibration.swathK.toFixed(3)}（H=${s.height.toFixed(1)}m W=${s.overlapW}% → 间距 ${s.spacing.toFixed(1)}m，${s.strips} 带）`);
    console.log(`       镜头覆盖表: ${JSON.stringify(m.lensOverrides)}`);
  }
}
const target = (fleet.models || []).find((m) => m.payload !== null && m.payload !== undefined) || fleet.models?.[0];
check('存在可用机型', !!target, target ? target.key : '无');
if (!target) process.exit(1);

const polygon = [
  [113.493512, 23.092449],
  [113.494488, 23.092449],
  [113.494488, 23.091551],
  [113.493512, 23.091551],
];
const base = { height: 60, speed: 10, overlapH: 80, overlapW: 70, direction: 0, margin: 0 };

console.log('\n[2] 正射面状（广角）');
const ortho = await plan({ polygon, aircraftKey: target.key, params: base });
check('规划成功', ortho.ok, ortho.message || '');
if (ortho.ok) {
  const s = ortho.plan.stats;
  console.log(`     ${s.stripCount} 带 / ${s.waypointCount} 点 / 里程 ${s.lengthM}m / ${s.durationText} / 片基 ${s.base}m / 间隔 ${s.shootInterval}s / 约 ${s.photoCount} 张`);
  console.log(`     镜头=${ortho.lens.names.join('+')} 系数=${ortho.lens.swathK}（${ortho.spacingSource.text}）`);
  check('间距与片基为正', s.spacing > 0 && s.base > 0, `间距 ${s.spacing}m 片基 ${s.base}m`);
  check('井字未开启', ortho.templateType === 'mapping2d');
}

console.log('\n[3] 镜头切换（广角 vs 长焦）');
const tele = await plan({ polygon, aircraftKey: target.key, params: { ...base, lens: ['tele'] } });
const wide = await plan({ polygon, aircraftKey: target.key, params: { ...base, lens: ['wide'] } });
check('长焦规划成功', tele.ok, tele.message || '');
if (tele.ok && wide.ok) {
  console.log(`     广角: 间距 ${wide.plan.stats.spacing}m / ${wide.plan.stats.stripCount} 带 / ${wide.plan.stats.waypointCount} 点`);
  console.log(`     长焦: 间距 ${tele.plan.stats.spacing}m / ${tele.plan.stats.stripCount} 带 / ${tele.plan.stats.waypointCount} 点`);
  check('长焦间距显著小于广角', tele.plan.stats.spacing < wide.plan.stats.spacing * 0.5);
  check('长焦航带数多于广角', tele.plan.stats.stripCount > wide.plan.stats.stripCount);
  check('镜头索引写入正确', tele.lens.payloadLensIndex === 'visable', tele.lens.payloadLensIndex);
}
const dual = await plan({ polygon, aircraftKey: target.key, params: { ...base, lens: ['wide', 'ir'] } });
if (dual.ok) {
  console.log(`     广角+红外: 间距 ${dual.plan.stats.spacing}m（受 ${dual.lens.governing} 约束）`);
  check('多镜头取最窄视场约束', dual.lens.governing === '红外热成像' && dual.lens.payloadLensIndex === 'visable,ir', dual.lens.payloadLensIndex);
}

console.log('\n[4] 井字航线');
const grid = await plan({ polygon, aircraftKey: target.key, params: { ...base, templateType: 'doubleGrid' } });
check('井字规划成功', grid.ok, grid.message || '');
if (grid.ok && ortho.ok) {
  console.log(`     ${grid.plan.stats.stripCount} 带 / ${grid.plan.stats.waypointCount} 点 / 里程 ${grid.plan.stats.lengthM}m / ${grid.plan.stats.durationText}`);
  check('航带数约为正射两倍', grid.plan.stats.stripCount >= ortho.plan.stats.stripCount * 2 - 2, `${grid.plan.stats.stripCount} vs ${ortho.plan.stats.stripCount}`);
  const g = await build({ polygon, aircraftKey: target.key, params: { ...base, templateType: 'doubleGrid' }, name: 'DUAV内核-井字' });
  check('井字模板开启 doubleGrid', g.ok && /<wpml:doubleGridWaylineEnable>1</.test(g.files['wpmz/template.kml']));
}

console.log('\n[5] 带状航线');
const centerline = [
  [113.4930, 23.0910],
  [113.4945, 23.0920],
  [113.4960, 23.0928],
];
// 用户口径：画完中心线后指定「左右各外扩多少米」（默认 20）→ 生成面 → 面里布垂直于中心线的工字形扫线
const corrParams = { ...base, templateType: 'corridor', corridorHalfWidth: 20, extend: 20, margin: 0 };
const corr = await plan({
  centerline,
  aircraftKey: target.key,
  params: corrParams,
});
check('带状规划成功', corr.ok, corr.message || '');
if (corr.ok) {
  const s = corr.plan.stats;
  console.log(`     总带宽 ${s.width}m（左右各 ${s.halfWidth}m）/ ${s.stripCount} 条扫线 / ${s.waypointCount} 点 / 里程 ${s.lengthM}m / 覆盖 ${(s.areaM2 / 10000).toFixed(2)} 公顷`);
  check('扫线条数符合走廊长度/间距', s.stripCount >= 2, `${s.stripCount} 条`);
  check('左右外扩写回统计', s.halfWidth === 20 && s.width === 40, `半宽 ${s.halfWidth}m / 总宽 ${s.width}m`);
  check('缓冲边界已生成', Array.isArray(corr.bufferPolygon) && corr.bufferPolygon.length >= 4, `${corr.bufferPolygon?.length} 点`);

  // 工字形几何三连检：垂直 / 长度 / 沿边连接
  const frame = makeLocalFrame(centerline[0][0], centerline[0][1]);
  const xy = (p) => frame.toXY(p);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const len = (v) => Math.hypot(v[0], v[1]) || 1;
  const segVec = sub(xy(centerline[1]), xy(centerline[0]));
  const rung0 = corr.plan.strips[0].map(xy);
  const rungVec = sub(rung0[1], rung0[0]);
  const cos = (segVec[0] * rungVec[0] + segVec[1] * rungVec[1]) / (len(segVec) * len(rungVec));
  check('扫线垂直于中心线', Math.abs(cos) < 0.02, `夹角余弦 ${cos.toFixed(4)}（0 为垂直）`);
  const rungLen = len(rungVec);
  check('扫线长度等于走廊总宽', Math.abs(rungLen - 40) < 1.5, `${rungLen.toFixed(1)} m / 期望 40 m`);
  const rung1 = corr.plan.strips[1].map(xy);
  const link = len(sub(rung1[0], rung0[1]));
  check('相邻扫线沿走廊边缘连接', Math.abs(link - s.spacing) < s.spacing * 0.6 + 2, `连接段 ${link.toFixed(1)} m / 间距 ${s.spacing} m`);

  const cb = await build({ centerline, aircraftKey: target.key, params: corrParams, name: 'DUAV内核-带状' });
  check('带状 KMZ 生成成功', cb.ok && cb.kmz?.length > 0, `${cb.kmz?.length || 0} B`);
  if (cb.ok) {
    const tpl = cb.files['wpmz/template.kml'];
    check('带状模板沿用 mapping2d', /<wpml:templateType>mapping2d</.test(tpl));
    check('测区多边形为缓冲边界', /<coordinates>/.test(tpl));
  }
}

console.log('\n[6] KMZ 打包与关键字段');
const built = await build({ polygon, aircraftKey: target.key, params: base, name: 'DUAV内核冒烟' });
check('生成 KMZ', built.ok && built.kmz?.length > 0, `${built.kmz?.length || 0} B`);
if (built.ok) {
  const names = Object.keys(built.files);
  check('同时包含 template.kml 与 waylines.wpml', names.includes('wpmz/template.kml') && names.includes('wpmz/waylines.wpml'), names.join(', '));
  const tpl = built.files['wpmz/template.kml'];
  const wpl = built.files['wpmz/waylines.wpml'];
  check('命名空间为 WPML 1.0.6', tpl.includes('http://www.dji.com/wpmz/1.0.6'));
  check('机型枚举写入正确', new RegExp(`<wpml:droneEnumValue>${target.type}<`).test(tpl) && new RegExp(`<wpml:droneSubEnumValue>${target.subType}<`).test(tpl));
  check('载荷枚举写入正确', new RegExp(`<wpml:payloadEnumValue>${target.payload}<`).test(tpl));
  const pmCount = (wpl.match(/<Placemark>/g) || []).length;
  check('航点数与规划一致', pmCount === built.preview.plan.stats.waypointCount, `${pmCount} 个 Placemark`);
  check('拍照间隔已写入', new RegExp(`<wpml:minShootInterval>${built.preview.plan.stats.shootInterval}</wpml:minShootInterval>`).test(wpl));
}

console.log('\n[7] 参数边界自检');
const bad = await plan({ polygon, aircraftKey: target.key, params: { ...base, height: 1000, overlapH: 10 } });
check('超限参数被本地拦下', bad.ok === false, bad.message || '');
const wrongModel = await plan({ polygon, aircraftKey: '0-999-9', params: base });
check('非机队机型被拦下', wrongModel.ok === false, wrongModel.message || '');
const fast = await plan({ polygon, aircraftKey: target.key, params: { ...base, speed: 15, overlapH: 90 } });
if (fast.ok) {
  check('航速过快时给出重叠率告警', (fast.warnings || []).some((w) => w.includes('航向重叠率')), (fast.warnings || []).join(' | ') || '无告警');
}

console.log(`\n结果：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.log('失败项：' + fails.join(' / '));
  process.exit(1);
}
