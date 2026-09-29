/**
 * 邮件配置
 *
 * ⚠️ 安全要求：授权码只从环境变量读，绝不写入源码、配置文件、数据库或日志。
 *
 * 环境变量：
 *   SMTP_USER     **完整邮箱地址**，如 your@163.com（必需，缺失则邮件功能不可用）
 *   SMTP_PASS     授权码（非登录密码！）
 *   SMTP_HOST     可选，按邮箱后缀自动推断，也可显式指定
 *   SMTP_PORT     可选，默认 465
 *   SMTP_SECURE   可选，默认 1（SSL）；用 587 STARTTLS 时设为 0
 *   ORG_NAME      落款单位名
 *   ORG_CONTACT   落款联系方式
 *   PLATFORM_URL  平台访问地址（邮件深链接，注意不带 #）
 *
 * 常见邮箱的 SMTP 主机：
 *   @163.com→ smtp.163.com:465     @126.com       → smtp.126.com:465
 *   @qq.com  → smtp.qq.com:465     @foxmail.com   → smtp.qq.com:465
 *   @gmail.com → smtp.gmail.com:465（需应用专用密码 + 允许低安全应用）
 *   企业腾讯邮 → smtp.exmail.qq.com:465
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../db/config.js';

const CONFIG_FILE = path.join(DATA_DIR, 'mail.json');

/** 按邮箱后缀推断 SMTP 主机 */
export function guessHost(user) {
  const domain = String(user || '').split('@')[1]?.toLowerCase() || '';
  const map = {
    '163.com': 'smtp.163.com',
    '126.com': 'smtp.126.com',
    'yeah.net': 'smtp.163.com',
    'vip.163.com': 'smtp.163.com',
    'qq.com': 'smtp.qq.com',
    'foxmail.com': 'smtp.qq.com',
    'vip.qq.com': 'smtp.qq.com',
    'exmail.qq.com': 'smtp.exmail.qq.com',
    'gmail.com': 'smtp.gmail.com',
  };
  return map[domain] || 'smtp.163.com';
}

/** 从环境变量读取配置 */
function fromEnv() {
  const user = process.env.SMTP_USER || '';
  return {
    host: process.env.SMTP_HOST || guessHost(user),
    port: Number(process.env.SMTP_PORT || 465),
    secure:
      process.env.SMTP_SECURE === undefined
        ? true
        : process.env.SMTP_SECURE !== '0' && process.env.SMTP_SECURE !== 'false',
    user,
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || user,
    orgName: process.env.ORG_NAME || '低空智能监管平台',
    orgContact: process.env.ORG_CONTACT || '',
    // 默认用 BFF 单端口（8787 同时托管 API 与前端静态资源）
    platformUrl: process.env.PLATFORM_URL || 'http://localhost:8787',
  };
}

/** 从本地配置文件读取（仅存非敏感项；授权码不建议落盘） */
function fromFile() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

let cached = null;

/** 获取完整配置：环境变量优先，文件兜底 */
export function getConfig() {
  if (cached) return cached;
  cached = { ...fromFile(), ...fromEnv() };
  return cached;
}

/**
 * 对外输出（隐藏授权码明文）
 * 用于 GET /api/notify/config
 */
export function getPublicConfig() {
  const c = getConfig();
  return {
    configured: !!(c.user && c.pass),
    host: c.host,
    port: c.port,
    secure: c.secure,
    user: c.user,
    from: c.from,
    hasPass: !!c.pass,
    orgName: c.orgName,
    orgContact: c.orgContact,
    platformUrl: c.platformUrl,
  };
}

/** 保存非敏感配置项到本地文件（授权码不写盘） */
export function savePublicConfig(patch) {
  const allowed = ['orgName', 'orgContact', 'platformUrl'];
  const cur = fromFile();
  for (const k of allowed) {
    if (patch[k] !== undefined) cur[k] = patch[k];
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8');
  cached = null;
  return getPublicConfig();
}

/** 仅用于测试：清缓存 */
export function resetCache() {
  cached = null;
}
