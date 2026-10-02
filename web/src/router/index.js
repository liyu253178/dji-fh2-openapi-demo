import { createRouter, createWebHistory } from 'vue-router';

/**
 * 信息架构：仅保留司空 2 OpenAPI 真实可支撑的模块
 * 指挥大屏 / 监控管理 / 无人机控制大屏 / 航线规划 / 巡检任务 / 飞行记录 / 设备管理 / 系统管理
 *
 * 已移除的占位模块（依赖外部服务，OpenAPI 无法提供真实数据）：
 *  - 事件管理：需外部 AI 推理服务回推事件
 *  - 素材与 GIS 建模：需媒资/建模服务
 *  - 算法管理：需外部算法推理服务
 *
 * 一期新增：巡检成果 / 影像审核 / 工单中心 / 台账统计 / 邮件配置 / 问题字典 / 派发对象 / 系统状态
 * 注意：路由为 createWebHistory（非 hash），配合 server 的 SPA 回退，
 *      深链接不能带#/，邮件模板已按 /tickets/:id 形式生成。
 */
const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '首页大屏', subtitle: '巡检指挥中心', icon: 'Monitor', full: true } },
  // 广东省域态势大屏：Cesium 真三维地球 + 21 地市立体块，指标全部走真实接口
  { path: '/screen', name: 'screen', component: () => import('../views/GuangdongScreenView.vue'), meta: { title: '省域态势', subtitle: '广东省 · 21 地市', icon: 'Aim', full: true } },
  { path: '/cockpit', name: 'cockpit', component: () => import('../views/CockpitView.vue'), meta: { title: '虚拟座舱', subtitle: '实时飞行控制', icon: 'Coordinate', full: true } },
  // 「航线管理」升级为一级栏目「航线规划」：司空 2 不开放航线规划，规划能力由平台自建
  { path: '/wayline/plan', name: 'wayline-plan', component: () => import('../views/wayline/PlanView.vue'), meta: { title: '规划工作台', subtitle: '绘制测区 · 生成航线', icon: 'EditPen' } },
  { path: '/wayline', name: 'wayline', component: () => import('../views/WaylineView.vue'), meta: { title: '航线库', subtitle: '机型匹配与上传', icon: 'MapLocation' } },
  { path: '/wayline/tasks', name: 'wayline-tasks', component: () => import('../views/wayline/TaskListView.vue'), meta: { title: '执行记录', subtitle: '下发历史与状态', icon: 'Timer' } },
  // 「设备管理」原占用 /assets，一期「巡检成果」需要 /assets，故迁至 /devices
  { path: '/devices', name: 'devices', component: () => import('../views/DeviceView.vue'), meta: { title: '设备管理', subtitle: '机场与飞行器', icon: 'Box' } },
  { path: '/models', name: 'models', component: () => import('../views/ModelLibraryView.vue'), meta: { title: '模型库', subtitle: '项目模型预览', icon: 'Collection' } },
  // Cesium 三维底座 POC（阶段 0）：独立路由、随时可删，用于打坐标/性能/量测/离线四个硬指标。
  // 路由级懒加载，Cesium chunk 不进任何业务页首屏。
  // 注：原 three.js 版「三维浏览与量测」（/models/geo，ModelGeoView）已按产品决策下线删除，
  //     需要找回时看 git 历史（提交「Cesium POC」之前的版本）。
  {
    path: '/models/geo-cesium',
    name: 'model-geo-cesium',
    component: () => import('../views/model/CesiumPocView.vue'),
    meta: { title: '三维底座 POC', subtitle: 'Cesium 独立验证', icon: 'DataLine' },
  },

  // ---------- 一期新增 ----------
  { path: '/assets', name: 'assets', component: () => import('../views/AssetLibraryView.vue'), meta: { title: '巡检成果', subtitle: '航拍影像与架次', icon: 'FolderOpened' } },
  // 「影像审核」队列页（ReviewQueueView）已删除：审核入口统一在巡检成果的「审核影像」，
  // 这里保留 /review 深链接（邮件、历史收藏、外部跳转）兼容重定向，避免 404。
  { path: '/review', redirect: '/assets' },
  { path: '/review/task/:taskUuid', name: 'review-task', component: () => import('../views/ReviewWorkbenchView.vue'), meta: { title: '审核工作台', hidden: true } },
  { path: '/tickets', name: 'tickets', component: () => import('../views/TicketListView.vue'), meta: { title: '工单管理', subtitle: '派发与跟踪', icon: 'Tickets' } },
  { path: '/tickets/:id', name: 'ticket-detail', component: () => import('../views/TicketDetailView.vue'), meta: { title: '工单详情', hidden: true } },
  { path: '/stats', name: 'stats', component: () => import('../views/StatsView.vue'), meta: { title: '台账统计', subtitle: '按行政区与类型', icon: 'DataAnalysis' } },
  { path: '/admin', name: 'admin', component: () => import('../views/AdminView.vue'), meta: { title: '其他设置', subtitle: '组织 · 接入点 · 日志', icon: 'Setting' } },
  { path: '/admin/mail', name: 'admin-mail', component: () => import('../views/admin/MailConfigView.vue'), meta: { title: '邮件配置', subtitle: 'SMTP 服务', icon: 'Message' } },
  { path: '/admin/dict', name: 'admin-dict', component: () => import('../views/admin/IssueTypeView.vue'), meta: { title: '问题字典', subtitle: '问题类型管理', icon: 'Notebook' } },
  { path: '/admin/recipients', name: 'admin-recipients', component: () => import('../views/admin/RecipientView.vue'), meta: { title: '派发对象', subtitle: '责任单位维护', icon: 'User' } },
  { path: '/admin/status', name: 'admin-status', component: () => import('../views/admin/SystemStatusView.vue'), meta: { title: '系统状态', subtitle: '同步与告警', icon: 'Monitor' } },
];

export const menuItems = routes
  .filter((r) => r.meta?.title && !r.meta?.hidden)
  .map((r) => ({ path: r.path, title: r.meta.title, icon: r.meta.icon }));

export default createRouter({ history: createWebHistory(), routes });
