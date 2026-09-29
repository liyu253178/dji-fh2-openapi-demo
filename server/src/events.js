/**
 * 事件总线：设备上下线、任务状态变更等 → SSE 推送前端
 */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(200);

/** 发布领域事件 */
export function emit(type, payload) {
  bus.emit('event', { type, payload, ts: Date.now() });
}

/** 订阅（SSE 用） */
export function subscribe(fn) {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
