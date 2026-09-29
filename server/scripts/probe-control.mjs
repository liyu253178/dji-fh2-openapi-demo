/**
 * 探针：GET /device/control 的可用 payload_index 组合
 * 目的：找出「获取控制权」为什么返回 Bad Request —— 是 payload_index 的问题还是接口本身的问题
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

const DRONE = 'YOUR_DEVICE_SN';
const DOCK = 'YOUR_DEVICE_SN';
/** 目标项目 UUID（从环境变量取，避免把客户信息写进仓库） */
const PRJ = process.env.PRJ || '';

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
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, text: text.slice(0, 220) };
}

async function findProject() {
  const prj = await api('GET', '/project?page=1&page_size=200');
  for (const p of prj.data?.list || []) {
    const d = await api('GET', '/project/device', { projectUuid: p.uuid });
    for (const it of d.data?.list || []) {
      if (it.drone?.sn === DRONE) return { uuid: p.uuid, name: p.name };
    }
  }
  return null;
}

async function main() {
  const prj = PRJ ? { uuid: PRJ, name: '(env)' } : await findProject();
  if (!prj) return console.log('未找到设备所属项目');
  console.log(`项目：${prj.name} ${prj.uuid}\n`);

  const variants = [
    { label: '飞行器 99-0-0', body: { drone_sn: DRONE, payload_index: ['99-0-0'] } },
    { label: '飞行器 176-0-0', body: { drone_sn: DRONE, payload_index: ['176-0-0'] } },
    { label: '机场 165-0-7', body: { drone_sn: DRONE, payload_index: ['165-0-7'] } },
    { label: '空数组', body: { drone_sn: DRONE, payload_index: [] } },
    { label: '不带 payload_index', body: { drone_sn: DRONE } },
    { label: '用机场 SN 当 drone_sn', body: { drone_sn: DOCK, payload_index: ['165-0-7'] } },
  ];

  for (const v of variants) {
    const r = await api('POST', '/device/control', { body: v.body, projectUuid: prj.uuid });
    console.log(
      `${v.label.padEnd(22)} → http=${r.http} code=${r.code ?? '-'} msg=${r.message ?? r.text?.slice(0, 60)} data=${JSON.stringify(r.data)?.slice(0, 80)}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
