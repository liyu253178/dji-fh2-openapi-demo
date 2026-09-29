/**
 * 监管指标服务（一网统飞总览看板 / 大屏）
 */
import { snapshot } from './telemetry.js';
import * as taskService from './taskService.js';
import { request } from '../../../djiClient.js';
import { remember } from '../../../cache.js';

const WAYLINE_TTL = 60000;

export const waylineCount = () =>
  remember('wayline:count', WAYLINE_TTL, async () => {
    const r = await request({ method: 'GET', path: '/wayline', tag: '航线管理' });
    return r.ok ? (r.data?.list || []).length : 0;
  });

/** 近 N 日任务趋势 */
function trend(tasks, days = 7) {
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = d.getTime() + 86400000;
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const cnt = (tasks || []).filter((t) => {
      const ts = t.begin_time ? t.begin_time * 1000 : Date.now();
      return ts >= d.getTime() && ts < next;
    }).length;
    buckets.push({ label, count: cnt });
  }
  return buckets;
}

/** 综合总览 */
export async function overview(force = false) {
  const [snap, tasks] = await Promise.all([snapshot(force), taskService.list({}, force)]);
  const stats = await taskService.statistics(tasks);
  const wl = await waylineCount();

  const onlineAirports = snap.airports.filter((a) => a.online).length;
  const onlineDrones = snap.drones.filter((d) => d.online).length;

  return {
    ok: true,
    data: {
      ts: Date.now(),
      devices: {
        airports: snap.airports.length,
        drones: snap.drones.length,
        onlineAirports,
        onlineDrones,
        onlineRate:
          snap.devices.length
            ? Math.round((snap.devices.filter((d) => d.online).length / snap.devices.length) * 100)
            : 0,
        positioned: snap.withPosition.length,
      },
      flight: {
        total: stats.total,
        successRate: stats.successRate,
        sorties: stats.sorties,
        distanceKm: stats.distanceKm,
        durationMin: stats.durationMin,
        byStatus: stats.byStatus,
      },
      resources: {
        waylines: wl,
        alerts: snap.alerts.length,
      },
      trend: trend(tasks, 7),
      alerts: snap.alerts.slice(0, 20),
      airports: snap.airports.map((a) => ({
        sn: a.sn,
        callsign: a.callsign,
        model: a.model,
        online: a.online,
        modeText: a.modeText,
        battery: a.battery,
        position: a.position,
        droneSn: a.droneSn,
        projectName: a.projectName,
      })),
      drones: snap.drones.map((d) => ({
        sn: d.sn,
        callsign: d.callsign,
        model: d.model,
        online: d.online,
        modeText: d.modeText,
        battery: d.battery,
        position: d.position,
        dockSn: d.dockSn,
        projectName: d.projectName,
      })),
    },
  };
}
