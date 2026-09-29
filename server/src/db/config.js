/**
 * db 模块配置
 *
 * 路径解析顺序：
 *   1. 环境变量 DUAV_DATA_DIR（推荐，部署时可指向 NAS）
 *   2. server/data（默认，与存量 store.js 保持一致）
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 数据根目录 */
export const DATA_DIR = path.resolve(
  process.env.DUAV_DATA_DIR || path.join(__dirname, '..', '..', 'data')
);

/** 数据库文件 */
export const DB_FILE = path.join(DATA_DIR, 'duav.db');

/** 影像根目录（按 项目/日期/架次 组织） */
export const ASSET_DIR = path.join(DATA_DIR, 'assets');

/** 缩略图目录（200px，审核网格用） */
export const THUMB_DIR = path.join(DATA_DIR, 'preview');

/** 邮件用压缩图（1600px，约 500KB/张） */
export const MAIL_IMAGE_DIR = path.join(DATA_DIR, 'mail-attach');

/** 邮件位置示意图临时目录 */
export const MAIL_TMP_DIR = path.join(DATA_DIR, 'mail-tmp');

/** 日志目录 */
export const LOG_DIR = path.join(DATA_DIR, 'logs');

/** 磁盘剩余空间告警阈值（字节）。低于此值停止下载新影像并告警。 */
export const DISK_WARN_BYTES = 5 * 1024 * 1024 * 1024; // 5GB

/** 缩略图边长（px） */
export const THUMB_SIZE = 200;

/** 邮件压缩图边长（px） */
export const MAIL_IMAGE_SIZE = 1600;

/** 邮件压缩图质量 */
export const MAIL_IMAGE_QUALITY = 80;

/** 确保所有目录存在（幂等） */
export function ensureDirs() {
  for (const dir of [DATA_DIR, ASSET_DIR, THUMB_DIR, MAIL_IMAGE_DIR, MAIL_TMP_DIR, LOG_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/** 检查磁盘可用空间，返回字节数 */
export function diskFree() {
  try {
    // statfs 从 Node 18.15+ / 20+ 可用；不可用时返回 null 表示"未知"
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(DATA_DIR);
      return st.bavail * st.bsize;
    }
  } catch {
    /* 平台不支持时忽略 */
  }
  return null;
}

/** 相对存储根目录的路径（用于入库，避免存绝对路径导致迁移失败） */
export function toRelative(absPath) {
  return path.isAbsolute(absPath) ? path.relative(DATA_DIR, absPath) : absPath;
}

/** 相对路径还原为绝对路径（出库时用） */
export function toAbsolute(relPath) {
  if (!relPath) return '';
  return path.isAbsolute(relPath) ? relPath : path.join(DATA_DIR, relPath);
}
