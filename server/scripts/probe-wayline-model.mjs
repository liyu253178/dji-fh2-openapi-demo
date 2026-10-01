/**
 * 探针：拉取司空 2 真实航线，解析其 KMZ/WPML，确认「机型」字段到底在哪、长什么样。
 * 目的：为自建航线规划模块的「机型匹配」提供实测依据，而不是猜。
 *
 * 用法：node server/scripts/probe-wayline-model.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '../data/tokens.json');
const store = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || {};
const TOKEN = tok.token || tok.value || (typeof tok === 'string' ? tok : '');
const PROJECT = store.activeProjectUuid || tok.projectUuid || '';
const BASE = 'https://es-flight-api-cn.djigate.com';
const PREFIX = '/openapi/v0.1';

if (!TOKEN) { console.error('未找到 TK'); process.exit(1); }

async function req(p, query) {
  const url = new URL(PREFIX + p, BASE);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, {
    headers: {
      'X-User-Token': TOKEN,
      'X-Project-Uuid': PROJECT,
      'X-Request-Id': crypto.randomUUID(),
      'X-Language': 'zh-CN',
    },
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { ok: false, http: res.status, raw: text.slice(0, 300) }; }
  return { ok: Number(j.code) === 0 && res.ok, http: res.status, code: j.code, message: j.message, data: j.data };
}

console.log('== 1. 航线列表 GET /wayline ==');
const list = await req('/wayline', { page: 1, page_size: 50 });
if (!list.ok) { console.error('列表失败', list); process.exit(1); }
const items = list.data?.list || list.data?.items || [];
console.log('航线条数:', items.length);
if (items.length) {
  console.log('第一条全字段:');
  console.log(JSON.stringify(items[0], null, 2));
  console.log('所有条目的字段名并集:', [...new Set(items.flatMap(i => Object.keys(i)))].join(', '));
}

// 逐条取 download_url 并解析 WPML
const targets = items.slice(0, 8);
console.log('\n== 2. 解析各航线 KMZ 内的 WPML ==');
for (const it of targets) {
  const d = await req(`/wayline/${encodeURIComponent(it.id)}`);
  const url = d.data?.download_url;
  if (!url) { console.log(`- ${it.name}: 无 download_url (${d.message || ''})`); continue; }
  let buf;
  try {
    const up = await fetch(url, { redirect: 'follow' });
    buf = Buffer.from(await up.arrayBuffer());
  } catch (e) { console.log(`- ${it.name}: 下载失败 ${e.message}`); continue; }
  let zip;
  try { zip = unzipSync(new Uint8Array(buf)); } catch (e) { console.log(`- ${it.name}: 非 zip (${e.message})`); continue; }
  const names = Object.keys(zip);
  const wpmlName = names.find(n => n.endsWith('.wpml'));
  const tplName = names.find(n => n.endsWith('template.kml'));
  const src = wpmlName || tplName;
  if (!src) { console.log(`- ${it.name}: 包内无 wpml/template (${names.join('|')})`); continue; }
  const xml = strFromU8(zip[src]);
  const grab = (re) => { const m = xml.match(re); return m ? m[1] : null; };
  const info = {
    name: it.name,
    file: src,
    droneEnumValue: grab(/<wpml:droneEnumValue>([^<]*)<\/wpml:droneEnumValue>/),
    droneSubEnumValue: grab(/<wpml:droneSubEnumValue>([^<]*)<\/wpml:droneSubEnumValue>/),
    templateId: grab(/<wpml:templateId>([^<]*)<\/wpml:templateId>/),
    executeHeightMode: grab(/<wpml:executeHeightMode>([^<]*)<\/wpml:executeHeightMode>/),
    autoFlightSpeed: grab(/<wpml:autoFlightSpeed>([^<]*)<\/wpml:autoFlightSpeed>/),
    waypointCount: (xml.match(/<Placemark>/g) || []).length,
    finishAction: grab(/<wpml:finishAction>([^<]*)<\/wpml:finishAction>/),
    turnMode: grab(/<wpml:waypointTurnMode>([^<]*)<\/wpml:waypointTurnMode>/),
    headingMode: grab(/<wpml:waypointHeadingMode>([^<]*)<\/wpml:waypointHeadingMode>/),
    payloadEnum: [...new Set(xml.match(/<wpml:payloadEnumValue>[^<]*<\/wpml:payloadEnumValue>/g) || [])].join(';'),
    gimbalPitch: [...new Set(xml.match(/<wpml:gimbalPitchRotateAngle>[^<]*<\/wpml:gimbalPitchRotateAngle>/g) || [])].slice(0, 3).join(';'),
  };
  console.log('-', JSON.stringify(info));
  console.log('   包内文件:', names.join(' | '));
}
