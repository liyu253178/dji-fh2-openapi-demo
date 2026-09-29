/**
 * 司空 2 字典表
 *
 * 来源：DJI 官方示例源码 `FlightHub-2-OpenAPI-V2-Demo`
 *   PublicCloud/DeviceList/main.ts（MODEL_NAME_MAP / *_WORKING_MAP / HMS_* ）
 * 这些是平台侧的枚举语义，官方示例里的取值与文案已与司空前端 i18n 对齐，
 * 直接采用可以避免我们自己猜测（例如 mode_code 14 到底是「未连接」还是「关机」）。
 */

/** 设备型号 key → 中文名（device_model.name 缺失时兜底） */
export const MODEL_NAME_MAP = {
  '0-67-0': 'M30', '0-67-1': 'M30T', '0-77-0': 'Mavic 3E', '0-77-1': 'Mavic 3T', '0-77-3': 'Mavic 3TA',
  '0-99-0': 'Matrice 4E', '0-99-1': 'Matrice 4T', '0-103-0': 'Matrice 400',
  '0-100-0': 'M4D', '0-100-1': 'M4TD',
  '0-60-0': 'M300 RTK', '0-89-0': 'M350 RTK',
  '0-11-0': 'Phantom 4', '0-18-0': 'Phantom 4 Pro', '0-59-0': 'Phantom 4 RTK', '0-27-0': 'Phantom 4 Advanced',
  '0-91-0': 'M3D', '0-91-1': 'M3TD',
  '3-1-0': 'Dock', '3-2-0': 'Dock 2', '3-3-0': 'Dock 3', '3-4-0': 'D-RTK 3 (Inside Edition)',
  '6-600-0': 'D-RTK 3', '6-610-0': 'O4 地面站（中继）',
  '8-135-0': 'O4 地面站',
  '9-131-0': 'EA340D',
  '0-130-0': 'EA340T',
  '0-139-0': 'PM355',
};

/** 设备 class → 中文 */
export const DEVICE_CLASS_TEXT = {
  airport: '机场', hangar: '机库', base_station: '地面站', dock: 'Dock', drone: '飞行器', relay: '中继站',
};

/** 机场 mode_code → 中文（353101 表示离线，不是「关机」） */
export const AIRPORT_WORKING_MAP = {
  0: '设备空闲中', 1: '现场调试中', 2: '远程调试中', 3: '设备升级中', 4: '设备作业中',
  5: '设备未标定', 6: '节能状态中', 7: '现场急停中',
  47: '作业准备中', 48: '飞行作业中', 49: '等待作业结束',
  50: '自定义飞行区更新中', 51: '地形障碍物数据更新中', 353101: '设备已离线',
};

/** 飞行器 mode_code → 中文（14=飞行器未连接，353101=舱内关机，353102=开机中） */
export const DRONE_WORKING_MAP = {
  0: '待机', 1: '起飞准备中', 2: '起飞准备完成', 3: '手动飞行', 4: '自动起飞',
  5: '航线飞行', 6: '全景拍照', 7: '智能跟随', 8: 'ADS-B躲避', 9: '返航',
  10: '降落', 11: '强制降落', 12: '三桨叶降落', 13: '升级中', 14: '飞行器未连接',
  15: '高级手动飞行:智能绕行避障', 16: '手动飞行', 17: '指点飞行', 18: 'RTK 收敛中',
  19: '机场选址中', 20: 'poi 环绕', 21: '离场航线', 22: '中继选址中',
  353101: '舱内关机', 353102: '开机中', 100: '--', 65535: '状态异常',
};

/** 中继 / 地面站 mode_code → 中文 */
export const RELAY_WORKING_MAP = {
  0: '已连接', 1: '现场调试中', 2: '远程调试中', 3: '设备升级中',
  4: '未标定', 14: '未连接', 65535: '状态异常',
};

/** 地面站 mode_code → 中文（与机场文案相近但不完全一致） */
export const BASE_STATION_WORKING_MAP = {
  0: '设备空闲中', 1: '现场调试中', 2: '远程调试中', 3: '设备升级中', 4: '设备作业中',
  5: '设备未标定', 6: '节能状态中', 353101: '设备已离线',
};

/** 地面站工作模式 */
export const BASESTATION_WORK_MODE_TEXT = {
  0: '常规基站', 1: '漫游基站', 2: '简易机场',
};

/** 供电方式 */
export const POWER_MODE_TEXT = { 0: '交流', 1: '直流', 2: 'PoE' };

/** PoE 功率等级 → 瓦数 */
export const POE_LEVEL_WATT = { 2: 30, 3: 60, 4: 90 };

/** 标定状态（v0.1 数字 / v2.0 字符串） */
export const CALIBRATION_MAP = {
  1: '已标定', 2: '已标定', 0: '未标定',
  calibrated: '已标定', not_calibrated: '未标定', no_calibration_required: '无需标定',
};

/** 备降点 / 进离场航线配置状态 */
export const DEPARTURE_POINT_MAP = {
  0: '未设置', 1: '已设置', 2: '无需配置',
  not_set: '未设置', set: '已设置', not_required: '无需配置', already_set: '已设置',
};

/** 雨量（v2.0 为字符串枚举） */
export const RAINFALL_TEXT_MAP = {
  no_rain: '无降雨', light_rain: '小雨', moderate_rain: '中雨',
  heavy_rain: '大雨', torrential_rain: '暴雨',
};

/** 任务执行状态映射：接口 11 种原始 task_status → 4 类显示（取自 DJI 官方示例） */
export const TASK_STATUS_MAP = {
  0: { key: 'pending', text: '待执行', color: 'var(--c-info)' },
  1: { key: 'failed', text: '执行失败', color: 'var(--c-err)' },
  2: { key: 'running', text: '执行中', color: 'var(--c-ok)' },
  3: { key: 'running', text: '执行中', color: 'var(--c-ok)' },
  4: { key: 'failed', text: '执行失败', color: 'var(--c-err)' },
  5: { key: 'success', text: '执行成功', color: 'var(--c-ok)' },
  6: { key: 'pending', text: '待执行', color: 'var(--c-info)' },
  7: { key: 'failed', text: '执行失败', color: 'var(--c-err)' },
  8: { key: 'failed', text: '执行失败', color: 'var(--c-err)' },
  9: { key: 'pending', text: '待执行', color: 'var(--c-info)' },
  10: { key: 'pending', text: '待执行', color: 'var(--c-info)' },
};

/** 任务类型 */
export const TASK_TYPE_TEXT = { 1: '自动任务', 2: '手动任务' };

/**
 * 任务状态「字符串枚举」→ 归并后的语义 key
 *
 * 实测字段名是 status（不是 task_status）：
 *   GET /openapi/v0.1/flight-task/list → { status, task_type, run_at, completed_at, ... }
 * 取值范围在不同版本/版本线上不统一，已尽可能穷尽：
 *   - 官方 SDK 文档：pending | running | success | failed
 *   - 私有版「更新飞行计划状态」枚举：restored | in_progress | paused | canceled | suspended
 *   - 司空前台文案：无任务 / 待执行 / 执行中 / 执行失败 / 执行终止
 *   - 官方示例（数字化）：0~10
 * 未命中的一律走 unknown，不会显示成空白。
 */
export const TASK_STATUS_TEXT = {
  // 待执行
  pending: 'pending', waiting: 'pending', scheduled: 'pending', ready: 'pending',
  not_started: 'pending', to_be_executed: 'pending', restored: 'pending',
  // 执行中
  running: 'running', in_progress: 'running', executing: 'running', started: 'running',
  paused: 'running', suspended: 'running', resuming: 'running',
  // 成功
  success: 'success', succeeded: 'success', completed: 'success', finished: 'success', done: 'success',
  // 失败 / 终止
  failed: 'failed', error: 'failed', starting_failure: 'failed', timeout: 'failed',
  canceled: 'canceled', cancelled: 'canceled', terminated: 'canceled', stopped: 'canceled',
  aborted: 'canceled',
};

const TASK_STATUS_STYLE = {
  pending: { text: '待执行', color: 'var(--c-info)' },
  running: { text: '执行中', color: 'var(--c-ok)' },
  success: { text: '执行成功', color: 'var(--c-ok)' },
  failed: { text: '执行失败', color: 'var(--c-err)' },
  canceled: { text: '执行终止', color: 'var(--c-warn)' },
  unknown: { text: '未知', color: 'var(--c-text-2)' },
};

/** 已结束的任务状态（用于「未完成 / 已结束」分组） */
export const TASK_DONE_KEYS = ['success', 'failed', 'canceled'];

/** 未完成 / 已结束 分组（接口 flight_task_status） */
export const TASK_GROUP = { 1: '未完成', 2: '已结束' };

/** 媒体上传状态 → 文案 */
export const MEDIA_UPLOAD_TEXT = {
  uploading: '上传中',
  success: '已上传',
  uploaded: '已上传',
  failed: '上传失败',
  no_media: '无媒体',
  none: '无媒体',
  pending: '待上传',
};

/** 任务状态（数字 / 字符串都兼容，未知值兜底） */
export function taskStatus(status) {
  if (status === undefined || status === null || status === '') {
    return { key: 'unknown', ...TASK_STATUS_STYLE.unknown };
  }
  const n = Number(status);
  if (Number.isFinite(n) && String(status).trim() !== '') {
    const hit = TASK_STATUS_MAP[n];
    if (hit) return hit;
  }
  const key = TASK_STATUS_TEXT[String(status).toLowerCase()];
  return key ? { key, ...TASK_STATUS_STYLE[key] } : { key: 'unknown', ...TASK_STATUS_STYLE.unknown, raw: String(status) };
}

/** 媒体上传状态 → 文案 */
export function mediaUploadText(v) {
  if (v === undefined || v === null || v === '') return '--';
  return MEDIA_UPLOAD_TEXT[String(v).toLowerCase()] || String(v);
}

/** 任务类型（含未知值兜底） */
export function taskType(t) {
  return TASK_TYPE_TEXT[Number(t)] || '--';
}

/**
 * 公有云 v2.0 的字符串枚举 → 数字
 * 实测：公有云 v2.0 的 device_state 会用字符串（mode_code='idle'、rainfall='light_rain'），
 * 私有化 / v0.1 则是数字。预置这张表，将来切换接口版本时只需改 djiClient 的 PREFIX。
 */
export const PUBLIC_MODE_CODE_MAP = {
  idle: 0, standby: 0, in_operation: 4,
  takeoff_ready: 2, takeoff_preparation: 1, takeoff_preparation_completed: 2,
  manual_flight: 3, auto_takeoff: 4, automatic_takeoff: 2, wayline_flight: 4,
  return_home: 7, auto_returning_to_home: 7,
  landing: 5, automatic_landing: 5, force_landing: 6, forced_landing: 6,
  three_prop_landing: 6, three_blade_landing: 6,
  panoramic_photography: 4, intelligent_tracking: 4, adsb_avoidance: 4,
  offline: 353101, unknown: 65535,
};

/** v2.0 在线状态字符串 → 布尔 */
export const PUBLIC_ONLINE_MAP = {
  online: true, power_on: true, offline: false, power_off: false,
};

/**
 * 归一化 mode_code：v0.1 数字原样返回，v2.0 字符串查表转数字
 * @param {number|string} code
 */
export function normalizeModeCode(code) {
  if (typeof code === 'string') {
    if (code in PUBLIC_MODE_CODE_MAP) return PUBLIC_MODE_CODE_MAP[code];
    const n = Number(code);
    return Number.isFinite(n) ? n : code;
  }
  return code;
}

/** HMS 告警等级 → 颜色 / 文案 */
export const HMS_LEVEL_COLOR = {
  notification: 'var(--c-ok)',
  reminder: 'var(--c-warn)',
  warning: 'var(--c-err)',
};
export const HMS_LEVEL_TEXT = { notification: '通知', reminder: '注意', warning: '告警' };

/** HMS 所属模块 → 文案 */
export const HMS_MODULE_TEXT = {
  flight_mission: '飞行任务', device_management: '设备管理', media: '媒体', hms: 'HMS',
};

/** HMS 发生时设备是否在空中 */
export const HMS_SKY_TEXT = { on_the_ground: '地面', in_the_sky: '空中' };

/** HMS domain_type → 文案 */
export const DOMAIN_TEXT_MAP = {
  drone_nest: '机场', drone: '飞行器', relay: '中继', base_station: '基站', hangar: '机库',
};

/** 机场空调状态 */
/** 机场空调状态（数字枚举 → 文案） */
export const AIR_CONDITIONER_MAP = {
  0: '空闲中', 1: '制冷中', 2: '加热中', 3: '除湿中', 4: '制冷退出中',
  5: '加热退出中', 6: '除湿退出中', 7: '制冷准备中', 8: '加热准备中',
  9: '除湿准备中', 10: '风冷准备中', 11: '风冷中', 12: '风冷退出中',
};

/**
 * 空调状态字符串枚举 → 数字
 * 实测：**公有云 v0.1 的 air_conditioner_state 也是字符串**（如 'cooling_mode'），
 * 只按数字查表会原样吐出英文。取自 DJI 官方示例的 AC_MODE_MAP。
 */
export const AC_MODE_MAP = {
  idle: 0, close: 0, idle_mode: 0,
  cooling_mode: 1, heating_mode: 2, dehumidification_mode: 3,
  cooling_exit_mode: 4, heating_exit_mode: 5, dehumidification_exit_mode: 6,
  cooling_ready_mode: 7, heating_ready_mode: 8, dehumidification_ready_mode: 9,
  ventilation_ready_mode: 10, ventilation_mode: 11, ventilation_exit_mode: 12,
};

/** 空调状态 → 中文（兼容数字 / 字符串） */
export function airConditionerText(v) {
  if (v === null || v === undefined || v === '') return '--';
  const n = typeof v === 'string' ? AC_MODE_MAP[v] : Number(v);
  return AIR_CONDITIONER_MAP[n] ?? String(v);
}

/**
 * 把 mode_code 翻译成人话。
 * 兼容 v0.1 数字枚举与 v2.0 字符串枚举（内部先归一化）。
 * @param {'airport'|'drone'|'relay'|'base_station'|string} kind 设备类型
 * @param {number|string} code
 */
export function modeText(kind, code) {
  const n = normalizeModeCode(code);
  const map =
    kind === 'drone'
      ? DRONE_WORKING_MAP
      : kind === 'relay'
      ? RELAY_WORKING_MAP
      : kind === 'base_station'
      ? BASE_STATION_WORKING_MAP
      : AIRPORT_WORKING_MAP;
  return map[n] || (code === undefined || code === null || code === '' ? '-' : `状态 ${code}`);
}

/** 设备型号展示名：优先用接口给的 name，缺失时查表 */
export function modelText(model) {
  if (!model) return '-';
  return model.name || MODEL_NAME_MAP[model.key] || model.key || '-';
}

/** HMS 等级展示（含颜色） */
export function hmsLevel(level) {
  const key = String(level || '').toLowerCase();
  return {
    key,
    text: HMS_LEVEL_TEXT[key] || level || '提示',
    color: HMS_LEVEL_COLOR[key] || 'var(--c-text-2)',
  };
}

/** 标定状态（兼容数字 / 字符串） */
export const calibrationText = (v) => CALIBRATION_MAP[v] ?? '--';

/** 备降点 / 进离场航线配置状态（兼容数字 / 字符串） */
export const departureText = (v) => DEPARTURE_POINT_MAP[v] ?? '--';

/** 雨量（兼容数字与字符串） */
export const rainfallText = (v) => {
  if (v === null || v === undefined || v === '') return '--';
  return RAINFALL_TEXT_MAP[v] ?? `${v}`;
};

/** 供电方式 */
export const powerModeText = (v) => POWER_MODE_TEXT[v] ?? (v === null || v === undefined ? '--' : String(v));

/** 设备 class → 统一归类的容器类型（机场/机库/Dock 都算“机场类”） */
export function deviceBucket(deviceClass) {
  const c = String(deviceClass || '').toLowerCase();
  if (c === 'drone') return 'drone';
  if (c === 'relay') return 'relay';
  if (c === 'base_station') return 'base_station';
  if (['airport', 'dock', 'hangar'].includes(c)) return 'airport';
  return c || 'airport';
}

/**
 * RTK/GPS 定位状态
 * 实测 position_state.is_fixed 是**字符串** 'fixing_successful'（不是布尔），
 * 直接当布尔判断会永远显示「未固定」。
 */
export const RTK_FIX_TEXT = {
  fixing_successful: '已固定',
  fixing_failed: '未固定',
  1: '已固定',
  0: '未固定',
};

/** 定位质量 'gear_5' → '5 格' */
export function gearText(quality) {
  if (quality === null || quality === undefined || quality === '') return '--';
  const m = /gear_(\d+)/.exec(String(quality));
  return m ? `${m[1]} 格` : String(quality);
}

/** 飞行器是否在舱：实测是字符串 'inside' / 'outside' */
export const DRONE_IN_DOCK_TEXT = { inside: '是（舱内）', outside: '否（已出舱）' };

/** 图传链路状态 */
export const LINK_STATE_TEXT = { connect: '已连接', disconnect: '未连接' };

/** 图传工作模式 */
export const LINK_WORKMODE_TEXT = {
  sdr_mode: 'SDR 图传',
  '4g_mode': '4G 增强图传',
  dual_mode: '双链路',
  unknown: '未知',
};

/** 网络质量 */
export const NET_QUALITY_TEXT = {
  no_signal: '无信号', weak: '弱', fair: '一般', good: '良好', excellent: '优秀',
};

/**
 * 开关类字段 → 开启/关闭
 * 实测 backup_battery.switch 是**字符串** 'enable'/'disable'（公有云），
 * 私有化可能是 1/0 或 true/false，统一处理。
 */
export const SWITCH_TEXT = {
  enable: '开启', disable: '关闭', on: '开启', off: '关闭',
  enabled: '开启', disabled: '关闭', open: '开启', close: '关闭',
  '1': '开启', '0': '关闭', true: '开启', false: '关闭',
};

export function switchText(v) {
  if (v === null || v === undefined || v === '') return '--';
  const k = typeof v === 'boolean' ? String(v) : String(v).toLowerCase();
  return SWITCH_TEXT[k] ?? String(v);
}
