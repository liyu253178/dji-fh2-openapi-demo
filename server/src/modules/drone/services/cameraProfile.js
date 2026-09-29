/**
 * 相机范式（Camera Profile）—— 按「设备类型」而非「某台设备」定义拉流与控制策略
 *
 * 设计原则（重要）：
 *   本项目对接的是司空 2 OpenAPI，同一个设备型号（device_model.key 相同）的多台设备，
 *   其相机拓扑、可用机位、拉流表现应当完全一致。
 *   **严禁**为某一台设备的序列号写分支或记忆（如「职校用 outdoor、深圳用 indoor」），
 *   那属于设备特化：换一台同型号机场就要改代码，且上线后无法自愈。
 *
 *   正确做法：把差异抽象成「类型级范式 + 实测回退」——
 *     ① 范式给出候选顺序（对所有同型号设备一致）
 *     ② 运行时用真实结果（有没有画面）在候选里自动回退
 *   这样同型号新设备接入无需改任何代码。
 *
 * 已沉淀的实测结论（都来自真机验证，不要凭直觉推翻）：
 *   - Dock 3（3-3-0）：camera_list 只上报 1 路（165-0-7），camera_position 只报 indoor；
 *     但舱外机位物理上存在且可切（change-camera 返回 code=0），
 *     且「上报 indoor」不等于「indoor 有画面」——实测存在 indoor 纯黑、outdoor 正常出图的机场。
 *     ⇒ 机场机位不能只信上报，必须「按范式顺序枚举 + 实测选择」。
 *   - Matrice 4TD（0-100-1）：上报两路相机，取 camera_list[0] 会选中推不出流的那一路；
 *     正确范式是按镜头能力（available_lens_types 数量）降序选主云台。
 *   - 「有流」≠「有画面」：videoWidth>0 且 currentTime 推进时画面仍可能是纯黑，
 *     成功判据必须是「画面有内容」（亮度/方差），见前端 LivePlayer 的黑屏检测。
 */
import { deviceTree } from './telemetry.js';

/** 设备大类（对应 device_model.class） */
export const CLASS = {
  AIRPORT: 'airport',
  DRONE: 'drone',
};

/**
 * 类型级相机范式
 * fallbackIndex 仅在设备完全不上报 camera_list 时兜底（按类型定义，不按设备定义）
 */
const PROFILE = {
  [CLASS.AIRPORT]: {
    /** 机场相机机位尝试顺序：先看舱外（监控视角），回退舱内 */
    positionOrder: ['outdoor', 'indoor'],
    /** 舱外相机是可选配件，未安装时切换是空操作，因此必须允许回退 */
    allowPositionFallback: true,
    fallbackIndex: '165-0-7',
    fallbackText: '机场相机默认索引',
  },
  [CLASS.DRONE]: {
    /** 飞行器只有云台相机，无机位概念 */
    positionOrder: [],
    allowPositionFallback: false,
    fallbackIndex: '176-0-0',
    fallbackText: '飞行器主云台默认索引',
  },
};

const DEFAULT_PROFILE = {
  positionOrder: [],
  allowPositionFallback: false,
  fallbackIndex: '',
  fallbackText: '未定义范式的设备类型',
};

export function profileOf(deviceClass) {
  return PROFILE[deviceClass] || DEFAULT_PROFILE;
}

/** 取设备大类（兼容 device_model.class 缺失的情况） */
export function classOf(device) {
  return device?.device_model?.class || '';
}

/**
 * 相机选择范式：镜头能力越丰富越可能是主云台相机
 * （Matrice 4TD 实测：176-0-0 只有 normal，99-0-0 有 normal/wide/zoom/ir 且正常出图）
 */
export function scoreCamera(c) {
  return (c?.lens_list || []).reduce((n, l) => n + (l?.available_lens_types?.length || 0), 0);
}

/** 按范式排序后的相机候选（推荐顺序） */
export function rankCameras(cameraList) {
  return (cameraList || [])
    .filter((c) => c?.camera_index)
    .slice()
    .sort((a, b) => scoreCamera(b) - scoreCamera(a));
}

export function pickBestCamera(cameraList) {
  return rankCameras(cameraList)[0] || null;
}

export function cameraCandidates(cameraList) {
  return rankCameras(cameraList).map((c) => c.camera_index);
}

/**
 * 在设备树里定位设备及其所属机场/飞行器
 * @returns {{device:object|null, peer:object|null, dockSn:string, projectUuid:string, deviceClass:string}}
 */
export async function locate(sn) {
  try {
    const { list } = await deviceTree();
    for (const item of list || []) {
      const gw = item.gateway || null;
      const dr = item.drone || null;
      if (gw?.sn === sn) {
        return { device: gw, peer: dr, dockSn: gw.sn, projectUuid: item.projectUuid || '', deviceClass: classOf(gw) };
      }
      if (dr?.sn === sn) {
        return { device: dr, peer: gw, dockSn: gw?.sn || '', projectUuid: item.projectUuid || '', deviceClass: classOf(dr) };
      }
    }
  } catch {
    /* 交由调用方兜底 */
  }
  return { device: null, peer: null, dockSn: '', projectUuid: '', deviceClass: '' };
}

/**
 * 解析开播用的 camera_index（类型级范式，不含任何设备分支）
 *
 * 顺序：指定值 → 设备自身 camera_list（按镜头能力排序） → 同组对端设备 → 类型兜底索引
 */
export async function resolveCameraIndex(sn, provided) {
  if (provided) return { index: provided, source: 'provided', candidates: [], deviceClass: '' };

  const found = await locate(sn);
  const deviceClass = found.deviceClass || (found.device ? CLASS.AIRPORT : '');
  const profile = profileOf(deviceClass);
  const reportedPositions = (found.device?.camera_list || [])
    .map((c) => c?.camera_position)
    .filter(Boolean);

  const selfCandidates = cameraCandidates(found.device?.camera_list);
  if (selfCandidates.length) {
    return {
      index: selfCandidates[0],
      candidates: selfCandidates,
      reportedPositions,
      source: deviceClass === CLASS.DRONE ? 'drone' : 'airport',
      deviceClass,
    };
  }

  // 自身没上报（飞行器未开机时 camera_list 为 null）→ 借同组对端设备
  const peerCandidates = cameraCandidates(found.peer?.camera_list);
  if (peerCandidates.length) {
    return {
      index: peerCandidates[0],
      candidates: peerCandidates,
      source: deviceClass === CLASS.DRONE ? 'airport-fallback' : 'drone-fallback',
      deviceClass,
    };
  }

  return {
    index: profile.fallbackIndex,
    candidates: [],
    source: 'fallback',
    deviceClass,
  };
}

/**
 * 机场机位候选顺序（类型级范式）
 * 注意：设备上报的 camera_position 只作为「参考」，不作为唯一依据——
 * 实测有机场只报 indoor 但 outdoor 才有画面，只信上报会导致这类机场永远黑屏。
 */
export function positionOrder(deviceClass, reported = []) {
  const profile = profileOf(deviceClass);
  const order = [...profile.positionOrder];
  // 上报里出现、但范式没列的机位，补在后面（不丢信息）
  for (const p of reported) if (p && !order.includes(p)) order.push(p);
  return order;
}

/** 解析控制权限用的 payload_index：必须是飞行器自己的相机索引 */
export async function resolvePayloadIndex(droneSn, provided) {
  const providedList = Array.isArray(provided) ? provided : provided ? [provided] : [];
  const found = await locate(droneSn);
  const base = { droneSn, dockSn: found.dockSn, projectUuid: found.projectUuid };

  if (providedList.length) return { ...base, payloadIndex: providedList, source: 'provided' };

  const drone = found.deviceClass === CLASS.DRONE ? found.device : found.peer;
  const candidates = cameraCandidates(drone?.camera_list);
  if (candidates.length) return { ...base, payloadIndex: [candidates[0]], source: 'drone' };

  // 飞行器未开机时没有 camera_list，只能用类型兜底（不能用机场索引，否则 327002）
  return {
    ...base,
    payloadIndex: [profileOf(CLASS.DRONE).fallbackIndex],
    source: 'fallback',
  };
}

export function sourceText(source) {
  return (
    {
      provided: '使用指定 camera_index',
      airport: '使用机场相机索引（按镜头能力排序）',
      drone: '使用飞行器云台相机索引（按镜头能力排序）',
      'airport-fallback': '飞行器未开机（无 camera_list），回退使用机场相机',
      'drone-fallback': '机场未上报相机，回退使用飞行器相机',
      fallback: '设备未上报相机，使用该类型的默认相机索引',
    }[source] || source
  );
}
