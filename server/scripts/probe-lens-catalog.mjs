/**
 * 机型 · 镜头能力普查
 *
 * 目的：航线规划要适配「不同机型的镜头」，先搞清楚司空 2 到底上报了什么。
 * 遍历当前组织下所有项目的 /project/device，按 device_model.key 聚合，
 * 输出每种机型的：类型、名称、camera_list 结构、lens_list 里的 available_lens_types。
 *
 * 设计原则：**只报实测字段，不猜**。接口没给焦距就写「接口未给」，不拿印象中的规格冒充。
 *
 * 用法：
 *   FH2_TOKEN=<jwt> node server/scripts/probe-lens-catalog.mjs
 * 可选：
 *   MAX_PROJECTS=20  限制遍历项目数（默认全量）
 *   OUT=/tmp/lens-catalog.json  原始数据落盘路径
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TOKEN = process.env.FH2_TOKEN;
if (!TOKEN) {
  console.error('缺少 FH2_TOKEN 环境变量');
  process.exit(1);
}
const BASE = 'https://es-flight-api-cn.djigate.com';
const OUT = process.env.OUT || '/tmp/lens-catalog.json';
const MAX = Number(process.env.MAX_PROJECTS || 0);

async function api(p, projectUuid) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Request-Id': randomUUID(),
    'X-Language': 'zh',
    'X-User-Token': TOKEN,
  };
  if (projectUuid) headers['X-Project-Uuid'] = projectUuid;
  const res = await fetch(new URL(BASE + '/openapi/v0.1' + p), { headers });
  const j = await res.json().catch(() => null);
  return j || {};
}

const prj = await api('/project?page=1&page_size=100');
const projects = prj.data?.list || [];
console.log(`项目 ${projects.length} 个` + (MAX ? `，本次只跑前 ${MAX} 个` : ''));

const models = new Map();
const raw = [];
let scanned = 0;

const list = MAX ? projects.slice(0, MAX) : projects;
for (const p of list) {
  const d = await api('/project/device', p.uuid);
  for (const item of d.data?.list || []) {
    for (const role of ['gateway', 'drone']) {
      const dev = item[role];
      if (!dev) continue;
      scanned += 1;
      const dm = dev.device_model || {};
      const key = dm.key || dev.model || '(未知)';
      const rec = {
        project: p.name,
        role,
        sn: dev.sn,
        key,
        name: dm.name || dev.model || '',
        class: dm.class || '',
        domain: dm.domain || '',
        subType: dm.sub_type || dm.subType || '',
        cameraList: dev.camera_list || null,
        // 设备模型上可能直接带能力字段，一并留档
        modelExtra: Object.fromEntries(
          Object.entries(dm).filter(([k]) => !['key', 'name', 'class', 'domain'].includes(k))
        ),
      };
      raw.push(rec);
      if (!models.has(key)) {
        models.set(key, {
          key,
          name: rec.name,
          class: rec.class,
          domain: rec.domain,
          subType: rec.subType,
          count: 0,
          lensTypes: new Set(),
          cameraIndexes: new Set(),
          sample: null,
          modelExtra: rec.modelExtra,
        });
      }
      const m = models.get(key);
      m.count += 1;
      if (!m.sample) m.sample = rec;
      for (const c of rec.cameraList || []) {
        if (c?.camera_index) m.cameraIndexes.add(c.camera_index);
        for (const l of c?.lens_list || []) {
          for (const t of l?.available_lens_types || []) m.lensTypes.add(t);
        }
      }
    }
  }
}

console.log(`\n扫描设备 ${scanned} 台，去重机型 ${models.size} 种\n`);
console.log('='.repeat(100));
for (const m of [...models.values()].sort((a, b) => b.count - a.count)) {
  console.log(`\n■ ${m.name || m.key}  [key=${m.key}] class=${m.class} domain=${m.domain} 共 ${m.count} 台`);
  console.log(`  镜头能力 available_lens_types: ${m.lensTypes.size ? [...m.lensTypes].join(', ') : '(空/未上报)'}`);
  console.log(`  camera_index: ${m.cameraIndexes.size ? [...m.cameraIndexes].join(', ') : '(空)'}`);
  const cl = m.sample?.cameraList;
  if (cl?.length) {
    console.log(`  camera_list[0] 原始字段: ${Object.keys(cl[0]).join(', ')}`);
    console.log(`  camera_list[0] lens_list: ${JSON.stringify(cl[0].lens_list)}`);
  } else {
    console.log('  camera_list: (未上报)');
  }
  if (Object.keys(m.modelExtra || {}).length) {
    console.log(`  device_model 其余字段: ${JSON.stringify(m.modelExtra)}`);
  }
}
console.log('\n' + '='.repeat(100));

fs.writeFileSync(OUT, JSON.stringify({ scanned, models: [...models.values()].map((m) => ({ ...m, lensTypes: [...m.lensTypes], cameraIndexes: [...m.cameraIndexes] })), raw }, null, 2));
console.log(`\n原始数据已写入 ${OUT}`);
console.log('注：接口若未返回焦距/传感器尺寸，需按官方规格补齐，不能凭印象写死。');
