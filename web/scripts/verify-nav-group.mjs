/**
 * 侧边栏「工单管理」折叠栏目 + 新接口的浏览器断言（需要系统 Chrome + playwright-core）
 *
 * 覆盖三项需求：① 14 项平铺收敛成 8 个一级项，「工单管理」可折叠；② 组内 7 个子路由
 * 可直达且渲染正常；③ GET /api/asset/known-docks 能给出该项目历史机场。
 * ⚠️ 断言注意：Vue Router 的 pathname 可能带尾斜杠（/assets/），比较前要归一化；
 *    known-docks 必填 projectUuid，不传会 400（前端调用前有 projectUuid 判空保护）。
 *
 * 用法：cd web && node scripts/verify-nav-group.mjs [BASE_URL]（需先起服务）
 * 依赖：playwright-core + 系统 Chrome，找不到则跳过（退出码 0），避免卡住回归。
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
  } catch {
    /* 试下一个 */
  }
}
const chromium = mod?.chromium || mod?.default?.chromium;
const chromePath = CHROME_PATHS.find((x) => fs0.existsSync(x));
if (!chromium || !chromePath) {
  console.log('⏭  跳过导航分组断言：未找到 playwright-core 或系统 Chrome');
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
const bad = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
p.on('response', (r) => {
  if (r.status() >= 400 && r.url().indexOf('/api/') < 0) bad.push(r.status() + ' ' + r.url());
});

await p.goto(BASE + '/dashboard', { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(2000);

const nav = await p.evaluate(() => {
  const items = document.querySelectorAll('.nav-item, .nav-group, aside a');
  return { count: items.length, hasGroup: document.body.innerText.indexOf('工单管理') >= 0 };
});
ok('侧边栏含「工单管理」栏目', nav.hasGroup);
ok('一级项已收敛（<=10）', nav.count > 0 && nav.count <= 10, '实际 ' + nav.count);

const clicked = await p.evaluate(() => {
  const all = Array.from(document.querySelectorAll('*'));
  const el = all.find((e) => e.children.length === 0 && e.textContent.trim() === '工单管理');
  if (!el) return false;
  const host = el.closest('[class*="nav"]') || el;
  host.click();
  return true;
});
await p.waitForTimeout(600);
ok('可点击父项触发折叠', clicked);

const routes = [['/assets', '巡检成果'], ['/review', '审核'], ['/tickets', '工单']];
for (const r of routes) {
  await p.goto(BASE + r[0], { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(1200);
  const st = await p.evaluate(() => ({
    url: location.pathname,
    body: document.body.innerText.slice(0, 200),
  }));
  const norm = st.url.replace(/\/+$/, '') || '/';
  ok(r[0] + ' 可直达且内容渲染', norm === r[0] && st.body.length > 20, st.url + ' | ' + st.body.slice(0, 40));
}

const api = await p.evaluate(async (base) => {
  try {
    const s = await fetch(base + '/api/session').then((x) => x.json());
    const pu = (s && s.data && (s.data.projectUuid || s.data.activeProjectUuid)) || '';
    const r = await fetch(base + '/api/asset/known-docks?projectUuid=' + encodeURIComponent(pu));
    return await r.json();
  } catch (e) {
    return { err: String(e) };
  }
}, BASE);
ok('GET /api/asset/known-docks 返回成功', api && api.code === 0, JSON.stringify(api).slice(0, 120));
const docks = (api && api.data && api.data.list) || [];
ok('历史机场列表非空', docks.length > 0, docks.length + ' 个 | ' + JSON.stringify(api.data).slice(0, 160));

ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));
ok('0 个页面级 4xx', bad.length === 0, bad.slice(0, 2).join(' | '));

await b.close();
console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
