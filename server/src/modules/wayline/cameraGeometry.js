/**
 * 摄站几何解算：任务参数（GSD / 航高 / 倾角 / 重叠率）→ 飞行几何参数（相对航高、摄影基线、航线间距）
 *
 * 为什么要单独抽这个模块（对照专家给出的四点结构）：
 *
 * 【一、基础参数解算】
 *   GSD 与航高是同一个公式的两端，任何一端都能作为输入：
 *       GSD = H · frameW / (f · imageW)      ← 由航高算地面分辨率
 *       H   = GSD · f · imageW / frameW      ← 由 GSD 反算相对航高（用户给的公式 H = f·GSD/δ）
 *   这里 f/frameW 用的是**等效焦距与等效画幅**（35mm 口径），δ = frameW/imageW 就是等效像元尺寸，
 *   两式完全等价，不需要真的知道传感器物理尺寸。
 *
 *   关键在于：一旦云台俯仰偏离 −90°（倾斜摄影），单张影像在地面上的覆盖就不再是矩形，
 *   而是沿倾斜方向被拉长的**梯形**，近端窄、远端宽。此时：
 *       B_base = L_ground · (1 − O_forward)    只对「矩形」成立；
 *       D_line = W_ground · (1 − O_side)       同上。
 *   倾斜时 L/W 取哪个值？窄端偏保守导致航带过密，宽端偏激进会在窄端漏拍。
 *   本模块的解法：不套近似公式，直接**按中心投影几何把影像四角投到地面得到真实 footprint 四边形**，
 *   再用「凸多边形平移求交」算出相邻两张的真实重叠面积比，最后二分反解出满足目标重叠率的
 *   摄影基线 B 与航线间距 D。
 *   ——这条链路在 θ=0（正射）时会精确退化回上面两个经典公式（见 scripts/verify-grid-geometry.mjs），
 *     在 θ≠0 时才体现它的价值：两组井字航线的间距会被自动解算出不同的值。
 *
 * 【四、iter 迭代调整接口】专家要求「参数解算模块需保留迭代调整接口，为仿地飞行或重叠率动态修正留出空间」：
 *   下面的解算过程全部是 height / tilt 的**纯函数**（见 makeHeightSolver），
 *   后续做仿地飞行（逐点按地形高程重解 N member）时，只需对每个航点重调同一个函数即可，
 *   不用改结构。见 makeHeightSolver()。
 *
 * 纯函数、无 IO，便于单测。
 */

const DEG = Math.PI / 180;

/** 默认成像底片：Matrice 4 系列可见光 8064×6048（4:3），等效画幅取 36×27 */
export const SENSOR = { frameW: 36, frameH: 27, imageW: 8064, imageH: 6048 };

/** 单条光线的最大天底夹角：超过这个角度射线几乎擦地平线，数值上不可用（也不会有可用的影像） */
const MAX_RAY_DEG = 88;

/** 等效像元尺寸（mm）：δ = 画幅宽 / 横向像素数 */
export const pixelSizeMm = ({ frameW = SENSOR.frameW, imageW = SENSOR.imageW } = {}) => frameW / imageW;

/** 由地面分辨率反算相对航高（米）。H = GSD·f/δ */
export function heightFromGsd({ gsdCm, focalEq, frameW = SENSOR.frameW, imageW = SENSOR.imageW }) {
  const gsdM = Number(gsdCm) / 100;
  if (!(gsdM > 0) || !(focalEq > 0)) return NaN;
  return (gsdM * imageW * focalEq) / frameW;
}

/** 由航高算地面分辨率（厘米/像素） */
export function gsdFromHeight({ height, focalEq, frameW = SENSOR.frameW, imageW = SENSOR.imageW }) {
  if (!(height > 0) || !(focalEq > 0)) return NaN;
  return (height * frameW * 100) / (focalEq * imageW);
}

/* ------------------------------------------------------------------ *
 * 形：工作任务单张影像的地面投影（footprint）
 * ------------------------------------------------------------------ */

/**
 * 单张影像的地面覆盖四边形（倾斜／正射通用）
 *
 * 坐标系：以天底点为原点，x = 倾斜方向（机身前方），y = 侧方，单位米。
 * 针孔模型：相机位于 (0,0,H)，视线前向 fwd、右向 right、影像上方 up 构成正交基，
 * 影像角点 (±halfW, ±halfH) 对应的光线 intersect 地面平面 z=0。
 *
 * @returns {{points:[number,number][], area:number, halfAlong:number, halfCross:number, clamped:boolean, tiltDeg:number}}
 *          points 为**逆时针**顺序；clamped 为 true 表示远端光线已越过可用角度，已对远端做了裁剪。
 */
export function groundFootprint({
  height,
  focalEq,
  frameW = SENSOR.frameW,
  frameH = SENSOR.frameH,
  tiltDeg = 0,
}) {
  const H = Math.max(0.1, Number(height) || 0.1);
  const f = Number(focalEq) || 24;
  const th = (Number(tiltDeg) || 0) * DEG;

  // 机身坐标系：θ=0 时前向指地心，影像上方指向机身前方（+x），右向 +y
  const fwd = [Math.sin(th), 0, -Math.cos(th)];
  const right = [0, 1, 0];
  const up = [Math.cos(th), 0, Math.sin(th)];

  let hw = frameW / (2 * f);
  let hh = frameH / (2 * f);

  // 远端光线擦地平线的保护：沿倾斜方向的半角必须满足 θ + atan(hh) < MAX_RAY_DEG
  let clamped = false;
  const tilt = Number(tiltDeg) || 0;
  // 前方到「可用视角上限」还剩多少度：θ + atan(hh) 必须小于 MAX_RAY_DEG
  const allow = Math.tan(Math.max(0.5, MAX_RAY_DEG - tilt) * DEG);
  if (hh > allow) {
    hh = allow;
    clamped = true;
  }

  const corner = (sx, sy) => {
    const d = [
      fwd[0] + sx * hw * right[0] + sy * hh * up[0],
      fwd[1] + sx * hw * right[1] + sy * hh * up[1],
      fwd[2] + sx * hw * right[2] + sy * hh * up[2],
    ];
    if (d[2] >= -1e-9) return null; // 光线不与地面相交
    const t = -H / d[2];
    return [t * d[0], t * d[1]];
  };

  const quads = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  if (quads.some((p) => !p)) throw new Error('影像光线未与地面相交，请降低倾角或提高航高');
  let points = quads;
  const signed = signedArea(points);
  if (signed < 0) points = points.slice().reverse();

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    points,
    area: Math.abs(signed),
    minAlong: Math.min(...xs),
    maxAlong: Math.max(...xs),
    minCross: Math.min(...ys),
    maxCross: Math.max(...ys),
    height: H,
    tiltDeg: Number(tiltDeg) || 0,
    clamped,
  };
}

/* ------------------------------------------------------------------ *
 * 几何工具：面积、平移、凸多边形求交
 * ------------------------------------------------------------------ */

/** 有符号面积（逆时针为正） */
export function signedArea(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export const polygonArea = (poly) => Math.abs(signedArea(poly));

export const shiftPolygon = (poly, dx, dy) => poly.map(([x, y]) => [x + dx, y + dy]);

/** 保证逆时针序（Sutherland–Hodgman 要求 clip 多边形有向） */
function ccw(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

/**
 * 凸多边形求交（Sutherland–Hodgman 半平面裁剪）
 * footprint 与平移后的 footprint 都是凸四边形，可以直接用。
 */
export function convexIntersection(subject, clipPoly) {
  let out = ccw(subject);
  const clip = ccw(clipPoly);
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    // inside: 叉积 ≥ 0（逆时针多边形左侧为内）
    const side = (p) => ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const sc = side(cur);
      const sp = side(prev);
      if (sc >= 0) {
        if (sp < 0) out.push(lineIntersect(prev, cur, a, b));
        out.push(cur);
      } else if (sp >= 0) {
        out.push(lineIntersect(prev, cur, a, b));
      }
    }
  }
  return out;
}

/** 线段 P1P2 与直线 AB 的交点（调用前已确定符号相反） */
function lineIntersect(p1, p2, a, b) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const denom = ex * dy - ey * dx;
  if (Math.abs(denom) < 1e-15) return p1;
  const t = (ex * (p1[1] - a[1]) - ey * (p1[0] - a[0])) / denom;
  return [p1[0] - t * dx, p1[1] - t * dy];
}

/* ------------------------------------------------------------------ *
 * 第三步：按目标重叠率反解「摄影基线」与「航线间距」
 * ------------------------------------------------------------------ */

/** footprint 在「飞行方向 ψ」下的度量：ψ 是飞行方向相对倾斜方向的夹角（度） */
export function footprintMetrics(footprint, psiDeg = 0) {
  const p = (Number(psiDeg) || 0) * DEG;
  const ca = Math.cos(p);
  const sa = Math.sin(p);
  let aMin = Infinity;
  let aMax = -Infinity;
  let cMin = Infinity;
  let cMax = -Infinity;
  // Width(along) 剖面：用于「最小宽度」与「平均宽度」两个保守指标
  for (const [x, y] of footprint.points) {
    const a = x * ca + y * sa;
    const c = -x * sa + y * ca;
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
    if (c < cMin) cMin = c;
    if (c > cMax) cMax = c;
  }
  const along = aMax - aMin;
  const cross = cMax - cMin;
  const area = polygonArea(footprint.points);
  return {
    along,
    cross,
    area,
    /** 平均宽度 = 面积 / 纵深：教科书公式在这个方向上真正该用的那个 W */
    meanWidth: along > 0 ? area / along : 0,
    centerAlong: (aMin + aMax) / 2,
  };
}

/**
 * footprint 与「沿某方向平移 offset 后的自身」的重叠面积比
 * @param {'along'|'cross'} axis along=相邻两张（摄影基线）／cross=相邻航带（航线间距）
 */
export function overlapRatio(footprint, psiDeg, axis, offset) {
  const p = (Number(psiDeg) || 0) * DEG;
  const ca = Math.cos(p);
  const sa = Math.sin(p);
  const dir = axis === 'along' ? [ca, sa] : [-sa, ca];
  const moved = shiftPolygon(footprint.points, dir[0] * offset, dir[1] * offset);
  const inter = convexIntersection(footprint.points, moved);
  const area0 = polygonArea(footprint.points);
  if (!(area0 > 0)) return 0;
  return polygonArea(inter) / area0;
}

/**
 * 二分反解：使面积重叠率等于 targetOverlap 的平移步长
 * 重叠率随步长单调递减（0 → 1，跨度 → 0），二分稳定收敛。
 */
export function solveStep(footprint, psiDeg, axis, targetOverlap, { minStep = 0.5 } = {}) {
  const m = footprintMetrics(footprint, psiDeg);
  const span = axis === 'along' ? m.along : m.cross;
  if (!(span > 0)) return NaN;
  const target = Math.min(0.98, Math.max(0, Number(targetOverlap) || 0));
  let lo = 0;
  let hi = span;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const r = overlapRatio(footprint, psiDeg, axis, mid);
    if (r > target) lo = mid;
    else hi = mid;
  }
  return Math.max(minStep, (lo + hi) / 2);
}

/**
 * 一趟航线的完整几何解算
 *
 * @param {object} o
 * @param {object} o.footprint  groundFootprint 的结果
 * @param {number} o.psiDeg     飞行方向相对「倾斜方向」的夹角（度）
 *                              tiltFrame='heading'（云台随航向）时为 0；
 *                              云台俯仰固定朝向某个方位时为「飞行方向 − 倾斜方位角」。
 * @param {number} o.overlapForward 航向重叠率（%）
 * @param {number} o.overlapSide    旁向重叠率（%）
 * @returns {{base:number, spacing:number, along:number, cross:number, meanWidth:number, footArea:number}}
 *          base=摄影基线（米处相邻曝光点），spacing=航线间距
 */
export function passGeometry({ footprint, psiDeg = 0, overlapForward = 80, overlapSide = 70 }) {
  const m = footprintMetrics(footprint, psiDeg);
  const base = solveStep(footprint, psiDeg, 'along', overlapForward / 100, { minStep: 1 });
  const spacing = solveStep(footprint, psiDeg, 'cross', overlapSide / 100, { minStep: 2 });
  return {
    psiDeg: Number(psiDeg) || 0,
    base: Math.round(base * 10) / 10,
    spacing: Math.round(spacing * 10) / 10,
    along: Math.round(m.along * 10) / 10,
    cross: Math.round(m.cross * 10) / 10,
    meanWidth: Math.round(m.meanWidth * 10) / 10,
    footArea: Math.round(m.area),
    // 教科书公式在这个方向上会给出多少（用于对比与自检，不用于实际规划）
    textbookSpacing: Math.round(m.cross * (1 - overlapSide / 100) * 10) / 10,
    textbookBase: Math.round(m.along * (1 - overlapForward / 100) * 10) / 10,
  };
}

/**
 * 高度 → 一趟几何 的纯函数工厂
 * 仿地飞行 / 重叠率动态修正的预留接口：对每个航点的高程重调 fn(h) 即可拿到当地的 base/spacing，
 * 不需要改动本模块的任何结构。
 */
export function makeHeightSolver({ focalEq, frameW, frameH, tiltDeg, overlapForward, overlapSide, psiDeg }) {
  return (height) => {
    const foot = groundFootprint({ height, focalEq, frameW, frameH, tiltDeg });
    return { height, footprint: foot, ...passGeometry({ footprint: foot, psiDeg, overlapForward, overlapSide }) };
  };
}

export { DEG };
