/**
 * module-drone：无人机业务模块
 * 参考项目架构对应：无人机管理、任务调度、航线、直播、控制权、一键起飞、遥测
 */
export * as telemetry from './services/telemetry.js';
export * as controlService from './services/controlService.js';
export * as liveService from './services/liveService.js';
export * as taskService from './services/taskService.js';
export * as scheduler from './services/scheduler.js';
export * as statsService from './services/statsService.js';
export * as takeoffService from './services/takeoffService.js';
