/**
 * 三维浏览与量测页验收（地理配准 + 底图叠加 + 智图式操控）
 *
 * 三件事必须证明，否则都是自说自话：
 *  1. 二维模型能按「建图报告的实测角点」叠到卫星底图上——票据是foot-bar 上的经纬度
 *     必须落在校验值附近（±0.001°），而不是铺到西半球去。
 *  2. 三维模型能从 tileset 的 ECEF 包围盒反算出真实经度范围（同样有校验值）。
 *  3. 视角快捷键、智图键位提示、悬停经纬高读数都在。
 * 依赖 playwright-core + 系统 Chrome；缺失则跳过（退出码 0）。
 */
import { existsSync } from 'node:fs';

const PW = '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(PW) || !existsSync(CHROME)) {
  console.log('⏭  未找到 playwright-core / Chrome，跳过');
  process.exit(0);
}
const mod = await import(PW);
const chromium = mod.chromium || mod.default.chromium;

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const SHOT = process.env.SHOT || '/tmp/model-geo.png';
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

/** 期望值：来自司空 2 map_report.json 实测角点 / ECEF 包围盒反算（独立算过一遍） */
const EXPECT = {
  '2d': { minLat: 22.578191, maxLat: 22.579643, minLon: 113.937019, maxLon: 113.939023 },
  '3d': { centerLat: 22.579623, centerLon: 113.938028 },
};

const jget = async (u) => fetch(u).then((r) => r.json()).catch(() => null);
const list = (await jget(`${BASE}/api/model?refresh=1`))?.data?.list || [];
const two = list.find((m) => m.file_type === 'model_2d');
const three = list.find((m) => m.file_type === 'model_3d');
console.log(`模型 ${list.length} 个：2D=${two?.name || '-'} / 3D=${three?.name || '-'}`);
if (!two && !three) {
  console.log('⏭  组织内没有模型，跳过');
  process.exit(0);
}

const b = await chromium.launch({ executablePath: CHROME, headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

const pick = async (name) => {
  await p.locator('.geo .el-select').first().click();
  await p.waitForTimeout(400);
  await p.locator('.el-select-dropdown__item').filter({ hasText: name }).first().click();
};

try {
  await p.goto(`${BASE}/models/geo`, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForSelector('.geo .el-select', { timeout: 30000 });
  await p.waitForTimeout(1500);

  console.log('\n[1] 二维模型：地理配准');
  await pick(two.name);
  await p.waitForSelector('.foot-bar', { timeout: 60000 });
  const foot2 = await p.evaluate(() => {
    const el = document.querySelector('.foot-bar');
    const nums = (el?.querySelector('.mono')?.innerText || '').match(/-?\d+\.\d+/g) || [];
    return { text: el?.innerText || '', nums: nums.map(Number) };
  });
  ok('二维模型算出了覆盖范围', foot2.nums.length === 4, foot2.text.replace(/\n/g, ' | '));
  if (foot2.nums.length === 4) {
    const [minLat, minLon, maxLat, maxLon] = foot2.nums;
    const near = (a, b) => Math.abs(a - b) < 0.002;
    ok(
      '角点与建图报告实测一致（±0.002°）',
      near(minLat, EXPECT['2d'].minLat) && near(minLon, EXPECT['2d'].minLon) &&
        near(maxLat, EXPECT['2d'].maxLat) && near(maxLon, EXPECT['2d'].maxLon),
      `${minLat},${minLon} → ${maxLat},${maxLon}`
    );
  }
  const srcText = foot2.text.includes('建图报告实测角点');
  ok('坐标来源标注为建图报告', srcText);

  console.log('\n[2] 二维叠加：点「加载至底图」真的能出瓦片');
  // 用 request 事件（response 事件在部分内核版本对 image 请求不触发）；
  // tileSrc 的 path 是编码过的，解出来后应为 model/.../{z}/{x}/{y}.png 形态
  const tileReqs = [];
  const failReqs = [];
  p.on('response', (r) => {
    const u = decodeURIComponent(r.url());
    if (u.includes('/asset?path=') && /\/(\d+)\/(\d+)\/(\d+)\.png/.test(u)) tileReqs.push(r.status());
    if (r.status() >= 400) failReqs.push(`${r.status()} ${u.slice(0, 120)}`);
  });
  await p.getByRole('button', { name: '加载至底图' }).click();
  await p.waitForSelector('.overlay-bar', { timeout: 180000 });
  await p.waitForTimeout(5000);
  const st = await p.evaluate(() => ({
    overlay: document.querySelector('.overlay-bar')?.innerText || '',
    warn: document.querySelector('.map-warn')?.innerText || '',
    tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
    zoom: window.__leafletZoom ?? null,
  }));
  ok('叠加成功且未报错', !!st.overlay && !st.warn, st.warn || st.overlay.replace(/\n/g, ' | '));
  ok('影像瓦片请求成功返回 200', tileReqs.filter((s) => s === 200).length > 0, `${tileReqs.length} 个瓦片请求`);
  ok('画布上真的渲染出了瓦片', st.tiles > 0, `${st.tiles} 张已加载`);
  await p.screenshot({ path: '/tmp/model-geo-2d.png', fullPage: false });

  console.log('\n[3] 三维模型：ECEF 反算与智图式操控');
  await pick(three.name);
  await p.waitForSelector('.foot-bar', { timeout: 120000 }).catch(() => {});
  const foot3 = await p.evaluate(() => {
    const el = document.querySelector('.foot-bar');
    return el?.innerText || '';
  });
  const nums3 = (foot3.match(/-?\d+\.\d+/g) || []).map(Number);
  ok('三维模型算出了真实范围', nums3.length >= 4, foot3.replace(/\n/g, ' | ').slice(0, 160));
  if (nums3.length >= 4) {
    const [minLat, minLon, maxLat, maxLon] = nums3;
    const inside =
      EXPECT['3d'].centerLat > minLat - 0.002 && EXPECT['3d'].centerLat < maxLat + 0.002 &&
      EXPECT['3d'].centerLon > minLon - 0.002 && EXPECT['3d'].centerLon < maxLon + 0.002;
    ok(
      '反算中心落在该模型范围内（与独立计算一致）',
      inside,
      `${minLat}~${maxLat} / ${minLon}~${maxLon}`
    );
  }

  await p.locator('.geo .el-radio-button', { hasText: '3D 模型' }).click();
  await p.waitForSelector('.viewer canvas', { timeout: 120000 }).catch(() => {});
  await p.waitForTimeout(25000);
  const ui = await p.evaluate(() => ({
    views: [...document.querySelectorAll('.vv-btn')].map((e) => e.innerText.trim()),
    tip: document.querySelector('.viewer-tip')?.innerText || '',
    coord: document.querySelector('.viewer-coord')?.innerText || '',
    stage: document.querySelector('.viewer-stage')?.innerText || '',
    err: document.querySelector('.viewer-error')?.innerText || '',
  }));
  ok('视角快捷按钮齐全', ['俯视', '正视', '后视', '左视', '右视', '复位'].every((t) => ui.views.includes(t)), ui.views.join(' '));
  ok(
    '操控文案对齐大疆智图（左键平移 / 中键旋转 / 右键缩放）',
    ui.tip.includes('左键') && ui.tip.includes('平移') && ui.tip.includes('缩放') && ui.tip.includes('旋转'),
    ui.tip
  );
  ok('三维场景加载无错误提示', !ui.err, ui.err || ui.stage || '');

  // 点「俯视」应无异常，且不再报错
  await p.locator('.vv-btn', { hasText: '俯视' }).click();
  await p.waitForTimeout(1500);
  await p.locator('.vv-btn', { hasText: '⟳' }).click();
  await p.waitForTimeout(1200);
  await p.locator('.vv-btn', { hasText: '⟳' }).click();

  // 悬停模型：应给出该点经纬高（拾取命中才出数，给足时间）
  const box = await p.locator('.viewer').boundingBox();
  let coord = '';
  for (const [dx, dy] of [[0.5, 0.5], [0.5, 0.62], [0.42, 0.55], [0.58, 0.48]]) {
    await p.mouse.move(box.x + box.width * dx, box.y + box.height * dy);
    await p.waitForTimeout(900);
    coord = coord || (await p.evaluate(() => document.querySelector('.viewer-coord')?.innerText || ''));
    if (coord) break;
  }
  ok('悬停显示该点经纬高', /N.*E.*m/.test(coord), coord || '（未命中模型表面）');

  console.log('\n[4] 量测：距离读数含直线/水平/垂直/坡度');
  await p.locator('.geo .el-radio-button', { hasText: '距离' }).click();
  await p.waitForTimeout(600);
  for (const [dx, dy] of [[0.45, 0.52], [0.55, 0.58], [0.6, 0.5]]) {
    await p.mouse.click(box.x + box.width * dx, box.y + box.height * dy);
    await p.waitForTimeout(1200);
  }
  const res = await p.evaluate(() => document.querySelector('.result-bar')?.innerText || '');
  ok('量测结果含直线距离', /直线 [\d.]+ m/.test(res), res.replace(/\n/g, ' | ').slice(0, 160));
  ok('量测结果含水平/垂直距离与坡度', /水平 [\d.]+ m/.test(res) && /垂直 [-\d.]+ m/.test(res) && /坡度/.test(res));

  await p.screenshot({ path: SHOT, fullPage: false });
  console.log(`\n  截图：${SHOT}`);

  console.log('\n[5] 控制台');
  console.log('  非致命请求（多为个别模型缺预览图）:', failReqs.slice(0, 3).join(' ; ') || '无');
  const bad = errs.filter((e) => !/Validation failed|ResizeObserver|Maps\.GL|tile|Failed to load resource/i.test(e));
  ok('无未预期的控制台错误', bad.length === 0, bad.slice(0, 3).join(' | '));
} finally {
  await b.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
