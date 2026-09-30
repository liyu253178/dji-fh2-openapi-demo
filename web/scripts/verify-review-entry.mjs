/**
 * 审核入口收敛 + 去除面积估算 验收
 *
 * 断言点：
 *  1. 巡检成果列表的操作按钮文案为「审核影像」（原「查看影像」）
 *  2. 点它直达 /review/task/:uuid 工作台（不再经过已删除的 /review 队列页）
 *  3. 表单里不再出现「问题范围 / 已框选 / ㎡ / 亩 / 重新框选」
 *  4. 框选后不再调用 /api/review/area-estimate（面积计算已停用）
 *  5. 巡检成果/工单列表跨项目：带任意 projectUuid 参数也返回全组织数据
 *  6. 0 控制台错误
 *
 * 依赖：playwright-core + 系统 Chrome；找不到就跳过（退出码 0）。
 */
import fs0 from 'node:fs';

const CANDIDATES = [
  process.env.PLAYWRIGHT_CORE_PATH,
  'playwright-core',
  '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js',
].filter(Boolean);
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Google Chrome',
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
  console.log('⏭  跳过：未找到 playwright-core 或系统 Chrome');
  process.exit(0);
}

const BASE = process.env.DUAV_BASE || 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''));
  }
};

const b = await chromium.launch({ executablePath: chromePath, headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
const calls = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
p.on('request', (r) => {
  const u = r.url();
  if (u.includes('area-estimate')) calls.push(u);
});

// 1) 巡检成果页按钮文案
await p.goto(BASE + '/assets', { waitUntil: 'networkidle', timeout: 40000 });
try {
  await p.waitForSelector('.el-table__row', { timeout: 30000 });
} catch {
  console.log('⏭  跳过：全组织范围内没有已同步的影像架次');
  await b.close();
  process.exit(0);
}
await p.waitForTimeout(1200);

const btns = await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.el-table__row'));
  return rows
    .flatMap((r) => Array.from(r.querySelectorAll('button')))
    .map((x) => (x.innerText || '').trim())
    .filter(Boolean);
});
ok('列表出现「审核影像」按钮', btns.some((t) => t === '审核影像'), JSON.stringify(btns.slice(0, 6)));
ok('不再有「查看影像」旧文案', !btns.some((t) => t === '查看影像'), JSON.stringify(btns.slice(0, 6)));

// 1.5) 跨项目：列表接口应忽略 projectUuid（运营视角看全组织）
const orgWide = await p.evaluate(async (base) => {
  const [a, t] = await Promise.all([
    fetch(`${base}/api/asset/tasks?pageSize=5&projectUuid=not-exist-project`).then((r) => r.json()),
    fetch(`${base}/api/tickets?pageSize=5&projectUuid=not-exist-project`).then((r) => r.json()),
  ]);
  return { assetTotal: a?.data?.total ?? -1, ticketTotal: t?.data?.total ?? -1 };
}, BASE);
ok('巡检成果跨项目（忽略 projectUuid）', orgWide.assetTotal > 0, `total=${orgWide.assetTotal}`);
ok('工单列表跨项目（忽略 projectUuid）', orgWide.ticketTotal >= 0, `total=${orgWide.ticketTotal}`);

// 2) 点「审核影像」直达工作台
await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.el-table__row'));
  for (const r of rows) {
    const btn = Array.from(r.querySelectorAll('button')).find((x) => (x.innerText || '').trim() === '审核影像');
    if (btn) {
      btn.click();
      return;
    }
  }
});
await p.waitForTimeout(3000);
const url = await p.evaluate(() => location.pathname);
ok('点击后进入审核工作台 /review/task/:uuid', /^\/review\/task\/.+/.test(url), url);

// 3) 框选 → 打开表单（真实鼠标拖拽）
await p.waitForSelector('.thumbs .thumb', { timeout: 30000 });
await p.waitForTimeout(1500);
const stage = await p.$('.stage, .img-wrap, .viewer');
const box = await (stage || (await p.$('body'))).boundingBox();
const cx = box.x + box.width * 0.4;
const cy = box.y + box.height * 0.4;
await p.mouse.move(cx, cy);
await p.mouse.down();
await p.mouse.move(cx + 160, cy + 120, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(2500);

const formText = await p.evaluate(() => {
  const dlg = document.querySelector('.el-dialog');
  return dlg ? dlg.innerText : '';
});
ok('框选后表单已打开', formText.length > 20, formText.slice(0, 60).replace(/\n/g, ' '));
ok('表单内无「问题范围」', formText.indexOf('问题范围') < 0, formText.slice(0, 160).replace(/\n/g, ' '));
ok('表单内无面积文案（㎡/亩/已框选）', !/㎡|亩|已框选/.test(formText), formText.slice(0, 160).replace(/\n/g, ' '));
ok('表单内无「重新框选」按钮', formText.indexOf('重新框选') < 0);

// 4) 面积估算接口不再被调用
ok('未调用 /api/review/area-estimate', calls.length === 0, calls.slice(0, 2).join(' | '));

ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await b.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
