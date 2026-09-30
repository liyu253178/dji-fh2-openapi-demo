/**
 * 派发门槛验收：位置描述 / 估算面积留空时，仍应能保存图斑并生成工单
 *
 * 背景：位置描述改选填后，派单侧（ticketRepo.createFromPatch）仍在强制位置描述
 * 与 require_area 面积，UI 上表现为「请先填写位置描述」。本脚本走真实 UI 路径
 * 复现用户操作，断言两道门槛都已撤掉。
 *
 * 依赖：playwright-core + 系统 Chrome；找不到就跳过（退出码 0）。
 * 会真实创建 1 个图斑 + 1 张工单，结束后从库里清理掉，不留脏数据。
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
// 收集所有轻提示文案（Element Plus 的 message 默认 3 秒后消失，轮询兜住）
await p.addInitScript(() => {
  window.__toasts = [];
  setInterval(() => {
    document.querySelectorAll('.el-message, .el-message-box').forEach((el) => {
      const t = (el.innerText || '').trim();
      if (t && !window.__toasts.includes(t)) window.__toasts.push(t);
    });
  }, 150);
});
// 收集写接口的返回（POST /api/review/patches、POST /api/tickets）
const net = [];
p.on('response', async (r) => {
  if (r.request().method() !== 'POST') return;
  if (!/\/api\/(review\/patches|tickets)(\?|$)/.test(r.url())) return;
  let body = null;
  try {
    body = await r.json();
  } catch { /* 忽略非 JSON */ }
  net.push({ url: r.url(), status: r.status(), body });
});

const taskUuid = await p.evaluate(async (base) => {
  const j = await fetch(`${base}/api/asset/tasks?pageSize=100`).then((r) => r.json());
  const list = j?.data?.list || [];
  const hit = list.find((t) => (t.imageCount || 0) > 0);
  return hit ? hit.taskUuid : '';
}, BASE);
if (!taskUuid) {
  console.log('⏭  跳过：当前没有可用于验证的影像架次');
  await b.close();
  process.exit(0);
}

await p.goto(`${BASE}/review/task/${taskUuid}`, { waitUntil: 'networkidle', timeout: 40000 });
await p.waitForSelector('.thumbs .thumb', { timeout: 30000 });
await p.waitForTimeout(2000);

// 1) 拖拽框选
const box = await p.evaluate(() => {
  const el = document.querySelector('.viewer');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
ok('找到影像框选区', !!box && box.w > 50 && box.h > 50);
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
await p.waitForSelector('.el-dialog .el-form', { timeout: 10000 });
await p.waitForTimeout(1200);

/**
 * 在指定 label 的下拉里选第一项。
 * 用真实鼠标点中下拉再走键盘，避免点到页面上其它残留浮层（项目切换等）。
 */
async function pickFirst(itemKeyword) {
  const pt = await p.evaluate((kw) => {
    const dlg = document.querySelector('.el-dialog');
    const it = Array.from(dlg.querySelectorAll('.el-form-item')).find((x) => x.innerText.includes(kw));
    const sel = it?.querySelector('.el-select');
    if (!sel) return null;
    const r = sel.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, itemKeyword);
  if (!pt) return '';
  await p.mouse.click(pt.x, pt.y);
  await p.waitForTimeout(700);
  await p.keyboard.press('ArrowDown');
  await p.waitForTimeout(300);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  return p.evaluate((kw) => {
    const dlg = document.querySelector('.el-dialog');
    const it = Array.from(dlg.querySelectorAll('.el-form-item')).find((x) => x.innerText.includes(kw));
    return it?.querySelector('input')?.value || '';
  }, itemKeyword);
}

// 2) 选问题类型
await pickFirst('问题类型');
const titleAfter = await p.evaluate(() => {
  const dlg = document.querySelector('.el-dialog');
  const it = Array.from(dlg.querySelectorAll('.el-form-item')).find((x) => x.innerText.includes('标题'));
  return it?.querySelector('input')?.value || '';
});
// 选不到类型时标题不会自动生成，用它反推选择是否生效
ok('能选到问题类型（标题已自动生成）', titleAfter.length > 0, `标题=${titleAfter}`);
await p.waitForTimeout(2600); // 等逆地理把行政区带出来

// 3) 确保位置描述为空；行政区为空时补一个（它不是本次要验的门槛）
const formState = await p.evaluate(() => {
  const dlg = document.querySelector('.el-dialog');
  const items = Array.from(dlg.querySelectorAll('.el-form-item'));
  const find = (kw) => items.find((x) => x.innerText.includes(kw));
  const setVal = (item, v) => {
    const input = item?.querySelector('input');
    if (!input) return false;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  const pos = find('位置描述');
  const posEl = pos?.querySelector('input, textarea');
  if (posEl) {
    posEl.value = '';
    posEl.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const region = find('行政区');
  const regionVal = region?.querySelector('input')?.value || '';
  if (!regionVal) setVal(region, '验收街道');
  const land = find('当前地类');
  const landRequired = land ? land.classList.contains('is-required') : false;
  return {
    posValue: posEl ? posEl.value : null,
    posRequired: pos ? pos.classList.contains('is-required') : null,
    regionValue: regionVal || '验收街道',
    landRequired,
  };
});
ok('位置描述保持为空', formState.posValue === '', JSON.stringify(formState.posValue));
ok('位置描述非必填', formState.posRequired === false, `posRequired=${formState.posRequired}`);

// 若该类型强制地类，补选第一项（与本次门槛无关，只为保证能提交）
if (formState.landRequired) await pickFirst('当前地类');

// 4) 保存并生成工单
const clicked = await p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.el-dialog button')).find((x) =>
    x.innerText.includes('保存并生成工单'),
  );
  if (!btn) return false;
  btn.click();
  return true;
});
ok('点到「保存并生成工单」', clicked);
await p.waitForTimeout(5000);

const toasts = await p.evaluate(() => window.__toasts || []);
const joined = toasts.join(' | ');

const s = (x) => String(JSON.stringify(x) ?? '').slice(0, 160);
if (process.env.DEBUG_GATE) {
  console.log('  · 提示：' + toasts.join(' | '));
  console.log('  · 写请求：' + (net.map((x) => x.url + ' ' + x.status).join(' , ') || '（无）'));
  const dbg = await p.evaluate(() => {
    const dlg = document.querySelector('.el-dialog');
    if (!dlg) return { gone: true };
    return {
      errs: Array.from(dlg.querySelectorAll('.el-form-item__error')).map((x) => x.innerText),
      text: dlg.innerText.replace(/\n+/g, ' / ').slice(0, 500),
    };
  });
  console.log('  · 表单：' + JSON.stringify(dbg));
}
const patchRes = net.find((x) => x.url.includes('/api/review/patches'));
const ticketRes = net.find((x) => x.url.includes('/api/tickets'));
// 接口返回 { code: 0 } 表示成功（ok 是 api 层包装出来的字段）
const patchOk = patchRes?.body?.code === 0 && !!patchRes?.body?.data?.patchId;
const ticketOk = ticketRes?.body?.code === 0 && !!ticketRes?.body?.data?.ticketId;
ok('图斑保存成功', patchOk, s(patchRes?.body) || '未捕获到 POST /api/review/patches');
ok('工单创建成功（未被拦下）', ticketOk, s(ticketRes?.body) || '未捕获到 POST /api/tickets');
ok('提示为「已创建」', joined.includes('已创建'), joined.slice(0, 120));
ok('不再提示「请先填写位置描述」', !joined.includes('位置描述'), joined.slice(0, 160));
ok('不再提示「面积」相关拦截', !joined.includes('面积'), joined.slice(0, 160));
ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await b.close();

// 5) 清理本次产生的图斑与工单，避免污染演示数据
const patchId = patchRes?.body?.data?.patchId || 0;
const ticketId = ticketRes?.body?.data?.ticketId || 0;
let cleaned = '';
if (patchId || ticketId) {
  try {
    const Database = (await import('/Users/candice/WorkBuddy/2026-09-29-13-15-12/dji-fh2-openapi-demo/server/node_modules/better-sqlite3/lib/index.js')).default;
    const db = new Database('/Users/candice/WorkBuddy/2026-09-29-13-15-12/dji-fh2-openapi-demo/server/data/duav.db');
    if (ticketId) {
      db.prepare('DELETE FROM mail_queue WHERE ticket_id = ?').run(ticketId);
      db.prepare('DELETE FROM ticket_log WHERE ticket_id = ?').run(ticketId);
      db.prepare('DELETE FROM ticket WHERE id = ?').run(ticketId);
    }
    if (patchId) {
      db.prepare('DELETE FROM patch_image WHERE patch_id = ?').run(patchId);
      db.prepare('DELETE FROM patch WHERE id = ?').run(patchId);
    }
    db.close();
    cleaned = `（已清理 patch=${patchId} ticket=${ticketId}）`;
  } catch (e) {
    cleaned = `（清理失败，请手工删除 patch=${patchId} ticket=${ticketId}：${e.message}）`;
  }
}

console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败 ' + cleaned);
process.exit(fail ? 1 : 0);
