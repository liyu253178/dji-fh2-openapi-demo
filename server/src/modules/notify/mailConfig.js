/**
 * 邮件配置
 *
 * ⚠️ 安全要求：授权码只从环境变量读，绝不写入源码、配置文件、数据库或日志。
 *
 * 环境变量：
 *   SMTP_HOST     默认 smtp.qq.com
 *   SMTP_PORT     默认 465（SSL 直连）
 *   SMTP_SECURE   默认 1（true=SSL/TLS；0=STARTTLS，一般用 587 端口）
 *   SMTP_USER     完整邮箱地址，如 your@qq.com
 *   SMTP_PASS     授权码（非登录密码！）
 *   SMTP_FROM     发件人地址，须与 SMTP_USER 一致否则可能被拒
 *   ORG_NAME      落款单位名
 *   ORG_CONTACT   落款联系方式
 *   PLATFORM_URL  平台访问地址（邮件里的深链接）
 *
 * 163 邮箱用户把 SMTP_HOST 换成 smtp.163.com 即可，其余相同。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../db/config.js';

const CONFIG_FILE = path.join(DATA_DIR, 'mail.json');

/** 从环境变量读取配置（推荐方式） */
function fromEnv() {
  return {
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE === undefined ? true : process.env.SMTP_SECURE !== '0' && process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    orgName: process.env.ORG_NAME || '低空智能监管平台',
    orgContact: process.env.ORG_CONTACT || '',
    platformUrl: process.env.PLATFORM_URL || 'http://localhost:5173',
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
