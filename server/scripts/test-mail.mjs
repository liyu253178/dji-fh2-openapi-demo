/**
 * W4 邮件模块测试：模板渲染 · 附件生成 · 错误分类 · 队列
 * 不需要 SMTP，构造数据验证渲染链路
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * ⚠️ 安全约束：本脚本会清库重建，必须用独立测试目录（默认 server/data-test）。
 *    历史版本直接删 server/data/duav.db，会把手工同步的真实数据一并毁掉。
 *    必须在下面 import db 模块之前设置 DUAV_DATA_DIR。
 */
const TEST_DATA_DIR =
  process.env.DUAV_TEST_DATA_DIR || path.join(__dirname, '..', 'data-test');
process.env.DUAV_DATA_DIR = TEST_DATA_DIR;
const DB_FILE = path.join(TEST_DATA_DIR, 'duav.db');
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' — ' + e : ''}`); } };
const section = (t) => console.log(`\n${'─'.repeat(56)}\n▶ ${t}\n${'─'.repeat(56)}`);

const { migrate } = await import('../src/db/migrate.js');
const { seed } = await import('../src/db/seed.js');
const DB = await import('../src/db/index.js');
const { syncRepo, assetRepo, ticketRepo, dictRepo, patchRepo } = await import('../src/db/repositories/index.js');
const { buildContext, render, renderDispatch, TEMPLATE_IDS } = await import('../src/modules/notify/templates.js');
const { classify, describeError, composeTicketMail, queueStats, runQueueOnce } = await import('../src/modules/notify/mailer.js');
const { getPublicConfig } = await import('../src/modules/notify/mailConfig.js');

migrate();
seed({ withSampleRecipients: true });

// 造数据
const PU = 'proj-mail';
syncRepo.upsertProject({ uuid: PU, name: '邮件测试项目' });
syncRepo.upsertTask({ uuid: 'task-mail', projectUuid: PU, dockSn: 'DOCK', name: '邮件测试架次', taskType: 'immediate', status: 'success', beginAt: '2026-09-20T02:00:00Z' });
const imgIds = [];
for (let i = 1; i <= 3; i++) {
  const r = assetRepo.upsertImage({
    taskUuid: 'task-mail', mediaUuid: `mm${i}`, projectUuid: PU, dockSn: 'DOCK',
    fileName: `DJI_2026092002000${i}_0001_V`, fileType: 'image', lensType: 'visible',
    imageSource: 'ZoomCamera', lat: 22.5364 + i * 0.0001, lon: 113.982,
    altitudeAbs: 106, altitudeRel: 80, gpsStatus: 'RTK', droneModel: 'M4TD',
    parseStatus: 'ok', shotAt: '2026-09-20T02:00:0' + i + '+08:00',
    // 造 3 个 1600px 压缩图文件
    filePath: `assets/mailtest/DJI_${i}.jpg`,
    mailPath: `mail-attach/DJI_${i}.jpg`,
  });
  imgIds.push(r.id);
  // 真实文件（sharp 生成，模拟已生成的压缩图）
  const sharp = (await import('sharp')).default;
  const { MAIL_IMAGE_DIR } = await import('../src/db/config.js');
  if (!fs.existsSync(MAIL_IMAGE_DIR)) fs.mkdirSync(MAIL_IMAGE_DIR, { recursive: true });
  const buf = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 70 + i * 30, g: 110, b: 150 } } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(MAIL_IMAGE_DIR, `DJI_${i}.jpg`), buf);
}

// 建图斑 + 工单
const { createPatch, attachImages } = await import('../src/modules/review/reviewService.js');
const geo = await import('../src/modules/review/geo.js');
const rect = geo.rectPolygon({ lat: 22.5363, lon: 113.9819 }, { lat: 22.5365, lon: 113.9821 });
const pr = createPatch({
  projectUuid: PU, taskUuid: 'task-mail',
  issueType: 'ILLEGAL_BUILD', title: '疑似新增钢结构厂房',
  description: '航拍可见新增钢结构覆盖约 300 ㎡，周边为耕地',
  lat: 22.5364, lon: 113.982, geometry: rect,
  adminRegion: '深圳市宝安区XX街道', village: 'XX社区',
  positionDesc: '东至XX路，西至XX河，南至XX鱼塘',
  landType: '耕地', isPermanentFarmland: true,
  imageIds: imgIds, primaryImageId: imgIds[0],
});
ok('前置：图斑创建', pr.ok === true, pr.message);
attachImages(pr.patchId, imgIds.slice(1));
const tk = ticketRepo.createFromPatch({ patchId: pr.patchId, recipientId: 1, assignedTo: '李四', contact: '138xxxx' });
ok('前置：工单生成', tk.ok === true, tk.message);
const TID = tk.id;

section('1. 模板上下文构建');
const t = ticketRepo.findById(TID);
// ⚠️ 必须用 patchRepo.findById（已转 camelCase），不能直接查 DB 原始行——
//    buildContext 读的是 camelCase 字段，传 snake_case 会全为空
const p = patchRepo.findById(pr.patchId);
const recipient = dictRepo.getRecipient(1);
const images = imgIds.map((id) => assetRepo.findById(id));
const cfg = { orgName: '低空智能监管平台', orgContact: '张三 138xxxx', platformUrl: 'http://localhost:5173' };
const ctx = buildContext({ ticket: t, patch: { ...p, issueTypeName: t.issueTypeName }, recipient, images, config: cfg });
ok('工单号变量', ctx.ticket_no === t.ticketNo, ctx.ticket_no);
ok('问题类型变量', ctx.issue_type_name === '疑似违法建设');
ok('行政区变量', ctx.admin_region.includes('宝安区'), JSON.stringify(ctx.admin_region));
ok('位置描述变量', !!ctx.position_desc, JSON.stringify(ctx.position_desc));
ok('面积变量已格式化', typeof ctx.area === 'string' && ctx.area.includes('平方米'), ctx.area);
ok('永久基本农田转中文', ctx.is_permanent_farmland === '是', ctx.is_permanent_farmland);
ok('地类变量', ctx.land_type === '耕地', ctx.land_type);
ok('影像数量变量', ctx.image_count === 3, `${ctx.image_count}`);
ok('定位质量转中文', ctx.gps_quality.includes('RTK'), ctx.gps_quality);
ok('高度变量带单位', ctx.flight_altitude.includes('米'), ctx.flight_altitude);
ok('工单深链接', ctx.ticket_url.includes(`/tickets/${TID}`), ctx.ticket_url);
ok('落款单位', ctx.org_name === '低空智能监管平台');

section('2. 变量替换');
const tpl = 'Hello {{ticket_no}} at {{admin_region}}|{{unknown_var}}|';
const out = render(tpl, ctx);
ok('已知变量被替换', out.includes(t.ticketNo));
ok('未知变量替换为空', out.endsWith('|'), JSON.stringify(out));
ok('不会残留 {{}}', !render('{{a}}', { a: 'x' }).includes('{{'));

section('3. 邮件渲染（合规红线）');
const { subject, html } = renderDispatch(ctx, { attachments: [] });
console.log(`  主题：${subject}`);
ok('主题含工单号', subject.includes(t.ticketNo));
ok('主题含区域', subject.includes('宝安区'));
ok('主题含限期', subject.includes(t.deadline));
ok('正文含问题定位', html.includes('问题定位'));
ok('正文含线索描述', html.includes('线索描述'));
ok('正文含影像依据', html.includes('影像依据'));
ok('正文含需处理事项', html.includes('需处理事项'));
ok('正文含反馈方式', html.includes('反馈方式'));
// 合规红线检查。
// 允许：①「疑似违法建设」作问题类型名 ②「不作为违法定性依据」③「是否违法、如何处置须…认定」④「不构成违法事实认定」
// 禁止：任何把线索直接定性为违法的表述，如「违法占地」「违法建设行为已确认」「属违法行为」
const ALLOWED_PATTERNS = [
  /疑似违法建设/g,
  /不作为违法定性依据/g,
  /是否违法、如何处置/g,
  /不构成违法事实认定/g,
  /疑似线索/g,
];
let probe = html;
for (const re of ALLOWED_PATTERNS) probe = probe.replace(re, '');
const violation = probe.match(/违法(?!建设)|违规/g);
ok('不含违法定性表述', !violation, violation ? `发现：${violation.join(',')}` : '');
ok('含免责声明', html.includes('不作为违法定性依据') || html.includes('不构成违法事实认定'));
ok('含疑似线索措辞', html.includes('疑似'));
ok('含"是否违法由主管部门认定"表述', html.includes('由主管部门认定'));
ok('含处理时限', html.includes(t.deadline));
ok('含在线处理链接', html.includes(ctx.ticket_url));
ok('正文长度合理(3-40KB)', html.length > 3000 && html.length < 40000, `${(html.length / 1024).toFixed(1)}KB`);

section('4. 附件组装（真实文件）');
const composed = await composeTicketMail(TID, { degrade: false });
console.log(`  主题：${composed.subject}`);
console.log(`  附件：${composed.attachments.length} 个 → ${composed.attachments.map((a) => a.filename).join(', ')}`);
ok('组装成功', !!composed.subject && !!composed.html);
ok('含 3 张压缩图附件', composed.attachments.filter((a) => a.filename.startsWith('DJI_')).length === 3, `${composed.attachments.filter(a=>a.filename.startsWith("DJI_")).length}`);
ok('含位置示意图', composed.attachments.some((a) => a.filename.includes('位置示意图')));
ok('附件路径均存在', composed.attachments.every((a) => fs.existsSync(a.path)));
const png = composed.attachments.find((a) => a.filename.endsWith('.png'));
if (png) {
  const sz = fs.statSync(png.path).size;
  console.log(`  位置示意图大小：${(sz / 1024).toFixed(0)}KB`);
  ok('示意图体积合理(5-200KB)', sz > 5000 && sz < 204800, `${(sz / 1024).toFixed(0)}KB`);
}
ok('未降级时无降级计数', composed.degradedCount === 0, `${composed.degradedCount}`);

section('5. 降级模式（附件过大时）');
const deg = await composeTicketMail(TID, { degrade: true });
console.log(`  降级后附件：${deg.attachments.length} 个 → ${deg.attachments.map((a) => a.filename).join(', ')}`);
ok('降级后不含影像附件', deg.attachments.filter((a) => a.filename.startsWith('DJI_')).length === 0);
ok('降级后仍含位置示意图', deg.attachments.some((a) => a.filename.includes('位置示意图')));
ok('降级计数 > 0', deg.degradedCount > 0, `${deg.degradedCount}`);
ok('降级后正文仍可渲染', deg.html.includes('问题定位'));

section('6. 错误分类与重试策略');
const cases = [
  ['535 Authentication failed', 'auth', false, false],
  ['550 mailbox unavailable', 'address', false, false],
  ['552 Message too large', 'too-large', false, true],
  ['421 Connection refused', 'throttled', true, false],
  ['550 Rejected spam content', 'rejected', false, false],
  ['ETIMEDOUT when fetching', 'network', true, false],
  ['ECONNREFUSED 127.0.0.1', 'network', true, false],
];
for (const [msg, kind, retry, degrade] of cases) {
  const c = classify({ message: msg });
  const pass = c.kind === kind && c.retry === retry && !!c.degrade === degrade;
  ok(`${msg.slice(0, 28).padEnd(30)} → ${kind}`, pass, `实际 kind=${c.kind} retry=${c.retry} degrade=${!!c.degrade}`);
}
ok('认证类不重试（防锁账号）', classify({ message: '535 auth failed' }).retry === false);
ok('限流有退避表', (classify({ message: '421' }).backoff || []).length === 3);
ok('错误说明含中文提示', describeError({ message: '535 auth failed' }).includes('应用专用密码'));

section('7. 队列机制');
const now = new Date().toISOString();
DB.run(`INSERT INTO mail_queue (ticket_id, priority, status, attempts, created_at, updated_at) VALUES (@t,5,'pending',0,@n,@n)`, { t: TID, n: now });
let qs = queueStats();
console.log(`  队列状态：${JSON.stringify(qs)}`);
ok('待处理计数正确', qs.pending === 1, `${qs.pending}`);

// 无 SMTP 配置时 worker 应把任务标记失败而不是崩溃
const { resetCache } = await import('../src/modules/notify/mailConfig.js');
resetCache();
const r = await runQueueOnce();
console.log(`  worker 执行：${JSON.stringify(r)}`);
ok('worker 处理了任务', r.processed === 1);
qs = queueStats();
ok('无 SMTP 时任务标记 failed', qs.failed === 1, JSON.stringify(qs));
const t2 = ticketRepo.findById(TID);
ok('工单 mail_status 回写 failed', t2.mailStatus === 'failed', t2.mailStatus);
ok('工单状态仍为 draft（未误流转）', t2.status === 'draft', t2.status);
const el = DB.all('SELECT * FROM email_log WHERE ticket_id=@t', { t: TID });
ok('已写发送记录', el.length >= 1, `${el.length}`);
ok('记录了失败原因', !!el[0]?.error, el[0]?.error?.slice(0, 40));
const al = DB.all("SELECT * FROM alert WHERE category='mail'");
ok('已产生邮件告警', al.length >= 1, `${al.length}`);

section('8. 配置脱敏');
const pub = getPublicConfig();
ok('未配置时 configured=false', pub.configured === false);
ok('不返回授权码明文', !JSON.stringify(pub).includes('wsidfzgagvuudigi'));
ok('hasPass 标记存在', 'hasPass' in pub);

console.log(`\n${'═'.repeat(56)}`);
console.log(`测试结果：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n失败：'); failures.forEach((f) => console.log(`  - ${f}`)); }
console.log('═'.repeat(56));
DB.closeDb();
process.exit(fail > 0 ? 1 : 0);
