/**
 * 探针：机场内飞行器（未起飞/离线）能否拉到图传直播
 * 步骤：
 *  1. 列出所有机场/飞行器（camera_list / online / mode_code）
 *  2. 直接尝试用飞行器 SN + 已知 camera_index 开播
 *  3. 若失败：先获取控制权（上电），再刷新设备树看 camera_list 是否出现，再开播
 * 注意：获取控制权只会让机场给飞行器上电，不会开舱、不会起飞。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tokens.json'), 'utf8'));
const active = raw.tokens.find((t) => t.id === raw.activeId) || raw.tokens[0];
const TOKEN = process.env.FH2_TOKEN || active.token;
const BASE = 'https://es-flight-api-cn.djigate.com';
const PREFIX = '/openapi/v0.1';

async function api(method, p, { body, projectUuid } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
    'X-Language': 'zh',
    'X-User-Token': TOKEN,
  };
  if (projectUuid) headers['X-Project-Uuid'] = projectUuid;
  const res = await fetch(new URL(BASE + PREFIX + p), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, text: text.slice(0, 200) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prj = await api('GET', '/project?page=1&page_size=100');
  const projects = prj.data?.list || [];

  console.log('=== 1. 设备当前状态 ===');
  const devices = [];
  for (const p of projects) {
    const d = await api('GET', '/project/device', { projectUuid: p.uuid });
    for (const item of d.data?.list || []) {
      const g = item.gateway;
      const dr = item.drone;
      if (!g?.sn) continue;
      const rec = {
        project: p.name,
        projectUuid: p.uuid,
        dockSn: g.sn,
        dockName: g.callsign || '',
        dockOnline: !!g.device_online_status,
        dockCameras: g.camera_list || [],
        droneSn: dr?.sn || '',
        droneName: dr?.callsign || '',
        droneOnline: !!dr?.device_online_status,
        droneCameras: dr?.camera_list || null,
        droneMode: dr?.mode_code,
        dockMode: g.mode_code,
      };
      devices.push(rec);
      console.log(
        `[${p.name}] 机场 ${g.sn}(${rec.dockName}) online=${rec.dockOnline} mode=${rec.dockMode} cams=${JSON.stringify(rec.dockCameras)}`
      );
      console.log(
        `          飞行器 ${rec.droneSn}(${rec.droneName}) online=${rec.droneOnline} mode=${rec.droneMode} cams=${JSON.stringify(rec.droneCameras)}`
      );
    }
  }

  const target = devices.find((d) => d.droneSn) || devices[0];
  if (!target) return console.log('没有设备');

  console.log(`\n=== 2. 直接尝试飞行器直播（sn=${target.droneSn}）===`);
  const idxGuess = target.droneCameras?.[0]?.camera_index || '176-0-0';
  let r = await api('POST', '/live-stream/start', {
    body: { sn: target.droneSn, camera_index: idxGuess, video_expire: 600, quality_type: 'adaptive' },
    projectUuid: target.projectUuid,
  });
  console.log(`camera_index=${idxGuess} → code=${r.code} ${r.message} room=${r.data?.url?.match(/room_id=([^&]+)/)?.[1] || '-'}`);

  if (r.code === 0) {
    console.log('\n✔ 飞行器直播可直接开启，无需额外处理');
    return;
  }

  console.log('\n=== 3. 先获取控制权（让机场给飞行器上电）===');
  // payload_index 必须是非空数组；飞行器离线（camera_list=null）时回退机场相机索引
  const payloadIndex = target.droneCameras?.[0]?.camera_index || target.dockCameras?.[0]?.camera_index || '165-0-7';
  console.log(`（payload_index 回退为 ${payloadIndex}）`);
  const cr = await api('POST', '/device/control', {
    body: { drone_sn: target.droneSn, payload_index: [payloadIndex] },
    projectUuid: target.projectUuid,
  });
  console.log(`takeControl → code=${cr.code} ${cr.message} data=${JSON.stringify(cr.data)}`);

  // 机场状态（确认飞行器是否在舱内 / 机场是否空闲）
  const st = await api('GET', `/device/${target.dockSn}/state`, { projectUuid: target.projectUuid });
  const s = st.data?.device_state || {};
  console.log(`机场状态：mode_code=${s.mode_code} drone_in_dock=${s.drone_in_dock}`);

  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    const d = await api('GET', '/project/device', { projectUuid: target.projectUuid });
    const item = (d.data?.list || []).find((x) => x.drone?.sn === target.droneSn);
    const cams = item?.drone?.camera_list;
    console.log(`  第 ${i + 1} 次轮询（${(i + 1) * 5}s）：online=${item?.drone?.device_online_status} camera_list=${JSON.stringify(cams)}`);
    if (cams?.length) {
      const idx = cams[0].camera_index;
      r = await api('POST', '/live-stream/start', {
        body: { sn: target.droneSn, camera_index: idx, video_expire: 600, quality_type: 'adaptive' },
        projectUuid: target.projectUuid,
      });
      console.log(`  → 用 ${idx} 开播：code=${r.code} ${r.message} room=${r.data?.url?.match(/room_id=([^&]+)/)?.[1] || '-'}`);
      if (r.code === 0) {
        console.log('\n✔ 上电后飞行器图传可用');
        return;
      }
      break;
    }
  }
  console.log('\n✘ 仍无法开启飞行器直播，需要人工确认飞行器状态');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
