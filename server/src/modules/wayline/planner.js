/**
 * 规划编排：机型校验（闸 1）→ 几何展开 → 本地自检（闸 0）→ KMZ 打包
 *
 * 航线类型：
 *   mapping2d  正射面状：固定角度往返扫描，适合地块
 *   doubleGrid 井字：正射两遍，第二遍旋转 90°，重叠更充分，适合建模
 *   corridor   带状：航带跟随中心线走向，适合河道/道路/管线走廊
 *
 * 间距从哪来：
 *   spacing = 航高 × swathK × (1 − 旁向重叠率)
 *   swathK 优先取本机队真实航线反演值，没有则用镜头理论值 36/等效焦距（见 lensProfile）
 *   多镜头采集时取最窄的那颗，保证窄视场那一路也不漏拍。
 */

import { fleetModels, findModel } from './aircraftService.js';
import { planArea, planCorridor, areaXY, bboxXY, makeLocalFrame } from './routePlanner.js';
import { buildWaylineFiles } from './wpmlBuilder.js';
import { packKmz } from './kmzPacker.js';
import { compareWithReference } from './wpmlInspector.js';
import { effectiveCoef, lensIndexText, lensByKey } from './lensProfile.js';

/** 相机最小拍照间隔（DJI Matrice 4 系列实测规格 0.7s） */
const MIN_SHOOT_INTERVAL = 0.7;

export const LIMITS = {
  height: { min: 20, max: 500 },
  overlap: { min: 50, max: 90 },
  speed: { min: 1, max: 15 },
  waypoints: 1500,
  /** 带状航线：中心线左右各外扩的半宽（米），总带宽 = 2×halfWidth */
  corridorHalfWidth: { min: 5, max: 1000 },
  areaMaxM2: 50 * 1000 * 1000, // 50 km²，超过这个规模应当拆条
};

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 带状航线的半宽（左右各外扩多少米），默认 20。
 * 主参数是 corridorHalfWidth；旧字段 corridorWidth 是「总带宽」，按一半折算，
 * 避免同名不同义（不能让旧调用方的 80m 突然变成 160m）。
 */
export function corridorHalfWidth(params = {}) {
  if (params.corridorHalfWidth !== undefined && params.corridorHalfWidth !== null && params.corridorHalfWidth !== '') {
    return Number(params.corridorHalfWidth);
  }
  const w = Number(params.corridorWidth);
  if (Number.isFinite(w) && w > 0) return w / 2;
  return 20;
}

/** 目标机型必须来自机队（闸 1） */
export async function resolveAircraft(aircraftKey) {
  if (!aircraftKey) return { ok: false, code: 'MODEL_REQUIRED', message: '请先选择目标机型' };
  const aircraft = await findModel(aircraftKey);
  if (!aircraft) {
    return {
      ok: false,
      code: 'MODEL_NOT_IN_FLEET',
      message: `机型 ${aircraftKey} 不在本机队，无法规划（只能为本队实际拥有的机型生成航线）`,
    };
  }
  if (aircraft.payload === null || aircraft.payload === undefined) {
    return {
      ok: false,
      code: 'PAYLOAD_UNKNOWN',
      message: `未能从航线库反演出 ${aircraft.name} 的载荷枚举。请先在司空 2 中上传一条该机型的航线作为参考，或联系管理员校准。`,
    };
  }
  return { ok: true, aircraft };
}

/** 本地自检：能在本地挡住的就不浪费一次上传 */
export function precheck({ polygon, centerline, params, templateType }) {
  const errs = [];
  const warns = [];
  const inChina = (lon, lat) => lon >= 73 && lon <= 136 && lat >= 3 && lat <= 54;

  if (templateType === 'corridor') {
    if (!Array.isArray(centerline) || centerline.length < 2) errs.push('带状航线至少需要 2 个中心线顶点');
    else if (centerline.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !inChina(p[0], p[1]))) {
      errs.push('中心线坐标非法或不在中国境内，请检查是否未做坐标系转换');
    }
    const hw = corridorHalfWidth(params);
    const lim = LIMITS.corridorHalfWidth;
    if (!Number.isFinite(hw) || hw < lim.min || hw > lim.max) {
      errs.push(`左右外扩需在 ${lim.min}–${lim.max} m 之间（总带宽为 2 倍）`);
    }

  } else {
    if (!Array.isArray(polygon) || polygon.length < 3) errs.push('测区至少需要 3 个顶点');
    else {
      if (polygon.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) errs.push('测区坐标中存在非法值');
      else if (polygon.some((p) => !inChina(p[0], p[1]))) errs.push('测区坐标超出中国境内范围，请检查是否未做坐标系转换');
      else if (polygon.length >= 4 && hasSelfIntersection(polygon)) errs.push('测区多边形自相交，请重新绘制');
    }
  }

  const h = Number(params.height);
  if (!Number.isFinite(h) || h < LIMITS.height.min || h > LIMITS.height.max) {
    errs.push(`航高需在 ${LIMITS.height.min}–${LIMITS.height.max} m 之间`);
  }
  for (const [k, label] of [['overlapH', '航向重叠率'], ['overlapW', '旁向重叠率']]) {
    const v = Number(params[k]);
    if (!Number.isFinite(v) || v < LIMITS.overlap.min || v > LIMITS.overlap.max) {
      errs.push(`${label}需在 ${LIMITS.overlap.min}–${LIMITS.overlap.max}% 之间`);
    }
  }
  const sp = Number(params.speed);
  if (!Number.isFinite(sp) || sp < LIMITS.speed.min || sp > LIMITS.speed.max) {
    errs.push(`航速需在 ${LIMITS.speed.min}–${LIMITS.speed.max} m/s 之间`);
  }
  if (h > 120) warns.push('航高超过 120 m，需确认当地空域是否允许');
  return { errors: errs, warnings: warns };
}

function segIntersect(a, b, c, d) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function hasSelfIntersection(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (i === j || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** 测区面积（平方米） */
export function measurePolygon(polygon) {
  const lons = polygon.map((p) => p[0]);
  const lats = polygon.map((p) => p[1]);
  const center = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const frame = makeLocalFrame(center[0], center[1]);
  const xy = polygon.map(frame.toXY);
  const bb = bboxXY(xy);
  return { areaM2: Math.round(areaXY(xy)), widthM: Math.round(bb.maxX - bb.minX), heightM: Math.round(bb.maxY - bb.minY) };
}

/** 归一化镜头选择（数组） */
function normalizeLens(params) {
  const raw = params.lens ?? params.lenses ?? 'wide';
  const arr = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : ['wide'];
}

/**
 * 生成规划预览（不落库、不上传）
 */
export async function plan(input) {
  const { polygon, centerline, aircraftKey } = input;
  const params = input.params || {};
  const templateType = params.templateType || input.templateType || 'mapping2d';

  const resolved = await resolveAircraft(aircraftKey);
  if (!resolved.ok) return resolved;
  const { aircraft } = resolved;

  const check = precheck({ polygon, centerline, params, templateType });
  if (check.errors.length) {
    return { ok: false, code: 'PRECHECK_FAILED', message: check.errors.join('；'), errors: check.errors, warnings: check.warnings };
  }

  const lensKeys = normalizeLens(params);
  const coef = effectiveCoef(lensKeys, aircraft.lensOverrides || {});
  const height = Number(params.height);
  const overlapW = Number(params.overlapW);
  const overlapH = Number(params.overlapH);
  const speed = clamp(Number(params.speed), LIMITS.speed.min, LIMITS.speed.max);

  // 航线间距：由航高、旁向重叠率、镜头视场共同决定
  const spacing = Math.max(5, height * coef.swathK * (1 - overlapW / 100));
  // 片基（沿航向两张照片的地面间距）：决定航点密度与拍照间隔
  const base = Math.max(2, height * coef.stepK * (1 - overlapH / 100));
  const wpSpacing = clamp(Number(params.wpSpacing) || base, 5, 1000);

  const common = {
    spacing,
    wpSpacing,
    margin: Number(params.margin) || 0,
    maxWaypoints: LIMITS.waypoints,
  };

  let plan;
  let templatePolygon = polygon;
  if (templateType === 'corridor') {
    // 带状：先按「左右各外扩 halfWidth」缓冲出走廊面，再在面里布垂直于中心线的工字形扫线
    plan = planCorridor({
      centerline,
      halfWidth: corridorHalfWidth(params),
      extend: Number(params.extend) || 0,
      ...common,
    });
    // 带状仍走已验证的 mapping2d 面状模板（用缓冲边界当测区），
    // 不冒险用未验证的 mapping_strip 模板类型——实测缺字段会直接 200500。
    templatePolygon = plan.buffer;
  } else if (templateType === 'doubleGrid') {
    const a = planArea({ polygon, direction: Number(params.direction) || 0, ...common });
    const b = planArea({ polygon, direction: (Number(params.direction) || 0) + 90, ...common });
    plan = {
      strips: [...a.strips, ...b.strips],
      waypoints: [...a.waypoints, ...b.waypoints],
      stats: {
        ...a.stats,
        stripCount: a.stats.stripCount + b.stats.stripCount,
        waypointCount: a.waypoints.length + b.waypoints.length,
        lengthM: a.stats.lengthM + b.stats.lengthM,
        adjusted: a.stats.adjusted || b.stats.adjusted,
        spacing: a.stats.spacing,
        wpSpacing: a.stats.wpSpacing,
      },
    };
  } else {
    plan = planArea({ polygon, direction: Number(params.direction) || 0, ...common });
  }

  const measure = templateType === 'corridor' ? { areaM2: plan.stats.areaM2 } : measurePolygon(polygon);
  const durationS = Math.round(plan.stats.lengthM / speed);

  // 拍照间隔：连拍模式下按「片基 / 航速」秒一张，但不能快过相机最小间隔
  const needInterval = base / speed;
  const shootInterval = Math.max(MIN_SHOOT_INTERVAL, Math.round(needInterval * 10) / 10);
  const warnings = [...check.warnings];
  if (needInterval < MIN_SHOOT_INTERVAL) {
    warnings.push(
      `按当前航速 ${speed} m/s 与片基 ${base.toFixed(1)} m，需每 ${needInterval.toFixed(2)} s 拍一张，` +
        `快于相机最小间隔 ${MIN_SHOOT_INTERVAL} s，航向重叠率将达不到 ${overlapH}%。建议降速至 ${(base / MIN_SHOOT_INTERVAL).toFixed(1)} m/s 以下或提高航高`
    );
  }
  const photoCount = Math.ceil(durationS / shootInterval);

  const compare = compareWithReference(
    {
      droneEnumValue: aircraft.type,
      droneSubEnumValue: aircraft.subType,
      payloadEnumValue: aircraft.payload,
      coordinateMode: 'WGS84',
      heightMode: 'relativeToStartPoint',
      shootType: 'time',
      actionFuncs: ['gimbalAngleLock', 'gimbalRotate', 'startTimeLapse'],
    },
    { template: aircraft.reference?.wpml, actionFuncs: aircraft.reference?.actionFuncs }
  );

  // 带状航线把缓冲边界带出去：template.kml 要用它当测区多边形
  const bufferPolygon = templateType === 'corridor' ? plan.buffer : null;

  return {
    ok: true,
    templateType,
    bufferPolygon,
    aircraft: {
      key: aircraft.key,
      name: aircraft.name,
      type: aircraft.type,
      subType: aircraft.subType,
      payload: aircraft.payload,
      calibrated: !!aircraft.calibrated,
      reference: aircraft.reference || null,
    },
    lens: {
      keys: lensKeys,
      names: lensKeys.map((k) => lensByKey(k).name),
      governing: coef.governing.name,
      payloadLensIndex: lensIndexText(lensKeys),
      swathK: Math.round(coef.swathK * 1000) / 1000,
      calibratedKeys: Object.keys(aircraft.lensOverrides || {}),
    },
    plan: {
      strips: plan.strips,
      waypoints: plan.waypoints,
      /** 完整飞行路径（带状含沿边缘的连接段），用于画「工」字 */
      flightPath: plan.flightPath || null,
      stats: {
        ...plan.stats,
        base: Math.round(base * 10) / 10,
        shootInterval,
        photoCount,
        durationS,
        durationText: durationText(durationS),
      },
    },
    spacingSource: {
      calibrated: lensKeys.some((k) => (aircraft.lensOverrides || {})[k] !== undefined),
      text: lensKeys.some((k) => (aircraft.lensOverrides || {})[k] !== undefined)
        ? `间距系数取自本队真实航线反演（${coef.governing.name}）`
        : `按镜头理论值计算（${coef.governing.name} 等效 ${coef.governing.focalEq}mm，系数 ${coef.swathK.toFixed(3)}）`,
      sample: aircraft.calibration?.sample || null,
    },
    compare,
    measure,
    warnings,
    adjusted: plan.stats.adjusted,
  };
}

function durationText(s) {
  if (!Number.isFinite(s) || s <= 0) return '--';
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} 分 ${String(r).padStart(2, '0')} 秒`;
}

/**
 * 生成 KMZ（不做上传）
 */
export async function build(input) {
  const { polygon, centerline, aircraftKey, params = {}, name } = input;
  const templateType = params.templateType || 'mapping2d';

  const resolved = await resolveAircraft(aircraftKey);
  if (!resolved.ok) return resolved;
  const { aircraft } = resolved;

  const check = precheck({ polygon, centerline, params, templateType });
  if (check.errors.length) {
    return { ok: false, code: 'PRECHECK_FAILED', message: check.errors.join('；'), errors: check.errors };
  }

  const preview = await plan(input);
  if (!preview.ok) return preview;

  // 带状航线用缓冲边界作为面状测区（沿用已验证的 mapping2d 模板结构，
  // 不冒险用未验证的 mapping_strip 模板类型）
  const templatePolygon = templateType === 'corridor' ? preview.bufferPolygon : polygon;

  const files = buildWaylineFiles({
    name,
    aircraft: { type: aircraft.type, subType: aircraft.subType, payload: aircraft.payload },
    polygon: templatePolygon,
    waypoints: preview.plan.waypoints,
    config: {
      height: Number(params.height),
      speed: Number(params.speed),
      overlapH: Number(params.overlapH),
      overlapW: Number(params.overlapW),
      // 带状航线的主航线角由中心线走向决定，用户在面板上填的角度对它无意义
      direction:
        templateType === 'corridor'
          ? Number(preview.plan.stats.bearing) || 0
          : Number(params.direction) || 0,
      margin: Number(params.margin) || 0,
      gimbalPitch: Number(params.gimbalPitch ?? -90),
      shootInterval: preview.plan.stats.shootInterval,
      takeOffSecurityHeight: Number(params.takeOffSecurityHeight) || 20,
      rthHeight: Number(params.rthHeight) || 100,
      doubleGrid: templateType === 'doubleGrid',
      payloadLensIndex: preview.lens.payloadLensIndex,
    },
  });

  return { ok: true, kmz: packKmz(files), files, preview };
}

export { fleetModels };
