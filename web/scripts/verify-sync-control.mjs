/**
 * 验收「同步弹窗运行态的暂停/继续/终止」+「运行中重新打开弹窗能接着控」
 * 用真实司空数据起一轮只拉元数据的同步（不下载、不删数据），验完即终止。
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
  console.log('⏭  跳过：未找到 playwright-core 或系统 Chrome');
  process.exit(0);
}
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
// 项目与机场运行时从接口取，不写死（仓库里不留项目 UUID / 设备 SN）
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opt) => {
  const r = await fetch(BASE + p, opt);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (p, body) =>
  api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

const fmt = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00:00`;

const session = await api('/api/session');
const PU = session.body?.data?.projectUuid || '';
const docks = (await api(`/api/asset/known-docks?projectUuid=${encodeURIComponent(PU)}`)).body?.data?.list || [];
if (!PU || !docks.length) {
  console.log('⏭  跳过：未获取到项目或机场清单');
  process.exit(0);
}
console.log(`  项目 ${PU.slice(0, 8)}… · ${docks.length} 个机场`);

// 1) 后台起一轮同步（只拉元数据，不落盘不删数据）
const start = await post('/api/asset/sync', {
  projectUuid: PU,
  dockSns: docks.map((d) => d.dockSn),
  beginAt: fmt(new Date(Date.now() - 60 * 86400000)),
  endAt: fmt(new Date()),
  downloadImages: false,
  skipEmptyTasks: false,
});
ok('后台同步已受理', start.body?.code === 0, JSON.stringify(start.body));

// 只拉元数据时 49 个架次约 10 秒跑完，等浏览器打开弹窗再暂停就来不及了。
// 先在 API 层把它挂起（暂停后永不自然结束），再用浏览器验收「打开即运行态 + 终止」。
await sleep(1500);
const paused0 = await post('/api/asset/sync/pause');
ok('API 层暂停成功', paused0.body?.code === 0, JSON.stringify(paused0.body));

const b = await chromium.launch({
  executablePath: chromePath,
  headless: true,
});
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 160));
});

await p.goto(BASE + '/assets', { waitUntil: 'networkidle', timeout: 40000 });
await p.waitForTimeout(2500);
await p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.includes('同步影像'));
  btn?.click();
});
await p.waitForTimeout(2000);

// 2) 同步在跑时打开弹窗：应直接是运行态，而不是配置态
const dlg = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  if (!el) return null;
  const t = el.innerText;
  return {
    text: t,
    isRunning: /已暂停|正在同步|已处理架次/.test(t),
    btns: Array.from(el.querySelectorAll('button')).map((x) => ({ t: x.innerText.trim(), d: x.disabled })),
  };
});
ok('运行中打开弹窗直接进入运行态', dlg && dlg.isRunning, dlg ? dlg.text.slice(0, 100) : 'no dialog');
const btnTexts = (dlg?.btns || []).map((x) => x.t);
ok('暂停态下出现「继续」按钮', btnTexts.includes('继续'), JSON.stringify(btnTexts));
ok('有「终止」按钮', btnTexts.includes('终止'), JSON.stringify(btnTexts));

const afterPause = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const t = el ? el.innerText : '';
  return { pausedUi: t.includes('已暂停'), btns: el ? Array.from(el.querySelectorAll('button')).map((x) => x.innerText.trim()) : [] };
});
ok('界面显示已暂停', afterPause.pausedUi);

const s1 = (await api('/api/asset/sync/status')).body?.data || {};
ok('后端状态为 paused', s1.paused === true, JSON.stringify(s1));
ok('暂停期间 running 仍为 true', s1.running === true, JSON.stringify(s1));

// 3) 点继续 → 恢复
await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const btn = Array.from(el.querySelectorAll('button')).find((x) => x.innerText.trim() === '继续');
  btn?.click();
});
await p.waitForTimeout(1500);
const s2 = (await api('/api/asset/sync/status')).body?.data || {};
ok('后端状态恢复 running', s2.paused === false, JSON.stringify(s2));
const resumedUi = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const t = el ? el.innerText : '';
  return { backToPause: Array.from(el?.querySelectorAll('button') || []).map((x) => x.innerText.trim()).includes('暂停') };
});
ok('继续后按钮回到「暂停」', resumedUi.backToPause);

// 5) 先暂停再终止：只拉元数据时 49 个架次十来秒就跑完了，
//    不暂停的话点「终止」时同步已自然结束，验不到终止分支
await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const btn = Array.from(el.querySelectorAll('button')).find((x) => x.innerText.trim() === '暂停');
  btn?.click();
});
await p.waitForTimeout(1500);
const s3 = (await api('/api/asset/sync/status')).body?.data || {};
ok('终止前处于暂停态', s3.paused === true && s3.running === true, JSON.stringify(s3));

// 6) 点终止 → 进入完成/终止态
await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  const btn = Array.from(el.querySelectorAll('button')).find((x) => x.innerText.trim() === '终止');
  btn?.click();
});
await p.waitForTimeout(3000);
const done = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  return el ? el.innerText.slice(0, 200) : '';
});
ok('终止后显示已终止', done.includes('已终止'), done.slice(0, 120));

// 收尾：确保同步真的停了
for (let i = 0; i < 30; i++) {
  const s = (await api('/api/asset/sync/status')).body?.data || {};
  if (!s.running) break;
  await sleep(1000);
}
const fin = (await api('/api/asset/sync/status')).body?.data || {};
ok('同步最终已停止', fin.running === false, JSON.stringify(fin));
ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await b.close();
console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
