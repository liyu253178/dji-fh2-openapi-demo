/**
 * 航线规划工作台浏览器断言（需要系统 Chrome + playwright-core）
 *
 * 覆盖本次四项改动：
 *   ① 「航线规划」是一级折叠栏目，含规划工作台 / 航线库 / 执行记录
 *   ② 测绘区成型后出现可拖动顶点 + ✥ 整体平移手柄 + 缩放按钮
 *   ③ 带状：画完中心线后主动询问「左右各外扩多少米」（默认 20）
 *   ④ 底图不再出现「暂无坐标」提示（那句会把工作台自己的浮层顶掉）
 *
 * 用法：cd web && node scripts/verify-wayline-plan.mjs [BASE_URL]（需先起服务）
 * 依赖：playwright-core + 系统 Chrome，找不到则跳过（退出码 0）。
 */
const fs0 = await import('node:fs');
const CANDIDATES = [
  process.env.PLAYWRIGHT_CORE_PATH,
  'playwright-core',
  '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js',
].filter(Boolean);
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
let mod = null;
for (const c of CANDIDATES) {
  try {
    mod = await import(c);
    if (mod.chromium || mod.default?.chromium) break;
  } catch {
    /* 试下一个 */
  }
}
const chromium = mod?.chromium || mod?.default?.chromium;
const chromePath = CHROME_PATHS.find((x) => fs0.existsSync(x));
if (!chromium || !chromePath) {
  console.log('⏭  跳过工作台断言：未找到 playwright-core 或系统 Chrome');
  process.exit(0);
}

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) {
    pass++;
    console.log('  [ok] ' + n);
  } else {
    fail++;
    console.log('  [FAIL] ' + n + ' ' + e);
  }
};

const b = await chromium.launch({ executablePath: chromePath, headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});

/** 按文字点击（取最深的叶子节点，避免点到容器） */
async function clickText(text) {
  return p.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('*'));
    const el = all.find((e) => e.children.length === 0 && (e.textContent || '').trim() === t);
    if (!el) return false;
    (el.closest('button') || el).click();
    return true;
  }, text);
}

const shot = process.env.SHOT || '/tmp/plan-view.png';

await p.goto(BASE + '/wayline/plan', { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(2000);

console.log('\n[1] 导航与落地');
const navInfo = await p.evaluate(() => ({
  text: document.body.innerText.slice(0, 400),
  path: location.pathname,
}));
ok('规划工作台直达', navInfo.path.replace(/\/+$/, '') === '/wayline/plan', navInfo.path);
ok('侧边栏含「航线规划」一级栏目', navInfo.text.includes('航线规划'));
ok('底图不再显示「暂无坐标」提示', !navInfo.text.includes('暂无坐标'));
ok('类型按钮为「正射航线 / 倾斜航线 / 带状航线」',
  navInfo.text.includes('正射航线') && navInfo.text.includes('倾斜航线') && navInfo.text.includes('带状航线'));
ok('旧「井字」叫法已下线', !navInfo.text.includes('井字'));
ok('类型卡不再带介绍小字', !navInfo.text.includes('固定角度往返扫描'));

console.log('\n[2] 带状：画中心线后主动询问左右外扩');
await clickText('带状航线');
await p.waitForTimeout(500);
const box = await p.locator('.plan-map').boundingBox();
ok('地图区域存在', !!box);
if (box) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await p.mouse.click(cx - 150, cy - 60);
  await p.waitForTimeout(250);
  await p.mouse.click(cx, cy - 20);
  await p.waitForTimeout(250);
  await p.mouse.click(cx + 150, cy + 40);
  await p.waitForTimeout(250);
  await p.mouse.dblclick(cx + 190, cy + 70);
  await p.waitForTimeout(700);
}
const after = await p.evaluate(() => ({
  text: document.body.innerText,
  handles: document.querySelectorAll('.plan-handle').length,
  move: document.querySelectorAll('.plan-handle-move').length,
  mid: document.querySelectorAll('.plan-handle-mid').length,
}));
const m = after.text.match(/已选 (\d+) 点/);
ok('中心线已落点（≥2）', !!m && Number(m[1]) >= 2, m ? m[1] + ' 点' : '未匹配');
ok('主动询问左右外扩', after.text.includes('请设置左右外扩'));
ok('默认左右外扩 20 m 且说明总带宽', after.text.includes('总带宽 = 左右外扩 × 2，当前 40 m'));
ok('顶点手柄已生成（可拖动改形状）', after.handles > 0, `${after.handles} 个`);
ok('整体平移手柄已生成', after.move === 1, `${after.move} 个`);
ok('边中点手柄可插入顶点', after.mid > 0, `${after.mid} 个`);

console.log('\n[3] 整体缩放与自动重算开关');
const before = after.handles;
await clickText('＋放大');
await p.waitForTimeout(500);
const scaled = await p.evaluate(() => document.querySelectorAll('.plan-handle').length);
ok('放大后顶点数不变（等比缩放）', scaled === before, `${before} → ${scaled}`);
const autoOn = await p.evaluate(() => document.body.innerText.includes('范围改动后自动重算航线'));
ok('自动重算开关可见', autoOn);

console.log('\n[4] 切换类型不丢图形（面保留，直接重算）');
await clickText('正射航线');
await p.waitForTimeout(800);
const switched = await p.evaluate(() => ({
  text: document.body.innerText,
  handles: document.querySelectorAll('.plan-handle').length,
}));
const m2 = switched.text.match(/已选 (\d+) 点/);
ok('切换正射后顶点保留', !!m2 && Number(m2[1]) >= 2, m2 ? m2[1] + ' 点' : '未匹配');
ok('顶点手柄仍在（面可继续拖拽）', switched.handles > 0, `${switched.handles} 个`);
ok('作业参数含「地面分辨率」（GSD 驱动航高）', switched.text.includes('地面分辨率'));
ok('作业参数含「云台俯仰」（倾斜摄影）', switched.text.includes('云台俯仰'));

await p.screenshot({ path: shot, fullPage: false });
console.log(`\n  截图：${shot}`);

console.log('\n[5] 控制台');
const realErrs = errs.filter((t) => !/favicon|net::ERR_/i.test(t));
ok('无控制台错误', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

await b.close();
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
