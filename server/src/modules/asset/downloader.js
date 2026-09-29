/**
 * 影像下载
 *
 * 关键约束（实测）：
 *   司空 2 的媒体 URL 带 auth_key 签名，**有效期约 24 小时**，过期直接 403。
 *   → 同步时必须立即把原图下载到本地，不能长期持有司空 URL。
 *   → 每次需要新签名时，重新调 media 接口取一次即可。
 *
 * 探测可用性用 GET + Range: bytes=0-0，**不要用 HEAD**（CDN/OSS 对 HEAD 常返 403）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ASSET_DIR, diskFree, DISK_WARN_BYTES, toRelative, toAbsolute } from '../../db/config.js';
import { log } from '../../logger.js';

const DEFAULT_TIMEOUT = 60000;

/** 磁盘不足异常（同步流程据此中止而非逐张失败） */
export class DiskFullError extends Error {
  constructor(free) {
    super(`磁盘空间不足（剩余 ${(free / 1024 / 1024 / 1024).toFixed(2)}GB），已暂停下载`);
    this.name = 'DiskFullError';
    this.free = free;
  }
}

/** 计算文件 sha256（用于去重与完整性校验） */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 相对安全的文件名：去掉路径分隔与特殊字符，保留中文 */
function safeName(name) {
  return String(name || 'unnamed')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}

/**
 * 确保任务目录存在：assets/{project}/{日期}/{架次名}
 */
export async function taskDir({ projectUuid, shotDate, taskName }) {
  const d = path.join(
    ASSET_DIR,
    safeName(projectUuid || 'unknown'),
    safeName(shotDate || 'nodate'),
    safeName(taskName || 'task')
  );
  await fsp.mkdir(d, { recursive: true });
  return d;
}

/**
 * 下载单张影像
 * @param {string} url 司空 CDN 地址
 * @param {object} opts
 * @param {string} opts.fileName 原始文件名
 * @param {string} opts.dir 目标目录
 * @param {number} [opts.maxBytes] 单文件大小上限（防超大文件）
 * @returns {Promise<{ok:boolean, filePath?:string, fileSize?:number, fileHash?:string, error?:string, skipped?:boolean}>}
 */
export async function downloadImage(url, { fileName, dir, maxBytes = 64 * 1024 * 1024 }) {
  // 下载前检查磁盘，避免写到一半失败
  const free = diskFree();
  if (free !== null && free < DISK_WARN_BYTES) throw new DiskFullError(free);

  const fname = safeName(fileName);
  const abs = path.join(dir, fname);
  const rel = toRelative(abs);

  // 已下载过则跳过（幂等）
  if (fs.existsSync(abs)) {
    const st = await fsp.stat(abs);
    return { ok: true, filePath: rel, fileSize: st.size, skipped: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow', // OSS/CDN 常有 302
      headers: { Range: `bytes=0-${maxBytes - 1}` },
    });
    if (!res.ok && res.status !== 206) {
      return { ok: false, error: `HTTP ${res.status} ${res.status === 403 ? '(签名可能已过期)' : ''}`.trim() };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: '空响应' };
    if (buf.length >= maxBytes) return { ok: false, error: `文件超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB` };

    // 写入临时文件再改名，避免中断留下半截文件被当成完整
    const tmp = `${abs}.part`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, abs);
    return { ok: true, filePath: rel, fileSize: buf.length, fileHash: sha256(buf) };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `下载超时(${DEFAULT_TIMEOUT}ms)` : e.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 读取已下载文件（生成缩略图时用） */
export async function readLocal(relPath) {
  return fsp.readFile(toAbsolute(relPath));
}

/** 删除原图 */
export async function removeLocal(relPath) {
  try {
    await fsp.unlink(toAbsolute(relPath));
  } catch {
    /* 忽略 */
  }
}

/**
 * 探测司空 URL 是否可用（用 Range，不要用 HEAD）
 * @returns {Promise<{available:boolean, status:number, totalBytes?:number}>}
 */
export async function probeUrl(url) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const cr = r.headers.get('content-range');
    const total = cr ? Number(cr.split('/')[1] || 0) : 0;
    return { available: r.status === 200 || r.status === 206, status: r.status, totalBytes: total };
  } catch (e) {
    return { available: false, status: 0, error: e.message };
  }
}
