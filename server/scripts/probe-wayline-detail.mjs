/**
 * 探针 2：全量航线机型画像 + 代表性航线 WPML 全文落盘
 * 用于确定「机型匹配」的唯一键，以及面状/巡逻/航点三类航线的结构差异。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/tokens.json'), 'utf8'));
const tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || {};
const TOKEN = tok.token || tok.value || '';
const PROJECT = store.activeProjectUuid || '';
const BASE = 'https://es-flight-api-cn.djigate.com';
const PREFIX = '/openapi/v0.1';
const OUT = path.resolve(__dirname, '../data/probe-wayline');
fs.mkdirSync(OUT, { recursive: true });

async function req(p, query) {
  const url = new URL(PREFIX + p, BASE);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: { 'X-User-Token': TOKEN, 'X-Project-Uuid': PROJECT, 'X-Request-Id': crypto.randomUUID(), 'X-Language': 'zh-CN' },
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { ok: false, http: res.status, raw: text.slice(0, 200) }; }
  return { ok: Number(j.code) === 0 && res.ok, code: j.code, message: j.message, data: j.data };
}

const list = await req('/wayline', { page: 1, page_size: 100 });
const items = list.data?.list || [];
console.log('航线总数:', items.length);

console.log('\n== A. 机型标识画像 device_model_key × template_types ==');
const byKey = new Map();
for (const it of items) {
  const k = `${it.device_model_key} | ${(it.template_types || []).join(',')} | payload=${JSON.stringify(it.payload_information)}`;
  byKey.set(k, (byKey.get(k) || 0) + 1);
}
for (const [k, v] of [...byKey].sort((a, b) => b[1] - a[1])) console.log(`  ${v} 条  ${k}`);

console.log('\n== B. 设备列表里能否拿到机型名 ==');
const dev = await req('/device');
const dl = dev.data?.list || [];
console.log('设备数:', dl.length);
const models = new Map();
for (const d of dl) {
  const dr = d.drone || {}, gw = d.gateway || {};
  const key = `${dr.device_model_key || dr.model_key || '-'} / ${dr.model || dr.device_model || dr.name || '-'} (dock:${gw.device_model_key || gw.model || '-'})`;
  models.set(key, (models.get(key) || 0) + 1);
}
for (const [k, v] of models) console.log(`  ${v} 台  ${k}`);
if (dl[0]) console.log('  样例 drone 字段:', JSON.stringify(dl[0].drone, null, 2).slice(0, 1200));

console.log('\n== C. 代表性航线 WPML 全文落盘 ==');
// 按 template_types 各取一条
const seen = new Set();
const picks = [];
for (const it of items) {
  const t = (it.template_types || []).join(',') || 'none';
  if (!seen.has(t)) { seen.add(t); picks.push(it); }
}
for (const it of picks.slice(0, 6)) {
  const d = await req(`/wayline/${encodeURIComponent(it.id)}`);
  const url = d.data?.download_url;
  if (!url) { console.log(`- ${it.name}: 无下载链接`); continue; }
  const buf = Buffer.from(await (await fetch(url, { redirect: 'follow' })).arrayBuffer());
  const zip = unzipSync(new Uint8Array(buf));
  const names = Object.keys(zip);
  const safe = it.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  for (const n of names) {
    const out = path.join(OUT, `${safe}__${n.replace(/\//g, '_')}`);
    fs.writeFileSync(out, strFromU8(zip[n]));
  }
  console.log(`- ${it.name} [${(it.template_types || []).join(',')}] device_model_key=${it.device_model_key} → ${names.join(' | ')} (${buf.length}B)`);
}
console.log('\n落盘目录:', OUT);
