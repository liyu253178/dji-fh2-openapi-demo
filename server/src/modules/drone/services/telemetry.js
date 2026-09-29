/**
 * 遥测领域服务（一网统飞核心）
 * 统一聚合：设备树 + 物模型 + 位置 + 电量 + 状态归一化 + HMS
 * 供监控页、虚拟座舱、大屏、地图复用（V1 各页各拉一遍是主要性能问题）
 */
import { request } from '../../../djiClient.js';
import { remember, get, set, clear } from '../../../cache.js';
import { emit } from '../../../events.js';
import { log } from '../../../logger.js';

const TREE_TTL = 30000; // 设备树 30s
const STATE_TTL = 10000; // 物模型 10s
const SNAP_TTL = 8000; // 遥测快照 8s

/** 状态归一化：同时兼容司空 2 数字码与字符串枚举（说明书中机场/飞行器状态存在两种表达） */
const AIRPORT_MODE = {
  0: '空闲中', 1: '现场调试', 2: '远程调试', 3: '固件升级中', 4: '作业中',
  idle: '空闲中', on_job: '作业中', working: '作业中', debug: '现场调试',
  remote_debug: '远程调试', upgrade: '固件升级中', preparing: '作业准备中',
  returning: '作业后关舱盖中', offline: '已离线',
};
const DRONE_MODE = {
  0: '待机', 1: '起飞准备', 2: '起飞准备完毕', 3: '手动飞行', 4: '自动起飞', 5: '航线飞行',
  6: '全景拍照', 9: '自动返航', 10: '自动降落', 13: '升级中', 14: '未连接', 19: '机场选址中',
  standby: '待机', not_connected: '未连接', in_dock_power_off: '舱内关机', powering_on: '开机中',
  takeoff_preparing: '起飞准备', takeoff_ready: '起飞准备完成', manual: '手动飞行',
  auto_takeoff: '自动起飞', wayline: '航线飞行', returning: '返航', landing: '降落',
  upgrading: '升级中', force_avoid: '强制躲避', force_landing: '强制降落',
};

export const normalizeAirportMode = (c) => AIRPORT_MODE[c] ?? (c === undefined ? '-' : String(c));
export const normalizeDroneMode = (c) => DRONE_MODE[c] ?? (c === undefined ? '-' : String(c));

/** 从物模型中提取位置（机场用 latitude/longitude，飞行器回退 home 点） */
export function extractPosition(state) {
  const s = state?.device_state;
  if (!s) return null;
  const pick = (lat, lng) => {
    if (lat === undefined || lng === undefined) return null;
    if (lat === 0 && lng === 0) return null;
    return { lat, lng, height: s.height ?? s.elevation ?? 0 };
  };
  return pick(s.latitude, s.longitude) || pick(s.home_latitude, s.home_longitude);
}

function pickBattery(state) {
  const s = state?.device_state || {};
  return (
    s.battery?.capacity_percent ??
    s.drone_charge_state?.capacity_percent ??
    s.capacity_percent ??
    null
  );
}

/** 设备树：遍历项目聚合（标注每台设备真实归属项目，物模型才取得到数据） */
export async function deviceTree(force = false) {
  return remember('device:tree', TREE_TTL, async () => {
    const prj = await request({ method: 'GET', path: '/project', query: { page: 1, page_size: 100 }, tag: '组织项目' });
    const projects = prj.ok && prj.data?.list ? prj.data.list : [];
    const list = [];
    for (const p of projects) {
      const d = await request({ method: 'GET', path: '/project/device', projectUuid: p.uuid, tag: '组织项目' });
      for (const item of d.ok && d.data?.list ? d.data.list : []) {
        list.push({ ...item, projectUuid: p.uuid, projectName: p.name });
      }
    }
    if (!list.length) {
      const all = await request({ method: 'GET', path: '/device', tag: '组织项目' });
      for (const item of all.ok && all.data?.list ? all.data.list : []) {
        list.push({ ...item, projectUuid: '', projectName: '' });
      }
    }
    return { list, projects };
  }, {
    force,
    // 空设备树不落缓存：启动瞬间 token 未就绪会返回空列表，缓存住就会一直“找不到设备”
    isEmpty: (v) => !v?.list?.length,
  });
}

/** 单设备物模型（带项目头 + 缓存） */
export async function deviceState(sn, projectUuid = '', force = false) {
  const key = `state:${sn}:${projectUuid}`;
  if (force) {
    const r = await request({
      method: 'GET',
      path: `/device/${encodeURIComponent(sn)}/state`,
      projectUuid: projectUuid || undefined,
      tag: '设备管理',
    });
    if (r.ok && r.data) set(key, r.data, STATE_TTL);
    return r;
  }
  const cached = get(key);
  if (cached) return { ok: true, code: 0, message: '', data: cached, status: 200, duration: 0, cached: true };
  const r = await request({
    method: 'GET',
    path: `/device/${encodeURIComponent(sn)}/state`,
    projectUuid: projectUuid || undefined,
    tag: '设备管理',
  });
  if (r.ok && r.data) set(key, r.data, STATE_TTL);
  return r;
}

/**
 * 设备型号展示名
 * 接口偶尔不给 device_model.name，此时直接显示默认泛称（"机场"/"飞行器"）会丢失机型信息。
 * 机型 key → 中文名映射取自 DJI 官方示例源码 FlightHub-2-OpenAPI-V2-Demo。
 */
const MODEL_NAME_MAP = {
  '0-67-0': 'M30', '0-67-1': 'M30T', '0-77-0': 'Mavic 3E', '0-77-1': 'Mavic 3T', '0-77-3': 'Mavic 3TA',
  '0-99-0': 'Matrice 4E', '0-99-1': 'Matrice 4T', '0-103-0': 'Matrice 400',
  '0-100-0': 'M4D', '0-100-1': 'M4TD',
  '0-60-0': 'M300 RTK', '0-89-0': 'M350 RTK',
  '0-11-0': 'Phantom 4', '0-18-0': 'Phantom 4 Pro', '0-59-0': 'Phantom 4 RTK', '0-27-0': 'Phantom 4 Advanced',
  '0-91-0': 'M3D', '0-91-1': 'M3TD',
  '3-1-0': 'Dock', '3-2-0': 'Dock 2', '3-3-0': 'Dock 3', '3-4-0': 'D-RTK 3 (Inside Edition)',
  '6-600-0': 'D-RTK 3', '6-610-0': 'O4 地面站（中继）',
  '8-135-0': 'O4 地面站',
  '9-131-0': 'EA340D', '0-130-0': 'EA340T', '0-139-0': 'PM355',
};

export function modelName(model, fallback) {
  return model?.name || MODEL_NAME_MAP[model?.key] || model?.key || fallback;
}

/**
 * 设备树条目里各「设备角色」的 key。
 *
 * 公有云 v0.1（以及实测的 v2.0 `/project/device`）只返回 gateway + drone；
 * 私有化形态的设备树还会带 base_station / relay，或在 v2.0 的 manage-devices 里
 * 以 associate_*_device_info 出现（见 DJI 官方示例的 ManageDevice 类型）。
 * 这里按「角色 → 业务分类」统一处理，任一形态出现都能被识别，
 * 而不是只认 gateway/drone 把其它设备静默丢掉。
 */
const DEVICE_ROLES = [
  { key: 'gateway', kind: 'airport', label: '机场' },
  { key: 'drone', kind: 'drone', label: '飞行器' },
  { key: 'base_station', kind: 'base_station', label: '地面站' },
  { key: 'relay', kind: 'relay', label: '中继站' },
  { key: 'dock', kind: 'airport', label: 'Dock' },
  { key: 'hangar', kind: 'airport', label: '机库' },
  { key: 'associate_dock_device_info', kind: 'airport', label: '机场' },
  { key: 'associate_drone_device_info', kind: 'drone', label: '飞行器' },
  { key: 'associate_relay_device_info', kind: 'relay', label: '中继站' },
  { key: 'associate_base_station_device_info', kind: 'base_station', label: '地面站' },
];

/** 同一条目里同一 kind 可能被多个角色命中（gateway 与 associate_dock_device_info），按 sn 去重 */
function pushUnique(list, rec) {
  if (list.some((x) => x.sn === rec.sn)) return;
  list.push(rec);
}

/** 从设备原始结构里取统一视图 */
function toRecord(dev, role, kind, item) {
  const model = dev.device_model || {};
  return {
    kind,
    role: role.key,
    sn: dev.sn,
    callsign: dev.callsign || dev.sn,
    model: modelName(model, role.label),
    modelKey: model.key || '',
    deviceClass: model.class || kind,
    online: !!dev.device_online_status,
    modeCode: dev.mode_code,
    cameraList: dev.camera_list || [],
    /** 机场侧的关联飞行器 SN（scheduler / statsService / 座舱默认选择都在用，不能删） */
    droneSn: '',
    dockSn: '',
    projectUuid: item.projectUuid || '',
    projectName: item.projectName || '',
  };
}

/**
 * 摊平为「设备类型无关」的列表
 * @returns {{airports:object[], drones:object[], baseStations:object[], relays:object[], all:object[]}}
 */
export function flatten(list) {
  const airports = [];
  const drones = [];
  const baseStations = [];
  const relays = [];
  const bucketOf = { airport: airports, drone: drones, base_station: baseStations, relay: relays };

  /** 把一条设备记录按 class 二次归类（class 比角色 key 更权威） */
  const recategorize = (rec) => {
    const cls = String(rec.deviceClass || '').toLowerCase();
    if (cls === 'drone') return 'drone';
    if (cls === 'relay') return 'relay';
    if (cls === 'base_station') return 'base_station';
    return 'airport';
  };

  for (const item of list || []) {
    let dockSn = '';
    for (const role of DEVICE_ROLES) {
      const dev = item[role.key];
      if (!dev?.sn) continue;
      const rec = toRecord(dev, role, role.kind, item);
      const kind = recategorize(rec);
      rec.kind = kind;
      pushUnique(bucketOf[kind], rec);
      if (kind === 'airport') dockSn = dockSn || rec.sn;
    }
    // 飞行器回填所属机场；机场回填关联飞行器（同一设备树条目内成对出现）
    for (const d of drones) {
      if (d.dockSn) continue;
      if ((item.drone && item.drone.sn === d.sn) || (item.associate_drone_device_info?.sn === d.sn)) {
        d.dockSn = dockSn;
      }
    }
    for (const a of airports) {
      if (a.droneSn || a.sn !== dockSn) continue;
      const dr = item.drone || item.associate_drone_device_info;
      if (dr?.sn) a.droneSn = dr.sn;
    }
  }

  return {
    airports,
    drones,
    baseStations,
    relays,
    all: [...airports, ...drones, ...baseStations, ...relays],
  };
}

/** 统一遥测快照：一次聚合，多处复用 */
export async function snapshot(force = false) {
  return remember('telemetry:snapshot', SNAP_TTL, async () => {
    const { list } = await deviceTree(force);
    const { airports, drones } = flatten(list);

    const tasks = [];
    for (const d of [...airports, ...drones]) {
      tasks.push(
        deviceState(d.sn, d.projectUuid, force).then((r) => {
          const data = r.ok ? r.data : null;
          const s = data?.device_state || {};
          return {
            ...d,
            modeText: d.kind === 'drone' ? normalizeDroneMode(d.modeCode ?? s.mode_code) : normalizeAirportMode(d.modeCode ?? s.mode_code),
            position: extractPosition(data),
            battery: pickBattery(data),
            height: s.height ?? null,
            elevation: s.elevation ?? null,
            inDock: s.drone_in_dock ?? null,
            liveCapacity: s.live_capacity ?? null,
            stateError: r.ok ? null : r.message || '物模型获取失败',
          };
        })
      );
    }
    const devices = await Promise.all(tasks);
    const withPos = devices.filter((d) => d.position);

    // HMS 告警聚合
    let alerts = [];
    if (devices.length) {
      const r = await request({
        method: 'GET',
        path: '/device/hms',
        query: { device_sn_list: devices.map((d) => d.sn), language: 'zh' },
        tag: '设备管理',
      });
      if (r.ok) {
        alerts = (r.data?.list || []).flatMap((x) => x.device_hms?.list || []);
      }
    }

    return {
      ts: Date.now(),
      devices,
      airports: devices.filter((d) => d.kind === 'airport'),
      drones: devices.filter((d) => d.kind === 'drone'),
      withPosition: withPos,
      alerts,
      summary: {
        total: devices.length,
        online: devices.filter((d) => d.online).length,
        airports: devices.filter((d) => d.kind === 'airport').length,
        drones: devices.filter((d) => d.kind === 'drone').length,
        positioned: withPos.length,
        alertCount: alerts.length,
      },
    };
  }, force);
}

/** 强制刷新（切换 TK/项目后调用） */
export function invalidate() {
  clear('device:');
  clear('state:');
  clear('telemetry:');
  log.info('TELEMETRY', '遥测缓存已失效');
}

/** 设备上下线检测（轮询比对后发事件） */
let lastOnline = new Map();
export function detectChanges(snap) {
  for (const d of snap.devices) {
    const prev = lastOnline.get(d.sn);
    if (prev !== undefined && prev !== d.online) {
      emit(d.online ? 'device.online' : 'device.offline', { sn: d.sn, callsign: d.callsign, kind: d.kind });
    }
    lastOnline.set(d.sn, d.online);
  }
}
