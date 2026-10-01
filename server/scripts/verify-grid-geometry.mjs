/**
 * 井字形（倾斜摄影）航线内核回归 —— 纯数学，不需要司空 2 凭据
 *   node scripts/verify-grid-geometry.mjs
 *
 * 覆盖专家给出的四段结构与我们的落地实现：
 *   一、基础参数解算（GSD ↔ 航高、footprint、按目标重叠率反解基线/间距）
 *   二、扫描线填充（凹多边形、无效段剔除、凸包选项）
 *   三、井字交叉（第二组独立解算）
 *   四、航点排序（之字形、最近端接入、多架次切分）
 */
import {
  groundFootprint,
  passGeometry,
  overlapRatio,
  heightFromGsd,
  gsdFromHeight,
  SENSOR,
} from '../src/modules/wayline/cameraGeometry.js';
import { planArea, planAreaXY, planDoubleGrid, planCorridor, makeLocalFrame, pointInPolygonXY } from '../src/modules/wayline/routePlanner.js';
import { sequenceGroups, splitSorties, pathLength } from '../src/modules/wayline/pathSequence.js';

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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------------------------------------------------------- *
 * 一、基础参数解算
 * ---------------------------------------------------------- */
console.log('\n[1] GSD 与相对航高互算');
const FOCAL = 24;
const H_BY_GSD = heightFromGsd({ gsdCm: 2, focalEq: FOCAL });
check('H = GSD·f/δ 与理论值一致', near(H_BY_GSD, (0.02 * SENSOR.imageW * FOCAL) / SENSOR.frameW, 0.01), `${H_BY_GSD.toFixed(1)} m`);
const GSD_BACK = gsdFromHeight({ height: H_BY_GSD, focalEq: FOCAL });
check('GSD 往返计算闭合', near(GSD_BACK, 2, 0.01), `${GSD_BACK.toFixed(3)} cm/px`);
check('航高翻倍 GSD 也翻倍', near(gsdFromHeight({ height: 200, focalEq: FOCAL }), 2 * gsdFromHeight({ height: 100, focalEq: FOCAL }), 1e-6));

console.log('\n[2] 单张影像地面覆盖 footprint');
const nadir = groundFootprint({ height: 100, focalEq: FOCAL, tiltDeg: 0 });
const along0 = nadir.maxAlong - nadir.minAlong;
const cross0 = nadir.maxCross - nadir.minCross;
check('正射纵深 = H·frameH/f', near(along0, (100 * SENSOR.frameH) / FOCAL, 0.01), `${along0.toFixed(2)} m`);
check('正射横向 = H·frameW/f', near(cross0, (100 * SENSOR.frameW) / FOCAL, 0.01), `${cross0.toFixed(2)} m`);
check('正射覆盖面积 = 纵深×横向', near(nadir.area, along0 * cross0, 0.5), `${nadir.area.toFixed(0)} m²`);
check('正射 footprint 未触发限幅', nadir.clamped === false);

const tilt45 = groundFootprint({ height: 100, focalEq: FOCAL, tiltDeg: 45 });
check('倾斜后覆盖面积显著变大', tilt45.area > nadir.area * 3, `${tilt45.area.toFixed(0)} vs ${nadir.area.toFixed(0)} m²`);
check('倾斜后纵深被拉伸', tilt45.maxAlong - tilt45.minAlong > along0 * 2, `${(tilt45.maxAlong - tilt45.minAlong).toFixed(1)} m`);
const edgeTilt = groundFootprint({ height: 100, focalEq: FOCAL, tiltDeg: 80 });
check('极端倾角触发远端限幅保护', edgeTilt.clamped === true && edgeTilt.points.flat().every(Number.isFinite));

console.log('\n[3] 按目标重叠率反解摄影基线 / 航线间距');
const OH = 80;
const OW = 70;
const gNadir0 = passGeometry({ footprint: nadir, psiDeg: 0, overlapForward: OH, overlapSide: OW });
check('正射时间距 = W·(1−旁向重叠)', near(gNadir0.spacing, cross0 * (1 - OW / 100), 0.5), `${gNadir0.spacing} m`);
check('正射时基线 = L·(1−航向重叠)', near(gNadir0.base, along0 * (1 - OH / 100), 0.5), `${gNadir0.base} m`);
// 反解结果必须真的达到目标重叠率（自洽校验）
check(
  '间距反解后旁向重叠率达标',
  near(overlapRatio(nadir, 0, 'cross', gNadir0.spacing), OW / 100, 0.005),
  `实测 ${(overlapRatio(nadir, 0, 'cross', gNadir0.spacing) * 100).toFixed(2)}%`
);
check(
  '基线反解后航向重叠率达标',
  near(overlapRatio(nadir, 0, 'along', gNadir0.base), OH / 100, 0.005),
  `实测 ${(overlapRatio(nadir, 0, 'along', gNadir0.base) * 100).toFixed(2)}%`
);

console.log('\n[4] 倾斜摄影：两组井字必须各自独立解算');
const gA = passGeometry({ footprint: tilt45, psiDeg: 0, overlapForward: OH, overlapSide: OW });
const gB = passGeometry({ footprint: tilt45, psiDeg: 90, overlapForward: OH, overlapSide: OW });
console.log(`     ψ=0°：间距 ${gA.spacing} m / 基线 ${gA.base} m（矩形假设计算会给出 ${gA.textbookSpacing} / ${gA.textbookBase}）`);
console.log(`     ψ=90°：间距 ${gB.spacing} m / 基线 ${gB.base} m（矩形假设计算会给出 ${gB.textbookSpacing} / ${gB.textbookBase}）`);
const diff = Math.abs(gA.spacing - gB.spacing) / Math.max(gA.spacing, gB.spacing);
check('两组间距确实不同（沿用同一间距会有一个方向不达标）', diff > 0.05, `相差 ${(diff * 100).toFixed(1)}%`);
check('倾斜下间距比矩形假设更保守（不会因过度拉宽而漏拍）', gA.spacing < gA.textbookSpacing && gB.spacing < gB.textbookSpacing);
check(
  '倾斜下两组解算各自满足目标旁向重叠率',
  near(overlapRatio(tilt45, 0, 'cross', gA.spacing), OW / 100, 0.005) &&
    near(overlapRatio(tilt45, 90, 'cross', gB.spacing), OW / 100, 0.005),
  `${(overlapRatio(tilt45, 0, 'cross', gA.spacing) * 100).toFixed(2)}% / ${(overlapRatio(tilt45, 90, 'cross', gB.spacing) * 100).toFixed(2)}%`
);
check(
  '倾斜下两组解算各自满足目标航向重叠率',
  near(overlapRatio(tilt45, 0, 'along', gA.base), OH / 100, 0.005) &&
    near(overlapRatio(tilt45, 90, 'along', gB.base), OH / 100, 0.005)
);

/* ---------------------------------------------------------- *
 * 二、扫描线填充
 * ---------------------------------------------------------- */
console.log('\n[5] 扫描线填充：矩形 / 凹多边形');
const polyRect = [
  [113.493512, 23.092449],
  [113.494488, 23.092449],
  [113.494488, 23.091551],
  [113.493512, 23.091551],
];
const single = planArea({ polygon: polyRect, direction: 0, spacing: 30, wpSpacing: 30, margin: 0, maxWaypoints: 1500 });
check('矩形测区生成多条航带', single.stats.stripCount >= 3, `${single.stats.stripCount} 带 / ${single.stats.waypointCount} 点`);
check('航带数与测区宽度/间距相符', Math.abs(single.stats.stripCount - 100 / 30) <= 1.5, `${single.stats.stripCount} 带`);
check('相邻航带首尾相接（之字形）', (() => {
  let ok = true;
  for (let i = 1; i < single.strips.length; i++) {
    const prevEnd = single.strips[i - 1][single.strips[i - 1].length - 1];
    const curStart = single.strips[i][0];
    const d = Math.hypot(prevEnd[0] - curStart[0], prevEnd[1] - curStart[1]) * 111000;
    if (d > 40) ok = false;
  }
  return ok;
})());

// L 形凹多边形：不能出现穿过空缺的无效航线段
const lShape = [
  [0, 0],
  [100, 0],
  [100, 40],
  [40, 40],
  [40, 100],
  [0, 100],
];
const frame = makeLocalFrame(113.5, 23.1);
const lPoly = lShape.map(([x, y]) => frame.toLL([x, y]));
const inXY = lShape;
const lXY = planAreaXY({ polygon: lPoly, direction: 0, spacing: 20, wpSpacing: 20, margin: 0, maxWaypoints: 1500 });
const lStripsXY = lXY.strips;
// 参考多边形要换算到 planAreaXY 自己建立的局部坐标系里，否则差一个基准点
const lRef = lPoly.map(lXY.frame.toXY);
// 航带正好压到边上时航点会落在边界线上（这是合法的几何），射线法对「边上」的点判定不稳定，
// 所以这里按「在多边形内」或「到任意边的距离 < 1 cm」判定。
const distToPolygon = (pt, poly) => {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const l2 = ex * ex + ey * ey || 1;
    let t = ((pt[0] - a[0]) * ex + (pt[1] - a[1]) * ey) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(pt[0] - (a[0] + t * ex), pt[1] - (a[1] + t * ey)));
  }
  return best;
};
const insideOrOn = (pt, poly) => pointInPolygonXY(pt, poly) || distToPolygon(pt, poly) < 0.01;
check('识别出凹多边形', lXY.concave === true);
check(
  '所有航点都落在测区内（无穿空线段）',
  lStripsXY.flat().every((p) => insideOrOn(p, lRef)),
  `${lStripsXY.flat().length} 个航点`
);
check(
  '凹多边形的空缺处没有生成无效航线段',
  // L 形的空缺是右下角 x∈[-10,50]、y∈[-50,-10] 这块矩形内部不应有航点
  lStripsXY.flat().every((p) => !inHole(p)),
  `${lStripsXY.flat().length} 个航点`
);

/** L 形右下角空缺（相对 bbox 中心的局部坐标） */
function inHole([x, y]) {
  return x > -10 + 0.01 && x < 50 - 0.01 && y > -10 + 0.01 && y < 50 - 0.01;
}
const hullArea = planAreaXY({ polygon: lPoly, direction: 0, spacing: 20, wpSpacing: 20, margin: 0, maxWaypoints: 1500, useHull: true });
check('凸包方案可作为凹多边形的工程折中', hullArea.strips.length >= lXY.strips.length, `${hullArea.strips.length} vs ${lXY.strips.length} 带`);

/* ---------------------------------------------------------- *
 * 三、井字交叉 + 四、航点排序
 * ---------------------------------------------------------- */
console.log('\n[6] 井字形双遍：正交、独立间距、最近端接入');
const grid = planDoubleGrid({
  polygon: polyRect,
  direction: 30,
  spacing: 30,
  wpSpacing: 40,
  spacing2: 20,
  wpSpacing2: 40,
  margin: 0,
  maxWaypoints: 1500,
  maxSortieLengthM: 0,
});
check('两组航线都已生成', grid.groups.length === 2 && grid.groups.every((g) => g.stripCount > 0), grid.groups.map((g) => `${g.stripCount}带`).join(' + '));
check('第二组航线角为第一组 +90°', ((grid.groups[1].direction - grid.groups[0].direction) % 360 + 360) % 360 === 90, `${grid.groups[0].direction}° → ${grid.groups[1].direction}°`);
check('两组沿用各自解算出的间距', grid.groups[0].spacing === 30 && grid.groups[1].spacing === 20, `${grid.groups[0].spacing} / ${grid.groups[1].spacing} m`);
check('第二组更密 → 航带更多', grid.groups[1].stripCount > grid.groups[0].stripCount);
check('航点总数不超上限', grid.stats.waypointCount <= grid.stats.maxWaypoints, `${grid.stats.waypointCount} / ${grid.stats.maxWaypoints}`);
check('串接后的路径包含两组全部航点', grid.stats.waypointCount === grid.groups.reduce((s, g) => s + g.waypointCount, 0), `${grid.stats.waypointCount} 点`);

// 组间接入：应当取两端里更近的那一端
{
  const xyGrid = grid.groups.map((g) => g.strips.map((s) => s.map(frame.toXY)));
  const forwardEnd = sequenceGroups([{ name: 'a', strips: xyGrid[0] }, { name: 'b', strips: xyGrid[1] }]);
  const manual = (() => {
    const lastA = xyGrid[0].flat().slice(-1)[0];
    const head = xyGrid[1][0][0];
    const tailStrip = xyGrid[1][xyGrid[1].length - 1];
    const tail = tailStrip[tailStrip.length - 1];
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    return Math.min(d(lastA, head), d(lastA, tail));
  })();
  check('组间转移距离取的是较近端点', near(forwardEnd.transitionsM, manual, 0.5), `${forwardEnd.transitionsM} m（另一端的距离更长）`);
  check('记录是否与默认顺序相反的选择', forwardEnd.links.length === 1 && typeof forwardEnd.links[0].reversed === 'boolean', JSON.stringify(forwardEnd.links));
}

console.log('\n[7] 航点上限与自动放宽');
const tight = planDoubleGrid({
  polygon: polyRect,
  direction: 0,
  spacing: 12,
  wpSpacing: 10,
  margin: 0,
  maxWaypoints: 90,
});
check('超过上限时自动放宽间距并如实上报', tight.stats.adjusted === true && tight.stats.waypointCount <= 90, `${tight.stats.waypointCount} 点 / 间距 ${tight.stats.spacing}→${tight.stats.spacing2} m`);

console.log('\n[8] 多架次切分');
const longLine = Array.from({ length: 400 }, (_, i) => [i * 50, 0]);
const sorties = splitSorties(longLine, { maxLengthM: 5000 });
check('按最大航程切成多个架次', sorties.length >= 3, `${sorties.length} 个架次`);
check('每个架次里程不超过上限', sorties.every((s) => s.lengthM <= 5000 + 50), sorties.map((s) => s.lengthM).join(' / '));
check('不带起飞点时架次航点完整覆盖原序列', sorties.reduce((s, x) => s + x.waypointCount, 0) === longLine.length, `${sorties.reduce((s, x) => s + x.waypointCount, 0)} / ${longLine.length} 点`);
const withHome = splitSorties(longLine, { maxLengthM: 5000, homeXY: [0, 0] });
check('带起飞点时每个架次都是一个完整起降循环', withHome.every((s) => {
  const p = s.points;
  return p[0][0] === 0 && p[0][1] === 0 && p[p.length - 1][0] === 0 && p[p.length - 1][1] === 0;
}), withHome.map((s) => `${s.waypointCount}点`).join(' / '));
const gridSortieCount = planDoubleGrid({ polygon: polyRect, direction: 0, spacing: 20, wpSpacing: 20, maxWaypoints: 1500, maxSortieLengthM: 300 });
check('超过续航时给出架次明细', gridSortieCount.sorties.length >= 2, `${gridSortieCount.sorties.length} 个架次`);

console.log('\n[9] 走廊（带状）与面状共用一套内核，不受本次改动影响');
const corridor = planCorridor({
  centerline: [
    [113.493, 23.091],
    [113.4945, 23.092],
    [113.496, 23.0928],
  ],
  halfWidth: 20,
  extend: 20,
  spacing: 30,
  margin: 0,
  maxWaypoints: 1500,
});
check('带状仍按工字形生成', corridor.stats.stripCount >= 2 && corridor.strips[0].length === 2, `${corridor.stats.stripCount} 条扫线`);
check('扫线长度等于总带宽', (() => {
  const f = makeLocalFrame(113.493, 23.091);
  const a = f.toXY(corridor.strips[0][0]);
  const b = f.toXY(corridor.strips[0][1]);
  return near(Math.hypot(a[0] - b[0], a[1] - b[1]), 40, 1.5);
})(), '40 m');

console.log(`\n结果：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.log('失败项：' + fails.join(' / '));
  process.exit(1);
}
