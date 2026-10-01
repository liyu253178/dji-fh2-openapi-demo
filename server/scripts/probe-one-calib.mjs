/** 临时排查：单独跑一条航线的反演，看是否被新闸门误杀 */
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

const list = await request({ method: 'GET', path: '/wayline', query: { page: 1, page_size: 100 }, tag: 'probe' });
for (const w of (list.data?.list || [])) {
  if (!/^DUAV/i.test(w.name || '') && (w.template_types || []).some((t) => String(t).includes('2d'))) {
    const d = await request({ method: 'GET', path: '/wayline/' + encodeURIComponent(w.id), tag: 'probe' });
    if (!d.ok || !d.data?.download_url) { console.log(w.name, '无下载链接'); continue; }
    const buf = Buffer.from(await (await fetch(d.data.download_url)).arrayBuffer());
    const info = inspectKmz(buf);
    console.log(
      w.name,
      '| 点数', info.waypointCount,
      '| lens', JSON.stringify(info.lensKeys),
      '| calib', info.calibration ? `swathK=${info.calibration.swathK.toFixed(3)} strips=${info.calibration.sample.strips}` : 'null'
    );
  }
}
