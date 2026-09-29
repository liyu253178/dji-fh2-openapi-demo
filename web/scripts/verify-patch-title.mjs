/**
 * 图斑表单验收：标题按「街道 + 问题类型」自动生成、位置描述改为选填
 *
 * 依赖：playwright-core + 系统 Chrome；找不到就跳过（退出码 0），避免卡住回归。
 * 只读验证（不保存图斑），不动真实数据。
 */
const fs0 = await import('node:fs');
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
  } catch { /* 试下一个 */ }
}
const chromium = mod?.chromium || mod?.default?.chromium;
const chromePath = CHROME_PATHS.find((x) => fs0.existsSync(x));
if (!chromium || !chromePath) {
  console.log('⏭  跳过：未找到 playwright-core 或系统 Chrome');
  process.exit(0);
}
const BASE = 'http://127.0.0.1:8787';
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
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});

// 取第一个含影像的架次（任务 UUID 运行时取，不写死）
const taskUuid = await p.evaluate(async (base) => {
  const j = await fetch(`${base}/api/asset/tasks?pageSize=100`).then((r) => r.json());
  const list = j?.data?.list || [];
  const hit = list.find((t) => (t.imageCount || 0) > 0);
  return hit ? hit.taskUuid : '';
}, BASE);
if (!taskUuid) {
  console.log('⏭  跳过：当前没有可用于验证的影像架次');
  process.exit(0);
}

await p.goto(`${BASE}/review/task/${taskUuid}`, { waitUntil: 'networkidle', timeout: 40000 });
await p.waitForSelector('.thumbs .thumb', { timeout: 30000 });
await p.waitForTimeout(2000);

// 左键拖拽框选（表单要求先框选）
const box = await p.evaluate(() => {
  const el = document.querySelector('.viewer');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
ok('找到框选区', !!box && box.w > 50 && box.h > 50);
await p.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
await p.mouse.down();
await p.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.55, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(1200);

const opened = await p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.includes('保存为图斑'));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
ok('可打开图斑表单', opened);
await p.waitForTimeout(2500);

// 选择问题类型 → 标题应立即用类型名生成（街道可能还没回来）
const typeName = await p.evaluate(() => {
  const dlg = document.querySelector('.el-dialog');
  const sel = dlg.querySelector('.el-form-item .el-select');
  sel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
});
await p.waitForTimeout(600);
const picked = await p.evaluate(() => {
  const opts = [...document.querySelectorAll('.el-select-dropdown__item')];
  if (!opts.length) return '';
  const want = opts.find((x) => x.innerText.includes('疑似')) || opts[0];
  const name = want.innerText.trim();
  want.click();
  return name;
});
ok('能选到问题类型', !!picked, JSON.stringify(picked));
await p.waitForTimeout(800);

const readForm = () =>
  p.evaluate(() => {
    const dlg = document.querySelector('.el-dialog');
    const items = Array.from(dlg.querySelectorAll('.el-form-item'));
    const titleItem = items.find((x) => x.innerText.includes('标题'));
    const title = titleItem ? titleItem.querySelector('input').value : '';
    const posItem = items.find((x) => x.innerText.includes('位置描述'));
    const posRequired = posItem ? posItem.classList.contains('is-required') : null;
    const regionItem = items.find((x) => x.innerText.includes('行政区'));
    const regionRequired = regionItem ? regionItem.classList.contains('is-required') : null;
    const region = regionItem ? regionItem.querySelector('input').value : '';
    return { title, posRequired, regionRequired, region };
  });

const f1 = await readForm();
ok('选类型后标题自动生成（类型名部分）', f1.title.includes(picked), JSON.stringify(f1.title));

// 等逆地理回来 → 标题应升级为「xx街道 xx问题」，行政区也带上
await p.waitForTimeout(2500);
const f2 = await readForm();
ok('行政区已自动带出', f2.region.length > 0, JSON.stringify(f2.region));
ok('标题为「街道 + 问题类型」格式', /街道 .+/.test(f2.title) && f2.title.includes(picked), JSON.stringify(f2.title));

// 手改标题 → 不再被自动结果覆盖
await p.evaluate(() => {
  const dlg = document.querySelector('.el-dialog');
  const items = Array.from(dlg.querySelectorAll('.el-form-item'));
  const t = items.find((x) => x.innerText.includes('标题'));
  const input = t.querySelector('input');
  input.value = '我的手写标题';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(600);
await p.evaluate(() => {
  const dlg = document.querySelector('.el-dialog');
  const btn = Array.from(dlg.querySelectorAll('.el-form-item .el-select'));
  btn[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await p.waitForTimeout(600);
await p.evaluate(() => {
  const opts = [...document.querySelectorAll('.el-select-dropdown__item:not([style*="display: none"])')];
  const other = opts.find((x) => !x.innerText.includes('疑似')) || opts[1] || opts[0];
  other?.click();
});
await p.waitForTimeout(900);
const f3 = await readForm();
ok('手改标题后不再被自动覆盖', f3.title === '我的手写标题', JSON.stringify(f3.title));

// 位置描述非必选：无红星；行政区仍必选：有红星
ok('位置描述已改为选填（无必选标记）', f3.posRequired === false, `posRequired=${f3.posRequired}`);
ok('行政区仍为必选（保留红星）', f3.regionRequired === true, `regionRequired=${f3.regionRequired}`);

ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await b.close();
console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
