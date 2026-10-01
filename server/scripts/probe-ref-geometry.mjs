/**
 * 临时排查：把参考航线的测区尺寸与航点几何打出来，判断反演是否可信
 * node scripts/probe-ref-geometry.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const store = JSON.parse(fs.readFileSync(path.join(root, 'data/tokens.json'), 'utf8'));
const tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || {};
const { session, request } = await import('../src/djiClient.js');
session.token = tok.token || tok.value || '';
session.projectUuid = store.activeProjectUuid || '';
const { parseTemplate, parseWaypoints } = await import('../src/modules/wayline/wpmlInspector.js');
const { makeLocalFrame } = await import('../src/modules/wayline/routePlanner.js');
const { unpackKmz } = await import('../src/modules/wayline/kmzPacker.js');

const list = await request({ method: 'GET', path: '/wayline', query: { page: 1, page_size: 100 }, tag: 'dump' });
const want = ['教员考试航测', '存储桶测试——杨培龙', 'zyq'];
for (const w of (list.data?.list || []).filter((x) => want.includes(x.name))) {
  const d = await request({ method: 'GET', path: '/wayline/' + encodeURIComponent(w.id), tag: 'dump' });
  if (!d.ok || !d.data?.download_url) { console.log('=== ' + w.name + ' 无下载链接'); continue; }
  const buf = Buffer.from(await (await fetch(d.data.download_url)).arrayBuffer());
  const files = unpackKmz(buf);
  const tplText = Object.entries(files).find((e) => /template\.kml$/i.test(e[0]))?.[1];
  const wplText = Object.entries(files).find((e) => /waylines\.wpml$/i.test(e[0]))?.[1];
  const t = parseTemplate(tplText);
  const pts = parseWaypoints(wplText);
  const poly = t.polygon || [];
  const lons = poly.map((p) => p[0]);
  const lats = poly.map((p) => p[1]);
  const c = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const f = makeLocalFrame(c[0], c[1]);
  const xy = poly.map(f.toXY);
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  console.log('=== ' + w.name + '  H=' + t.globalShootHeight + ' W=' + t.overlapW + ' Ho=' + t.overlapH + ' dir=' + t.direction);
  console.log('  测区: ' + poly.length + ' 点, 尺寸≈ ' + (Math.max(...xs) - Math.min(...xs)).toFixed(1) + ' × ' + (Math.max(...ys) - Math.min(...ys)).toFixed(1) + ' m');
  console.log('  航点数: ' + pts.length);
  const pxy = pts.map((p) => f.toXY([p.lon, p.lat]));
  console.log('  航点XY(米): ' + pxy.slice(0, 10).map((p) => '[' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ']').join(' '));
}
