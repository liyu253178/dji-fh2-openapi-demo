/**
 * 图斑「具体地址」自动匹配验收：自动带出 / 手动改写 / 重新匹配
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

const b = await chromium.launch({
  executablePath: chromePath,
  headless: true,
});
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
const reqs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
p.on('request', (r) => {
  if (r.url().includes('/reverse-geocode')) reqs.push(r.url());
});

// 取第一个「有影像」的架次：地址匹配的前提是影像带 GPS
const taskUuid = await p.evaluate(async (base) => {
  const j = await fetch(`${base}/api/asset/tasks?pageSize=50`).then((r) => r.json());
  const list = j?.data?.list || j?.data?.items || [];
  const hit = list.find((t) => (t.imageCount || 0) > 0);
  return hit ? hit.taskUuid || hit.uuid : '';
}, BASE);
if (!taskUuid) {
  console.log('⏭  跳过：当前没有可用于验证的影像架次');
  process.exit(0);
}
console.log(`  使用架次 ${taskUuid.slice(0, 8)}…`);

await p.goto(`${BASE}/review/task/${taskUuid}`, { waitUntil: 'networkidle', timeout: 40000 });
await p.waitForTimeout(3500);

// 必须先在图上左键拖拽框选，否则 openForm 会提示「请先框选」而不开表单
const box = await p.evaluate(() => {
  const el = document.querySelector('.viewer') || document.querySelector('.mid') || null;
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
});
ok('找到框选区', !!box && box.w > 50 && box.h > 50, JSON.stringify(box));
await p.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
await p.mouse.down();
await p.mouse.move(box.x + box.w * 0.55, box.y + box.h * 0.55, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(1500);

const opened = await p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.includes('保存为图斑'));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
ok('可打开图斑表单', opened);
await p.waitForTimeout(3000);

const dlg = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  if (!el) return null;
  const items = Array.from(el.querySelectorAll('.el-form-item'));
  const addrItem = items.find((x) => x.innerText.includes('具体地址'));
  const input = addrItem ? addrItem.querySelector('input') : null;
  const btns = addrItem ? Array.from(addrItem.querySelectorAll('button')).map((x) => x.innerText.trim()) : [];
  return {
    hasAddr: !!addrItem,
    value: input ? input.value : '',
    btns,
    text: addrItem ? addrItem.innerText.replace(/\s+/g, ' ').trim() : '',
    // 坐标是否已带出（匹配的前提）
    coord: (() => {
      const ci = items.find((x) => x.innerText.includes('坐标'));
      const ins = ci ? Array.from(ci.querySelectorAll('input')) : [];
      return ins.map((i) => i.value);
    })(),
    adminRegion: (() => {
      const ri = items.find((x) => x.innerText.includes('行政区'));
      const i = ri ? ri.querySelector('input') : null;
      return i ? i.value : '';
    })(),
  };
});

ok('表单含「具体地址」项', dlg && dlg.hasAddr, dlg ? dlg.text.slice(0, 60) : 'no dialog');
ok('坐标已自动带出', dlg && dlg.coord.length >= 2 && !!dlg.coord[0] && !!dlg.coord[1], JSON.stringify(dlg && dlg.coord));
ok('地址已自动匹配并填入', dlg && dlg.value.length > 5, JSON.stringify(dlg && dlg.value));
ok('地址带出了区/街道级信息', dlg && /区|县|市/.test(dlg.value), dlg && dlg.value);
ok('有「重新匹配」按钮', dlg && dlg.btns.some((t) => t.includes('重新匹配')), JSON.stringify(dlg && dlg.btns));
ok('来源提示为自动匹配', dlg && dlg.text.includes('自动匹配'), dlg && dlg.text.slice(0, 120));
ok('行政区被顺手带上', dlg && dlg.adminRegion.length > 0, JSON.stringify(dlg && dlg.adminRegion));
ok('确实调用了逆地理接口', reqs.length > 0, reqs.slice(0, 1).join(','));

// 手动改写：source 应变成「人工填写」
const edited = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const items = Array.from(el.querySelectorAll('.el-form-item'));
  const addrItem = items.find((x) => x.innerText.includes('具体地址'));
  const input = addrItem.querySelector('input');
  input.value = '广东省广州市黄埔区穗东街道庙头北路 801 号旁空地（人工核实）';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
});
await p.waitForTimeout(800);
const after = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const items = Array.from(el.querySelectorAll('.el-form-item'));
  const addrItem = items.find((x) => x.innerText.includes('具体地址'));
  return {
    value: addrItem.querySelector('input').value,
    text: addrItem.innerText.replace(/\s+/g, ' ').trim(),
  };
});
ok('地址可手动改写', edited && after.value.includes('人工核实'), after.value);
ok('改写后来源标记为人工填写', after.text.includes('人工填写'), after.text.slice(0, 120));

// 点「重新匹配」：应重新请求并把地址刷回自动结果（force 覆盖手改）
const nBefore = reqs.length;
await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const items = Array.from(el.querySelectorAll('.el-form-item'));
  const addrItem = items.find((x) => x.innerText.includes('具体地址'));
  const btn = Array.from(addrItem.querySelectorAll('button')).find((x) => x.innerText.includes('重新匹配'));
  btn.click();
});
await p.waitForTimeout(3000);
const afterRe = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const items = Array.from(el.querySelectorAll('.el-form-item'));
  const addrItem = items.find((x) => x.innerText.includes('具体地址'));
  return {
    value: addrItem.querySelector('input').value,
    text: addrItem.innerText.replace(/\s+/g, ' ').trim(),
  };
});
ok('重新匹配触发了新请求', reqs.length > nBefore, `${nBefore} → ${reqs.length}`);
ok('重新匹配覆盖手改值', !afterRe.value.includes('人工核实'), afterRe.value);
ok('重新匹配后来源回到自动匹配', afterRe.text.includes('自动匹配'), afterRe.text.slice(0, 120));

ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await b.close();
console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
