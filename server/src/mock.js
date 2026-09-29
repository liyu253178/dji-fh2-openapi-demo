/**
 * 演示数据模式（Mock）
 * 当 OpenAPI TK 尚未打通时，用于验证全部界面与交互流程。
 * 开启后所有走 djiClient 的请求优先命中此表；未命中则返回通用成功。
 * 生产使用请在「司空管理 → 演示模式」关闭。
 */
export const mockState = { enabled: process.env.FH2_MOCK === '1' };

const AIRPORTS = [
  {
    sn: '7CTDM3D00BZNVZ1',
    callsign: '天河机场-Dock2',
    model: 'DJI Dock 2',
    lat: 23.1245,
    lng: 113.3211,
    online: true,
    modeCode: 0,
    camera: '165-0-7',
    height: 42,
  },
  {
    sn: '7CTDM3D00BZNVZ2',
    callsign: '黄埔机场-Dock3',
    model: 'DJI Dock 3',
    lat: 23.1812,
    lng: 113.4725,
    online: false,
    modeCode: 4,
    camera: '165-0-7',
    height: 36,
  },
];

const DRONES = [
  {
    sn: '1581F6Q8D242100CPWE1',
    callsign: 'M3TD-01',
    model: 'M3TD',
    lat: 23.1268,
    lng: 113.3245,
    online: true,
    modeCode: 5,
    camera: '81-0-0',
    height: 118,
    battery: 76,
    dock: '7CTDM3D00BZNVZ1',
  },
  {
    sn: '1581F6Q8D242100CPWE2',
    callsign: 'M4TD-02',
    model: 'M4TD',
    lat: 23.1812,
    lng: 113.4725,
    online: false,
    modeCode: 0,
    camera: '81-0-0',
    height: 0,
    battery: 100,
    dock: '7CTDM3D00BZNVZ2',
  },
];

const ok = (data, message = '') => ({ ok: true, code: 0, message, data, status: 200, duration: 8, mock: true });

function deviceList() {
  return ok({
    list: AIRPORTS.map((a, i) => ({
      gateway: {
        sn: a.sn,
        callsign: a.callsign,
        device_model: { key: '3-2-0', domain: '3', type: '2', sub_type: '0', name: a.model, class: 'airport' },
        device_online_status: a.online,
        mode_code: a.modeCode,
        camera_list: [{ camera_index: a.camera, available_camera_positions: ['indoor', 'outdoor'], camera_position: 'outdoor' }],
      },
      drone: {
        sn: DRONES[i].sn,
        callsign: DRONES[i].callsign,
        device_model: { key: '0-91-1', domain: '0', type: '91', sub_type: '1', name: DRONES[i].model, class: 'drone' },
        device_online_status: DRONES[i].online,
        mode_code: DRONES[i].modeCode,
        camera_list: [
          {
            camera_index: DRONES[i].camera,
            lens_list: [{ available_lens_types: ['normal', 'wide', 'zoom', 'ir'], lens_type: 'wide' }],
          },
        ],
      },
    })),
  });
}

function stateOf(sn) {
  const a = AIRPORTS.find((x) => x.sn === sn);
  if (a) {
    return ok({
      device_sn: a.sn,
      device_model: { key: '3-2-0', domain: '3', type: '2', sub_type: '0', name: a.model, class: 'airport' },
      device_state: {
        latitude: a.lat,
        longitude: a.lng,
        height: a.height,
        mode_code: a.modeCode,
        drone_in_dock: true,
        drone_charge_state: { capacity_percent: 82 },
        position_state: 'fixed',
        live_capacity: 4,
      },
    });
  }
  const d = DRONES.find((x) => x.sn === sn);
  if (d) {
    return ok({
      device_sn: d.sn,
      device_model: { key: '0-91-1', domain: '0', type: '91', sub_type: '1', name: d.model, class: 'drone' },
      device_state: {
        latitude: d.lat,
        longitude: d.lng,
        home_latitude: d.lat,
        home_longitude: d.lng,
        height: d.height,
        elevation: d.height + 20,
        mode_code: d.modeCode,
        battery: { capacity_percent: d.battery },
        attitude_heading: 45,
      },
    });
  }
  return ok(null, '演示模式：未找到该设备');
}

const WAYLINES = [
  { id: 'wl-001', name: '天河园区正射采集', template_types: ['mapping_2d'], update_time: Math.floor(Date.now() / 1000) - 86400 },
  { id: 'wl-002', name: '黄埔带状巡检', template_types: ['mapping_strip'], update_time: Math.floor(Date.now() / 1000) - 172800 },
  { id: 'wl-003', name: '倾斜摄影-示范区', template_types: ['mapping_3d'], update_time: Math.floor(Date.now() / 1000) - 259200 },
];

const TASKS = [
  { uuid: 'tk-001', name: '天河园区正射采集', status: 'success', task_type: 'immediate', sn: AIRPORTS[0].sn, begin_time: Math.floor(Date.now() / 1000) - 3600 },
  { uuid: 'tk-002', name: '黄埔带状巡检', status: 'executing', task_type: 'immediate', sn: AIRPORTS[1].sn, begin_time: Math.floor(Date.now() / 1000) - 600 },
  { uuid: 'tk-003', name: '夜间红外巡查', status: 'waiting', task_type: 'timed', sn: AIRPORTS[0].sn, begin_time: Math.floor(Date.now() / 1000) - 200 },
  { uuid: 'tk-004', name: '河道巡检-失败重试', status: 'starting_failure', task_type: 'immediate', sn: AIRPORTS[0].sn, begin_time: Math.floor(Date.now() / 1000) - 7200 },
  { uuid: 'tk-005', name: '园区周界巡航', status: 'paused', task_type: 'immediate', sn: AIRPORTS[1].sn, begin_time: Math.floor(Date.now() / 1000) - 10800 },
];

/**
 * 返回演示响应；未命中返回 null（走真实请求）
 */
export function mockResponse(method, path, query, body, enabled = mockState.enabled) {
  if (!enabled) return null;
  const p = path.replace(/\/+$/, '');

  // 项目列表
  if (method === 'GET' && p === '/openapi/v0.1/project') {
    return ok({
      list: [
        { name: '广州智慧城市巡检', uuid: 'demo-prj-001', org_uuid: 'demo-org', created_at: Math.floor(Date.now() / 1000) - 864000, introduction: '演示项目', project_work_center_point: { latitude: 23.1245, longitude: 113.3211 } },
        { name: '黄埔区河道巡检', uuid: 'demo-prj-002', org_uuid: 'demo-org', created_at: Math.floor(Date.now() / 1000) - 432000, introduction: '演示项目', project_work_center_point: { latitude: 23.1812, longitude: 113.4725 } },
      ],
    });
  }
  if (method === 'GET' && (p === '/openapi/v0.1/device' || p === '/openapi/v0.1/project/device')) return deviceList();
  if (method === 'GET' && /^\/openapi\/v0\.1\/device\/[^/]+\/state$/.test(p)) return stateOf(decodeURIComponent(p.split('/')[4]));
  if (method === 'GET' && p === '/openapi/v0.1/system_status') return ok({});
  if (method === 'GET' && p === '/openapi/v0.1/device/hms') {
    return ok({ list: [{ device_hms: { list: [{ level: 'reminder', module: 'flight_mission', in_the_key: 'on_the_ground', message: '电量低于 30% 时请返航' }] } }] });
  }
  if (method === 'GET' && p === '/openapi/v0.1/wayline') return ok({ list: WAYLINES });
  if (method === 'GET' && /^\/openapi\/v0\.1\/wayline\/[^/]+$/.test(p)) {
    return ok({ id: p.split('/')[4], name: '演示航线', download_url: 'https://example.com/demo.kmz', update_time: Math.floor(Date.now() / 1000), template_types: ['mapping_2d'] });
  }
  if (method === 'POST' && p === '/openapi/v0.1/wayline/finish-upload') return ok({ name: body?.name || 'demo', uuid: 'wl-new' });
  if (method === 'GET' && p === '/openapi/v0.1/project/sts-token') return ok(null, '演示模式不提供真实存储凭证');
  if (method === 'GET' && p === '/openapi/v0.1/flight-task/list') return ok({ list: TASKS });
  if (method === 'GET' && /^\/openapi\/v0\.1\/flight-task\/[^/]+$/.test(p)) {
    const t = TASKS.find((x) => x.uuid === p.split('/')[4]) || TASKS[0];
    return ok({ ...t, wayline_uuid: 'wl-001', media_count: 12 });
  }
  if (method === 'GET' && /^\/openapi\/v0\.1\/flight-task\/[^/]+\/media$/.test(p)) {
    return ok({
      list: [
        { uuid: 'm1', name: 'DJI_001.jpg', file_type: 'image', suffix: 'jpg', size: 204800, preview_url: '', original_url: '', create_at: '2026-09-23', update_at: '2026-09-23' },
        { uuid: 'm2', name: 'DJI_002.mp4', file_type: 'video', suffix: 'mp4', size: 10485760, preview_url: '', original_url: '', create_at: '2026-09-23', update_at: '2026-09-23' },
      ],
    });
  }
  if (method === 'GET' && /^\/openapi\/v0\.1\/flight-task\/[^/]+\/track$/.test(p)) {
    const base = [23.1245, 113.3211];
    const points = Array.from({ length: 24 }, (_, i) => ({
      timestamp: Math.floor(Date.now() / 1000) + i * 10,
      latitude: base[0] + i * 0.0004,
      longitude: base[1] + i * 0.0006,
      height: 100 + i,
    }));
    return ok({ status: 'success', wayline_uuid: 'wl-001', track: { track_id: 'tr-1', drone_sn: DRONES[0].sn, flight_distance: 3200, flight_duration: 480, points } });
  }
  if (method === 'POST' && p === '/openapi/v0.1/flight-task') {
    return ok({ task_uuid: 'tk-new-' + Date.now() });
  }
  if (method === 'POST' && p === '/openapi/v0.1/live-stream/start') {
    return ok({
      expire_ts: Math.floor(Date.now() / 1000) + 7200,
      url: '',
      url_type: 'demo',
      message: '演示模式：无真实拉流地址',
    });
  }
  if (p === '/openapi/v0.1/device/control') return ok({ drone_sn: body?.drone_sn, controls: [{ type: 'payload', gateway: { sn: AIRPORTS[0].sn }, user: { call_sign: 'demo', user_id: '0', type: 'Cloud' }, payload_index: body?.payload_index?.[0] }] });
  if (method === 'POST' && /\/command$/.test(p)) return ok(null);
  if (method === 'POST' && p === '/openapi/v0.1/device/change-camera') return ok(null);
  if (method === 'POST' && p === '/openapi/v0.1/device/change-lens') return ok(null);
  if (method === 'PUT' && p === '/openapi/v0.1/device/stream/quality') return ok(null);
  if (method === 'PUT' && /\/status$/.test(p)) return ok(null);

  return ok(null, '演示模式：该接口的演示数据未定义');
}

export function setMock(enabled) {
  mockState.enabled = !!enabled;
  return mockState.enabled;
}
