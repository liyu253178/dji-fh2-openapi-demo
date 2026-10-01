/**
 * WPML 读取与反演
 *
 * 用途有两个，都是「拉取现有司空航线数据进行对比」这一诉求的落地：
 *  1. 从本队同型号的真实航线里**反演出机型参数**（载荷枚举、航线间距系数），
 *     避免硬编码机型表——换一个型号接进来，只要库里有它的航线就能自学习。
 *  2. 生成完先跟参考航线做字段级 diff（闸 0），能在本地挡住的问题不浪费一次上传。
 *
 * 只读解析，用正则取字段：司空 2 返回的 WPML 结构稳定，无需引入 XML 依赖。
 */

import { unpackKmz } from './kmzPacker.js';
import { makeLocalFrame } from './routePlanner.js';

const first = (re, text) => {
  const m = text && text.match(re);
  return m ? m[1] : null;
};

/** 从 KMZ 文本里取出两个文件内容 */
export function splitKmzText(files) {
  let template = null;
  let waylines = null;
  for (const [name, content] of Object.entries(files)) {
    if (/template\.kml$/i.test(name)) template = content;
    else if (/waylines\.wpml$/i.test(name)) waylines = content;
  }
  return { template, waylines };
}

/** 取 WPML 版本号（命名空间里的 1.0.x） */
export function wpmlVersion(text = '') {
  return first(/wpmz\/(1\.\d+(?:\.\d+)?)/, text);
}

/** 解析面状模板的关键参数 */
export function parseTemplate(text) {
  if (!text) return null;
  const num = (re) => {
    const v = first(re, text);
    return v === null ? null : Number(v);
  };
  const coords = first(/<coordinates>([\s\S]*?)<\/coordinates>/, text);
  const polygon = coords
    ? coords
        .trim()
        .split(/\s+/)
        .map((s) => s.split(',').map(Number))
        .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .map(([lon, lat]) => [lon, lat])
    : [];
  return {
    version: wpmlVersion(text),
    templateType: first(/<wpml:templateType>([^<]+)<\/wpml:templateType>/, text),
    droneEnumValue: num(/<wpml:droneEnumValue>(\d+)<\/wpml:droneEnumValue>/),
    droneSubEnumValue: num(/<wpml:droneSubEnumValue>(\d+)<\/wpml:droneSubEnumValue>/),
    payloadEnumValue: num(/<wpml:payloadEnumValue>(\d+)<\/wpml:payloadEnumValue>/),
    payloadPositionIndex: num(/<wpml:payloadPositionIndex>(\d+)<\/wpml:payloadPositionIndex>/),
    coordinateMode: first(/<wpml:coordinateMode>([^<]+)<\/wpml:coordinateMode>/, text),
    heightMode: first(/<wpml:heightMode>([^<]+)<\/wpml:heightMode>/, text),
    globalShootHeight: num(/<wpml:globalShootHeight>([\d.]+)<\/wpml:globalShootHeight>/),
    autoFlightSpeed: num(/<wpml:autoFlightSpeed>([\d.]+)<\/wpml:autoFlightSpeed>/),
    shootType: first(/<wpml:shootType>([^<]+)<\/wpml:shootType>/, text),
    direction: num(/<wpml:direction>(-?[\d.]+)<\/wpml:direction>/),
    overlapH: num(/<wpml:orthoCameraOverlapH>([\d.]+)<\/wpml:orthoCameraOverlapH>/),
    overlapW: num(/<wpml:orthoCameraOverlapW>([\d.]+)<\/wpml:orthoCameraOverlapW>/),
    polygon,
  };
}

/** 解析展开后的航点坐标 */
export function parseWaypoints(text) {
  if (!text) return [];
  const out = [];
  const re = /<coordinates>\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*<\/coordinates>/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({ lon: Number(m[1]), lat: Number(m[2]) });
  }
  return out;
}

/** 取首个 actionGroup 的动作函数名，用于对比拍照方式 */
export function parseActionFuncs(text = '') {
  const out = new Set();
  const re = /<wpml:actionActuatorFunc>([^<]+)<\/wpml:actionActuatorFunc>/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

const median = (arr) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

/** 取 payloadLensIndex（实测航线里写作 "visable" 或 "visable,ir"） */
export function parseLensIndex(text = '') {
  const m = text.match(/<wpml:payloadLensIndex>([^<]+)<\/wpml:payloadLensIndex>/);
  if (!m) return ['wide'];
  const raw = m[1].toLowerCase();
  const out = [];
  if (raw.includes('ir')) out.push('ir');
  if (raw.includes('visable') || raw.includes('visible')) out.push('wide');
  return out.length ? out : ['wide'];
}

/**
 * 从一条真实航线反演「航带间距系数」swathK
 *
 * 原理：航带间距 = 航高 × (等效画幅宽/等效焦距) × (1 − 旁向重叠率)
 *                 ⇒ swathK = spacing / (H × (1 − W))
 * 这样就不必硬编码相机参数——库里有一条该型号的真实航线就能学出来。
 *
 * ⚠️ 只反演 swathK，**不反演航点间距**：WPML 1.0.6 用 betweenAdjacentPoints +
 *    startTimeLapse 按时间连拍，真实航线里每条航带通常只存首尾两个航点
 *    （本机队航线实测：325m 见方的测区只有 44 个航点 = 22 带 × 2 点），
 *    所以航点间距在这里没有物理含义，拿来反演会得到 0.2m 这种荒谬值。
 */
export function calibrateFromWayline(template, waypoints, lensKeys = ['wide']) {
  if (!template || waypoints.length < 4) return null;
  const H = template.globalShootHeight;
  const W = template.overlapW;
  if (!H || W === null || W === undefined) return null;
  const dir = template.direction || 0;

  const lons = waypoints.map((p) => p.lon);
  const lats = waypoints.map((p) => p.lat);
  const center = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const frame = makeLocalFrame(center[0], center[1]);
  const xy = waypoints.map((p) => frame.toXY([p.lon, p.lat]));

  const th = (dir * Math.PI) / 180;
  const ux = Math.sin(th);
  const uy = Math.cos(th);
  const vx = Math.cos(th);
  const vy = -Math.sin(th);
  const proj = xy.map(([x, y]) => ({ s: x * ux + y * uy, t: x * vx + y * vy }));

  /**
   * 航带间距提取：用「间距众数」而不是聚类。
   *
   * 同一航带的两个端点在 t 上并不严格相等（航向角导致的 0.1m 级抖动），
   * 按固定精度聚类会把一条带拆成多条（实测 22 带被拆成 43 组，间距算成 0.3m）。
   * 但相邻航带间距是恒定的，所以对所有 t 排序后取相邻差的**众数**即可得到真实间距；
   * 同一带内的近零差被 0.5m 阈值过滤掉。
   */
  const ts = proj.map((p) => p.t).sort((a, b) => a - b);
  const buckets = new Map();
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d < 0.5) continue; // 同一航带内的抖动
    const k = Math.round(d * 2) / 2; // 0.5m 分辨率
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  let spacing = null;
  let hitCount = 0;
  for (const [k, c] of buckets) {
    if (c > hitCount) {
      hitCount = c;
      spacing = k;
    }
  }
  // 结构校验：间距至少要重复出现 4 次，且能凑出 4 条以上航带。
  // 只存多边形顶点的测试航线过不了这一关（实测会算出 0.019 这种荒谬系数）。
  if (!spacing || spacing <= 0 || hitCount < 4) return null;
  const strips = Math.round((ts[ts.length - 1] - ts[0]) / spacing) + 1;
  if (strips < 4) return null;

  const swathK = spacing / (H * (1 - W / 100));
  // 合理性闸门：系数落到 0.1–3.0（等效焦距 12–360mm）之外说明不是标准平行航带结构
  if (!(swathK > 0.1 && swathK < 3.0)) return null;

  return {
    swathK,
    lensKeys,
    sample: { height: H, overlapW: W, spacing, strips, waypoints: waypoints.length, hits: hitCount },
  };
}

/** 读取一条 KMZ（Buffer）→ 结构化参考信息 */
export function inspectKmz(buf) {
  const files = unpackKmz(buf);
  const { template: tplText, waylines: wplText } = splitKmzText(files);
  const template = parseTemplate(tplText);
  const waypoints = parseWaypoints(wplText);
  const lensKeys = parseLensIndex(wplText || tplText || '');
  const calib = template ? calibrateFromWayline(template, waypoints, lensKeys) : null;
  return {
    lensKeys,
    files: Object.keys(files),
    template,
    waypointCount: waypoints.length,
    actionFuncs: parseActionFuncs(wplText || ''),
    version: wpmlVersion(tplText || wplText || ''),
    calibration: calib,
  };
}

/**
 * 把我们生成的航线与同型号参考航线做字段级对比
 * 只对比「会影响能否飞」的关键项，不做全文 diff（版本/时间戳之类别进来制造噪声）
 */
export function compareWithReference(mine, ref) {
  if (!ref?.template) return { available: false, diffs: [], message: '本机队暂无同型号参考航线，跳过对比' };
  const pairs = [
    ['droneEnumValue', mine.droneEnumValue, ref.template.droneEnumValue],
    ['droneSubEnumValue', mine.droneSubEnumValue, ref.template.droneSubEnumValue],
    ['payloadEnumValue', mine.payloadEnumValue, ref.template.payloadEnumValue],
    ['coordinateMode', mine.coordinateMode, ref.template.coordinateMode],
    ['heightMode', mine.heightMode, ref.template.heightMode],
    ['shootType', mine.shootType, ref.template.shootType],
  ];
  const diffs = [];
  for (const [k, a, b] of pairs) {
    if (a === undefined || a === null || b === undefined || b === null) continue;
    if (String(a) !== String(b)) diffs.push({ field: k, mine: a, reference: b });
  }
  if (ref.actionFuncs?.length) {
    const missing = ref.actionFuncs.filter((f) => !(mine.actionFuncs || []).includes(f));
    if (missing.length) diffs.push({ field: 'actionFuncs', mine: mine.actionFuncs || [], reference: ref.actionFuncs });
  }
  return { available: true, diffs, message: diffs.length ? `${diffs.length} 项与参考航线不一致` : '与同型号参考航线一致' };
}
