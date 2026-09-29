/**
 * 全景查看器验收：全景图自动进球面模式（拖拽转动 + 平面切换），普通图不受影响
 *
 * 依赖：playwright-core + 系统 Chrome；找不到就跳过（退出码 0），避免卡住回归。
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
// 任务 UUID 运行时从接口取，不写死在源码里（仓库里不留设备 SN / 任务 UUID）
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
const bad = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
p.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/api/')) bad.push(`${r.status()} ${r.url()}`);
});

// ① 动态找一个含全景图（宽高比 ≥ 1.9）的架次
const tasks = await p.evaluate(async (base) => {
  const r = await fetch(`${base}/api/asset/tasks?pageSize=100`);
  const j = await r.json();
  return (j.data?.list || j.data?.items || []).filter((t) => (t.imageCount || 0) > 0);
}, BASE);
ok('能取到含影像的架次', tasks.length > 0, String(tasks.length));

let taskUuid = '';
let panoId = 0;
let flatId = 0;
for (const t of tasks.slice(0, 30)) {
  const r = await p.evaluate(async (u) => {
    const rr = await fetch(`${u.base}/api/asset/tasks/${u.uuid}/images`);
    const jj = await rr.json();
    return ((jj.data && jj.data.list) || []).map((x) => x.id);
  }, { base: BASE, uuid: t.taskUuid });
  // 在页面里逐个量宽高比，分别找全景图与普通图
  const dimOf = async (id) =>
    p.evaluate(async (url) => {
      const d = await new Promise((res) => {
        const im = new Image();
        im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res(null);
        im.src = url;
      });
      return d && d.h > 0 ? d.w / d.h : 0;
    }, `${BASE}/api/asset/images/${id}/file`);
  let pano = 0;
  let flat = 0;
  for (const id of r) {
    const ratio = await dimOf(id);
    if (ratio >= 1.9 && !pano) pano = id;
    if (ratio > 0 && ratio < 1.9 && !flat) flat = id;
    if (pano && flat) break;
  }
  if (pano && flat) {
    taskUuid = t.taskUuid;
    panoId = pano;
    flatId = flat;
    break;
  }
}
ok('找到同时含全景图与普通图的架次', !!taskUuid && !!panoId && !!flatId, `task=${taskUuid} pano=${panoId} flat=${flatId}`);
if (!taskUuid) {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败（库中暂无全景图，无法验收）`);
  await b.close();
  process.exit(0);
}

// ② 打开该架次审核页，点击全景图缩略图
await p.goto(`${BASE}/review/task/${taskUuid}`, { waitUntil: 'networkidle', timeout: 40000 });
await p.waitForSelector('.thumbs .thumb', { timeout: 30000 });
await p.waitForTimeout(1500);

const clicked = await p.evaluate((pid) => {
  const thumbs = [...document.querySelectorAll('.thumbs .thumb')];
  const target = thumbs.find((el) => el.innerHTML.includes(`images/${pid}/`) || el.dataset?.id === String(pid));
  if (target) {
    target.click();
    return true;
  }
  // 兜底：按顺序点，找不到精确匹配就全点一遍
  return false;
}, panoId);
ok('能点中全景图缩略图', clicked);

// 若精确点击失败则逐个点直到出现模式按钮
let found = await p.evaluate(() => !!document.querySelector('.mode-toggle'));
if (!found) {
  const n = await p.evaluate(() => document.querySelectorAll('.thumbs .thumb').length);
  for (let i = 0; i < n && !found; i++) {
    await p.evaluate((k) => {
      document.querySelectorAll('.thumbs .thumb')[k]?.click();
    }, i);
    await p.waitForTimeout(900);
    found = await p.evaluate(() => !!document.querySelector('.mode-toggle'));
  }
}
ok('全景图出现「平面模式」切换按钮', found);

// ③ 球面渲染：canvas 存在且有尺寸
const canvas = await p.evaluate(() => {
  const c = document.querySelector('.pano canvas');
  return c ? { w: c.width, h: c.height } : null;
});
ok('WebGL 全景 canvas 已渲染', !!canvas && canvas.w > 100 && canvas.h > 100, JSON.stringify(canvas));

// ④ 平面图的查看器不应有全景按钮
await p.evaluate((fid) => {
  const thumbs = [...document.querySelectorAll('.thumbs .thumb')];
  const target = thumbs.find((el) => el.innerHTML.includes(`images/${fid}/`) || el.dataset?.id === String(fid));
  (target || thumbs[0])?.click();
}, flatId);
await p.waitForTimeout(1200);
const flatNoToggle = await p.evaluate(() => !document.querySelector('.mode-toggle'));
ok('普通图不出现全景切换按钮', flatNoToggle);

// ⑤ 切回全景图 → 点「平面模式」→ stage img 可见，可继续框选
await p.evaluate((pid) => {
  const thumbs = [...document.querySelectorAll('.thumbs .thumb')];
  const target = thumbs.find((el) => el.innerHTML.includes(`images/${pid}/`) || el.dataset?.id === String(pid));
  (target || thumbs[0])?.click();
}, panoId);
await p.waitForTimeout(1200);
await p.evaluate(() => {
  const btn = [...document.querySelectorAll('.mode-toggle')].find((x) => x.innerText.includes('平面'));
  btn?.click();
});
await p.waitForTimeout(600);
const flatMode = await p.evaluate(() => ({
  imgVisible: !!document.querySelector('.viewer .stage img'),
  panoGone: !document.querySelector('.pano'),
  toggleBack: [...document.querySelectorAll('.mode-toggle')].some((x) => x.innerText.includes('全景')),
}));
ok('切平面后原图可见、全景层卸载', flatMode.imgVisible && flatMode.panoGone, JSON.stringify(flatMode));
ok('按钮文案回到「全景模式」', flatMode.toggleBack);

ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));
ok('0 个 API 4xx', bad.length === 0, bad.slice(0, 2).join(' | '));

await b.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
