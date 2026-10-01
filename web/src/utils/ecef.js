/**
 * ECEF（地心地固直角坐标）↔ WGS84 经纬高
 *
 * 司空 2 / 大疆智图导出的 3D Tiles 有两种坐标系：
 *  - 带地理参考：boundingVolume 直接是 ECEF 米制坐标（asset.gltfUpAxis = "Z"）
 *  - 不带地理参考：局部坐标（通常是 Y-up），无法可靠配准
 * 这里提供换算，用来回答两个业务问题：
 *  1. 模型在地球上哪里（画足迹 / 在卫星底图上定位）
 *  2. 鼠标停在模型的哪一点（BLH 读数，用来佐证配准正确）
 *
 * 注意：不能把 ECEF 的 Z 直接当纬度用。地心纬度与测地纬度在 22°N 附近差约 0.14°
 * （≈15 km），必须做椭球迭代，否则模型会整整偏出一个镇。
 */

const A = 6378137.0; // WGS84 长半轴
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

/** ECEF(m) → [经度°, 纬度°, 椭球高 m] */
export function ecefToLlh(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  if (p < 1e-6) {
    // 落在极轴上：经度无定义，按 0 处理
    return [0, z >= 0 ? 90 : -90, Math.abs(z) - A * Math.sqrt(1 - E2)];
  }
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i += 1) {
    const sin = Math.sin(lat);
    const N = A / Math.sqrt(1 - E2 * sin * sin);
    h = p / Math.cos(lat) - N;
    const next = Math.atan2(z, p * (1 - (E2 * N) / (N + h)));
    if (Math.abs(next - lat) < 1e-12) break;
    lat = next;
  }
  const sin = Math.sin(lat);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  h = Math.abs(Math.cos(lat)) > 1e-9 ? p / Math.cos(lat) - N : z / Math.abs(sin) - N * (1 - E2);
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI, h];
}

/** WGS84 → ECEF(m) */
export function llhToEcef(lonDeg, latDeg, h = 0) {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [
    (N + h) * cosLat * Math.cos(lon),
    (N + h) * cosLat * Math.sin(lon),
    (N * (1 - E2) + h) * sinLat,
  ];
}

/**
 * 判断一组坐标是否像 ECEF：地心矢量的模应接近地球半径（10^6 米量级）。
 * 局部坐标的模型通常是几十到几千米，量级差三四个数量级，足够区分。
 */
export function looksLikeEcef(x, y, z) {
  const r = Math.hypot(x, y, z);
  return Number.isFinite(r) && r > 1e6 && r < 2e7;
}

/** 把「半径（米）」换算成经纬度半跨度，用于给包围球画外接矩形 */
export function radiusToDegrees(latDeg, radiusM) {
  const dLat = radiusM / 111132.92;
  const dLon = radiusM / (111412.84 * Math.cos((latDeg * Math.PI) / 180) || 1e-6);
  return { dLat: Math.abs(dLat), dLon: Math.abs(dLon) };
}

/**
 * 3D Tiles 的 boundingVolume.box（12 元：中心 + 三条半轴）→ WGS84 经纬度矩形。
 * 直接拿中心点当地理中心是不够的：大模型的八个角能差出几百米，
 * 画足迹时必须把整盒的角点都换算一遍取并集。
 */
export function boxVolumeToBounds(box) {
  const [cx, cy, cz, ux, uy, uz, vx, vy, vz, wx, wy, wz] = box;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minH = Infinity;
  let maxH = -Infinity;
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      for (const c of [-1, 1]) {
        const llh = ecefToLlh(
          cx + a * ux + b * vx + c * wx,
          cy + a * uy + b * vy + c * wy,
          cz + a * uz + b * vz + c * wz
        );
        minLon = Math.min(minLon, llh[0]);
        maxLon = Math.max(maxLon, llh[0]);
        minLat = Math.min(minLat, llh[1]);
        maxLat = Math.max(maxLat, llh[1]);
        minH = Math.min(minH, llh[2]);
        maxH = Math.max(maxH, llh[2]);
      }
    }
  }
  return { minLon, maxLon, minLat, maxLat, minH, maxH };
}

/** 格式化经纬度为易读字符串 */
export function fmtLlh(lon, lat, h) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const s =
    `${Math.abs(lat).toFixed(6)}°${ns} ${Math.abs(lon).toFixed(6)}°${ew}` +
    (Number.isFinite(h) ? ` · ${h.toFixed(1)} m` : '');
  return s;
}

/** 面积格式化：大疆智图的习惯是同时给平方米与主业单位（亩 / 公顷） */
export function fmtArea(m2) {
  const mu = m2 / 666.6667;
  if (m2 >= 1e6) return `${m2.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} ㎡（${(m2 / 1e6).toFixed(3)} k㎡ · ${mu.toFixed(2)} 亩）`;
  return `${m2.toFixed(2)} ㎡（${mu.toFixed(3)} 亩）`;
}
