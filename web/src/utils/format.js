/** 通用格式化工具 */

/**
 * 生成安全的任务名
 * 司空 2 对任务名中的 / : 等字符较为敏感，统一转成 YYYY-MM-DD HH-mm-ss 形式
 * @param {string} prefix 前缀，如「一键起飞」
 */
export function taskName(prefix = '任务') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `${prefix} ${stamp}`;
}

/** 空值统一：null / undefined / 空串 → '--' */
export function getDisplayValue(val, placeholder = '--') {
  if (val === null || val === undefined || val === '') return placeholder;
  if (typeof val === 'number' && !Number.isFinite(val)) return placeholder;
  return String(val);
}

const p2 = (n) => String(n).padStart(2, '0');

/**
 * 秒 / 毫秒时间戳 → 'YYYY-MM-DD HH:mm:ss'
 * 司空 2 的时间字段秒和毫秒混用（有 10 位也有 13 位），自动判别。
 */
export function fmtTime(sec, placeholder = '--') {
  if (sec === null || sec === undefined || sec === 0 || sec === '') return placeholder;
  const ms = Number(sec) > 1e12 ? Number(sec) : Number(sec) * 1000;
  if (!Number.isFinite(ms)) return placeholder;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return placeholder;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 毫秒时间戳 → 'YYYY-MM-DD HH:mm' */
export function fmtMs(ms, placeholder = '--') {
  if (!ms) return placeholder;
  const t = fmtTime(ms, placeholder);
  return t === placeholder ? placeholder : t.slice(0, 16);
}

/** 只保留到分钟 */
export function fmtMinute(sec, placeholder = '--') {
  const t = fmtTime(sec, placeholder);
  return t === placeholder ? placeholder : t.slice(0, 16);
}

/**
 * 秒 → 人话时长：'3天2时' / '5时12分' / '48分30秒' / '30秒'
 * @param {number} sec
 */
export function formatDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '--';
  const d = Math.floor(n / 86400);
  const h = Math.floor((n % 86400) / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  if (d > 0) return `${d}天${h}时`;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** 秒 → 时分秒，用于「累计飞行时长」这类需要更细粒度的场景 */
export function formatFlightDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '--';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  return h > 0 ? `${h}时${m}分` : m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

/** 毫伏 → 伏（保留 2 位） */
export function formatVoltage(mv) {
  const n = Number(mv);
  if (!Number.isFinite(n) || n === 0) return '--';
  return `${(n / 1000).toFixed(2)} V`;
}

/** 毫安 → 安（保留 2 位） */
export function formatCurrent(ma) {
  const n = Number(ma);
  if (!Number.isFinite(n) || n === 0) return '--';
  return `${(n / 1000).toFixed(2)} A`;
}

/** 速率（KB/s）→ 带单位字符串 */
export function formatRate(kbps) {
  const n = Number(kbps);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1024) return `${(n / 1024).toFixed(2)} MB/s`;
  return `${n.toFixed(1)} KB/s`;
}

/** 数值 + 单位，空值 → '--' */
export function withUnit(v, unit, digits = null) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return '--';
  const s = digits === null ? String(n) : n.toFixed(digits);
  return unit ? `${s} ${unit}` : s;
}

/** 0/1 → 是/否 */
export function boolText(v, yes = '是', no = '否') {
  if (v === null || v === undefined || v === '') return '--';
  return Number(v) ? yes : no;
}
