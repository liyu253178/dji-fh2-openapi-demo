/**
 * 日志总线：环形缓冲 + SSE 广播
 * 司空管理页面的「日志输出」与全站排障都依赖它。
 */
import { EventEmitter } from 'node:events';

const MAX = 800;
const buffer = [];
export const bus = new EventEmitter();
bus.setMaxListeners(0);

let seq = 0;

function levelOf(entry) {
  return entry.level || 'info';
}

export function push(level, tag, message, detail) {
  const entry = {
    id: ++seq,
    ts: Date.now(),
    time: new Date().toTimeString().slice(0, 8) + '.' + String(Date.now() % 1000).padStart(3, '0'),
    level,
    tag,
    message,
    detail: detail === undefined ? null : detail,
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  bus.emit('log', entry);
  return entry;
}

export const log = {
  info: (tag, message, detail) => push('info', tag, message, detail),
  ok: (tag, message, detail) => push('success', tag, message, detail),
  warn: (tag, message, detail) => push('warning', tag, message, detail),
  error: (tag, message, detail) => push('error', tag, message, detail),
  debug: (tag, message, detail) => push('debug', tag, message, detail),
};

export function getLogs(level, keyword, limit = 300) {
  let list = buffer;
  if (level && level !== 'all') list = list.filter((e) => e.level === level);
  if (keyword) {
    const k = keyword.toLowerCase();
    list = list.filter(
      (e) =>
        (e.message && e.message.toLowerCase().includes(k)) ||
        (e.tag && e.tag.toLowerCase().includes(k)) ||
        (e.detail && JSON.stringify(e.detail).toLowerCase().includes(k))
    );
  }
  return list.slice(-limit);
}

export function clearLogs() {
  buffer.length = 0;
  bus.emit('clear');
}
