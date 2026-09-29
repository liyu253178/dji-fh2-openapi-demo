import { createRouter, createWebHistory } from 'vue-router';

/**
 * 信息架构：仅保留司空 2 OpenAPI 真实可支撑的模块
 * 指挥大屏 / 监控管理 / 无人机控制大屏 / 航线规划 / 巡检任务 / 飞行记录 / 设备管理 / 系统管理
 *
 * 已移除的占位模块（依赖外部服务，OpenAPI 无法提供真实数据）：
 *  - 事件管理：需外部 AI 推理服务回推事件
 *  - 素材与 GIS 建模：需媒资/建模服务
 *  - 算法管理：需外部算法推理服务
 */
const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '首页大屏', subtitle: '巡检指挥中心', icon: 'Monitor', full: true } },
  { path: '/cockpit', name: 'cockpit', component: () => import('../views/CockpitView.vue'), meta: { title: '虚拟座舱', subtitle: '实时飞行控制', icon: 'Coordinate', full: true } },
  { path: '/wayline', name: 'wayline', component: () => import('../views/WaylineView.vue'), meta: { title: '航线管理', subtitle: '航线库与规划', icon: 'MapLocation' } },
  // 「设备管理」原占用 /assets，一期「巡检成果」需要 /assets，故迁至 /devices
  { path: '/devices', name: 'devices', component: () => import('../views/DeviceView.vue'), meta: { title: '设备管理', subtitle: '机场与飞行器', icon: 'Box' } },
  { path: '/models', name: 'models', component: () => import('../views/ModelLibraryView.vue'), meta: { title: '模型库', subtitle: '项目模型预览', icon: 'Collection' } },
  { path: '/admin', name: 'admin', component: () => import('../views/AdminView.vue'), meta: { title: '其他设置', subtitle: '组织 · 接入点 · 日志', icon: 'Setting' } },
];

export const menuItems = routes
  .filter((r) => r.meta?.title)
  .map((r) => ({ path: r.path, title: r.meta.title, icon: r.meta.icon }));

export default createRouter({ history: createWebHistory(), routes });
