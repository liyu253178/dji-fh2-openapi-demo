/**
 * 探针 2：先确认航线列表返回的 UUID 字段名，再逐步差分 flight-task 必填字段。
 * 依旧全部使用假机场 SN，不会真实起飞。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = path.join(__dirname, '..', 'data', 'tokens.json');
const BASE = process.env.FH2_BASE || 'https://es-flight-api-cn.djigate.com';
const PREFIX = '/openapi/v0.1';
const raw = JSON.parse(fs.readFileSync(TOKENS, 'utf8'));
const active = raw.tokens.find((t) => t.id === raw.activeId) || raw.tokens[0];
const TOKEN = process.env.FH2_TOKEN || active.token;

async function api(method, p, { body, projectUuid } = {}) {
  const url = new URL(BASE + PREFIX + (p.startsWith('/') ? p : '/' + p));
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
    'X-Language': 'zh',
    'X-User-Token': TOKEN,
  };
  if (projectUuid) headers['X-Project-Uuid'] = projectUuid;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, text: text.slice(0, 300) };
}

async function main() {
  const prj = await api('GET', '/project?page=1&page_size=100');
  const projects = prj.data?.list || [];
  // 项目名从环境变量取，避免把客户项目名写进仓库
  const want = process.env.PROJECT_NAME || '';
  const target = (want && projects.find((p) => p.name === want)) || projects[0];
  const PRJ = target.uuid;
  console.log(`项目：${target.name} ${PRJ}`);

  const w = await api('GET', '/wayline?page=1&page_size=100', { projectUuid: PRJ });
  const list = w.data?.list || [];
  console.log('航线列表顶层 keys:', Object.keys(w.data || {}));
  if (list[0]) {
    console.log('第一条航线原始字段:');
    console.log(JSON.stringify(list[0], null, 2));
  }

  // 找到真正匹配 0-100-1 的航线
  const cand = list.find((x) => (x.device_model_key || '') === '0-100-1');
  const uuidField = cand ? ['uuid', 'wayline_uuid', 'id', 'wayline_id'].find((k) => cand[k]) : null;
  const WL = cand ? cand[uuidField] : '';
  console.log(`\n候选航线：${cand?.name} 字段=${uuidField} 值=${WL}`);

  const sn = 'PROBE0000000000';
  const base = {
    name: 'probe_task',
    sn,
    time_zone: 'Asia/Chongqing',
    wayline_uuid: WL,
    rth_altitude: 110,
    rth_mode: 'optimal',
    wayline_precision_type: 'rtk',
    task_type: 'immediate',
  };
  const variants = [
    ['V1 基础7字段', base],
    ['V2 +out_of_control', { ...base, out_of_control_action_in_flight: 'return_home' }],
    ['V3 +resumable_status', { ...base, resumable_status: 'manual' }],
    ['V4 全字段', { ...base, out_of_control_action_in_flight: 'return_home', resumable_status: 'manual' }],
    ['V5 全字段+中文名', { ...base, name: '一键起飞测试', out_of_control_action_in_flight: 'return_home', resumable_status: 'manual' }],
    ['V6 全字段+gps', { ...base, wayline_precision_type: 'gps', out_of_control_action_in_flight: 'return_home', resumable_status: 'manual' }],
    ['V7 全字段+landing_dock_sn', { ...base, landing_dock_sn: sn, out_of_control_action_in_flight: 'return_home', resumable_status: 'manual' }],
  ];
  console.log('\n=== 差分探针（假 SN）===');
  for (const [tag, body] of variants) {
    const r = await api('POST', '/flight-task', { body, projectUuid: PRJ });
    console.log(`${r.code === 200610 ? '✘' : '✔'} ${tag} → code=${r.code} ${r.message} data=${JSON.stringify(r.data)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
