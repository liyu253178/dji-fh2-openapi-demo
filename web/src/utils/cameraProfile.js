/**
 * 相机范式（前端）—— 按「设备类型」定义拉流与机位策略
 *
 * 与后端 services/cameraProfile.js 同源同义，前端只保留拉流侧需要的部分。
 *
 * 铁律：不为某一台设备（SN）写分支，也不按 SN 记忆偏好。
 *      同一个 device_model.key 的设备必须走完全相同的代码路径；
 *      差异由「范式顺序 + 运行时实测回退」消化，换同型号新设备零改动。
 *
 * 实测沉淀：
 *   - 机场（Dock 3）camera_list 只上报 1 路且只报 indoor，
 *     但舱外机位物理上存在；且存在「上报 indoor、实际 outdoor 才有画面」的机场
 *     （职校：indoor 亮度 0 纯黑 / outdoor 亮度 152 正常）。
 *     ⇒ 机位不能只信上报，必须按范式顺序枚举 + 用「画面是否有内容」实测回退。
 *   - 「有流」≠「有画面」：videoWidth>0、currentTime 推进时仍可能纯黑，
 *     成功判据必须包含画面内容检测（见 LivePlayer 黑屏检测）。
 */

/** 设备大类（与后端 device_model.class 对齐） */
export const CLASS = {
  AIRPORT: 'airport',
  DRONE: 'drone',
};

/**
 * 类型级相机范式
 * positionOrder：机位尝试顺序（先舱外，回退舱内）
 * blackFallback：允许在画面全黑时自动切下一机位
 */
const PROFILE = {
  [CLASS.AIRPORT]: {
    positionOrder: ['outdoor', 'indoor'],
    blackFallback: true,
    /** 每个机位给多少秒出画面（切换物理机位 + 推流建立需要时间） */
    settleMs: 20000,
  },
  [CLASS.DRONE]: {
    positionOrder: [],
    blackFallback: false,
    settleMs: 20000,
  },
};

const DEFAULT_PROFILE = { positionOrder: [], blackFallback: false, settleMs: 20000 };

export function profileOf(deviceClass) {
  return PROFILE[deviceClass] || DEFAULT_PROFILE;
}

/** 机位文案 */
export const POSITION_TEXT = { outdoor: '舱外', indoor: '舱内' };

export function positionText(pos) {
  return POSITION_TEXT[pos] || pos || '未知机位';
}

/**
 * 机位尝试顺序：范式顺序优先，设备上报里多出来的机位补在后面（不丢信息）
 * 注意上报只作参考，不作为唯一依据。
 */
export function positionOrder(deviceClass, reported = []) {
  const order = [...profileOf(deviceClass).positionOrder];
  for (const p of reported || []) if (p && !order.includes(p)) order.push(p);
  return order;
}

/** 该类型是否支持黑屏自动换机位 */
export function supportsBlackFallback(deviceClass) {
  return profileOf(deviceClass).blackFallback;
}

/**
 * 在候选机位里取「下一个」（用于黑屏回退）
 * @returns {string|''} 没有下一个了返回空串
 */
export function nextPosition(order, current) {
  const i = (order || []).indexOf(current);
  if (i < 0) return order?.[0] || '';
  return order[i + 1] || '';
}

/** 画面内容判定阈值（与 LivePlayer 内黑屏检测保持一致，供测试与提示复用） */
export const BLACK = {
  MEAN_MAX: 8,
  STD_MAX: 4,
  TICKS: 3,
};
