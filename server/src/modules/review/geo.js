/**
 * 几何计算与校验
 *
 * 坐标系统一 WGS84（EPSG:4326），与 DJI 原生一致。
 * 面积用球面近似（小范围内误差 < 0.1%），够监管场景用；
 * 判定违法性质时仍需以现场核实与权籍调查为准。
 */

/** 地球平均半径（米） */
const R = 6378137;
/** 每纬度对应米数 */
const M_PER_DEG = 111320;

const rad = (d) => (d * Math.PI) / 180;

/** 校验经纬度 */
export function isValidLatLon(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  return (
    Number.isFinite(la) && Number.isFinite(lo) &&
    la >= -90 && la <= 90 && lo >= -180 && lo <= 180 &&
    !(la === 0 && lo === 0) // (0,0) 是"无数据"的常见占位，排除
  );
}

/** 从 GeoJSON geometry 提取外环坐标点集 [[lng,lat], ...] */
export function outerRing(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    return geometry.coordinates?.[0] || null;
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates?.[0]?.[0] || null;
  }
  return null;
}

/**
 * 球面多边形面积（平方米）
 * 用等距圆柱近似 + shoelace 公式，对小范围（< 数公里）精度足够
 */
export function polygonArea(geometry) {
  const ring = outerRing(geometry);
  if (!ring || ring.length < 3) return 0;
  const refLat = ring.reduce((s, p) => s + Number(p[1]), 0) / ring.length;
  const kx = M_PER_DEG * Math.cos(rad(refLat));
  const ky = M_PER_DEG;
  // 投影到平面（米）
  const pts = ring.map((p) => [Number(p[0]) * kx, Number(p[1]) * ky]);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
}

/** 周长（米） */
export function polygonPerimeter(geometry) {
  const ring = outerRing(geometry);
  if (!ring || ring.length < 2) return 0;
  const refLat = ring.reduce((s, p) => s + Number(p[1]), 0) / ring.length;
  const kx = M_PER_DEG * Math.cos(rad(refLat));
  const ky = M_PER_DEG;
  const pts = ring.map((p) => [Number(p[0]) * kx, Number(p[1]) * ky]);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += Math.hypot(x2 - x1, y2 - y1);
  }
  return sum;
}

/** 几何中心点 */
export function centroid(geometry) {
  const ring = outerRing(geometry);
  if (!ring || !ring.length) return null;
  const n = ring.length;
  const lng = ring.reduce((s, p) => s + Number(p[0]), 0) / n;
  const lat = ring.reduce((s, p) => s + Number(p[1]), 0) / n;
  return { lat, lon: lng };
}

/** bbox */
export function bboxOf(geometry) {
  const ring = outerRing(geometry);
  if (!ring || !ring.length) return null;
  let minLat = Infinity; let maxLat = -Infinity;
  let minLon = Infinity; let maxLon = -Infinity;
  for (const p of ring) {
    const la = Number(p[1]); const lo = Number(p[0]);
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * 从四点（框选的左上右下）构造矩形 Polygon
 * 入参顺序不限，按 min/max 归一
 */
export function rectPolygon(p1, p2) {
  const a = { lat: Number(p1.lat), lon: Number(p1.lon) };
  const b = { lat: Number(p2.lat), lon: Number(p2.lon) };
  if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) return null;
  const minLat = Math.min(a.lat, b.lat);
  const maxLat = Math.max(a.lat, b.lat);
  const minLon = Math.min(a.lon, b.lon);
  const maxLon = Math.max(a.lon, b.lon);
  if (minLat === maxLat || minLon === maxLon) return null; // 退化成线或点
  return {
    type: 'Polygon',
    coordinates: [[
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat],
    ]],
  };
}

/**
 * 面积估算：前端框选后调此接口
 * @returns {{ok:boolean, areaM2?:number, perimeterM?:number, message?:string, dataVersion?:string}}
 */
export function estimateArea(geometry) {
  const ring = outerRing(geometry);
  if (!ring || ring.length < 3) {
    return { ok: false, message: '范围至少需要 3 个顶点' };
  }
  for (const p of ring) {
    if (!isValidLatLon(Number(p[1]), Number(p[0]))) {
      return { ok: false, message: '范围包含无效坐标' };
    }
  }
  const areaM2 = polygonArea(geometry);
  if (!Number.isFinite(areaM2) || areaM2 <= 0) {
    return { ok: false, message: '范围面积为 0，请重新框选' };
  }
  // 面积数据依据说明（对齐业务文档要求的"置信度说明"）
  const dataVersion = '基于 WGS84 球面近似计算，最终以现场核实与权籍调查为准';
  return {
    ok: true,
    areaM2: Math.round(areaM2 * 100) / 100,
    perimeterM: Math.round(polygonPerimeter(geometry) * 100) / 100,
    centroid: centroid(geometry),
    bbox: bboxOf(geometry),
    dataVersion,
  };
}

/**
 * 点是否落在多边形内（射线法）
 * 用于「点在不在图里」初筛
 */
export function pointInPolygon(lat, lon, geometry) {
  const ring = outerRing(geometry);
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = Number(ring[i][1]); const xi = Number(ring[i][0]);
    const yj = Number(ring[j][1]); const xj = Number(ring[j][0]);
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/**
 * 图斑是否与某张影像的地面覆盖范围相交
 * 用 footprint bbox 粗判（点面套合，精度足够做初筛）
 */
export function patchOverlapsImage(patchBbox, imageFootprintBbox) {
  if (!patchBbox || !imageFootprintBbox) return false;
  return !(
    patchBbox.maxLat < imageFootprintBbox.minLat ||
    patchBbox.minLat > imageFootprintBbox.maxLat ||
    patchBbox.maxLon < imageFootprintBbox.minLon ||
    patchBbox.minLon > imageFootprintBbox.maxLon
  );
}

/** 人类可读面积 */
export function formatArea(areaM2) {
  if (!Number.isFinite(areaM2)) return '—';
  if (areaM2 < 10000) return `${Math.round(areaM2)} 平方米`;
  const mu = areaM2 / 666.6667; // 亩
  if (mu < 100) return `${mu.toFixed(1)} 亩（约 ${Math.round(areaM2)} ㎡）`;
  return `${(areaM2 / 1000000).toFixed(2)} 公顷`;
}
