/**
 * 飞行任务请求体构造器
 *
 * 实测结论（2026-09-23 用假机场 SN 做差分探针得出，均不会真实起飞）：
 *  1. 缺少 resumable_status  → 200610 invalid param format
 *  2. 传 landing_dock_sn（与 sn 相同）→ 200101 param is invalid，非蛙跳任务禁止传
 *  3. 任务名中的 / : 等字符会被净化，中文名不受影响
 *  4. time_zone 建议显式传 Asia/Chongqing（文档示例即如此）
 *
 * 因此所有创建飞行任务的入口统一走 buildFlightTaskBody，避免再踩同样的坑。
 */
export const DEFAULT_TIME_ZONE = 'Asia/Chongqing';

/** 任务名净化：去掉文件名/URL 非法字符，压缩空白，限制长度 */
export function sanitizeTaskName(name) {
  const raw = String(name ?? '').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return `flight_task_${Date.now()}`;
  return cleaned.slice(0, 60);
}

/**
 * 构造创建飞行任务的请求体
 * @param {object} input 业务侧传入的原始参数
 * @returns {object} 可直接 POST /openapi/v0.1/flight-task 的 body
 */
export function buildFlightTaskBody(input = {}) {
  const body = {
    name: sanitizeTaskName(input.name),
    wayline_uuid: input.wayline_uuid,
    sn: input.sn,
    // 非蛙跳任务禁止传 landing_dock_sn，实测会导致 200101
    time_zone: input.time_zone || DEFAULT_TIME_ZONE,
    rth_altitude: Number(input.rth_altitude) || 100,
    rth_mode: input.rth_mode === 'preset' ? 'preset' : 'optimal',
    wayline_precision_type: input.wayline_precision_type === 'gps' ? 'gps' : 'rtk',
    // 必填：漏传会返回 200610 invalid param format
    resumable_status: input.resumable_status === 'auto' ? 'auto' : 'manual',
    task_type: input.task_type || 'immediate',
  };

  if (input.out_of_control_action_in_flight) {
    body.out_of_control_action_in_flight = input.out_of_control_action_in_flight;
  }
  // 定时 / 重复 / 连续任务的扩展时间参数
  if (input.begin_at) body.begin_at = Number(input.begin_at);
  if (input.end_at) body.end_at = Number(input.end_at);
  if (input.repeat_type) body.repeat_type = input.repeat_type;
  if (input.repeat_option) body.repeat_option = input.repeat_option;
  if (input.min_battery_capacity) body.min_battery_capacity = Number(input.min_battery_capacity);

  return body;
}
