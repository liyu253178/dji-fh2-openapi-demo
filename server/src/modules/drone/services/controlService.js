/**
 * 控制权领域服务
 *
 * 关键实测结论：
 *  - 飞行器离线（未开机）时，设备列表 drone.camera_list 为 null（文档：飞行器开机后才能获得 camera_list）
 *  - payload_index 传空数组 / 不传 → 200610 "parameter invalid or blank"
 *  - payload_index 必须用**飞行器自己**的 camera_index（99-0-0 / 176-0-0 均可，实测都返回 code=0）；
 *    传机场的 165-0-7 → 327002 Bad Request；
 *    把机场 SN 当 drone_sn → 228432。
 *    ⚠️ 旧实现曾在 camera_list 为空时回退成机场索引，结果是必然失败的 327002，
 *       反而让「获取控制权」这一步长期显示红色错误。现改为回退飞行器默认相机索引。
 */
import { request, deleteWithBody } from '../../../djiClient.js';
import { log } from '../../../logger.js';
// 负载索引解析收敛到 cameraProfile：按设备类型定义，不再写死某一台设备的相机索引
import { resolvePayloadIndex, sourceText } from './cameraProfile.js';

export { resolvePayloadIndex };

/** 控制权相关错误码释义 */
const CONTROL_ERRORS = {
  327002: '参数不合法：payload_index 必须是飞行器自己的 camera_index（不能用机场相机索引）',
  228432: 'drone_sn 不是飞行器序列号（不能传机场 SN）',
  200610: 'payload_index 为空：飞行器未开机时需要用默认相机索引兜底',
};

/** 获取控制权 */
export async function takeControl(droneSn, payloadIndex) {
  if (!droneSn) return { ok: false, message: '缺少 drone_sn（必须是飞行器 SN，不是机场 SN）' };
  const r = await resolvePayloadIndex(droneSn, payloadIndex);
  const res = await request({
    method: 'POST',
    path: '/device/control',
    body: { drone_sn: droneSn, payload_index: r.payloadIndex },
    projectUuid: r.projectUuid || undefined,
    tag: '设备管理',
  });
  return {
    ...res,
    hint: CONTROL_ERRORS[Number(res.code)] || '',
    controlInfo: {
      droneSn,
      dockSn: r.dockSn,
      projectUuid: r.projectUuid,
      payloadIndex: r.payloadIndex,
      source: r.source,
      sourceText: sourceText(r.source),
    },
  };
}

/** 释放控制权（DELETE + Body，payload_index 需与获取时一致） */
export async function releaseControl(droneSn, payloadIndex) {
  if (!droneSn) return { ok: false, message: '缺少 drone_sn（必须是飞行器 SN）' };
  const r = await resolvePayloadIndex(droneSn, payloadIndex);
  const res = await deleteWithBody(
    '/device/control',
    { drone_sn: droneSn, payload_index: r.payloadIndex },
    { projectUuid: r.projectUuid || undefined, tag: '设备管理' }
  );
  return {
    ...res,
    hint: CONTROL_ERRORS[Number(res.code)] || '',
    controlInfo: {
      droneSn,
      dockSn: r.dockSn,
      projectUuid: r.projectUuid,
      payloadIndex: r.payloadIndex,
      source: r.source,
      sourceText: sourceText(r.source),
    },
  };
}
