/**
 * 航线几何：面状测区 → 往返扫描航带 → 航点序列
 *
 * 设计取舍（与竞品览达智航的关键差异，都是踩过的坑）：
 *  1. 用**局部切平面投影（ENU，米）**而不是 111320 m/deg 平面近似。
 *     后者在大测区上会有米级误差，且纬度越高经向误差越大。
 *  2. 航带数用 ceil(width / spacing) 且**居中布带**，不用「+2」的补边写法——
 *     那会产生一批裁剪后为空的无效航带（览达的实际行为）。
 *  3. 点数超限时**按更大间距重算并如实上报 adjusted**，不做「静默拉大间距」——
 *     静默改间距会让航向重叠悄悄不达标，而 UI 完全看不出来。
 *  4. 凹多边形用「交点排序 + 子段中点内测」双重校验，避免把多边形外的空档连成一条线。
 *
 * 纯函数、无 IO，便于单测。
 */

const DEG = Math.PI / 180;

/**
 * 局部切平面（ENU，米）投影：以给定中心为原点
 * 纬度用 WGS84 级数展开，比固定 111320 精确一个量级
 */
export function makeLocalFrame(centerLon, centerLat) {
  const lat0 = centerLat * DEG;
  const mLat =
    111132.92 - 559.82 * Math.cos(2 * lat0) + 1.175 * Math.cos(4 * lat0) - 0.0023 * Math.cos(6 * lat0);
  const mLng = 111412.84 * Math.cos(lat0) - 93.5 * Math.cos(3 * lat0) + 0.118 * Math.cos(5 * lat0);
  return {
    mLat,
    mLng,
    /** [lon,lat] → [x(东),y(北)] 米 */
    toXY: ([lon, lat]) => [(lon - centerLon) * mLng, (lat - centerLat) * mLat],
    /** [x,y] 米 → [lon,lat] */
    toLL: ([x, y]) => [centerLon + x / mLng, centerLat + y / mLat],
  };
}

/** 多边形面积（鞋带公式，输入为 XY 米坐标，取绝对值） */
export function areaXY(xy) {
  let s = 0;
  for (let i = 0, n = xy.length; i < n; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** 外包矩形 */
export function bboxXY(xy) {
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** 点是否在多边形内（射线法，XY 平面） */
export function pointInPolygonXY(pt, poly) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 两点距离（XY 米） */
const distXY = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * 把多边形投影到「航线坐标系」：
 *   s = 沿航线方向（direction 为从北顺时针的角度，与 WPML 的 <wpml:direction> 一致）
 *   t = 垂直航线方向（航带排列方向）
 * 在这个坐标系里，每条航带就是一条水平线 t = const，裁剪退化成一维求交，精确且无退化情况。
 */
function toRouteFrame(xy, directionDeg) {
  const th = (Number(directionDeg) || 0) * DEG;
  const ux = Math.sin(th);
  const uy = Math.cos(th);
  const vx = Math.cos(th);
  const vy = -Math.sin(th);
  return xy.map(([x, y]) => ({ s: x * ux + y * uy, t: x * vx + y * vy }));
}

/** 从航线坐标还原到平面 XY */
function fromRouteFrame(s, t, directionDeg) {
  const th = (Number(directionDeg) || 0) * DEG;
  const ux = Math.sin(th);
  const uy = Math.cos(th);
  const vx = Math.cos(th);
  const vy = -Math.sin(th);
  return [s * ux + t * vx, s * uy + t * vy];
}

/**
 * 一条水平线 t = tc 与多边形的交段（返回 [[s1,s2], ...]，已按 s 升序）
 * 凹多边形会切出多段，逐段用中点内测过滤掉落在多边形外的空档。
 */
function clipHorizontal(st, tc) {
  const hits = [];
  for (let i = 0, n = st.length; i < n; i++) {
    const a = st[i];
    const b = st[(i + 1) % n];
    const da = a.t - tc;
    const db = b.t - tc;
    // 端点恰在线上会重复计入，这里只取严格穿越，端点情况由相邻边补上
    if (da === 0) hits.push(a.s);
    else if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      hits.push(a.s + (tc - a.t) * ((b.s - a.s) / (b.t - a.t)));
    }
  }
  hits.sort((p, q) => p - q);
  const segs = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const s1 = hits[i];
    const s2 = hits[i + 1];
    if (s2 - s1 <= 1e-6) continue;
    const mid = { s: (s1 + s2) / 2, t: tc };
    if (pointInPolygonXY([mid.s, mid.t], st.map((p) => [p.s, p.t]))) segs.push([s1, s2]);
  }
  return segs;
}

/**
 * 面状测区展开为往返航带
 *
 * @param {object} opts
 * @param {[number,number][]} opts.polygon   测区顶点 [[lon,lat],...]（WGS84），顺时针/逆时针均可
 * @param {number} opts.direction            主航线角（度，从北顺时针）
 * @param {number} opts.spacing              航线间距（米，航带之间）
 * @param {number} opts.wpSpacing            航点间距（米，同一航带内）
 * @param {number} [opts.margin]             外扩距离（米），让航带两端超出测区边界
 * @param {number} [opts.maxWaypoints]       航点上限，超过则按更大间距重算
 * @returns {object} { strips, waypoints, stats }
 */
export function planArea(opts) {
  const { polygon, direction = 0 } = opts;
  let spacing = Math.max(1, Number(opts.spacing) || 30);
  let wpSpacing = Math.max(1, Number(opts.wpSpacing) || 40);
  const margin = Math.max(0, Number(opts.margin) || 0);
  const maxWaypoints = Number(opts.maxWaypoints) || 1500;

  if (!Array.isArray(polygon) || polygon.length < 3) {
    throw new Error('测区至少需要 3 个顶点');
  }

  const bb0 = {
    minLon: Math.min(...polygon.map((p) => p[0])),
    maxLon: Math.max(...polygon.map((p) => p[0])),
    minLat: Math.min(...polygon.map((p) => p[1])),
    maxLat: Math.max(...polygon.map((p) => p[1])),
  };
  const center = [(bb0.minLon + bb0.maxLon) / 2, (bb0.minLat + bb0.maxLat) / 2];
  const frame = makeLocalFrame(center[0], center[1]);
  const xy = polygon.map(frame.toXY);
  const areaM2 = areaXY(xy);
  const st = toRouteFrame(xy, direction);

  const ts = st.map((p) => p.t);
  const tMin = Math.min(...ts) - margin;
  const tMax = Math.max(...ts) + margin;
  const width = tMax - tMin;

  /** 按给定间距生成一次（提取成闭包，点数超限时换间距重跑） */
  const generate = (sp, wps) => {
    const n = Math.max(1, Math.ceil(width / sp));
    const strips = [];
    for (let i = 0; i < n; i++) {
      // 居中布带：避免首尾两带贴边导致的半带空飞
      const tc = tMin + ((i + 0.5) * width) / n;
      const segs = clipHorizontal(st, tc);
      if (!segs.length) continue;
      const pts = [];
      for (const [s1, s2] of segs) {
        const a = s1 - margin;
        const b = s2 + margin;
        const len = b - a;
        if (len <= 0.5) continue;
        const cnt = Math.max(2, Math.ceil(len / wps) + 1);
        for (let k = 0; k < cnt; k++) {
          const s = a + (len * k) / (cnt - 1);
          pts.push(fromRouteFrame(s, tc, direction));
        }
      }
      if (!pts.length) continue;
      // 往返（弓字）：奇数带整体反向，使相邻航带首尾相接，减少空飞
      if (strips.length % 2 === 1) pts.reverse();
      strips.push(pts);
    }
    return strips;
  };

  let strips = generate(spacing, wpSpacing);
  let adjusted = false;
  let total = strips.reduce((acc, s) => acc + s.length, 0);
  // 超限按更大间距重算（如实上报，不静默改参数）
  let guard = 0;
  while (total > maxWaypoints && guard++ < 12) {
    spacing = spacing * 1.25;
    wpSpacing = wpSpacing * 1.25;
    strips = generate(spacing, wpSpacing);
    total = strips.reduce((acc, s) => acc + s.length, 0);
    adjusted = true;
  }

  const waypoints = [];
  let lengthM = 0;
  let prev = null;
  for (const strip of strips) {
    for (const p of strip) {
      if (prev) lengthM += distXY(prev, p);
      prev = p;
      waypoints.push(frame.toLL(p));
    }
  }

  return {
    strips: strips.map((s) => s.map(frame.toLL)),
    waypoints: waypoints.map(([lon, lat]) => ({ lon, lat })),
    stats: {
      areaM2: Math.round(areaM2),
      stripCount: strips.length,
      waypointCount: waypoints.length,
      lengthM: Math.round(lengthM),
      spacing: Math.round(spacing * 10) / 10,
      wpSpacing: Math.round(wpSpacing * 10) / 10,
      adjusted,
      maxWaypoints,
    },
  };
}

/** 折线总长度（XY 米） */
export function polylineLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += distXY(points[i - 1], points[i]);
  return s;
}

/**
 * 沿折线按给定距离做偏移（miter 连接）
 * 用于带状航线：把中心线左右各偏移出若干条平行航带。
 * 尖角处 miter 会拉长，这里限制在 4 倍偏移距离以内，避免生成飞出去的怪点。
 */
export function offsetPolyline(pts, dist) {
  const n = pts.length;
  if (n < 2) return pts.map((p) => [p[0], p[1]]);
  const segNormals = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy) || 1;
    segNormals.push([-dy / len, dx / len]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const nPrev = segNormals[Math.max(0, i - 1)];
    const nNext = segNormals[Math.min(segNormals.length - 1, i)];
    let mx = nPrev[0] + nNext[0];
    let my = nPrev[1] + nNext[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      // 180° 折返：法向抵消，直接用当前段法向
      mx = nNext[0];
      my = nNext[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    const dot = mx * nNext[0] + my * nNext[1];
    const scale = Math.abs(dot) < 1e-6 ? 1 : 1 / dot;
    const limited = Math.max(-4, Math.min(4, scale));
    out.push([pts[i][0] + mx * dist * limited, pts[i][1] + my * dist * limited]);
  }
  return out;
}

/** 沿折线按间距均匀加密（保留首末端点） */
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const len = distXY(a, b);
    const cnt = Math.max(1, Math.ceil(len / step));
    for (let k = 1; k <= cnt; k++) {
      out.push([a[0] + ((b[0] - a[0]) * k) / cnt, a[1] + ((b[1] - a[1]) * k) / cnt]);
    }
  }
  return out;
}

/**
 * 带状航线（工字形）：中心线 → 左右外扩成走廊面 → 垂直于中心线的往返扫线
 *
 * 与面状（planArea）的本质区别：
 *   面状是**固定角度**的平行扫描，拐不了弯，适合地块；
 *   带状的每条扫线都**垂直于中心线的局部走向**，扫线之间沿走廊同一侧边缘连接，
 *   整体呈连续的「工」字/梯子形，能贴着河道、道路、管线走廊拐弯走。
 *
 * 流程与用户在地图上的操作顺序一一对应：
 *   1. 画一条多顶点的中心线
 *   2. 指定「左右各外扩多少米」（halfWidth，默认 20 m）→ 缓冲出走廊面 buffer
 *   3. 在这个面里按 spacing 沿中心线布横向扫线，每条扫线与面的边界求交得到端点
 *   4. 扫线端点按奇偶反向，相邻扫线沿同一侧边缘串起来 → 一条连续可飞的航线
 *
 * @param {object} opts
 * @param {[number,number][]} opts.centerline 中心线顶点 [[lon,lat],...]
 * @param {number} opts.halfWidth             左右各外扩的半宽（米），总带宽 = 2×halfWidth
 * @param {number} opts.spacing               扫线间距（米，沿中心线量）
 * @param {number} [opts.extend]              两端外延（米），保证端点覆盖
 * @param {number} [opts.margin]              扫线两端超出边界的外扩（米）
 */
export function planCorridor(opts) {
  const { centerline } = opts;
  let spacing = Math.max(1, Number(opts.spacing) || 30);
  const halfWidth = Math.max(1, Number(opts.halfWidth ?? (Number(opts.width) || 40) / 2) || 20);
  const extend = Math.max(0, Number(opts.extend) || 0);
  const margin = Math.max(0, Number(opts.margin) || 0);
  const maxWaypoints = Number(opts.maxWaypoints) || 1500;

  if (!Array.isArray(centerline) || centerline.length < 2) {
    throw new Error('带状航线至少需要 2 个中心线顶点');
  }

  const lons = centerline.map((p) => p[0]);
  const lats = centerline.map((p) => p[1]);
  const center = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const frame = makeLocalFrame(center[0], center[1]);

  let raw = dedupe(centerline.map(frame.toXY));
  if (raw.length < 2) throw new Error('中心线退化成一个点，请重新绘制');
  // 两端各外延一段，避免端点处漏拍
  if (extend > 0) raw = extendEnds(raw, extend);
  // 弧长参数化：细分成 ≤2 m 的折线，拐弯处的切线才稳定
  const path = densify(raw, Math.max(0.5, Math.min(2, spacing / 8)));
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distXY(path[i - 1], path[i]));
  const totalLen = cum[cum.length - 1];
  if (!(totalLen > 0)) throw new Error('中心线长度为 0，请重新绘制');

  // 走廊面（左右各外扩 halfWidth 后的闭合多边形）
  const buffer = buildCorridorBuffer(path, halfWidth);
  const areaM2 = areaXY(buffer);

  /** 按给定扫线间距生成一次；返回扫线数组与串联后的航点序列 */
  const generate = (sp) => {
    const cnt = Math.max(1, Math.round(totalLen / sp));
    const step = totalLen / cnt;
    const rungs = [];
    const seq = [];
    for (let i = 0; i <= cnt; i++) {
      const s = i * step;
      // 奇偶反向：相邻扫线首尾落在同一侧，中间那段就是「工」字的横边
      const enter = i % 2 === 0 ? -1 : 1;
      const exit = -enter;
      const a = boundaryAt(path, cum, buffer, s, enter, halfWidth, margin);
      const b = boundaryAt(path, cum, buffer, s, exit, halfWidth, margin);
      rungs.push([a, b]);
      seq.push(a, b);
      if (i < cnt) {
        // 沿同一侧边缘走到下一条扫线：曲线段上取中点，
        // 否则走廊拐弯时会「切弦」飞出边界。
        seq.push(boundaryAt(path, cum, buffer, s + step / 2, exit, halfWidth, margin));
      }
    }
    return { cnt, step, rungs, seq };
  };

  let r = generate(spacing);
  let adjusted = false;
  let guard = 0;
  while (r.seq.length > maxWaypoints && guard++ < 14) {
    spacing *= 1.25;
    r = generate(spacing);
    adjusted = true;
  }

  const waypoints = [];
  let lengthM = 0;
  let prev = null;
  for (const p of r.seq) {
    if (prev) lengthM += distXY(prev, p);
    prev = p;
    waypoints.push(frame.toLL(p));
  }

  return {
    strips: r.rungs.map((g) => g.map(frame.toLL)),
    waypoints: waypoints.map(([lon, lat]) => ({ lon, lat })),
    /** 完整飞行路径（含沿边缘的连接段），供预览画「工」字 */
    flightPath: r.seq.map(frame.toLL),
    // 缓冲后的边界多边形：给 template.kml 用（沿用已验证的 mapping2d 面状模板，不冒险用未验证的带状模板）
    buffer: buffer.map(frame.toLL),
    stats: {
      areaM2: Math.round(areaM2),
      lengthCenterlineM: Math.round(totalLen),
      stripCount: r.cnt + 1,
      waypointCount: waypoints.length,
      lengthM: Math.round(lengthM),
      spacing: Math.round(r.step * 10) / 10,
      width: Math.round(halfWidth * 2),
      halfWidth: Math.round(halfWidth * 10) / 10,
      bearing: Math.round(bearingDeg(frame.toLL(raw[0]), frame.toLL(raw[raw.length - 1]))),
      adjusted,
      maxWaypoints,
    },
  };
}

/** 相邻重复点会让切线退化，先去掉 */
function dedupe(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (distXY(pts[i - 1], pts[i]) > 1e-6) out.push(pts[i]);
  return out;
}

function unitVec(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/** 中心线两端各外延 extend 米 */
function extendEnds(xy, extend) {
  const n = xy.length;
  const u0 = unitVec(xy[1], xy[0]);
  const u1 = unitVec(xy[n - 2], xy[n - 1]);
  return [
    [xy[0][0] + u0[0] * extend, xy[0][1] + u0[1] * extend],
    ...xy,
    [xy[n - 1][0] + u1[0] * extend, xy[n - 1][1] + u1[1] * extend],
  ];
}

/**
 * 直线 P + t·d 与闭合多边形的交段（P 在多边形内部）
 * @returns {[number,number]|null} [tNeg, tPos]，分别是最靠近 P 的负向/正向交点
 */
function clipLineThroughPolygon(poly, P, d) {
  let neg = -Infinity;
  let pos = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const A = poly[i];
    const B = poly[(i + 1) % n];
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const denom = ex * d[1] - ey * d[0];
    if (Math.abs(denom) < 1e-12) continue; // 与该边平行
    const qx = P[0] - A[0];
    const qy = P[1] - A[1];
    const u = (qx * d[1] - qy * d[0]) / denom; // 沿边的参数
    if (u < 0 || u > 1) continue;
    const t = (qx * ey - qy * ex) / denom; // 沿直线的参数
    if (Math.abs(t) < 1e-9) continue;
    if (t < 0) neg = Math.max(neg, t);
    else pos = Math.min(pos, t);
  }
  if (!Number.isFinite(neg) || !Number.isFinite(pos)) return null;
  return [neg, pos];
}

/** 按弧长在折线上定位，返回点与单位切线 */
function arcLocate(path, cum, s) {
  const n = path.length;
  if (s <= 0) return { p: path[0], t: unitVec(path[0], path[1]) };
  const total = cum[cum.length - 1];
  if (s >= total) return { p: path[n - 1], t: unitVec(path[n - 2], path[n - 1]) };
  let lo = 0;
  let hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = path[lo];
  const b = path[lo + 1];
  const seg = cum[lo + 1] - cum[lo] || 1;
  const r = (s - cum[lo]) / seg;
  return { p: [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r], t: unitVec(a, b) };
}

/**
 * 走廊边界上的点：在弧长 s 处沿法向走到边界，再往外多走 margin
 * @param {number} side +1 左侧 / -1 右侧
 */
function boundaryAt(path, cum, poly, s, side, halfWidth, margin) {
  const { p, t } = arcLocate(path, cum, s);
  const nx = -t[1];
  const ny = t[0];
  const clip = clipLineThroughPolygon(poly, p, [nx, ny]);
  const d = clip ? (side > 0 ? clip[1] : -clip[0]) : halfWidth;
  const off = side > 0 ? d + margin : -(d + margin);
  return [p[0] + nx * off, p[1] + ny * off];
}

/** 走廊缓冲面：左偏移 + 反向的右偏移，闭合成多边形 */
function buildCorridorBuffer(xy, halfWidth) {
  const left = offsetPolyline(xy, halfWidth);
  const right = offsetPolyline(xy, -halfWidth).reverse();
  return [...left, ...right];
}

function bearingDeg(a, b) {
  const dLon = (b[0] - a[0]) * DEG;
  const lat1 = a[1] * DEG;
  const lat2 = b[1] * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

export { DEG };
