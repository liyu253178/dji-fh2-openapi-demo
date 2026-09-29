/**
 * 设备物模型 → 分组指标
 *
 * 字段路径、单位换算与阈值配色全部对照 DJI 官方示例源码
 * `FlightHub-2-OpenAPI-V2-Demo`（PublicCloud/DeviceList）整理，已逐条核对官方字段表。
 *
 * 设计约定：
 *  - 只输出**设备实际上报**的指标，缺的字段直接不出现（不同机型字段差异很大，
 *    例如供电电压/输入功率只在 Dock3，蓄电池开关只在 Dock2，车载配件只在 Dock3 移动式）。
 *  - 每个指标统一成 { k, v, color? } —— 渲染层只负责摆格子，不做任何业务判断。
 *  - 单位换算集中在这里：秒 → N天N时、毫伏 → V、KB/s、°C、%、m/s。
 */
import {
  formatDuration,
  formatFlightDuration,
  formatVoltage,
  formatCurrent,
  formatRate,
  fmtTime,
  getDisplayValue,
} from './format';
import {
  airConditionerText,
  BASESTATION_WORK_MODE_TEXT,
  DRONE_IN_DOCK_TEXT,
  LINK_STATE_TEXT,
  LINK_WORKMODE_TEXT,
  NET_QUALITY_TEXT,
  POE_LEVEL_WATT,
  RTK_FIX_TEXT,
  calibrationText,
  departureText,
  deviceBucket,
  gearText,
  modeText,
  powerModeText,
  rainfallText,
  switchText,
} from './dict';

/** 电量阈值配色：>50 绿 / 20~50 黄 / <20 红（与官方示例一致） */
export function batteryColor(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '';
  if (n > 50) return 'var(--c-ok)';
  if (n >= 20) return 'var(--c-warn)';
  return 'var(--c-err)';
}

/** 搜星阈值配色：<=6 红 / <=11 黄 / 其余正常 */
export function rtkColor(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (v <= 6) return 'var(--c-err)';
  if (v <= 11) return 'var(--c-warn)';
  return 'var(--c-ok)';
}

const has = (v) => v !== undefined && v !== null && v !== '';

/** 往分组里塞一条指标；value 为空则跳过 */
function add(list, k, raw, format, extra = {}) {
  if (!has(raw)) return;
  const v = format ? format(raw) : getDisplayValue(raw);
  if (v === '--' || v === '' || v === undefined || v === null) return;
  list.push({ k, v, ...extra });
}

const num = (v, digits = 1) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
};
const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.floor(n)) : '--';
};

/** tilt_angle 结构不固定（可能是 {x,y,z} 也可能是数字） */
function tiltText(t) {
  if (!has(t)) return '--';
  if (typeof t === 'number') return `${num(t)}°`;
  const parts = ['x', 'y', 'z'].map((k) => (has(t[k]) ? `${k.toUpperCase()} ${num(t[k])}°` : '')).filter(Boolean);
  return parts.length ? parts.join(' / ') : '--';
}

/** 避障开关（horizon/upside/downside，公有云为 enable/disable 字符串） */
function obstacleText(o) {
  if (!has(o)) return '--';
  const on = (v) => (typeof v === 'string' ? v === 'enable' : Number(v) === 1);
  const parts = [];
  if (has(o.horizon)) parts.push(`水平${on(o.horizon) ? '开' : '关'}`);
  if (has(o.upside)) parts.push(`上方${on(o.upside) ? '开' : '关'}`);
  if (has(o.downside)) parts.push(`下方${on(o.downside) ? '开' : '关'}`);
  return parts.length ? parts.join(' · ') : '--';
}

/** 从设备状态里取电量：三个分支按存在顺序兜底（官方示例同款逻辑） */
export function pickBatteryPercent(s) {
  if (!s) return undefined;
  return (
    s.drone_battery_maintenance_info?.batteries?.[0]?.capacity_percent ??
    s.drone_charge_state?.capacity_percent ??
    s.battery?.capacity_percent ??
    s.battery?.batteries?.[0]?.capacity_percent
  );
}

/**
 * 电池列表（左右双电池）
 * 实测结构：battery = { batteries: [ {index:'left_battery', loop_times, voltage, temperature, ...} ],
 *                       capacity_percent, landing_power, return_home_power }
 * 明细在 battery.batteries[] 里，**不在 battery 本身** —— 之前漏了这层，电池组只剩 2 项。
 */
function batteryList(s) {
  const b = s?.battery;
  if (!b) return [];
  if (Array.isArray(b)) return b;
  if (Array.isArray(b.batteries) && b.batteries.length) return b.batteries;
  return [b];
}

/** 电池位别：index='left_battery' → 左电池 */
function batteryLabel(b, i, total) {
  const idx = String(b?.index || '');
  if (idx.includes('left')) return '左电池 ';
  if (idx.includes('right')) return '右电池 ';
  return total > 1 ? `电池${i + 1} ` : '';
}

/** 图传信号：wireless_link 是对象（sdr_quality / sdr_link_state / link_workmode），不是数字 */
function wirelessLinkText(link) {
  if (!link || typeof link !== 'object') {
    if (link === null || link === undefined || link === '') return '--';
    return String(link);
  }
  const parts = [];
  if (has(link.sdr_quality)) parts.push(`${int(link.sdr_quality)} 格`);
  if (has(link.sdr_link_state)) parts.push(LINK_STATE_TEXT[link.sdr_link_state] || String(link.sdr_link_state));
  if (has(link.link_workmode)) parts.push(LINK_WORKMODE_TEXT[link.link_workmode] || String(link.link_workmode));
  return parts.length ? parts.join(' · ') : '--';
}

/** ---------- 机场 / Dock ---------- */
function airportGroups(s) {
  const rows = [];
  const staticRows = [];
  add(staticRows, '工作状态', modeText('airport', s.mode_code));
  add(staticRows, '累计运行时长', s.acc_time, formatDuration);
  add(staticRows, '作业架次', s.job_number, int);
  add(staticRows, '搜星', s.position_state?.rtk_number, int, {
    color: rtkColor(s.position_state?.rtk_number),
  });
  add(staticRows, '标定状态', s.position_state?.is_calibration, calibrationText);
  add(staticRows, '最近上报时间', s.device_data_update_time, fmtTime);
  if (staticRows.length) rows.push({ title: '运行信息', items: staticRows });

  const devRows = [];
  // 注意单位：electric_supply_voltage 是 V，working_voltage 是 mV，working_current 是 mA
  add(devRows, '供电电压', s.electric_supply_voltage, (v) => `${num(v)} V`);
  add(devRows, '工作电压', s.working_voltage, formatVoltage);
  add(devRows, '工作电流', s.working_current, formatCurrent);
  add(devRows, '输入功率', s.acdc_power_input, (v) => `${int(v)} W`);
  add(devRows, '网络速率', s.network_state?.rate, formatRate);
  add(devRows, '网络质量', s.network_state?.quality, (v) => NET_QUALITY_TEXT[v] ?? String(v));
  add(devRows, '网络类型', s.network_state?.type, (v) => ({ ethernet: '有线', '4g': '4G', wifi: 'Wi-Fi' }[v] ?? String(v)));
  add(devRows, '备降点', s.alternate_land_point?.is_configured, departureText);
  add(devRows, '进离场航线', s.departure_point_status, departureText);
  add(devRows, '空调状态', s.air_conditioner?.air_conditioner_state, airConditionerText);
  // backup_battery.switch 是字符串 'enable'/'disable'
  add(devRows, '蓄电池开关', s.backup_battery?.switch, switchText);
  add(devRows, '蓄电池电压', s.backup_battery?.voltage, formatVoltage);
  add(devRows, '蓄电池温度', s.backup_battery?.temperature, (v) => `${num(v)} °C`);
  add(devRows, '车载配件', s.vehicle_accessory, switchText);
  add(devRows, '倾斜角度', s.tilt_angle, tiltText);
  add(devRows, 'PoE 输出接口', s.poe_link_status, switchText);
  add(devRows, 'PoE 输出功率', s.poe_power_output, (v) => `${num(v)} W`);
  // 直播能力：可用路数 / 当前在推路数（排障时最常问的一个数）
  const cap = s.live_capacity;
  if (cap) {
    const avail = cap.available_video_number ?? cap.device_list?.[0]?.available_video_number;
    const max = cap.coexist_video_number_max ?? cap.device_list?.[0]?.coexist_video_number_max;
    add(devRows, '直播路数', avail !== undefined ? `${avail}${max !== undefined ? ` / ${max}` : ''}` : undefined);
  }
  if (Array.isArray(s.live_status)) add(devRows, '正在推流', s.live_status.length ? `${s.live_status.length} 路` : '无');
  if (devRows.length) rows.push({ title: '设备指标', items: devRows });

  const envRows = [];
  add(envRows, '舱内温度', s.temperature, (v) => `${num(v)} °C`);
  add(envRows, '舱内湿度', s.humidity, (v) => `${num(v)} %`);
  add(envRows, '环境温度', s.environment_temperature, (v) => `${num(v)} °C`);
  add(envRows, '雨量', s.rainfall, rainfallText);
  add(envRows, '风速', s.wind_speed, (v) => `${num(v)} m/s`);
  if (envRows.length) rows.push({ title: '舱内环境', items: envRows });

  return rows;
}

/** ---------- 地面站 ---------- */
function baseStationGroups(s) {
  const rows = [];
  add(rows, '工作状态', modeText('base_station', s.mode_code));
  add(rows, '基站模式', s.basestation_work_mode, (v) => BASESTATION_WORK_MODE_TEXT[v] ?? String(v));
  add(rows, '累计运行时长', s.acc_time, formatDuration);
  add(rows, '搜星', s.position_state?.rtk_number, int, { color: rtkColor(s.position_state?.rtk_number) });
  add(rows, '标定状态', s.position_state?.is_calibration, calibrationText);
  add(rows, '网络速率', s.network_state?.rate, formatRate);
  add(rows, 'LAN 口', s.lan_status, (v) => {
    const t = switchText(v);
    return t === '开启' ? '已连接' : t === '关闭' ? '未连接' : t;
  });
  add(rows, '倾斜角度', s.tilt_angle, tiltText);
  add(rows, '供电方式', s.power_mode ?? s.electric_supply_mode, powerModeText);
  add(rows, '电池电压', s.backup_battery?.voltage, formatVoltage);
  add(rows, 'PoE 功率等级', s.poe_status, (v) => {
    const w = POE_LEVEL_WATT[v];
    return w ? `${w} W（等级 ${v}）` : `等级 ${v}`;
  });
  return rows.length ? [{ title: '地面站指标', items: rows }] : [];
}

/** ---------- 飞行器 ---------- */
function droneGroups(s, parent) {
  const rows = [];

  const flyRows = [];
  add(flyRows, '工作状态', modeText('drone', s.mode_code));
  add(flyRows, '累计飞行时长', s.total_flight_time, formatFlightDuration);
  add(flyRows, '飞行架次', s.total_flight_sorties, int);
  add(flyRows, '真高', s.height, (v) => `${num(v)} m`);
  add(flyRows, '水平速度', s.horizontal_speed, (v) => `${num(v)} m/s`);
  add(flyRows, '图传信号', parent?.wireless_link, wirelessLinkText);
  add(flyRows, '在舱', s.drone_in_dock, (v) =>
    DRONE_IN_DOCK_TEXT[v] ?? (v === true || Number(v) === 1 ? '是（舱内）' : '否（已出舱）')
  );
  add(flyRows, '搜星', s.position_state?.rtk_number, int, { color: rtkColor(s.position_state?.rtk_number) });
  const pct = pickBatteryPercent(s);
  add(flyRows, '电量', pct, (v) => `${int(v)} %`, { color: batteryColor(pct) });
  if (flyRows.length) rows.push({ title: '飞行信息', items: flyRows });

  const posRows = [];
  add(posRows, '纬度', s.latitude, (v) => Number(v).toFixed(7));
  add(posRows, '经度', s.longitude, (v) => Number(v).toFixed(7));
  add(posRows, '海拔', s.elevation, (v) => `${num(v)} m`);
  // is_fixed 是字符串 'fixing_successful'，不能按布尔判断
  add(posRows, 'RTK 定位', s.position_state?.is_fixed, (v) => RTK_FIX_TEXT[v] ?? String(v));
  add(posRows, '定位质量', s.position_state?.quality, gearText);
  add(posRows, 'GPS 卫星', s.position_state?.gps_number, int);
  if (posRows.length) rows.push({ title: '位置', items: posRows });

  const batRows = [];
  const bats = batteryList(s);
  bats.forEach((b, i) => {
    const prefix = batteryLabel(b, i, bats.length);
    add(batRows, `${prefix}循环次数`, b?.loop_times, (v) => `${int(v)} 次`);
    add(batRows, `${prefix}高电量存储`, b?.high_voltage_storage_days, (v) => `${int(v)} 天`);
    add(batRows, `${prefix}电压`, b?.voltage, formatVoltage);
    add(batRows, `${prefix}温度`, b?.temperature, (v) => `${num(v)} °C`);
    // 单电池时电量已在「飞行信息」里展示，这里不重复
    if (bats.length > 1) {
      add(batRows, `${prefix}电量`, b?.capacity_percent, (v) => `${int(v)} %`, {
        color: batteryColor(b?.capacity_percent),
      });
    }
  });
  add(batRows, '返航预留电量', s.remaining_power_for_return_home ?? s.battery?.return_home_power, (v) => `${int(v)} %`);
  add(batRows, '降落预留电量', s.battery?.landing_power, (v) => `${int(v)} %`);
  add(batRows, '剩余飞行时间', s.battery?.remain_flight_time, (v) => `${int(v)} 分`);
  if (batRows.length) rows.push({ title: '电池', items: batRows });

  const setRows = [];
  add(setRows, '夜航灯', s.night_lights_state, switchText);
  add(setRows, '限高', s.height_limit, (v) => `${num(v, 0)} m`);
  add(setRows, '限远', s.distance_limit_status?.distance_limit, (v) => `${num(v, 0)} m`, {
    color: Number(s.distance_limit_status?.state) === 1 ? '' : 'var(--c-text-2)',
  });
  add(setRows, '避障', s.obstacle_avoidance, obstacleText);
  // battery_store_mode 是字符串 'standby_mode' / 'close_mode'
  add(setRows, '电池保养模式', s.battery_store_mode, (v) =>
    String(v) === 'standby_mode' ? '待命' : String(v) === 'close_mode' ? '关闭' : switchText(v)
  );
  add(setRows, '备降转移高', parent?.alternate_land_point?.safe_land_height, (v) => `${num(v, 0)} m`);
  if (setRows.length) rows.push({ title: '飞行器设置', items: setRows });

  return rows;
}

/** ---------- 中继站 ---------- */
function relayGroups(s) {
  const rows = [];
  add(rows, '工作状态', modeText('relay', s.mode_code));
  add(rows, '网络速率', s.network_state?.rate, formatRate);
  add(rows, '倾斜角度', s.tilt_angle, tiltText);
  add(rows, '电池电压', s.backup_battery?.voltage, formatVoltage);
  return rows.length ? [{ title: '中继站指标', items: rows }] : [];
}

/**
 * 主入口
 * @param {string} deviceClass device_model.class（airport / dock / hangar / drone / base_station / relay）
 * @param {object} state device_state 物模型
 * @param {object} [parent] 关联的父设备物模型（飞行器的图传信号、备降高在机场侧）
 * @returns {{title:string, items:{k:string,v:string,color?:string}[]}[]}
 */
export function buildMetricGroups(deviceClass, state, parent = null) {
  const s = state || {};
  switch (deviceBucket(deviceClass)) {
    case 'drone':
      return droneGroups(s, parent);
    case 'base_station':
      return baseStationGroups(s);
    case 'relay':
      return relayGroups(s);
    default:
      return airportGroups(s);
  }
}
