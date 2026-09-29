/**
 * 一键起飞领域服务
 *
 * 关键结论：
 *  - 司空 2 OpenAPI 没有独立「开机 / 起飞」接口。
 *  - 参考司空 2 说明书与参考项目，机场收到 task_type=immediate 的飞行任务后，
 *    会自动执行「开舱 → 飞行器上电 → 起飞 → 执行航线」流程。
 *  - 因此「一键起飞」的语义 = 预检 → 获取控制权 → 创建立即任务 → 轮询任务状态。
 */
import { request } from '../../../djiClient.js';
import { deviceTree, flatten, normalizeAirportMode } from './telemetry.js';
import { takeControl } from './controlService.js';
import { buildFlightTaskBody } from './flightTaskBody.js';
import { log } from '../../../logger.js';

const MIN_BATTERY_BLOCK = 20; // 低于则阻断
const MIN_BATTERY_WARN = 30; // 低于则警告

function isIdle(modeCode) {
  return modeCode === 'idle' || modeCode === 0 || normalizeAirportMode(modeCode) === '空闲中';
}

function isInDock(v) {
  return v === true || v === 1 || v === 'inside' || v === 'in';
}

function pickBattery(s) {
  return (
    s?.drone_charge_state?.capacity_percent ??
    s?.battery?.capacity_percent ??
    s?.capacity_percent ??
    null
  );
}

/**
 * 起飞前预检
 * @returns {Promise<{ok:boolean, blockers:string[], warnings:string[], checks:object[], dock:any, drone:any, projectUuid:string, battery:number|null, mode:string, inDock:any}>}
 */
export async function precheck({ dockSn, droneSn, waylineUuid }) {
  const { list } = await deviceTree();
  const { airports, drones } = flatten(list);
  const dock = airports.find((a) => a.sn === dockSn) || null;

  if (!dock) {
    return {
      ok: false,
      blockers: ['机场不存在或不在当前组织'],
      warnings: [],
      checks: [],
      dock: null,
      drone: null,
      projectUuid: '',
      battery: null,
      mode: '-',
      inDock: null,
    };
  }

  const drone = droneSn
    ? drones.find((d) => d.sn === droneSn) || null
    : drones.find((d) => d.dockSn === dockSn) || null;

  const stateR = await request({
    method: 'GET',
    path: `/device/${encodeURIComponent(dockSn)}/state`,
    projectUuid: dock.projectUuid || undefined,
    tag: '一键起飞',
  });
  const s = stateR.ok ? stateR.data?.device_state || {} : {};
  const blockers = [];
  const warnings = [];
  const checks = [];
  const add = (k, v, level) => checks.push({ k, v, level });

  // 机场在线
  add('机场在线', dock.online ? '在线' : '离线', dock.online ? 'ok' : 'block');
  if (!dock.online) blockers.push('机场离线');

  // 机场模式
  const modeText = normalizeAirportMode(s.mode_code ?? dock.modeCode);
  const idle = isIdle(s.mode_code ?? dock.modeCode);
  add('机场模式', modeText, idle ? 'ok' : 'block');
  if (!idle) blockers.push(`机场当前模式为「${modeText}」，需为「空闲中」才可起飞`);

  // 飞行器在舱
  const inDock = s.drone_in_dock;
  const inDockOk = isInDock(inDock);
  add('飞行器在舱', inDock === undefined ? '未知' : inDockOk ? '是' : '否', inDockOk ? 'ok' : 'block');
  if (!inDockOk) blockers.push('飞行器不在舱内');

  // 电量
  const battery = pickBattery(s);
  let batteryLevel = 'ok';
  if (battery === null) {
    batteryLevel = 'warn';
    warnings.push('无法获取飞行器电量');
  } else if (battery < MIN_BATTERY_BLOCK) {
    batteryLevel = 'block';
    blockers.push(`飞行器电量 ${battery}% 低于起飞阈值 ${MIN_BATTERY_BLOCK}%`);
  } else if (battery < MIN_BATTERY_WARN) {
    batteryLevel = 'warn';
    warnings.push(`飞行器电量 ${battery}% 偏低`);
  }
  add('飞行器电量', battery === null ? '-' : `${battery}%`, batteryLevel);

  // 航线
  add('航线选择', waylineUuid ? '已选' : '未选', waylineUuid ? 'ok' : 'block');
  if (!waylineUuid) blockers.push('未选择航线');

  /**
   * 航线机型匹配
   * 实测：司空 2 要求航线的 device_model_key 与机场内飞行器机型一致，
   * 不一致时创建立即任务会返回 200610 invalid param format（错误信息不直观）。
   */
  let waylineModelKey = '';
  let waylineName = '';
  if (waylineUuid) {
    const wl = await request({
      method: 'GET',
      path: `/wayline/${encodeURIComponent(waylineUuid)}`,
      projectUuid: dock.projectUuid || undefined,
      tag: '一键起飞',
    });
    if (wl.ok && wl.data) {
      waylineModelKey = wl.data.device_model_key || '';
      waylineName = wl.data.name || '';
    }
  }
  const droneModelKey = drone?.modelKey || '';
  const hasBoth = Boolean(waylineModelKey && droneModelKey);
  const modelMatched = !hasBoth || waylineModelKey === droneModelKey;
  add(
    '航线机型匹配',
    hasBoth
      ? modelMatched
        ? `匹配（${droneModelKey}）`
        : `不匹配：航线 ${waylineModelKey} ≠ 飞行器 ${droneModelKey}`
      : '未知（缺少机型信息）',
    modelMatched ? (hasBoth ? 'ok' : 'warn') : 'block'
  );
  if (!modelMatched) {
    blockers.push(
      `航线机型不匹配：航线要求 ${waylineModelKey}，机场内飞行器为 ${droneModelKey}${
        drone?.model ? `（${drone.model}）` : ''
      }，请改选匹配机型的航线`
    );
  }

  add('所属项目', dock.projectName || dock.projectUuid || '默认项目', 'ok');

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    checks,
    dock,
    drone,
    projectUuid: dock.projectUuid || '',
    battery,
    mode: modeText,
    inDock,
    waylineModelKey,
    waylineName,
    droneModelKey,
    modelMatched,
  };
}

/**
 * 执行一键起飞
 * @returns {Promise<{ok:boolean, message:string, taskUuid?:string, steps:object[], precheck:any, controlInfo:any, create?:any}>}
 */
export async function takeoff({
  dockSn,
  droneSn,
  waylineUuid,
  taskName,
  rthAltitude = 100,
  precision = 'rtk',
  acquireControl = true,
}) {
  if (!dockSn) return { ok: false, message: '缺少机场 SN', steps: [] };
  if (!waylineUuid) return { ok: false, message: '缺少航线 UUID', steps: [] };

  const steps = [];
  const pre = await precheck({ dockSn, droneSn, waylineUuid });

  // step 1 预检
  steps.push({
    key: 'precheck',
    title: '起飞前预检',
    status: pre.ok ? 'success' : 'fail',
    message: pre.ok
      ? `${pre.checks.length} 项检查通过`
      : `未通过：${pre.blockers.join('；')}`,
  });
  if (!pre.ok) {
    log.warn('一键起飞', `预检未通过：${pre.blockers.join('；')}`);
    return { ok: false, message: `预检未通过：${pre.blockers.join('；')}`, steps, precheck: pre };
  }

  // step 2 获取控制权
  let controlInfo = null;
  const droneSn2 = pre.drone?.sn;
  if (acquireControl && droneSn2) {
    const cr = await takeControl(droneSn2, []);
    const controls = cr.data?.controls || [];
    controlInfo = cr.controlInfo || null;
    if (!cr.ok) {
      steps.push({ key: 'control', title: '获取控制权', status: 'fail', message: cr.message });
      return { ok: false, message: `获取控制权失败：${cr.message}`, steps, precheck: pre, controlInfo };
    }
    steps.push({
      key: 'control',
      title: '获取控制权',
      status: 'success',
      message: controls.map((c) => (c.type === 'flight' ? '飞行控制权' : '负载控制权')).join(' + '),
    });
  } else {
    steps.push({ key: 'control', title: '获取控制权', status: 'skip', message: '已跳过' });
  }

  // step 3 创建立即任务
  const body = buildFlightTaskBody({
    name: taskName,
    wayline_uuid: waylineUuid,
    sn: dockSn,
    rth_altitude: rthAltitude,
    rth_mode: 'optimal',
    wayline_precision_type: precision,
    task_type: 'immediate',
  });
  log.info('一键起飞', `正在为机场 ${dockSn} 创建立即任务，航线 ${waylineUuid}`);
  const createR = await request({
    method: 'POST',
    path: '/flight-task',
    body,
    projectUuid: pre.projectUuid || undefined,
    tag: '一键起飞',
  });
  if (!createR.ok) {
    // 失败时把完整请求体打进日志，便于一眼定位是哪个字段不合规
    log.error('一键起飞', `创建立即任务失败 code=${createR.code} ${createR.message}`, {
      body,
      projectUuid: pre.projectUuid || '',
      dockSn,
      waylineUuid,
    });
    steps.push({
      key: 'create',
      title: '创建立即任务',
      status: 'fail',
      message: `${createR.message}${createR.code === 200610 ? '（请求体已写入日志，可到日志面板查看）' : ''}`,
    });
    return {
      ok: false,
      message: `创建立即任务失败：${createR.message}`,
      steps,
      precheck: pre,
      controlInfo,
    };
  }
  const taskUuid = createR.data?.task_uuid;
  steps.push({
    key: 'create',
    title: '创建立即任务',
    status: 'success',
    message: taskUuid ? `任务 UUID：${taskUuid}` : '任务已创建',
  });

  return {
    ok: true,
    message: '立即任务已创建，机场将自动开舱、飞行器上电并起飞',
    taskUuid,
    steps,
    precheck: pre,
    controlInfo,
  };
}

/** 任务状态轮询 */
export async function takeoffStatus(taskUuid) {
  if (!taskUuid) return { ok: false, message: '缺少任务 UUID' };
  const detail = await request({ method: 'GET', path: `/flight-task/${encodeURIComponent(taskUuid)}`, tag: '一键起飞' });
  const status = detail.ok ? detail.data?.status : null;
  return {
    ok: detail.ok,
    data: detail.data || null,
    status,
    message: detail.message || '',
    finished: ['success', 'terminated', 'starting_failure', 'timeout'].includes(status),
  };
}
