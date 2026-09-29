/**
 * 计划库（任务）领域服务：列表 / 详情 / 状态机 / 统计
 */
import { request } from '../../../djiClient.js';
import { remember } from '../../../cache.js';
import { buildFlightTaskBody } from './flightTaskBody.js';
import { log } from '../../../logger.js';

const LIST_TTL = 15000;

export const TASK_STATUS = {
  waiting: '待开始',
  starting_failure: '启动失败',
  executing: '执行中',
  paused: '暂停',
  terminated: '终止',
  success: '成功',
  suspended: '挂起',
  timeout: '超时',
  partially_done: '部分完成',
};
export const TASK_TYPE = {
  immediate: '立即任务',
  timed: '单次定时',
  recurring: '重复任务',
  continuous: '连续任务',
};

export const list = (params = {}, force = false) =>
  remember(`task:list:${JSON.stringify(params)}`, LIST_TTL, async () => {
    const r = await request({ method: 'GET', path: '/flight-task/list', query: params, tag: '任务管理' });
    return r.ok ? r.data?.list || [] : [];
  }, force);

export const detail = (uuid) =>
  request({ method: 'GET', path: `/flight-task/${encodeURIComponent(uuid)}`, tag: '任务管理' });

export const media = (uuid) =>
  request({ method: 'GET', path: `/flight-task/${encodeURIComponent(uuid)}/media`, tag: '任务管理' });

export const track = (uuid) =>
  request({ method: 'GET', path: `/flight-task/${encodeURIComponent(uuid)}/track`, tag: '任务管理' });

export const updateStatus = (uuid, status) =>
  request({
    method: 'PUT',
    path: `/flight-task/${encodeURIComponent(uuid)}/status`,
    body: { status },
    tag: '任务管理',
  });

/**
 * 创建飞行任务
 * 统一走 buildFlightTaskBody 补齐必填字段（resumable_status / time_zone）并净化任务名，
 * 避免前端漏传导致 200610 invalid param format。
 */
export async function create(body) {
  const payload = buildFlightTaskBody(body || {});
  const r = await request({ method: 'POST', path: '/flight-task', body: payload, tag: '任务管理' });
  if (!r.ok) {
    log.error('任务管理', `创建飞行任务失败 code=${r.code} ${r.message}`, payload);
  }
  return r;
}

/**
 * 统计：架次 / 成功 / 失败 / 时长 / 里程（轨迹接口提供 distance/duration）
 */
export async function statistics(tasks) {
  const list = tasks || (await list());
  const byStatus = {};
  for (const t of list) byStatus[t.status] = (byStatus[t.status] || 0) + 1;

  const finished = list.filter((t) => ['success', 'partially_done'].includes(t.status));
  let distance = 0;
  let duration = 0;
  let withTrack = 0;
  // 轨迹逐个拉取（有缓存保护，避免重复打司空 2）
  for (const t of finished.slice(0, 20)) {
    const r = await remember(`task:track:${t.uuid}`, 300000, () => track(t.uuid));
    const tr = r?.ok ? r.data?.track : null;
    if (tr) {
      distance += Number(tr.flight_distance || 0);
      duration += Number(tr.flight_duration || 0);
      withTrack++;
    }
  }
  const total = list.length;
  const success = byStatus.success || 0;
  return {
    total,
    byStatus,
    successRate: total ? Math.round((success / total) * 100) : 0,
    sorties: finished.length,
    distanceKm: Number((distance / 1000).toFixed(2)),
    durationMin: Math.round(duration / 60),
    tracked: withTrack,
  };
}
