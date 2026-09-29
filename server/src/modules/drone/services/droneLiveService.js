/**
 * 无人机直播自动开机链路
 *
 * 实测结论（决定了这套流程为什么必须这样写）：
 *  1. 飞行器必须开机才有 camera_list（官方文档原话），关机时开播 → 213003 no streaming gateway found。
 *  2. 「获取控制权」本身不会让飞行器上电：无论 payload_index 传机场相机 165-0-7
 *     还是飞行器相机 176-0-0，实测轮询 180s 飞行器仍 offline / camera_list=null。
 *  3. 公有云没有远程开机接口（debug-mode-open 返回 404）。
 *  → 唯一能让机场给飞行器上电的动作是「创建立即飞行任务」（机场自动开舱→上电→起飞）。
 *
 * 因此「点无人机直播 → 自动开机 → 出画面」的完整链路是：
 *   获取控制权 → 飞行器已开机? → 是：直接开播
 *                              → 否：创建立即任务（需航线）→ 轮询等待上电 → 自动开播
 */
import { deviceTree, flatten } from './telemetry.js';
import { takeControl } from './controlService.js';
import { startLive, pickBestCamera, cameraCandidates } from './liveService.js';
import { buildFlightTaskBody } from './flightTaskBody.js';
import { request } from '../../../djiClient.js';
import { log } from '../../../logger.js';

/** 关机时用于获取控制权的兜底飞行器相机索引（Matrice 4TD 默认相机） */
const DEFAULT_DRONE_PAYLOAD = '176-0-0';

/**
 * @param {object} o
 * @param {string} o.dockSn 机场 SN
 * @param {string} o.droneSn 飞行器 SN
 * @param {string} [o.waylineUuid] 用于开机（创建立即任务）的航线
 * @param {string} [o.taskUuid] 已创建的任务 UUID（轮询时传入，避免重复创建）
 * @param {boolean} [o.autoTakeoff] 飞行器关机时是否自动创立即时任务上电
 * @param {string} [o.cameraIndex] 指定相机索引；不传则按 lens_list 能力自动挑最优
 * @returns {Promise<{ok:boolean, phase:string, steps:object[], message:string, live?:object, taskUuid?:string}>}
 */
export async function startDroneLive({
  dockSn,
  droneSn,
  waylineUuid = '',
  taskUuid = '',
  autoTakeoff = true,
  video_expire = 7200,
  quality_type = 'adaptive',
  cameraIndex: wantCamera = '',
}) {
  const steps = [];
  // 强制刷新设备树：camera_list 是上电后才出现的，必须拿最新一次
  const { list } = await deviceTree(true);
  const { airports, drones } = flatten(list);
  const dock = airports.find((a) => a.sn === dockSn) || null;
  const drone = drones.find((d) => d.sn === droneSn) || null;

  if (!drone) {
    return { ok: false, phase: 'failed', steps, message: '未找到该飞行器，请确认机场与飞行器的绑定关系' };
  }

  // ---- step 1 获取控制权（上电后切镜头/控负载的前提，也是后续开播的必要铺垫）----
  // payload_index 只能用「飞行器自己」的相机索引；机场的 165-0-7 会让接口返回 327002 Bad Request
  const payloadIndex =
    pickBestCamera(drone.cameraList)?.camera_index ||
    drone.cameraList?.[0]?.camera_index ||
    DEFAULT_DRONE_PAYLOAD;
  const cr = await takeControl(drone.sn, [payloadIndex]);
  steps.push({
    key: 'control',
    title: '获取控制权',
    status: cr.ok ? 'success' : 'fail',
    message: cr.ok ? `已获取控制权（payload ${payloadIndex}）` : cr.hint || cr.message,
  });
  // 控制权失败不阻断：有些场景下控制权已被占用，但仍可拉流

  // ---- step 2 飞行器是否已上电 ----
  const powered = drone.cameraList?.length > 0;
  const candidates = cameraCandidates(drone.cameraList);
  steps.push({
    key: 'power',
    title: '飞行器上电状态',
    status: powered ? 'success' : 'wait',
    message: powered
      ? `已开机，候选相机 ${candidates.join(' / ')}`
      : '未开机（司空 2 无远程开机接口，需通过飞行任务让机场自动上电）',
  });

  if (powered) {
    // 指定优先，否则按 lens_list 能力挑主云台相机：直接取 [0] 可能拿到推不出流的那一路
    const best = pickBestCamera(drone.cameraList);
    let cameraIndex = wantCamera && candidates.includes(wantCamera) ? wantCamera : best?.camera_index;
    if (!cameraIndex) cameraIndex = drone.cameraList[0].camera_index;
    const lr = await startLive({
      sn: drone.sn,
      camera_index: cameraIndex,
      video_expire,
      quality_type,
      projectUuid: drone.projectUuid || dock?.projectUuid || undefined,
    });
    if (!lr.ok && candidates.length > 1 && !wantCamera) {
      // 首选那一路开播被拒时，继续尝试其余候选，避免因单路异常导致整个直播不可用
      for (const alt of candidates.filter((c) => c !== cameraIndex)) {
        const alt2 = await startLive({
          sn: drone.sn,
          camera_index: alt,
          video_expire,
          quality_type,
          projectUuid: drone.projectUuid || dock?.projectUuid || undefined,
        });
        steps.push({
          key: `live:${alt}`,
          title: `备选相机 ${alt}`,
          status: alt2.ok ? 'success' : 'fail',
          message: alt2.ok ? `已开启（${alt}）` : alt2.hint || alt2.message,
        });
        if (alt2.ok) {
          steps.push({
            key: 'live',
            title: '开启无人机图传',
            status: 'success',
            message: `首选 ${cameraIndex} 开播失败，已切换备选 ${alt}`,
          });
          return {
            ok: true,
            phase: 'live',
            steps,
            message: `无人机图传已开启（备选相机 ${alt}）`,
            live: alt2.data,
            liveInfo: { ...alt2.liveInfo, candidates },
            taskUuid,
          };
        }
      }
      return {
        ok: false,
        phase: 'failed',
        steps,
        message: `所有候选相机均无法开播：${lr.hint || lr.message}`,
      };
    }
    steps.push({
      key: 'live',
      title: '开启无人机图传',
      status: lr.ok ? 'success' : 'fail',
      message: lr.ok ? `已开启（${cameraIndex}）` : lr.hint || lr.message,
    });
    if (!lr.ok) {
      return { ok: false, phase: 'failed', steps, message: `开启图传失败：${lr.hint || lr.message}` };
    }
    return {
      ok: true,
      phase: 'live',
      steps,
      message: '无人机图传已开启',
      live: lr.data,
      liveInfo: { ...lr.liveInfo, candidates },
      taskUuid,
    };
  }

  // ---- step 3 未上电：创建立即任务让机场自动开舱上电起飞 ----
  if (!autoTakeoff) {
    return { ok: false, phase: 'need_task', steps, message: '飞行器未开机，需要执行起飞任务上电' };
  }
  if (!waylineUuid) {
    return {
      ok: false,
      phase: 'need_wayline',
      steps,
      message: '飞行器未开机，请选择一条航线创建立即任务，机场会自动开舱上电起飞后再拉图传',
    };
  }

  // 已有任务（轮询场景）：先查状态，不再重复创建
  if (taskUuid) {
    const tr = await request({
      method: 'GET',
      path: `/flight-task/${encodeURIComponent(taskUuid)}`,
      tag: '无人机直播',
    });
    const status = tr.ok ? tr.data?.status : null;
    steps.push({
      key: 'task',
      title: '起飞任务状态',
      status: 'wait',
      message: `任务 ${taskUuid.slice(0, 8)}… 当前状态：${status || '查询中'}，等待机场开舱上电`,
    });
    return {
      ok: false,
      phase: 'waiting_power_on',
      steps,
      message: '已下发起飞任务，等待机场开舱上电后自动拉起图传',
      taskUuid,
    };
  }

  const body = buildFlightTaskBody({
    name: `图传开机 ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
    wayline_uuid: waylineUuid,
    sn: dockSn,
    rth_altitude: 100,
    rth_mode: 'optimal',
    wayline_precision_type: 'rtk',
    task_type: 'immediate',
  });
  const createR = await request({
    method: 'POST',
    path: '/flight-task',
    body,
    projectUuid: dock?.projectUuid || undefined,
    tag: '无人机直播',
  });
  if (!createR.ok) {
    steps.push({
      key: 'task',
      title: '创建起飞任务',
      status: 'fail',
      message: `${createR.message}（请求体已写入日志）`,
    });
    log.error('无人机直播', `创建起飞任务失败 code=${createR.code} ${createR.message}`, body);
    return { ok: false, phase: 'failed', steps, message: `创建起飞任务失败：${createR.message}` };
  }
  const newUuid = createR.data?.task_uuid;
  steps.push({
    key: 'task',
    title: '创建起飞任务',
    status: 'wait',
    message: `任务 ${String(newUuid).slice(0, 8)}… 已下发，机场将自动开舱 → 飞行器上电 → 起飞`,
  });
  return {
    ok: false,
    phase: 'waiting_power_on',
    steps,
    message: '已下发起飞任务，等待机场开舱上电后自动拉起图传',
    taskUuid: newUuid,
  };
}
