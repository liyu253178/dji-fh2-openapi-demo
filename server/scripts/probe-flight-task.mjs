/**
 * 飞行任务创建参数探针（只读诊断用）
 *
 * 目的：定位 POST /openapi/v0.1/flight-task 返回 200610 invalid param format 的真实原因。
 * 安全性：全部用例使用「假机场 SN」，因此不会真的下发任务、不会真的起飞。
 *        一旦参数校验通过，返回的错误码会从 200610 变为「机场不存在/不属于项目」之类，
 *        据此即可判定哪一套参数是被服务端接受的。
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
  const res = await fetch(url, {
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

async function main() {
  console.log('=== 1. 项目列表 ===');
  const prj = await api('GET', '/project?page=1&page_size=100');
  const projects = prj.data?.list || [];
  console.log(projects.map((p) => `${p.name} = ${p.uuid}`).join('\n') || '(空)');

  console.log('\n=== 2. 设备与航线 ===');
  let dockSn = '';
  let projectUuid = '';
  let waylineUuid = '';
  let waylineModelKey = '';
  let droneModelKey = '';
  for (const p of projects) {
    const d = await api('GET', '/project/device', { projectUuid: p.uuid });
    const list = d.data?.list || [];
    for (const item of list) {
      const g = item.gateway || item;
      if (g?.sn && !dockSn) {
        dockSn = g.sn;
        projectUuid = p.uuid;
        console.log(`机场 ${g.sn}（${g.model || g.name || ''}） 项目=${p.name}`);
      }
      const dr = item.drone;
      if (dr?.sn) console.log(`  飞行器 ${dr.sn} ${dr.model_key || dr.device_model_key || dr.model || ''}`);
      if (dr?.model_key && !droneModelKey) droneModelKey = dr.model_key;
    }
    const w = await api('GET', '/wayline?page=1&page_size=100', { projectUuid: p.uuid });
    for (const wl of w.data?.list || []) {
      console.log(`  航线 ${wl.name} uuid=${wl.uuid} model=${wl.device_model_key || '-'}`);
      if (!waylineUuid) {
        waylineUuid = wl.uuid;
        waylineModelKey = wl.device_model_key || '';
      }
    }
  }

  console.log(`\n采用：dock=${dockSn} project=${projectUuid} wayline=${waylineUuid} waylineModel=${waylineModelKey}`);

  const FAKE_SN = 'PROBE0000000000';
  const cases = [
    {
      tag: 'A 现行实现（中文名含 / 和 : ,无 time_zone）',
      body: {
        name: `一键起飞 ${new Date().toLocaleString('zh-CN')}`,
        wayline_uuid: waylineUuid,
        sn: FAKE_SN,
        task_type: 'immediate',
        rth_mode: 'optimal',
        rth_altitude: 100,
        wayline_precision_type: 'rtk',
      },
    },
    {
      tag: 'B 净化英文名（无 / 和 :）',
      body: {
        name: `takeoff_${Date.now()}`,
        wayline_uuid: waylineUuid,
        sn: FAKE_SN,
        task_type: 'immediate',
        rth_mode: 'optimal',
        rth_altitude: 100,
        wayline_precision_type: 'rtk',
      },
    },
    {
      tag: 'C 净化英文名 + time_zone',
      body: {
        name: `takeoff_${Date.now()}`,
        wayline_uuid: waylineUuid,
        sn: FAKE_SN,
        time_zone: 'Asia/Chongqing',
        rth_altitude: 100,
        rth_mode: 'optimal',
        wayline_precision_type: 'rtk',
        task_type: 'immediate',
      },
    },
    {
      tag: 'D 文档示例全字段 + time_zone + manual/return_home',
      body: {
        name: 'flight_task_probe',
        sn: FAKE_SN,
        time_zone: 'Asia/Chongqing',
        wayline_uuid: waylineUuid,
        rth_altitude: 110,
        rth_mode: 'optimal',
        wayline_precision_type: 'rtk',
        out_of_control_action_in_flight: 'return_home',
        resumable_status: 'manual',
        task_type: 'immediate',
      },
    },
    {
      tag: 'E 文档示例全字段，去掉 time_zone',
      body: {
        name: 'flight_task_probe2',
        sn: FAKE_SN,
        wayline_uuid: waylineUuid,
        rth_altitude: 110,
        rth_mode: 'optimal',
        wayline_precision_type: 'rtk',
        out_of_control_action_in_flight: 'return_home',
        resumable_status: 'manual',
        task_type: 'immediate',
      },
    },
    {
      tag: 'F 中文纯名 + time_zone（验证中文是否被拒）',
      body: {
        name: '测试任务',
        sn: FAKE_SN,
        time_zone: 'Asia/Chongqing',
        wayline_uuid: waylineUuid,
        rth_altitude: 110,
        rth_mode: 'optimal',
        wayline_precision_type: 'rtk',
        task_type: 'immediate',
      },
    },
  ];

  console.log('\n=== 3. 参数探针（假 SN，不会真实起飞）===');
  for (const c of cases) {
    const r = await api('POST', '/flight-task', { body: c.body, projectUuid });
    const pass = r.code !== 200610;
    console.log(
      `${pass ? '✔' : '✘'} ${c.tag}\n   → http=${r.http} code=${r.code} message=${r.message} data=${JSON.stringify(r.data)}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
