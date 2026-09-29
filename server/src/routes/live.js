/**
 * 直播路由（薄）：委托给 liveService（供应商自适应 + camera_index 自动解析）
 */
import { Router } from 'express';
import { startLive } from '../modules/drone/services/liveService.js';
import { startDroneLive } from '../modules/drone/services/droneLiveService.js';

const router = Router();

/** 开启直播：camera_index 可留空，后端自动解析（机场 → 飞行器 → 兜底） */
router.post('/start', async (req, res) => {
  const { sn, camera_index, video_expire, quality_type, project_uuid } = req.body || {};
  res.json(await startLive({ sn, camera_index, video_expire, quality_type, projectUuid: project_uuid }));
});

/**
 * 无人机直播（自动开机链路）
 * 获取控制权 → 飞行器已开机则直接开播；未开机则创建立即任务让机场开舱上电 → 前端轮询直到出画面
 * 轮询时把 taskUuid 带回，避免重复创建任务
 */
router.post('/drone', async (req, res) => {
  const {
    dock_sn,
    drone_sn,
    wayline_uuid,
    task_uuid,
    auto_takeoff,
    video_expire,
    quality_type,
    camera_index,
  } = req.body || {};
  res.json(
    await startDroneLive({
      dockSn: dock_sn,
      droneSn: drone_sn,
      waylineUuid: wayline_uuid,
      taskUuid: task_uuid,
      autoTakeoff: auto_takeoff !== false,
      video_expire,
      quality_type,
      cameraIndex: camera_index,
    })
  );
});

export default router;
