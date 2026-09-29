/**
 * 探针：用「飞行器相机索引」获取控制权，验证是否能让机场给飞行器上电
 *
 * 假设：之前一直传机场相机索引 165-0-7 拿控制权，那只拿到机场相机的控制权，
 *       永远不会给飞行器上电 → 形成「飞行器关机 → 无 camera_index → 用机场索引 → 不上电」死循环。
 *       改为传飞行器自身的 camera_index（如 176-0-0），机场才可能给飞行器上电。
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
const P = '/openapi/v0.1';

const DOCK = process.env.DOCK_SN || 'YOUR_DEVICE_SN';
const DRONE = process.env.DRONE_SN || 'YOUR_DEVICE_SN';
const PROJECT = process.env.PROJECT_UUID || 'YOUR_PROJECT_UUID';
const PAYLOAD = (process.env.PAYLOAD_INDEX || '176-0-0').split(',');
const MAX_WAIT = Number(process.env.MAX_WAIT || 180000);

async function api(method, p, { body, projectUuid } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
    'X-Language': 'zh',
    'X-User-Token': TOKEN,
  };
  if (projectUuid) headers['X-Project-Uuid'] = projectUuid;
  const res = await fetch(new URL(BASE + P + p), { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, text: text.slice(0, 250) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function droneOf() {
  const d = await api('GET', '/project/device', { projectUuid: PROJECT });
  return (d.data?.list || []).find((x) => x.drone?.sn === DRONE)?.drone;
}

async function main() {
  const before = await droneOf();
  console.log(`初始：飞行器 online=${before?.device_online_status} mode=${before?.mode_code} camera_list=${JSON.stringify(before?.camera_list)}`);

  console.log(`\n=== 获取控制权：drone_sn=${DRONE} payload_index=${JSON.stringify(PAYLOAD)} ===`);
  const cr = await api('POST', '/device/control', {
    body: { drone_sn: DRONE, payload_index: PAYLOAD },
    projectUuid: PROJECT,
  });
  console.log(`code=${cr.code} ${cr.message}`);
  console.log(`data=${JSON.stringify(cr.data)}`);

  if (cr.code !== 0) {
    console.log('\n✘ 控制权获取失败');
    return;
  }

  console.log(`\n=== 轮询等待上电（最多 ${MAX_WAIT / 1000}s）===`);
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < MAX_WAIT) {
    await sleep(8000);
    const dr = await droneOf();
    const el = Math.round((Date.now() - t0) / 1000);
    const sig = `${dr?.device_online_status}|${dr?.mode_code}|${JSON.stringify(dr?.camera_list)}`;
    if (sig !== last) {
      console.log(`  ${el}s：online=${dr?.device_online_status} mode=${dr?.mode_code} camera_list=${JSON.stringify(dr?.camera_list)}`);
      last = sig;
    }
    if (dr?.camera_list?.length) {
      const idx = dr.camera_list[0].camera_index;
      console.log(`\n飞行器已上电，camera_index=${idx}，尝试开播…`);
      const lr = await api('POST', '/live-stream/start', {
        body: { sn: DRONE, camera_index: idx, video_expire: 600, quality_type: 'adaptive' },
        projectUuid: PROJECT,
      });
      console.log(`  开播 → code=${lr.code} ${lr.message} room=${lr.data?.url?.match(/room_id=([^&]+)/)?.[1] || '-'}`);
      if (lr.code === 0) {
        console.log(`\n✔ 成功！「获取控制权（飞行器 payload）→ 自动上电 → 图传」链路可行，耗时约 ${el}s`);
      }
      return;
    }
  }
  console.log('\n✘ 超时仍未上电');
}

main().catch((e) => { console.error(e); process.exit(1); });
