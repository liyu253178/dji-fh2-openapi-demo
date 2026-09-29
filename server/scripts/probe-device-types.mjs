/**
 * 探针：设备树里除 gateway/drone 之外还有哪些设备类型？
 * 决定「地面站 / 中继站」能否在 v0.1 接口上支持。
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

async function api(method, p, { projectUuid } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Request-Id': randomUUID(), 'X-Language': 'zh', 'X-User-Token': TOKEN };
  if (projectUuid) headers['X-Project-Uuid'] = projectUuid;
  const res = await fetch(new URL(BASE + PREFIX + p), { method, headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { ok: res.ok, code: json?.code, message: json?.message, data: json?.data, text: text.slice(0, 200) };
}

async function main() {
  const prj = await api('GET', '/project?page=1&page_size=200');
  const projects = prj.data?.list || [];
  const keyCount = new Map();
  let sample = null;

  for (const p of projects) {
    const d = await api('GET', '/project/device', { projectUuid: p.uuid });
    for (const item of d.data?.list || []) {
      for (const k of Object.keys(item)) keyCount.set(k, (keyCount.get(k) || 0) + 1);
      if (!sample) sample = item;
    }
  }

  console.log('=== 设备树条目出现过的所有 key ===');
  for (const [k, n] of [...keyCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ×${n}`);

  console.log('\n=== 一条样例条目的顶层 key ===');
  console.log(Object.keys(sample || {}).join(', '));

  console.log('\n=== 各条目里 gateway/drone 的 device_model.class ===');
  const classes = new Map();
  for (const p of projects) {
    const d = await api('GET', '/project/device', { projectUuid: p.uuid });
    for (const item of d.data?.list || []) {
      for (const role of ['gateway', 'drone', 'base_station', 'relay', 'dock', 'hangar']) {
        const dev = item[role];
        if (!dev?.sn) continue;
        const cls = dev.device_model?.class || '(无 class)';
        const key = `${role} → class=${cls} model=${dev.device_model?.key || '-'} name=${dev.device_model?.name || '-'}`;
        classes.set(key, (classes.get(key) || 0) + 1);
      }
    }
  }
  for (const [k, n] of [...classes.entries()].sort()) console.log(`  ${k}  ×${n}`);

  console.log('\n=== 组织级 /device 接口（可能有其它类型设备）===');
  const all = await api('GET', '/device?page=1&page_size=100');
  console.log(`code=${all.code} 条目数=${(all.data?.list || []).length}`);
  const allKeys = new Map();
  for (const it of all.data?.list || []) {
    for (const k of Object.keys(it)) allKeys.set(k, (allKeys.get(k) || 0) + 1);
  }
  for (const [k, n] of [...allKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${k}  ×${n}`);
  if (all.data?.list?.[0]) console.log('  样例：', JSON.stringify(all.data.list[0]).slice(0, 400));
}

main().catch((e) => { console.error(e); process.exit(1); });
