/**
 * 探针：打印设备树的完整原始字段，重点看 camera_list / live_capacity / video_list
 * 目的：确认「哪一路 camera_index 真的能推流」是否有权威字段可依，避免靠猜。
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
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, text: text.slice(0, 300) };
}

function keysDeep(obj, prefix = '', out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object') keysDeep(v[0], `${p}[]`, out);
      else out.push(`${p} = ${JSON.stringify(v)}`);
    } else if (v && typeof v === 'object') keysDeep(v, p, out);
    else out.push(`${p} = ${JSON.stringify(v)}`);
  }
  return out;
}

async function main() {
  const prj = await api('GET', '/project?page=1&page_size=200');
  const projects = prj.data?.list || [];
  console.log(`共 ${projects.length} 个项目：${projects.map((p) => p.name).join(' / ')}\n`);

  // 逐个项目找目标机场（项目列表里不一定直接带“深圳”字样）
  const DOCK_SN = process.env.DOCK_SN || 'YOUR_DEVICE_SN';
  let hit = null;
  for (const p of projects) {
    const d = await api('GET', '/project/device', { projectUuid: p.uuid });
    for (const item of d.data?.list || []) {
      if (item.gateway?.sn === DOCK_SN) { hit = { project: p, item }; break; }
    }
    if (hit) break;
  }
  if (!hit) return console.log(`未找到机场 ${DOCK_SN}`);

  const g = hit.item.gateway || {};
  const dr = hit.item.drone || {};
  console.log(`项目：${hit.project.name} (${hit.project.uuid})`);
  console.log(`机场：${g.sn} (${g.callsign || ''})  online=${g.device_online_status} mode=${g.mode_code}\n`);

  console.log('=== 机场 gateway 顶层字段 ===');
  console.log(Object.keys(g).join(', '));
  console.log('\n--- camera_list 原文 ---');
  console.log(JSON.stringify(g.camera_list, null, 1));
  console.log('\n--- live_capacity ---');
  console.log(JSON.stringify(g.live_capacity ?? '(无此字段)', null, 1));
  console.log('\n--- 含 video/live/camera/capacity 的键路径 ---');
  console.log(keysDeep(g).filter((k) => /video|live|camera|capacity/i.test(k)).join('\n') || '(无)');

  console.log('\n=== 飞行器 drone ===');
  console.log(Object.keys(dr).join(', '));
  console.log('camera_list =', JSON.stringify(dr.camera_list));
  console.log('mode_code =', dr.mode_code, ' online =', dr.device_online_status);
  console.log(keysDeep(dr).filter((k) => /video|live|camera|capacity/i.test(k)).join('\n') || '(无)');
}

main().catch((e) => { console.error(e); process.exit(1); });
