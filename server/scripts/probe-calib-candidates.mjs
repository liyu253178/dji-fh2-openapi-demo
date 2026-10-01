/**
 * 临时排查：把库里所有 M4TD 航线的反演结果都跑一遍，看出哪条可信
 * node scripts/probe-calib-candidates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/tokens.json'), 'utf8'));
const tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || {};
const { session, request } = await import('../src/djiClient.js');
session.token = tok.token || tok.value || '';
session.projectUuid = store.activeProjectUuid || '';
const { inspectKmz } = await import('../src/modules/wayline/wpmlInspector.js');

const list = await request({ method: 'GET', path: '/wayline', query: { page: 1, page_size: 100 }, tag: '排查' });
const rows = (list.data?.list || []).filter((w) => w.device_model_key === '0-100-1');
console.log('M4TD 航线数:', rows.length);

for (const w of rows) {
  const d = await request({ method: 'GET', path: `/wayline/${encodeURIComponent(w.id)}`, tag: '排查' });
  const url = d.data?.download_url;
  if (!url) {
    console.log(`- ${w.name}: 无下载链接`);
    continue;
  }
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  let info;
  try {
    info = inspectKmz(buf);
  } catch (e) {
    console.log(`- ${w.name}: 解析失败 ${e.message}`);
    continue;
  }
  const t = info.template || {};
  const c = info.calibration;
  console.log(
    `- ${w.name} [${(w.template_types || []).join('/')}] H=${t.globalShootHeight} W=${t.overlapW} Ho=${t.overlapH} 点数=${info.waypointCount} ver=${info.version}` +
      (c
        ? ` → swathK=${c.swathK.toFixed(4)} stepK=${c.stepK.toFixed(4)} (带${c.sample.strips} 间距${c.sample.spacing.toFixed(1)}m 点距${c.sample.wpSpacing.toFixed(1)}m)`
        : ' → 反演失败')
  );
}
