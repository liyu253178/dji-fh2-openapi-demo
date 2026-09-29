/**
 * 逆地理编码（坐标 → 地址）服务配置
 *
 * ⚠️ 安全红线：Key 只从「环境变量」或「本地配置文件」读取，**绝不写进源码、不进 Git**。
 *    server/data/ 与 .env 均已在 .gitignore 中。
 *
 * 读取优先级：环境变量 AMAP_KEY > 本地文件 data/geo.json
 * 环境变量里没有时，可在「系统状态 → 地址服务」页录入，写进 data/geo.json。
 *
 * ⚠️ 合规提示（地图）：本项目只用合规地图服务商（高德 / 腾讯 / 百度 / 天地图）。
 *    Key 需自行到「高德开放平台 → 应用管理 → 添加 Key → 服务平台选『Web服务』」申请，
 *    代码里不内置任何可用 Key；前端拿不到 Key（逆地理请求全部由本服务后端代理发出）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../db/config.js';

const CONFIG_FILE = path.join(DATA_DIR, 'geo.json');

/** 高德逆地理编码接口 */
export const AMAP_REGEO_URL = 'https://restapi.amap.com/v3/geocode/regeo';

function fromFile() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

let cached = null;

export function getConfig() {
  if (cached) return cached;
  const f = fromFile();
  cached = {
    key: process.env.AMAP_KEY || f.key || '',
    provider: f.provider || 'amap',
    // 命中半径（米）：高德 regeo 用它限定返回的最近 POI/道路
    radius: Number(f.radius) || 1000,
  };
  return cached;
}

/** 对外输出：只给「是否配置」，绝不吐 Key 明文 */
export function getPublicConfig() {
  const c = getConfig();
  return {
    configured: !!c.key,
    provider: c.provider,
    radius: c.radius,
    // 只回显末 4 位，方便核对是不是填错了 key
    keyTail: c.key ? `…${c.key.slice(-4)}` : '',
  };
}

export function saveConfig(patch = {}) {
  const cur = fromFile();
  if (typeof patch.key === 'string') cur.key = patch.key.trim();
  if (patch.provider) cur.provider = String(patch.provider);
  if (patch.radius !== undefined) cur.radius = Number(patch.radius) || 1000;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8');
  cached = null;
  return getPublicConfig();
}

/** 仅用于测试：清缓存 */
export function resetCache() {
  cached = null;
}
