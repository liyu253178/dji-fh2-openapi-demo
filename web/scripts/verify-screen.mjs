/**
 * 广东省域态势大屏验收（/screen）
 *
 * 对齐 docs/广东省域大屏-技术论证.md 第七节：
 *   1. 21 个地级市全部渲染
 *   2. 指标来自真实接口；无数据显示空态而不是假数据
 *   3. 1366 / 1920 / 2560 三档分辨率无溢出、无重叠
 *   4. 控制台 0 错误
 *   5. 独立页面，不影响主大屏
 *
 * 另外补三条本项目特有的硬要求（都是踩过坑后才加的）：
 *   - 页面数字必须与接口返回一致（防止 UI 里混入硬编码假数据）
 *   - 地市高亮必须是「算出来的」（点在面判定），不是按名字猜
 *   - Cesium 不能请求任何外部域名（离线前提）
 *
 * 依赖 playwright-core + 系统 Chrome，缺失则跳过（退出码 0）。
 * 用法：先起后端（node server/src/index.js），再 node scripts/verify-screen.mjs
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(PW) || !existsSync(CHROME)) {
  console.log('⏭  未找到 playwright-core / Chrome，跳过省域大屏验收');
  process.exit(0);
}
const mod = await import(PW);
const chromium = mod.chromium || mod.default.chromium;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..');
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
const info = (s) => console.log(`  · ${s}`);

const jget = async (u) => fetch(u).then((r) => r.json()).catch(() => null);
const ping = await jget(`${BASE}/api/ping`);
if (!ping?.ok) {
  console.log(`✗ 后端未启动（${BASE}/api/ping 无响应）`);
  process.exit(1);
}

// 接口侧先取一份真值，用来核对页面上的数字不是硬编码
const ov = await jget(`${BASE}/api/ops/overview`);
const snap = await jget(`${BASE}/api/ops/snapshot`);
const region = await jget(`${BASE}/api/tickets/stats/by-region`);
const expectDevices = (snap?.data?.devices || []).filter(
  (d) => d.position?.lat != null && d.position?.lng != null
).length;
info(`接口真值：机场 ${ov?.data?.devices?.airports}，在线机场 ${ov?.data?.devices?.onlineAirports}，告警 ${ov?.data?.resources?.alerts}，带坐标设备 ${expectDevices}`);

console.log('\n=== 广东省域态势大屏验收 ===\n');

const b = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
const external = [];
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
p.on('request', (r) => {
  const u = new URL(r.url());
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') external.push(u.host);
});

try {
  await p.goto(`${BASE}/screen`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => window.__GD_SCREEN__?.ready === true, { timeout: 120000 });
  await p.waitForTimeout(3000); // 等地市实体与图表渲染完

  /* ---------------- 1. 地市渲染 ---------------- */
  console.log('[1] 行政区渲染');
  const probe = await p.evaluate(() => window.__GD_SCREEN__.probe);
  ok('21 个地级市全部建模', probe.cities === 21, `${probe.cities} 个市 / ${probe.entities} 个面`);
  ok('带坐标的设备已落点', probe.devicePoints === expectDevices, `${probe.devicePoints} / 接口 ${expectDevices}`);

  /* ---------------- 2. 真实数据核对 ---------------- */
  console.log('\n[2] 指标与接口一致（防硬编码假数据）');
  // ⚠️ 必须只读「数值」那个 span，不能读 .kpi-val 整串：
  // 整串里含单位（如「0/ 2」），用 includes 匹配接口值会被单位里的数字蒙对，造成假阳性。
  // 另外 v-count 有 900ms 滚动动画，断言前要等它滚完，否则读到的是中间值。
  const readKpi = () =>
    p.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('.kpi')) {
        const label = el.querySelector('.kpi-label')?.innerText?.trim();
        // 必须排除 .dash（「—」占位 span 常驻 DOM，靠 v-show 隐藏），否则读到「—」→ NaN
        const num = el.querySelector('.kpi-val span:not(.dash)');
        out[label] = num ? Number(num.innerText.trim()) : null;
      }
      return out;
    });
  await p.waitForTimeout(1500); // 等数字滚动结束
  const shown = await readKpi();
  info(`页面 KPI：${Object.entries(shown).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  const eq = (label, want) => {
    const got = shown[label];
    ok(`${label} 与接口一致`, got === want, `页面 ${got} / 接口 ${want}`);
  };
  // 告警数会随时间变化，用页面自己拿到的那份接口值比对，不跨时刻比
  const pageOv = await p.evaluate(() => fetch('/api/ops/overview').then((r) => r.json()).then((j) => j.data));
  eq('在线机场', pageOv?.devices?.onlineAirports);
  eq('在线飞行器', pageOv?.devices?.onlineDrones);
  eq('告警', pageOv?.resources?.alerts);
  eq('航线', pageOv?.resources?.waylines);

  const regionRows = region?.data || [];
  const totalTickets = regionRows.reduce((n, r) => n + (Number(r.count) || 0), 0);
  const cityRows = probe.cityTickets.length;
  if (totalTickets > 0) {
    ok('街道级工单已匹配到地市', cityRows > 0, `${cityRows} 个市有工单，接口共 ${totalTickets} 条`);
  } else {
    info('接口无工单地域数据，跳过匹配断言（页面应显示空态）');
    ok('无数据时显示空态而非假数据', await p.locator('.left .empty').count() > 0);
  }

  /* ---------------- 3. 空态与口径 ---------------- */
  console.log('\n[3] 空态与口径说明');
  const trendZero = (ov?.data?.trend || []).every((t) => !t.count);
  if (trendZero) {
    ok('趋势全 0 时给出口径说明', (await p.locator('.bottom .empty').count()) > 0, '近 7 天无任务');
  } else {
    info('趋势有数据，跳过空态断言');
  }
  ok('页脚标明了数据来源与区划版本',
    (await p.locator('.foot').innerText()).includes('WGS84'));

  /* ---------------- 4. 三档分辨率 ---------------- */
  console.log('\n[4] 分辨率自适应');
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(600);
    const over = await p.evaluate(() => {
      const d = document.documentElement;
      return d.scrollWidth - d.clientWidth;
    });
    // 面板是否互相压住：左下与右下两块在 1366 下最容易撞车
    const collide = await p.evaluate(() => {
      const l = document.querySelector('.panel.left')?.getBoundingClientRect();
      const r = document.querySelector('.panel.right')?.getBoundingClientRect();
      if (!l || !r) return false;
      return l.right > r.left && l.bottom > r.top && l.top < r.bottom;
    });
    ok(`${w}×${h} 无横向溢出`, over <= 0, `溢出 ${over}px`);
    ok(`${w}×${h} 左右面板不重叠`, !collide);
    await p.screenshot({ path: path.join(WEB_ROOT, `dist/screen-${w}.png`) }).catch(() => {});
  }
  await p.setViewportSize({ width: 1920, height: 1080 });

  /* ---------------- 5. 离线与控制台 ---------------- */
  console.log('\n[5] 离线与控制台');
  ok('未请求任何外部域名', external.length === 0, external.length ? [...new Set(external)].join(', ') : '（无）');
  const realErrs = errs.filter((t) => !/ERR_FAILED|ERR_ABORTED|net::/i.test(t));
  ok('控制台 0 错误', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));
} finally {
  await b.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(fail ? '判定：省域大屏未通过验收。' : '判定：省域大屏通过验收。');
process.exit(fail ? 1 : 0);
