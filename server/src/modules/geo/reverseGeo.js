/**
 * 逆地理编码：影像 GPS → 具体地址
 *
 * 业务背景：工单要派到属地单位，「经纬度」对一线没用，「XX镇XX村XX路旁」才有用。
 * 影像的 WGS84 坐标来自 DJI XMP（drone-dji 私有命名空间），是标准 GPS 坐标。
 *
 * ⚠️ 坐标系红线：高德 / 腾讯 / 百度用的都是 GCJ-02（火星坐标）。
 *    直接拿 WGS84 去查会偏移 300~800 米，地址会错到隔壁村 —— 必须先转换。
 *    实测教训：这一步不做，界面上"自动匹配"出来的地址看着很合理但全是错的，最难排查。
 *
 * 降级链（任何一环失败都不能让表单空白，也不能假装成功）：
 *   1. 缓存（同坐标 12 小时内复用，省配额）
 *   2. 高德 Web 服务 regeo（需 Key）
 *   3. 同项目已填过的邻近地址（500m 内，source='nearby'）
 *   4. 纯坐标兜底（source='coords'，needKey=true，前端提示去配 Key）
 */

import { all } from '../../db/index.js';
import { getConfig } from './geoConfig.js';
import { log } from '../../logger.js';

const PI = Math.PI;
const A = 6378245.0; // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

function outOfChina(lat, lon) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * WGS84 → GCJ-02（火星坐标）
 * 境外不做偏移（outOfChina 时原样返回）。精度约 1 米级，足够地址匹配。
 */
export function wgs84ToGcj02(lat, lon) {
  const wgsLat = Number(lat);
  const wgsLon = Number(lon);
  if (!Number.isFinite(wgsLat) || !Number.isFinite(wgsLon)) return null;
  if (outOfChina(wgsLat, wgsLon)) return { lat: wgsLat, lon: wgsLon };
  let dLat = transformLat(wgsLon - 105.0, wgsLat - 35.0);
  let dLon = transformLon(wgsLon - 105.0, wgsLat - 35.0);
  const radLat = (wgsLat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: wgsLat + dLat, lon: wgsLon + dLon };
}

/** 两点球面距离（米） */
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((Number(lat2) - Number(lat1)) * PI) / 180;
  const dLon = ((Number(lon2) - Number(lon1)) * PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((Number(lat1) * PI) / 180) * Math.cos((Number(lat2) * PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 结果缓存：key = 4 位小数（约 11 米）坐标，12 小时 */
const cache = new Map();
const CACHE_TTL = 12 * 3600 * 1000;

function cacheKey(lat, lon) {
  return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

/** 高德 Web 服务：逆地理编码 */
async function amapRegeo(lat, lon, key, radius) {
  const g = wgs84ToGcj02(lat, lon) || { lat, lon };
  const url =
    `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(key)}` +
    `&location=${g.lon.toFixed(6)},${g.lat.toFixed(6)}` +
    `&extensions=all&radius=${radius}&roadlevel=0&output=JSON`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const j = await res.json();
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/** 高德错误码 → 人话（这些是真实会遇到的，别让用户自己猜） */
function amapMessage(info, infocode) {
  const map = {
    10001: 'Key 不正确或已过期',
    10002: '该 Key 未开通「Web服务」权限（要在高德控制台把服务平台选成 Web 服务）',
    10003: 'Key 已超限或被禁用',
    10009: '请求 Key 与绑定平台不符（Web 服务 Key 只能服务端调用）',
    10021: '接口未授权（请确认申请的是 Web 服务类型 Key）',
    20003: '坐标超出中国范围，无法逆地理编码',
    30001: '请求过于频繁，稍后再试',
  };
  return map[String(infocode)] || info || '逆地理编码失败';
}

/** 同项目 500m 内已填过的地址（无 Key 时的兜底） */
function nearbyAddress(lat, lon, projectUuid) {
  try {
    // ⚠️ 必须限定项目：不同项目可能分处两地，跨项目复用地址会把 A 市的地址写到 B 市的图斑上
    const sql =
      `SELECT address, admin_region, village, lat, lon FROM patch
       WHERE address IS NOT NULL AND address <> ''
         AND lat BETWEEN @lat0 AND @lat1 AND lon BETWEEN @lon0 AND @lon1` +
      (projectUuid ? ' AND project_uuid = @pu' : '');
    const rows = all(sql, {
      lat0: Number(lat) - 0.006,
      lat1: Number(lat) + 0.006,
      lon0: Number(lon) - 0.006,
      lon1: Number(lon) + 0.006,
      pu: projectUuid || null,
    });
    let best = null;
    let bestD = Infinity;
    for (const r of rows) {
      const d = distanceM(lat, lon, r.lat, r.lon);
      if (d <= 500 && d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best ? { address: best.address, distance: Math.round(bestD) } : null;
  } catch {
    return null;
  }
}

/**
 * 坐标 → 地址
 * @returns {Promise<{ok:boolean, address:string, source:string, needKey:boolean, message?:string, detail?:object}>}
 *   source: cache | amap | nearby | coords
 */
export async function reverseGeocode({ lat, lon, projectUuid } = {}) {
  const nLat = Number(lat);
  const nLon = Number(lon);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) {
    return { ok: false, address: '', source: 'invalid', needKey: false, message: '坐标无效' };
  }

  const ck = cacheKey(nLat, nLon);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { ...hit.value, source: 'cache' };
  }

  const cfg = getConfig();
  if (!cfg.key) {
    // 无 Key：不允许静默失败，明确告诉前端去配 Key，同时尽量给个可用的草稿
    const near = nearbyAddress(nLat, nLon, projectUuid);
    if (near) {
      const v = {
        ok: true,
        address: near.address,
        source: 'nearby',
        needKey: true,
        message: `未配置高德 Key，暂用 ${near.distance} 米内已填过的地址，请核对`,
      };
      cache.set(ck, { at: Date.now(), value: v });
      return v;
    }
    return {
      ok: true,
      address: '',
      source: 'coords',
      needKey: true,
      message: '未配置高德 Key，无法自动匹配地址，请手动填写',
      detail: { lat: nLat, lon: nLon },
    };
  }

  try {
    const j = await amapRegeo(nLat, nLon, cfg.key, cfg.radius);
    if (String(j.status) !== '1') {
      const msg = amapMessage(j.info, j.infocode);
      log.warn('地址匹配', `${msg}（infocode=${j.infocode}）`);
      // Key 有问题时也要降级，不能让表单永远空着
      const near = nearbyAddress(nLat, nLon, projectUuid);
      if (near) {
        return { ok: true, address: near.address, source: 'nearby', needKey: false, message: `${msg}；暂用邻近地址` };
      }
      return { ok: false, address: '', source: 'amap', needKey: false, message: msg };
    }

    const rc = j.regeocode || {};
    const ac = rc.addressComponent || {};
    const aoi = (rc.aois && rc.aois[0] && rc.aois[0].name) || '';
    const building = (ac.building && ac.building.name) || '';
    const neighborhood = (ac.neighborhood && ac.neighborhood.name) || '';
    // ⚠️ 实测坑：高德返回的 number 常常自带「号」（如 "801号"），
    //    无条件再拼一个「号」就变成「庙头路801号号」，看着像脏数据。
    const sn = ac.streetNumber || {};
    const num = sn.number ? String(sn.number) : '';
    const numText = num ? (num.endsWith('号') ? num : `${num}号`) : '';
    const streetNumber = (sn.street && numText)
      ? `${sn.street}${numText}`
      : (sn.street || numText || '');
    const township = ac.township || '';
    const district = ac.district || '';
    const city = ac.city || ac.province || '';
    const province = ac.province || '';

    // 「具体地址」优先用格式化全址；AOI/小区名能补上人话地标（如"XX工业园"）
    let address = rc.formatted_address || '';
    const landmark = aoi || neighborhood || building || '';
    if (landmark && !address.includes(landmark)) {
      address = `${address}（${landmark}）`;
    }

    const v = {
      ok: true,
      address,
      province,
      city,
      district,
      township,
      street: streetNumber,
      aoi: landmark,
      source: 'amap',
      needKey: false,
    };
    cache.set(ck, { at: Date.now(), value: v });
    return v;
  } catch (e) {
    log.warn('地址匹配', `调用失败：${e.message}`);
    const near = nearbyAddress(nLat, nLon, projectUuid);
    if (near) {
      return { ok: true, address: near.address, source: 'nearby', needKey: false, message: `网络异常，暂用邻近地址` };
    }
    return { ok: false, address: '', source: 'amap', needKey: false, message: `地址服务调用失败：${e.message}` };
  }
}

/** 仅测试用：清缓存 */
export function resetCache() {
  cache.clear();
}
