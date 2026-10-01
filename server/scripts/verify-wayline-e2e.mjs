/**
 * 端到端验证：平台生成 KMZ → 上传司空 2 → 回查比对机型（闸 2）
 *   node scripts/verify-wayline-e2e.mjs [ortho|doubleGrid|corridor]
 *
 * ⚠️ 会在当前项目留下一条测试航线（名称带 DUAV-E2E 前缀），无删除接口需手工清理。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/tokens.json'), 'utf8'));
const tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || {};
const { session } = await import('../src/djiClient.js');
session.token = tok.token || tok.value || '';
session.projectUuid = store.activeProjectUuid || '';

const { fleetModels } = await import('../src/modules/wayline/aircraftService.js');
const { build } = await import('../src/modules/wayline/planner.js');
const { submitAndVerify } = await import('../src/modules/wayline/verifyService.js');

const TYPE = process.argv[2] || 'ortho';
const fleet = await fleetModels({ force: true });
const ac = (fleet.models || []).find((m) => m.payload !== null && m.payload !== undefined);
if (!ac) {
  console.error('无可用机型');
  process.exit(1);
}

const polygon = [
  [113.493512, 23.092449],
  [113.494488, 23.092449],
  [113.494488, 23.091551],
  [113.493512, 23.091551],
];
const centerline = [
  [113.493, 23.091],
  [113.4945, 23.092],
  [113.496, 23.0928],
];
const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
const name = `DUAV-E2E-${TYPE}-${stamp}`;

const params = {
  height: 60,
  speed: 8,
  overlapH: 80,
  overlapW: 70,
  direction: 0,
  templateType: TYPE,
  corridorWidth: TYPE === 'corridor' ? 80 : undefined,
  extend: TYPE === 'corridor' ? 20 : 0,
};

const built = await build({
  ...(TYPE === 'corridor' ? { centerline } : { polygon }),
  aircraftKey: ac.key,
  params,
  name,
});
if (!built.ok) {
  console.error('生成失败:', built.message);
  process.exit(1);
}
const s = built.preview.plan.stats;
console.log(`生成 ${name}：${s.stripCount} 带 / ${s.waypointCount} 点 / 间距 ${s.spacing}m / KMZ ${built.kmz.length}B`);

const v = await submitAndVerify({ kmz: built.kmz, name, aircraft: { key: ac.key, name: ac.name } });
console.log('验证结果:', JSON.stringify(v, null, 2));

// 反向对照：故意用错误机型，确认闸 2 能识别出来（司空 2 自己不会拦，只会照单入库）
if (v.ok) {
  const wrongName = `${name}-错误机型`;
  const wrong = await build({
    ...(TYPE === 'corridor' ? { centerline } : { polygon }),
    aircraftKey: ac.key,
    params,
    name: wrongName,
  });
  const fake = {
    key: '0-91-1',
    name: '（错误机型）',
  };
  const v2 = await submitAndVerify({ kmz: wrong.kmz, name: wrongName, aircraft: fake });
  console.log('对照（错误机型）:', JSON.stringify({ ok: v2.ok, matched: v2.ok, remote: v2.remoteModelKey, message: v2.message }));
  console.log(v2.ok === false ? '✔ 闸 2 成功拦截错误机型' : '✘ 闸 2 未能拦截错误机型');
}
