/**
 * 二维模型预览验收
 *
 * 背景：司空 2 的「2D 模型」不是三维瓦片，而是正射影像瓦片金字塔
 *（包内 {z}/{x}/{y}.png，标准 Web Mercator XYZ）。原实现只有三维渲染器
 * （b3dm/glb），二维模型点预览只能退回一张预览图，看起来像「不能预览」。
 *
 * 本脚本走真实 UI 验证：2D 行显示「二维预览」→ 打开抽屉 → 瓦片真的加载出来。
 * 依赖：playwright-core + 系统 Chrome；找不到就跳过（退出码 0）。
 */
import { existsSync } from 'node:fs';

const PW = '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(PW) || !existsSync(CHROME)) {
  console.log('⏭  未找到 playwright-core / Chrome，跳过二维模型预览验收');
  process.exit(0);
}
const mod = await import(PW);
const chromium = mod.chromium || mod.default.chromium;

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

// 先问服务端有没有可用的 2D 模型（源文件可能已被清理）
const jget = async (u) => (await fetch(u).then((r) => r.json()).catch(() => null));
const list = await jget(`${BASE}/api/model?refresh=1`);
const all = list?.data?.list || [];
const twos = all.filter((m) => m.file_type === 'model_2d');
console.log(`模型总数 ${all.length}，其中 2D 模型 ${twos.length} 个`);
if (!twos.length) {
  console.log('⏭  组织内没有 2D 模型，跳过');
  process.exit(0);
}

// 逐个找源文件可用的（check 只取 1 字节，不下载整包）
let target = null;
for (const m of twos) {
  const c = await jget(`${BASE}/api/model/${m.id}/check`);
  if (c?.available) {
    target = m;
    break;
  }
}
if (!target) {
  console.log(`⏭  ${twos.length} 个 2D 模型的源文件在对象存储里均已不存在（NoSuchKey），无法验收`);
  console.log('    这属于司空 2 侧的数据缺失，不是预览能力问题；UI 会显示明确原因。');
  process.exit(0);
}
console.log(`用模型：${target.name}（id=${target.id}）\n`);

const b = await chromium.launch({ executablePath: CHROME, headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

try {
  await p.goto(`${BASE}/models`, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForSelector('.el-table__row', { timeout: 40000 });
  await p.waitForTimeout(1200);

  const row = p.locator('.el-table__row').filter({ hasText: '2D 模型' }).first();
  const btnText = (await row.locator('button').innerText()).trim();
  ok('2D 模型的按钮是「二维预览」', btnText === '二维预览', btnText);
  ok('3D 模型的按钮仍是「三维预览」', (await p.locator('.el-table__row').filter({ hasText: '3D 模型' }).first().locator('button').innerText()).trim() === '三维预览');

  // 记录瓦片请求，验证真的按 {z}/{x}/{y}.png 去取
  const tiles = [];
  p.on('response', (r) => {
    if (r.url().includes('/asset?path=')) {
      tiles.push({ status: r.status(), path: decodeURIComponent(r.url().split('path=')[1] || '') });
    }
  });

  await row.locator('button').click();
  ok('抽屉打开并渲染出 Leaflet 容器', (await p.locator('.leaflet-container').count()) > 0);
  await p.waitForTimeout(6000);

  const state = await p.evaluate(() => ({
    loaded: document.querySelectorAll('.leaflet-tile-loaded').length,
    total: document.querySelectorAll('.leaflet-tile').length,
    hud: document.querySelector('.r2d-hud')?.innerText || '',
    err: document.querySelector('.r2d-err')?.innerText || '',
  }));

  ok('无错误提示', !state.err, state.err);
  ok('瓦片已加载（影像真的渲染出来了）', state.loaded > 0, `loaded=${state.loaded}/${state.total}`);
  ok('HUD 显示 GSD 与瓦片数', /GSD/.test(state.hud) && /张瓦片/.test(state.hud), state.hud.replace(/\n/g, ' '));
  ok('请求路径符合 {z}/{x}/{y}.png 结构', tiles.some((t) => /download\/\d+\/\d+\/\d+\.png$/.test(t.path)), tiles[0]?.path || '无请求');
  const okCount = tiles.filter((t) => t.status === 200).length;
  ok('瓦片请求返回 200', okCount > 0, `200=${okCount} / 共 ${tiles.length}`);
  ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

  // 缩放一级，确认能继续加载更精细的瓦片
  const before = state.loaded;
  await p.locator('.leaflet-control-zoom-in').click();
  await p.waitForTimeout(3500);
  const after = await p.evaluate(() => document.querySelectorAll('.leaflet-tile-loaded').length);
  ok('放大后仍有影像（层级可推进）', after > 0, `${before} → ${after}`);
} finally {
  await b.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
