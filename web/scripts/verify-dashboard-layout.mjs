#!/usr/bin/env node
/**
 * 仪表盘浮层布局断言（需要系统 Chrome + playwright-core，见文末「依赖」）
 *
 * 首页大屏是「地图铺底 + 多个绝对定位浮层」的结构，浮层之间靠手算像素避让，
 * 极易在某个视口高度下互相压住。以下三处都是真实发生过的缺陷：
 *   ① 架次名（司空航线名如 FlyToTask_8UUXN2B00A00RV）只有 flex:1 + min-width:0，
 *      缺 overflow:hidden —— 文字以 overflow:visible 画到相邻元素上，实测溢出 28px、
 *      压住右侧「执行成功」标签 20px，视觉上变成「RV行成功」；
 *   ② .map-toolbar（z-index 999）原在左下 bottom:100px，与作业记录面板
 *      （top:12 / max-height:calc(100% - 130px)）在 1440x900 下重叠 65px，
 *      把「本月航线执行次数」柱状图第 4 条柱子盖住；1920x1080 下不重叠，
 *      属于「窗口不够矮才发作」的缺陷，只在单一大屏尺寸下测会漏掉；
 *   ③ 面板与底部 KPI 条在矮视口下的避让。
 * 这里在 4 个视口下量化「矩形相交面积」，任一为 0 才算通过。
 *
 * 用法：cd web && node scripts/verify-dashboard-layout.mjs [BASE_URL]
 *      默认 BASE_URL=http://127.0.0.1:8787（需先起服务）
 *
 * 依赖：playwright-core + 系统已装 Chrome。脚本会按以下顺序探测 playwright-core：
 *   PLAYWRIGHT_CORE_PATH 环境变量 → 本项目 node_modules → WorkBuddy 隔离工作区 → 全局 npm root
 * 找不到则跳过（退出码 0），避免在没装的环境里卡住回归。
 */

let chromium = null;
let skipped = '';

const CANDIDATES = [
  process.env.PLAYWRIGHT_CORE_PATH,
  'playwright-core',
  '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js',
].filter(Boolean);

for (const c of CANDIDATES) {
  try {
    const mod = await import(c);
    chromium = mod.chromium || mod.default?.chromium;
    if (chromium) break;
  } catch {
    /* 试下一个 */
  }
}

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

if (!chromium) {
  skipped = 'playwright-core 未找到（设 PLAYWRIGHT_CORE_PATH 或 npm i -D playwright-core）';
}
if (skipped) {
  console.log(`⏭  跳过仪表盘布局断言：${skipped}`);
  process.exit(0);
}

const fs = await import('node:fs');
const chromePath = CHROME_PATHS.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.log('⏭  跳过仪表盘布局断言：未找到系统 Chrome/Edge/Chromium');
  process.exit(0);
}

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 1280, h: 720 },
  { w: 960, h: 626 },
];

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

const browser = await chromium.launch({ executablePath: chromePath, headless: true });

for (const vp of VIEWPORTS) {
  console.log(`\n--- ${vp.w}x${vp.h} ---`);
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  const bad = [];
  page.on('response', (r) => {
    if (r.status() >= 400) bad.push(`${r.status()} ${r.url().replace(BASE, '')}`);
  });

  try {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log(`  ✗ 打开 /dashboard 失败：${e.message.split('\n')[0]}`);
    fail++;
    await page.close();
    continue;
  }
  // 必须等真实数据渲染出来再量。只等固定时长会在机器繁忙（例如与 vite build 并发）时
  // 量到「空面板」，出现假阴性 —— 实测并发跑时 4 个视口里会随机挂 2 条。
  await page
    .waitForSelector('.panel-tasks .panel-row', { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const d = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        top: Math.round(b.top), bottom: Math.round(b.bottom),
        left: Math.round(b.left), right: Math.round(b.right),
        w: Math.round(b.width), h: Math.round(b.height),
      };
    };
    const rows = [...document.querySelectorAll('.panel-tasks .panel-row')];
    const names = rows.map((row) => {
      const n = row.querySelector('.name');
      const t = row.querySelector('.tag');
      if (!n || !t) return null;
      const cs = getComputedStyle(n);
      const clipped = cs.overflow !== 'visible';
      // overflow:hidden 时文字被裁到 clientWidth，否则画到 scrollWidth
      const paintRight = n.getBoundingClientRect().left + (clipped ? n.clientWidth : n.scrollWidth);
      return {
        overflowPx: n.scrollWidth - n.clientWidth,
        visOverlapTag: Math.round(paintRight - t.getBoundingClientRect().left),
        clipped,
        textOverflow: cs.textOverflow,
      };
    });
    const ov = (a, b) => {
      if (!a || !b) return 0;
      const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      return dx > 0 && dy > 0 ? Math.min(dx, dy) : 0;
    };
    const t = {
      tasks: rect('.panel-tasks'),
      nest: rect('.panel-nest'),
      kpi: rect('.kpi-dash'),
      toolbar: rect('.map-toolbar'),
      chart: rect('.panel-tasks .rec-chart'),
    };
    return {
      names,
      ...t,
      ovToolbarTasks: ov(t.toolbar, t.tasks),
      ovToolbarKpi: ov(t.toolbar, t.kpi),
      ovToolbarNest: ov(t.toolbar, t.nest),
      ovToolbarChart: ov(t.toolbar, t.chart),
      ovTasksKpi: ov(t.tasks, t.kpi),
    };
  });

  // ① 长名称必须截断，且不压住状态标签
  const longOnes = d.names.filter((x) => x && x.overflowPx > 0);
  ok(
    `长名称已省略号截断（${longOnes.length} 条超长）`,
    longOnes.every((x) => x.clipped && x.textOverflow === 'ellipsis'),
    longOnes.length ? `overflow=${longOnes[0].overflowPx}px textOverflow=${longOnes[0].textOverflow}` : ''
  );
  const worst = d.names.filter(Boolean).reduce((m, x) => Math.max(m, x.visOverlapTag), -999);
  ok('名称不压住状态标签', worst <= 0, `最大视觉重叠 ${worst}px`);

  // ② 底图工具栏不与任何浮层重叠
  ok('工具栏不压作业记录面板', d.ovToolbarTasks === 0, `重叠 ${d.ovToolbarTasks}px`);
  ok('工具栏不压本月航线柱状图', d.ovToolbarChart === 0, `重叠 ${d.ovToolbarChart}px`);
  ok('工具栏不压 KPI 条', d.ovToolbarKpi === 0, `重叠 ${d.ovToolbarKpi}px`);
  ok('工具栏不压机巢面板', d.ovToolbarNest === 0, `重叠 ${d.ovToolbarNest}px`);

  // ③ 面板与 KPI 条的避让
  ok('作业记录面板不压 KPI 条', d.ovTasksKpi === 0, `重叠 ${d.ovTasksKpi}px`);

  ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));
  ok('0 个 4xx 请求', bad.length === 0, bad.slice(0, 2).join(' | '));

  if (d.tasks && d.toolbar) {
    console.log(`     位置：面板 ${d.tasks.top}-${d.tasks.bottom} · 工具栏 ${d.toolbar.top}-${d.toolbar.bottom} · KPI ${d.kpi?.top}-${d.kpi?.bottom}`);
  }
  await page.close();
}

await browser.close();

console.log(`\n${'═'.repeat(52)}`);
console.log(`测试结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
