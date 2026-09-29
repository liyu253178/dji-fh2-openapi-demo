/**
 * 探针：开启远程调试 → 飞行器上电 → 拉飞行器图传
 *
 * 背景（已实测）：
 *  - 文档明确「飞行器开机后，才能获得 camera_list 信息」
 *  - 飞行器离线时直接开播 → 213003 no streaming gateway found
 *  - 「获取控制权」实测 20 分钟也没有让飞行器上电，不是开机手段
 *  - OpenAPI 没有独立开机接口，唯一能触发上电的是「开启远程调试」
 *
 * 本脚本会用真实机场做一次 debug-mode-open（会开舱），测完调用 debug-mode-close 复位。
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

const ORG = process.env.ORG_UUID || JSON.parse(Buffer.from(TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).organization_uuid;
const DOCK = process.env.DOCK_SN || 'YOUR_DEVICE_SN';
const DRONE = process.env.DRONE_SN || '';
const PROJECT = process.env.PROJECT_UUID || 'YOUR_PROJECT_UUID';

async function api(method, p, { body, projectUuid } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
    'X-Language': 'zh',
    'X-User-Token': TOKEN,
  };
  if (projectUuid) headers['X-Project-Uuid'] = projectUuid;
  const res = await fetch(new URL(BASE + p), { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, text: text.slice(0, 300) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPEN = `/openapi/v1.0/manage/api/v1/organizations/${ORG}/manage-devices/cmds/debug-mode-open`;
const CLOSE = `/openapi/v1.0/manage/api/v1/organizations/${ORG}/manage-devices/cmds/debug-mode-close`;

async function main() {
  console.log(`org=${ORG} dock=${DOCK}`);

  console.log('\n=== 1. debug-mode-open ===');
  const o = await api('POST', OPEN, { body: { device_sn: DOCK }, projectUuid: PROJECT });
  console.log(`http=${o.http} code=${o.code} message=${o.message}`);
  console.log(`data=${JSON.stringify(o.data)}`);

  if (o.code !== 0) {
    console.log('\n✘ 开启远程调试失败，路径可能需要私有云或组织不匹配');
    return;
  }

  console.log('\n=== 2. 轮询飞行器上电状态 ===');
  for (let i = 0; i < 12; i++) {
    await sleep(10000);
    const d = await api('GET', '/openapi/v0.1/project/device', { projectUuid: PROJECT });
    const item = (d.data?.list || []).find((x) => x.gateway?.sn === DOCK);
    const dr = item?.drone;
    const mode = item?.gateway?.mode_code;
    console.log(
      `  ${(i + 1) * 10}s：机场 mode=${mode} | 飞行器 online=${dr?.device_online_status} mode=${dr?.mode_code} camera_list=${JSON.stringify(dr?.camera_list)}`
    );
    if (dr?.camera_list?.length) {
      const idx = dr.camera_list[0].camera_index;
      const lr = await api('POST', '/openapi/v0.1/live-stream/start', {
        body: { sn: dr.sn, camera_index: idx, video_expire: 600, quality_type: 'adaptive' },
        projectUuid: PROJECT,
      });
      console.log(`  → 开播 ${dr.sn} / ${idx}：code=${lr.code} ${lr.message} room=${lr.data?.url?.match(/room_id=([^&]+)/)?.[1] || '-'}`);
      if (lr.code === 0) {
        console.log('\n✔ 机场内飞行器图传成功（远程调试模式下）');
        console.log('  测完记得调用 debug-mode-close 复位');
        return;
      }
    }
  }
  console.log('\n✘ 远程调试已开启但飞行器仍未上电（可能需要更久，或飞行器未安装/电池耗尽）');
  console.log('  复位命令：debug-mode-close');
}

main().catch((e) => { console.error(e); process.exit(1); });
