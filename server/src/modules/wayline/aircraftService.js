/**
 * 机队机型服务 —— 三道闸里的「闸 1：机型只能从机队选」
 *
 * 铁律：**不维护硬编码机型表**。
 * 机型的枚举值全部由 /project/device 的 device_model 推导：
 *     device_model_key = `${domain}-${type}-${sub_type}`
 *     WPML droneEnumValue    = type
 *     WPML droneSubEnumValue = sub_type
 * 载荷枚举与航线间距系数则从本队同型号的**真实航线**里反演（见 wpmlInspector），
 * 这样换一个新型号接入，只要库里有它的航线就能自学习，不需要改代码。
 *
 * 之所以要这么严：实测司空 2 **完全不做机型校验**——
 * 把 droneEnumValue 写成 91 照样入库成功（probe-wayline-upload.mjs 模式 C）。
 * 也就是说「上传不报错」≠「能飞」，机型匹配只能我们自己卡。
 */

import { request } from '../../djiClient.js';
import { log } from '../../logger.js';
import { inspectKmz } from './wpmlInspector.js';
import { lensByKey } from './lensProfile.js';

const CACHE_TTL = 5 * 60 * 1000;
let cache = { at: 0, models: [] };

/** 构造机型主键（与司空 2 的 device_model.key 完全同构） */
export const modelKey = (m) => `${m.domain}-${m.type}-${m.sub_type}`;

/** 归一化 device_model → 平台内部机型对象 */
function normalize(m) {
  return {
    key: m.key || modelKey(m),
    name: m.name || m.key || '未知机型',
    domain: Number(m.domain ?? 0),
    type: Number(m.type ?? 0),
    subType: Number(m.sub_type ?? 0),
    class: m.class || '',
  };
}

/**
 * 拉取机队机型（/project/device → drone.device_model 去重）
 * gateway（机场）不算可飞机型，只作为机队规模展示。
 */
export async function fetchFleetModels() {
  const r = await request({ method: 'GET', path: '/project/device', tag: '航线规划' });
  if (!r.ok) return { ok: false, message: r.message || '获取项目设备失败', models: [] };

  const list = r.data?.list || [];
  const byKey = new Map();
  let airports = 0;

  for (const item of list) {
    const g = item.gateway || {};
    if (g.device_model) airports++;
    const dm = item.drone?.device_model;
    if (!dm) continue;
    const m = normalize(dm);
    const hit = byKey.get(m.key);
    if (hit) {
      hit.count++;
      if (item.drone?.sn) hit.sns.push(item.drone.sn);
      if (item.drone?.device_online_status) hit.online++;
    } else {
      byKey.set(m.key, { ...m, count: 1, online: item.drone?.device_online_status ? 1 : 0, sns: item.drone?.sn ? [item.drone.sn] : [] });
    }
  }
  // 镜头系数覆盖表：{ [lensKey]: swathK }，来自真实航线反演，优先级高于理论值
  for (const m of byKey.values()) m.lensOverrides = {};
  return { ok: true, models: [...byKey.values()], airports, message: '' };
}

/** 下载一条航线的 KMZ（列表 → 详情 download_url → CDN） */
async function downloadWayline(id) {
  const r = await request({ method: 'GET', path: `/wayline/${encodeURIComponent(id)}`, tag: '航线规划' });
  if (!r.ok || !r.data?.download_url) return null;
  try {
    const res = await fetch(r.data.download_url, { redirect: 'follow' });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    log.warn('航线规划', `参考航线下载失败：${e.message}`, { id });
    return null;
  }
}

/**
 * 从航线库里找同型号的真实航线，反演载荷枚举与间距系数
 * 优先取 mapping2d（正射面状）——它才有 overlap 与展开航点，能反演出系数。
 */
async function learnFromLibrary(models) {
  const r = await request({ method: 'GET', path: '/wayline', query: { page: 1, page_size: 100 }, tag: '航线规划' });
  if (!r.ok) return models;
  const lib = r.data?.list || [];

  for (const m of models) {
    const candidates = lib.filter((w) => w.device_model_key === m.key);
    m.libraryCount = candidates.length;
    // 同时给出「同主型号不同子型号」的数量，用于航线库的可飞性判定
    m.siblingCount = lib.filter((w) => {
      const k = String(w.device_model_key || '').split('-');
      return k[0] === String(m.domain) && k[1] === String(m.type) && w.device_model_key !== m.key;
    }).length;

    // ⚠️ 必须排除我们自己生成的航线：用自研产物反演自己的参数是自证循环，
    // 学出来的只是我们当初填进去的间距。只有客户/大疆侧产出的真实航线才有参考价值。
    const isOurs = (w) => /^DUAV/i.test(String(w.name || ''));
    const usable = candidates.filter((w) => (w.template_types || []).some((t) => String(t).includes('2d')));
    const pool = usable.length ? usable : candidates;
    // 逐条试到能反演出可信系数为止：库里不少航线是「只存了多边形顶点」的测试航线，
    // 拿它们反演会得到荒谬值（实测出现过 0.019），所以必须试多条并做结构校验。
    const tried = [];
    let ok = false;
    for (const ref of pool.filter((w) => !isOurs(w)).slice(0, 5)) {
      const buf = await downloadWayline(ref.id);
      if (!buf) continue;
      try {
        const info = inspectKmz(buf);
        m.payload = info.template?.payloadEnumValue ?? m.payload ?? null;
        if (!info.calibration) {
          tried.push(`${ref.name}(结构不符)`);
          continue;
        }
        m.calibration = info.calibration;
        m.calibrated = true;
        // 多镜头同时采集时，实测间距受**视场最窄**的那颗镜头约束，
        // 所以系数只能记到最窄那颗头上，不能当成广角的实测值。
        const keys = info.calibration.lensKeys || ['wide'];
        const narrowest = keys.map(lensByKey).sort((a, b) => b.focalEq - a.focalEq)[0];
        m.lensOverrides[narrowest.key] = { swathK: info.calibration.swathK, from: ref.name };
        m.reference = {
          waylineId: ref.id,
          name: ref.name,
          lensKeys: keys,
          selfGenerated: false,
          version: info.version,
          wpml: info.template ? { ...info.template, polygon: undefined } : null,
          actionFuncs: info.actionFuncs,
          waypointCount: info.waypointCount,
        };
        log.ok('航线规划', `已从参考航线「${ref.name}」反演：${m.name} ${narrowest.name} swathK=${info.calibration.swathK.toFixed(3)}`, {});
        ok = true;
        break;
      } catch (e) {
        tried.push(`${ref.name}(解析失败)`);
      }
    }
    if (!ok) {
      m.calibration = null;
      m.calibrated = false;
      // 至少把载荷枚举拿到手（载荷不需要航带结构，任何一条真实航线都能给）
      if (m.payload === null) {
        const any = pool.find((w) => !isOurs(w));
        if (any) {
          const buf = await downloadWayline(any.id);
          if (buf) {
            try {
              const info = inspectKmz(buf);
              m.payload = info.template?.payloadEnumValue ?? null;
              if (!m.reference) {
                m.reference = { waylineId: any.id, name: any.name, lensKeys: info.lensKeys, selfGenerated: false, version: info.version, wpml: info.template ? { ...info.template, polygon: undefined } : null, actionFuncs: info.actionFuncs, waypointCount: info.waypointCount };
              }
            } catch { /* 忽略：拿不到载荷就交给上层报错 */ }
          }
        }
      }
      log.warn('航线规划', `${m.name} 未能从航线库反演出可信的间距系数，将使用镜头理论值`, { tried });
    }
  }
  return models;
}

/**
 * 机队机型（带缓存）
 * @param {object} [opts]
 * @param {boolean} [opts.force] 强制刷新
 * @param {boolean} [opts.learn] 是否从航线库反演参数（默认 true）
 */
export async function fleetModels(opts = {}) {
  const { force = false, learn = true } = opts;
  if (!force && cache.models.length && Date.now() - cache.at < CACHE_TTL) {
    return { ok: true, models: cache.models, cached: true, message: '' };
  }
  const r = await fetchFleetModels();
  if (!r.ok) return r;
  const models = learn ? await learnFromLibrary(r.models) : r.models;
  cache = { at: Date.now(), models };
  return { ok: true, models, airports: r.airports, cached: false, message: '' };
}

/** 按 key 取机型（找不到返回 null） */
export async function findModel(key) {
  const { models } = await fleetModels();
  return models.find((m) => m.key === key) || null;
}

/**
 * 闸 3：下发前校验
 * 司空 2 不会拦机型，所以「航线库里的机型 ∈ 本机队机型」必须在这里断言。
 */
export async function assertDispatchable(waylineModelKey) {
  const { models, ok, message } = await fleetModels();
  if (!ok) return { ok: false, code: 'FLEET_UNAVAILABLE', message: message || '无法获取机队机型，已阻止下发' };
  if (!waylineModelKey) {
    return { ok: false, code: 'MODEL_UNKNOWN', message: '该航线没有机型标识，无法确认能否在本机队执行' };
  }
  if (models.some((m) => m.key === waylineModelKey)) {
    const m = models.find((x) => x.key === waylineModelKey);
    return { ok: true, model: m, message: `${m.name}（${m.key}）在本机队` };
  }
  const siblings = models.filter((m) => String(waylineModelKey).split('-')[1] === String(m.type));
  const hint = siblings.length
    ? `本机队有同系列 ${siblings.map((s) => s.name).join('、')}，但子型号不同（载荷可能不兼容）`
    : '本机队无此机型';
  return {
    ok: false,
    code: 'MODEL_MISMATCH',
    message: `该航线机型为 ${waylineModelKey}，${hint}，禁止下发`,
    siblings: siblings.map((s) => s.key),
  };
}

/** 清缓存（切项目 / 换 TK 后必须调） */
export function invalidate() {
  cache = { at: 0, models: [] };
}

/**
 * 航线库 × 机队的可飞性标注
 * 这是「36 条里只有 25 条能飞」这个价值的计算处。
 */
export async function annotateLibrary(list) {
  const { models, ok } = await fleetModels();
  const keys = new Set(models.map((m) => m.key));
  const types = new Set(models.map((m) => String(m.type)));
  if (!ok) return list.map((w) => ({ ...w, flyable: 'unknown', flyableText: '机型未知' }));

  return list.map((w) => {
    const key = String(w.device_model_key || '');
    if (!key) return { ...w, flyable: 'unknown', flyableText: '无机型标识' };
    if (keys.has(key)) {
      const m = models.find((x) => x.key === key);
      return { ...w, flyable: 'ok', flyableText: m.name, aircraftName: m.name };
    }
    const sub = key.split('-');
    if (types.has(sub[1])) {
      return { ...w, flyable: 'sibling', flyableText: `同系列不同子型号（${key}）` };
    }
    return { ...w, flyable: 'no', flyableText: `需 ${key}，本机队无此机型` };
  });
}
