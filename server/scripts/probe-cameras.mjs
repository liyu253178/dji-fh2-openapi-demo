/** 打印机场/飞行器的 camera_list 原始结构，确认舱内/舱外/飞行器相机索引 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tokens.json'), 'utf8'));
const active = raw.tokens.find((t) => t.id === raw.activeId) || raw.tokens[0];
const TOKEN = process.env.FH2_TOKEN || active.token;
const BASE = 'https://es-flight-api-cn.djigate.com';

async function api(p, projectUuid) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
    'X-Language': 'zh',
    'X-User-Token': TOKEN,
  };
  if (projectUuid) headers['X-Project-Uuid'] = projectUuid;
  const res = await fetch(new URL(BASE + '/openapi/v0.1' + p), { headers });
  return res.json();
}

const prj = await api('/project?page=1&page_size=100');
for (const p of prj.data?.list || []) {
  const d = await api('/project/device', p.uuid);
  for (const item of d.data?.list || []) {
    const g = item.gateway;
    const dr = item.drone;
    if (g?.sn === 'YOUR_DEVICE_SN' || (dr?.sn === 'YOUR_DEVICE_SN' && g)) {
      console.log(`项目 ${p.name} ${p.uuid}`);
      console.log('gateway:', JSON.stringify({ sn: g.sn, model: g.model, camera_list: g.camera_list }, null, 2));
      console.log('drone:', JSON.stringify({ sn: dr?.sn, model: dr?.model, camera_list: dr?.camera_list }, null, 2));
    }
  }
}
