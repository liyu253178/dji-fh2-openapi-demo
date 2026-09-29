/**
 * 一网统飞 · 最优机巢推荐（政务调度规则引擎）
 * 输入：目标点/航线起降点 + 候选机场；输出：推荐机场 + 可解释的评分明细
 * 规则来源：机场在线/空闲、直线距离 ≤ 作业半径、电量 ≥ 阈值、无严重 HMS 告警
 */
import { snapshot } from './telemetry.js';

/** 机型作业半径（米）：保守值，可按机型标定表扩展 */
const RANGE_BY_MODEL = {
  'Matrice 4TD': 7000,
  'Matrice 4D': 7000,
  M3TD: 6000,
  'Matrice 3D': 6000,
  M30T: 5000,
  'Matrice 350 RTK': 5000,
  DEFAULT: 5000,
};

/** Haversine 距离（米） */
export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function rangeOf(airport) {
  return RANGE_BY_MODEL[airport.model] ?? RANGE_BY_MODEL.DEFAULT;
}

/**
 * @param {{lat:number,lng:number}} target 目标点（航线起降点或网格中心）
 * @param {object} opts {minBattery=30, requireOnline=true}
 */
export async function recommendNest(target, opts = {}) {
  const { minBattery = 30, requireOnline = true } = opts;
  if (!target || target.lat === undefined || target.lng === undefined) {
    return { ok: false, message: '缺少目标点坐标' };
  }
  const snap = await snapshot();
  const airports = snap.airports || [];

  const candidates = airports.map((a) => {
    const reasons = [];
    let score = 0;

    // 1. 在线
    if (a.online) score += 30;
    else reasons.push('机场离线');
    if (requireOnline && !a.online) reasons.push('不满足在线要求');

    // 2. 位置已知
    if (!a.position) {
      reasons.push('未获取到机场坐标（物模型为空）');
      return { airport: a, score: 0, distance: null, reasons, eligible: false };
    }
    const d = distanceM(target, a.position);
    const range = rangeOf(a);

    // 3. 续航半径
    if (d <= range) score += Math.round(40 * (1 - d / range));
    else reasons.push(`超出作业半径（${(d / 1000).toFixed(1)}km > ${(range / 1000).toFixed(1)}km）`);

    // 4. 电量
    const batt = a.battery;
    if (batt === null || batt === undefined) reasons.push('电量未知');
    else if (batt >= minBattery) score += 20;
    else reasons.push(`电量不足（${batt}% < ${minBattery}%）`);

    // 5. 状态是否空闲
    if (/空闲|待机|idle/i.test(a.modeText || '')) score += 10;
    else reasons.push(`机场非空闲（${a.modeText}）`);

    return {
      airport: {
        sn: a.sn,
        callsign: a.callsign,
        model: a.model,
        online: a.online,
        modeText: a.modeText,
        battery: batt,
        position: a.position,
        droneSn: a.droneSn,
        projectUuid: a.projectUuid,
      },
      distance: Math.round(d),
      range,
      score,
      reasons,
      eligible: a.online && d <= range && (batt ?? 0) >= minBattery,
    };
  });

  candidates.sort((x, y) => y.score - x.score);
  const best = candidates.find((c) => c.eligible) || null;
  return {
    ok: true,
    data: {
      target,
      total: candidates.length,
      best,
      candidates,
      generatedAt: Date.now(),
    },
  };
}

/**
 * 巡检计划编排（一网统飞）：给一组网格/航线目标点批量推荐机场
 */
export async function planForTargets(targets = [], opts = {}) {
  const out = [];
  for (const t of targets) {
    const r = await recommendNest(t.point || t, opts);
    out.push({
      target: t.name || `${(t.point || t).lat},${(t.point || t).lng}`,
      point: t.point || t,
      best: r.ok ? r.data.best : null,
      error: r.ok ? null : r.message,
    });
  }
  return { ok: true, data: { plans: out } };
}
