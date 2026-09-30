/**
 * 草稿派发链路验收：工单列表「去派发」→ 选派发对象 → 确认发送 → 对象落到工单上
 *
 * 正确流程是「审核影像 → 发现问题 → 生成工单草稿 → 在草稿里选派发对象再派发」。
 * 本脚本用一张真实草稿工单走完整 UI 路径，断言：
 *   1. 未选对象的草稿行按钮是「去派发」，点击后弹的是派发对话框（不是直接发）
 *   2. 选择派发对象并确认后，PUT /tickets/:id/recipient 带上对象，工单记录到 recipientId
 *   3. POST /tickets/:id/send 入队成功（收件邮箱来自所选对象）
 *   4. 刷新后该行按钮变成「发送」，且列表不再显示「未选择派发对象」
 *   5. 结束时把测试数据还原（对象清空、状态回草稿、删掉本次队列与留痕）
 *
 * 依赖：playwright-core + 系统 Chrome；找不到就跳过（退出码 0）。
 */
const fs0 = await import('node:fs');
const { execFileSync } = await import('node:child_process');
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
const DB = '/Users/candice/WorkBuddy/2026-09-29-13-15-12/dji-fh2-openapi-demo/server/data/duav.db';
/** 代理会让 Node fetch 打不到本机：接口一律走 curl --noproxy */
const jget = (u) =>
  JSON.parse(execFileSync('curl', ['-s', '--noproxy', '*', '-m', '20', u], { encoding: 'utf8' }));

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

// 找一张「草稿且未选派发对象」的工单作为测试对象
const listJson = jget(`${BASE}/api/tickets?status=draft&pageSize=50`);
const target = (listJson?.data?.list || []).find((t) => !t.recipientId);
if (!target) {
  console.log('⏭  跳过：没有可用于验证的草稿工单（请在审核工作台生成一张）');
  process.exit(0);
}
const recipients = jget(`${BASE}/api/recipients`)?.data || [];
if (!recipients.length) {
  console.log('⏭  跳过：尚未配置派发对象');
  process.exit(0);
}
console.log(`  用草稿工单 ${target.ticketNo}（id=${target.id}）验证派发链路`);

const b = await chromium.launch({ executablePath: chromePath, headless: true });
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
const net = [];
p.on('response', (r) => {
  const m = r.request().method();
  if (!['PUT', 'POST'].includes(m)) return;
  if (!/\/api\/tickets\/\d+\/(recipient|send)/.test(r.url())) return;
  net.push({ url: r.url(), method: m });
});

await p.goto(`${BASE}/tickets?status=draft`, { waitUntil: 'networkidle', timeout: 40000 });
await p.waitForSelector('.el-table__row', { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(1200);

// 1) 定位目标工单所在行，点「去派发」
const rowIdx = await p.evaluate((no) => {
  const rows = Array.from(document.querySelectorAll('.el-table__row'));
  return rows.findIndex((r) => r.innerText.includes(no));
}, target.ticketNo);
ok('列表能定位到目标草稿工单', rowIdx >= 0, `rowIdx=${rowIdx}`);

const clickedDispatch = await p.evaluate((no) => {
  const row = Array.from(document.querySelectorAll('.el-table__row')).find((r) => r.innerText.includes(no));
  const btn = Array.from(row?.querySelectorAll('button') || []).find((x) => x.innerText.includes('去派发'));
  if (!btn) return false;
  btn.click();
  return true;
}, target.ticketNo);
ok('点到「去派发」', clickedDispatch);
await p.waitForSelector('.el-dialog', { timeout: 10000 });
await p.waitForTimeout(900);

const dlgText = await p.evaluate(() => document.querySelector('.el-dialog')?.innerText || '');
ok('弹出的派发框显示工单号', dlgText.includes(target.ticketNo), dlgText.slice(0, 60).replace(/\n/g, ' / '));
ok('未点确认前不会入队（尚无 /send 请求）', net.length === 0, JSON.stringify(net));

// 2) 选派发对象（真实鼠标点中下拉 + 键盘选首项）
const selPt = await p.evaluate(() => {
  const dlg = document.querySelector('.el-dialog');
  const it = Array.from(dlg.querySelectorAll('.el-form-item')).find((x) => x.innerText.includes('收件对象'));
  const sel = it?.querySelector('.el-select');
  if (!sel) return null;
  const r = sel.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
ok('能定位到收件对象下拉', !!selPt);
await p.mouse.click(selPt.x, selPt.y);
await p.waitForTimeout(700);
await p.keyboard.press('ArrowDown');
await p.waitForTimeout(300);
await p.keyboard.press('Enter');
await p.waitForTimeout(700);

// 3) 确认发送
const sent = await p.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('.el-dialog button'));
  const btn = btns.find((x) => x.innerText.includes('确认发送'));
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
});
ok('「确认发送」可点击', sent);
await p.waitForTimeout(3500);

const after = jget(`${BASE}/api/tickets/${target.id}`)?.data?.ticket || {};
ok('派发对象已写入工单', !!after.recipientId, `recipientId=${after.recipientId}`);
ok('走到了 setRecipient 接口', net.some((x) => x.url.includes('/recipient')), JSON.stringify(net));
ok('走到了 send 入队接口', net.some((x) => x.url.includes('/send')), JSON.stringify(net));

const doneDlg = await p.evaluate(() => document.querySelector('.el-dialog')?.innerText || '');
ok('弹窗显示已进入发送队列', doneDlg.includes('已进入发送队列'), doneDlg.slice(0, 60).replace(/\n/g, ' / '));

// 4) 关掉弹窗，刷新列表：这一行的按钮应变成「发送」
await p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('.el-dialog button')).find((x) => x.innerText.trim() === '确定');
  if (btn) btn.click();
});
await p.waitForTimeout(600);
await p.goto(`${BASE}/tickets?status=draft`, { waitUntil: 'networkidle', timeout: 40000 });
await p.waitForSelector('.el-table__row', { timeout: 20000 }).catch(() => {});
await p.waitForTimeout(1200);
const rowBtns = await p.evaluate((no) => {
  const row = Array.from(document.querySelectorAll('.el-table__row')).find((r) => r.innerText.includes(no));
  if (!row) return { btns: [], text: '' };
  return {
    btns: Array.from(row.querySelectorAll('button')).map((x) => x.innerText.trim()),
    text: row.innerText.replace(/\n/g, ' / '),
  };
}, target.ticketNo);
const latest = jget(`${BASE}/api/tickets/${target.id}`)?.data?.ticket || {};
if (latest.status === 'dispatched') {
  // 邮件已发出：邮件成功才转已派发（mailer 里 draft → dispatched）
  ok('派发完成后状态为已派发', latest.status === 'dispatched', `status=${latest.status}`);
  ok('已派发行不再有派发入口', !rowBtns.btns.includes('去派发') && !rowBtns.btns.includes('发送'), JSON.stringify(rowBtns.btns));
  ok('列表该行标签显示已派发', rowBtns.text.includes('已派发'), rowBtns.text.slice(0, 80));
} else {
  // 邮件还在队列或失败：仍应是草稿，且给「发送」让人工重试（而不是消失）
  ok('邮件未发出时仍是草稿', latest.status === 'draft', `status=${latest.status}`);
  ok('已选对象的草稿行按钮变为「发送」', rowBtns.btns.includes('发送'), JSON.stringify(rowBtns.btns));
}
ok('行内不再显示「未选择派发对象」', !rowBtns.text.includes('未选择派发对象'), rowBtns.text.slice(0, 100));

ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));
await b.close();

// 5) 还原测试数据：清空对象、回草稿、删掉本次队列与留痕
let reset = '';
try {
  const Database = (await import('/Users/candice/WorkBuddy/2026-09-29-13-15-12/dji-fh2-openapi-demo/server/node_modules/better-sqlite3/lib/index.js')).default;
  const db = new Database(DB);
  db.prepare('UPDATE ticket SET status=?, recipient_id=NULL, mail_status=?, dispatched_at=NULL WHERE id=?')
    .run('draft', 'none', target.id);
  db.prepare('DELETE FROM mail_queue WHERE ticket_id = ?').run(target.id);
  db.prepare('DELETE FROM ticket_log WHERE ticket_id = ? AND remark IN (?)')
    .run(target.id, '邮件发送成功');
  db.prepare("DELETE FROM ticket_log WHERE ticket_id = ? AND created_at > datetime('now', '-5 minutes')").run(target.id);
  db.close();
  reset = `（已还原 ${target.ticketNo}）`;
} catch (e) {
  reset = `（还原失败，请手工处理 ${target.ticketNo}：${e.message}）`;
}

console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败 ' + reset);
process.exit(fail ? 1 : 0);
