/**
 * 生成 README 用功能截图（docs/screenshots/*.jpg）
 *
 * 用法：
 *   1) 先启动服务（server，端口 8787）
 *   2) node tools/shoot-screenshots.mjs
 *
 * 隐私处理（重要）：截图前先在页面 DOM 内把敏感文本替换掉，再截图——
 * 设备 SN / 客户项目名 / 邮箱 / 手机号 / 精确坐标 / 项目 UUID 都会被遮蔽，
 * 避免截图把客户信息带进仓库。影像缩略图与地图画面保留（它们本身是
 * 「证据链」功能的展示对象）。
 *
 * 依赖：playwright-core + 本机 Chrome；缺任一则跳过并以 0 退出。
 */
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = `${ROOT}/docs/screenshots`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';

if (!existsSync(CHROME) || !existsSync(PW)) {
  console.log('⏭  未找到 Chrome 或 playwright-core，跳过截图生成');
  process.exit(0);
}
const mod = await import(PW);
const chromium = mod.chromium || mod.default.chromium;
mkdirSync(OUT, { recursive: true });

/** 客户项目名（从接口取，动态遮蔽） */
const jget = async (u) => (await fetch(u).then((r) => r.json()).catch(() => null));
const projects = (await jget(`${BASE}/api/session/projects`))?.data?.list || [];
const projectNames = projects.map((p) => p.name).filter(Boolean);
console.log('需遮蔽的项目名:', projectNames.join(' / ') || '(无)');

/** 有影像的架次（审核工作台入口） */
const tasks = (await jget(`${BASE}/api/asset/tasks?pageSize=100`))?.data?.list || [];
const withImages = tasks.find((t) => (t.imageCount || 0) > 0);
const taskUuid = withImages?.taskUuid || '';

/** 有邮件日志的工单（详情页有投递记录） */
const tickets = (await jget(`${BASE}/api/tickets?pageSize=50`))?.data?.list || [];
const dispatched = tickets.find((t) => t.status === 'dispatched') || tickets[0];

/** 页内脱敏：先按标签整行替换（相机 SN 的截断尾号），再走通用规则 */
const scrub = (p) =>
  p.evaluate((projNames) => {
    const LABELS = ['相机 SN', '相机SN', '飞机 SN', '飞机SN', '机场 SN', '机场SN', '设备 SN', '设备SN'];
    document.querySelectorAll('*').forEach((el) => {
      if (el.children.length) return;
      const t = (el.textContent || '').trim();
      if (!t) return;
      for (const lb of LABELS) {
        if (t.startsWith(lb) && t.replace(lb, '').trim().length > 0) {
          el.textContent = lb + '  YOUR_SN';
          break;
        }
      }
    });
    // 注意：规则不要写成 /[A-Z0-9]{4,12}$/ 这类宽匹配，会把 DUAV 之类的正常词一起遮掉
    const RULES = [
      [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'PROJECT-UUID'],
      [/\b[0-9A-Z]{10,20}\b/g, 'YOUR_SN'],
      [/[\w.+-]+@[\w-]+\.[\w.]+/g, 'contact@example.gov.cn'],
      [/\b1[3-9]\d{9}\b/g, '138****0000'],
      [/\b\d{2,3}\.\d{4,7}\s*,\s*\d{2,3}\.\d{4,7}\b/g, '00.000000, 000.000000'],
      [/\b\d{2}\.\d{6,}\b/g, '00.000000'],
      [/\b\d{3}\.\d{6,}\b/g, '000.000000'],
    ];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (w.nextNode()) nodes.push(w.currentNode);
    for (const n of nodes) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      let s = n.nodeValue;
      for (const [re, to] of RULES) s = s.replace(re, to);
      for (const nm of projNames) if (nm && s.includes(nm)) s = s.split(nm).join('某巡检项目');
      if (s !== n.nodeValue) n.nodeValue = s;
    }
    document.querySelectorAll('.leaflet-tooltip').forEach((el) => (el.textContent = '已脱敏'));
  }, projectNames);

const SHOTS = [
  { file: '01-dashboard', url: '/dashboard', wait: 4000, name: '首页大屏' },
  { file: '02-cockpit', url: '/cockpit', wait: 6000, name: '虚拟座舱' },
  { file: '03-wayline', url: '/wayline', wait: 3000, name: '航线管理' },
  { file: '04-devices', url: '/devices', wait: 4500, name: '设备管理' },
  { file: '05-models', url: '/models', wait: 5000, name: '模型库' },
  { file: '06-assets', url: '/assets', wait: 3500, name: '巡检成果' },
  ...(taskUuid ? [{ file: '07-review-workbench', url: `/review/task/${taskUuid}`, wait: 6000, name: '审核工作台' }] : []),
  { file: '08-ticket-list', url: '/tickets', wait: 3000, name: '工单列表' },
  {
    file: '09-dispatch-dialog',
    url: '/tickets',
    wait: 3000,
    name: '工单派发弹窗',
    async act(p) {
      // 找第一张草稿行（按钮是「去派发」）
      const row = p.locator('.el-table__row').filter({ has: p.getByRole('button', { name: '去派发' }) }).first();
      await row.getByRole('button', { name: '去派发' }).click();
      await p.waitForSelector('.el-dialog', { timeout: 8000 });
      await p.waitForTimeout(1500);
    },
  },
  ...(dispatched ? [{ file: '10-ticket-detail', url: `/tickets/${dispatched.id}`, wait: 6000, name: '工单详情' }] : []),
  { file: '11-stats', url: '/stats', wait: 4500, name: '台账统计' },
  { file: '12-recipients', url: '/admin/recipients', wait: 3000, name: '派发对象' },
];

const b = await chromium.launch({ executablePath: CHROME, headless: true });
let ok = 0;
for (const s of SHOTS) {
  const p = await b.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });
  const errs = [];
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  const png = `${OUT}/${s.file}.png`;
  try {
    await p.goto(BASE + s.url, { waitUntil: 'networkidle', timeout: 45000 });
    await p.waitForTimeout(s.wait);
    if (s.act) await s.act(p);
    await scrub(p);
    await p.waitForTimeout(300);
    await p.screenshot({ path: png });
    // PNG → JPEG，仓库体积可控（深色界面 68 质量足够）
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '68', png, '--out', `${OUT}/${s.file}.jpg`]);
    const chars = await p.evaluate(() => document.body.innerText.length);
    console.log(`✅ ${s.file}.jpg  ${s.name}  内容 ${chars} 字 / 控制台错误 ${errs.length}`);
    ok += 1;
  } catch (e) {
    console.log(`❌ ${s.file}  ${s.name}  ${String(e).split('\n')[0].slice(0, 90)}`);
  } finally {
    await p.close();
  }
}
await b.close();
try {
  execFileSync('/bin/rm', ['-f', ...SHOTS.map((s) => `${OUT}/${s.file}.png`)]);
} catch {}
console.log(`\n完成：${ok}/${SHOTS.length} 张已更新到 docs/screenshots/`);
