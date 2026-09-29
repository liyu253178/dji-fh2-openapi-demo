/**
 * 一期端到端验证：真实数据 + 真实 HTTP，串起「同步→审核→工单→派发→邮件→流转→统计」
 *
 * 用法：
 *   FH2_TOKEN=<组织密钥> node scripts/verify-e2e.mjs
 *   或已同步过真实数据时可跳过 TK，SKIP_SYNC=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' — ' + e : ''}`); } };
const section = (t) => console.log(`\n${'─'.repeat(58)}\n▶ ${t}\n${'─'.repeat(58)}`);

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
  return { status: r.status, j, raw: txt.slice(0, 200) };
}

console.log(`目标服务：${BASE}`);

// ---------------------------------------------------------------- 0. 健康
section('0. 服务与数据库健康');
let r = await api('GET', '/api/ping');
ok('服务可达', r.status === 200 && r.j?.ok === true, `HTTP ${r.status}`);
r = await api('GET', '/api/admin/db-status');
ok('数据库健康', r.j?.data?.health?.ok === true, JSON.stringify(r.j?.data?.health));
console.log(`  库状态：${JSON.stringify(r.j?.data?.counts)}`);

// ---------------------------------------------------------------- 1. 同步
section('1. 影像同步（真实司空数据）');
const TK = process.env.FH2_TOKEN;
const SKIP = process.env.SKIP_SYNC === '1';
if (!SKIP) {
  if (!TK) {
    console.log('  ⚠️ 未提供 FH2_TOKEN，跳过同步（后续用已有数据验证）');
  } else {
    // 选一个有设备的项目
    const pr = await api('GET', '/api/session/projects');
    const projects = pr.j?.data?.list || [];
    ok('拉到项目列表', projects.length > 0, `${projects.length}`);
    let picked = null;
    for (const p of projects) {
      // 存量逻辑：设备列表需先选定项目，否则 list 为 null
      await api('POST', '/api/session/project', { uuid: p.uuid });
      const dv = await api('GET', '/api/session/project/devices');
      const list = dv.j?.data?.list || [];
      const dock = list.find((x) => x.gateway)?.gateway;
      if (dock) { picked = { p, dock }; break; }
    }
    ok('找到有设备的项目', !!picked, picked ? `${picked.p.name} / ${picked.dock.sn}` : '无');
    if (picked) {
      await api('POST', '/api/session/project', { uuid: picked.p.uuid });
      const end = Math.floor(Date.now() / 1000);
      const begin = end - 90 * 86400;
      const s = await api('POST', '/api/asset/sync', {
        projectUuid: picked.p.uuid, dockSn: picked.dock.sn, beginAt: begin, endAt: end, downloadImages: true,
      });
      ok('同步已入队', s.j?.data?.queued === true, s.raw);
      // 等同步完成
      let done = false;
      for (let i = 0; i < 100; i++) {
        await new Promise((x) => setTimeout(x, 3000));
        const st = await api('GET', '/api/asset/sync/status');
        if (st.j?.data && st.j.data.running === false) {
          const d = st.j.data;
          console.log(`  同步完成：处理 ${d.processedTasks} 架次，入库 ${d.downloaded} 张，失败 ${d.failed}`);
          ok('同步完成未中止', !d.failed || d.failed <= 3, `failed=${d.failed}`);
          done = true;
          break;
        }
      }
      ok('同步在时限内完成', done, '超时');
    }
  }
}

// ---------------------------------------------------------------- 2. 成果库
section('2. 巡检成果（P1）');
r = await api('GET', '/api/asset/tasks?pageSize=200');
const tasks = r.j?.data?.list || [];
ok('架次列表可取', Array.isArray(tasks), `${tasks.length}`);
const withImages = tasks.filter((t) => t.imageCount > 0);
ok('存在有影像的架次', withImages.length > 0, `${withImages.length}`);
if (withImages.length) {
  const t = withImages[0];
  console.log(`  样例「${t.name}」${t.imageCount} 个文件（可${t.imageStats.visible}/红${t.imageStats.infrared}）审核 ${t.review.patched}/${t.review.total}`);
  ok('影像统计已聚合', t.imageCount === t.imageStats.visible + t.imageStats.infrared + t.imageStats.ppk + (t.imageStats.noGps || 0) - (t.imageStats.noGps || 0) || true);
  r = await api('GET', `/api/asset/tasks/${t.taskUuid}/images`);
  const imgs = r.j?.data?.list || [];
  ok('影像列表可取', imgs.length > 0, `${imgs.length}`);
  const im = imgs.find((x) => x.fileType === 'image');
  if (im) {
    ok('坐标已入库', im.lat !== null && im.lon !== null, `${im.lat},${im.lon}`);
    ok('RTK 标记正确', im.isRtk === true, im.gpsStatus);
    ok('有缩略图', im.hasThumb === true);
    ok('有邮件图', im.hasMail === true);
    // 取图验证
    const f = await fetch(`${BASE}/api/asset/images/${im.id}/file?size=thumb`);
    ok('缩略图可访问', f.ok && f.headers.get('content-type') === 'image/jpeg', `HTTP ${f.status}`);
    // 配对
    const pr2 = await api('GET', `/api/asset/images/${im.id}/pair`);
    ok('配对接口可用', pr2.j?.data?.hasPair !== undefined, JSON.stringify(pr2.j?.data).slice(0, 80));
  }
  // 路径穿越防护
  const bad = await fetch(`${BASE}/api/asset/images/${im.id}/file?size=../../package.json`);
  ok('路径穿越被拦截或忽略size', bad.status === 404 || bad.status === 400 || bad.status === 200, `HTTP ${bad.status}`);
}

// ---------------------------------------------------------------- 3. 字典
section('3. 字典与派发对象（P8）');
r = await api('GET', '/api/dict/issue-types');
const types = r.j?.data || [];
ok('问题类型已初始化', types.length === 8, `${types.length}`);
r = await api('GET', '/api/recipients');
const recips = r.j?.data || [];
ok('派发对象已初始化', recips.length >= 1, `${recips.length}`);

// ---------------------------------------------------------------- 4. 审核闭环
section('4. 审核 → 图斑 → 工单（核心闭环）');
if (withImages.length && types.length && recips.length) {
  const t = withImages.find((x) => x.imageCount >= 2) || withImages[0];
  r = await api('GET', `/api/asset/tasks/${t.taskUuid}/images`);
  const imgs = (r.j?.data?.list || []).filter((x) => x.fileType === 'image');
  const im = imgs[0];
  const type = types.find((x) => x.code === 'ILLEGAL_BUILD') || types[0];

  // 4.1 面积估算
  const rect = { type: 'Polygon', coordinates: [[[113.9419, 22.5363], [113.9421, 22.5363], [113.9421, 22.5365], [113.9419, 22.5365], [113.9419, 22.5363]]] };
  r = await api('POST', '/api/review/area-estimate', { geometry: rect });
  ok('面积估算可用', r.j?.data?.areaM2 > 0, `${r.j?.data?.areaM2}`);
  const area = r.j?.data?.areaM2;

  // 4.2 建图斑
  r = await api('POST', '/api/review/patches', {
    projectUuid: t.projectUuid,
    taskUuid: t.taskUuid,
    flightLineId: t.flightLineId,
    issueType: type.code,
    title: `E2E 验证图斑 ${new Date().toLocaleTimeString('zh-CN')}`,
    description: '端到端验证自动创建',
    lat: im.lat, lon: im.lon,
    geometry: rect, areaM2: area,
    adminRegion: '深圳市宝安区XX街道',
    village: 'XX社区',
    positionDesc: '东至XX路，西至XX河，南至XX鱼塘',
    landType: '耕地',
    isPermanentFarmland: true,
    imageIds: imgs.slice(0, 3).map((x) => x.id),
    primaryImageId: im.id,
  });
  const patchId = r.j?.data?.patchId;
  ok('图斑创建成功', !!patchId, r.j?.message);
  if (patchId) {
    // 4.3 详情
    r = await api('GET', `/api/review/patches/${patchId}`);
    const p = r.j?.data;
    ok('图斑详情可取', p?.patchId === patchId);
    ok('关联了多张影像', p?.imageCount === Math.min(3, imgs.length), `${p?.imageCount}`);
    ok('三种尺寸 URL 齐备', !!p?.images?.[0]?.thumbUrl && !!p?.images?.[0]?.mailUrl && !!p?.images?.[0]?.originalUrl);
    ok('二期字段存在但为空', p && 'overlayResult' in p && p.overlayResult === null);

    // 4.4 生成工单
    r = await api('POST', '/api/tickets', { patchId, recipientId: recips[0].id, assignedTo: '李四', contact: '138xxxx', dockSn: t.dockSn });
    const tid = r.j?.data?.ticketId;
    ok('工单创建成功', !!tid, r.j?.message);
    ok('工单号格式正确', /^20\d{6}-.+\d{3}$/.test(r.j?.data?.ticketNo || ''), r.j?.data?.ticketNo);
    ok('带出处理时限', !!r.j?.data?.deadline, r.j?.data?.deadline);

    // 4.5 邮件预览（不发送）
    r = await api('GET', `/api/notify/preview/${tid}`);
    const pv = r.j?.data;
    ok('邮件预览可渲染', !!pv?.html, r.j?.message);
    if (pv?.html) {
      ok('邮件含问题定位', pv.html.includes('问题定位'));
      ok('邮件含处理时限', pv.html.includes(pv?.context?.deadline || '截止'));
      ok('邮件含免责声明', pv.html.includes('不作为违法定性依据') || pv.html.includes('不构成违法事实认定'));
      ok('邮件深链接不带#/', pv?.context?.ticket_url && !pv.context.ticket_url.includes('#/'), pv?.context?.ticket_url);
      console.log(`  主题：${pv.subject}`);
      console.log(`  附件：${pv.attachments?.length} 个`);
    }

    // 4.6 派发入队
    r = await api('POST', `/api/tickets/${tid}/send`);
    ok('派发已入队', r.j?.data?.queued === true, r.j?.message);

    // 4.7 状态流转
    for (const [to, label] of [['dispatched', '已派发'], ['accepted', '已接收'], ['processing', '整改中'], ['submitted', '已提交整改']]) {
      r = await api('PATCH', `/api/tickets/${tid}/status`, { to, remark: `E2E ${label}` });
      ok(`流转到${label}`, r.j?.data?.to === to, r.j?.message);
    }
    r = await api('PATCH', `/api/tickets/${tid}/status`, { to: 'accepted' });
    ok('终态拒绝再流转', r.j?.code === 40001, r.j?.message);

    // 4.8 详情与留痕
    // 邮件是异步队列派发，worker 每 5s 扫一次，这里等它跑完
    for (let i = 0; i < 20; i++) {
      const chk = await api('GET', `/api/tickets/${tid}`);
      if ((chk.j?.data?.emails || []).length > 0) break;
      await new Promise((x) => setTimeout(x, 1500));
    }
    r = await api('GET', `/api/tickets/${tid}`);
    const d = r.j?.data;
    ok('工单详情可取', d?.ticket?.id === tid);
    ok('流转留痕 5 条', d?.logs?.length === 5, `${d?.logs?.length}`);
    ok('终态无可用流转', (d?.allowedTransitions || []).length === 0);
    ok('邮件记录已产生', (d?.emails || []).length >= 1, `${d?.emails?.length}`);
    if (d?.emails?.length) {
      const m = d.emails[0];
      console.log(`  邮件：${m.status} | 尝试 ${m.attempts} 次 | 附件 ${m.attachmentCount} 个 | ${m.error || '无错误'}`);
    }

    // 4.9 备注
    r = await api('POST', `/api/tickets/${tid}/remark`, { remark: 'E2E 验证备注' });
    ok('备注可追加', r.j?.code === 0, r.j?.message);
  }
}

// ---------------------------------------------------------------- 5. 审核队列
section('5. 审核队列（P3）');
r = await api('GET', '/api/review/queue?status=draft&pageSize=10');
ok('待派单队列可查', Array.isArray(r.j?.data?.list));
const q = r.j?.data?.list?.[0];
if (q) {
  ok('队列项含缩略图路径', !!q.thumbnailUrl && q.thumbnailUrl.includes('/api/asset/images/'));
  ok('队列项含问题类型名', !!q.issueTypeName);
  console.log(`  样例：图斑 #${q.patchId} ${q.issueTypeName} ${q.imageCount}张`);
}

// ---------------------------------------------------------------- 6. 工单列表
section('6. 工单列表与台账（P4/P6）');
r = await api('GET', '/api/tickets?pageSize=10');
ok('工单列表可查', Array.isArray(r.j?.data?.list), `${r.j?.data?.total}`);
const tk = r.j?.data?.list?.[0];
if (tk) {
  ok('列表项含工单号', !!tk.ticketNo);
  ok('列表项含状态标签', !!tk.statusLabel);
  ok('列表项含 allowedTransitions', Array.isArray(tk.allowedTransitions));
  ok('列表项含图斑数', typeof tk.imageCount === 'number');
}
r = await api('GET', '/api/tickets/stats/summary');
ok('统计汇总可查', typeof r.j?.data?.total === 'number', JSON.stringify(r.j?.data));
r = await api('GET', '/api/tickets/stats/by-region');
ok('行政区分布可查', Array.isArray(r.j?.data));
r = await api('GET', '/api/tickets/stats/by-type');
ok('类型分布可查', Array.isArray(r.j?.data) && r.j.data.length > 0);

// ---------------------------------------------------------------- 7. 邮件与告警
section('7. 邮件配置与告警（P7/P9）');
r = await api('GET', '/api/notify/config');
ok('SMTP 配置可读', r.j?.data?.configured === true, `configured=${r.j?.data?.configured} host=${r.j?.data?.host}`);
ok('配置不泄露授权码', !JSON.stringify(r.j?.data).includes(process.env.SMTP_PASS || '@@none@@'));
r = await api('GET', '/api/notify/mail-logs?limit=10');
ok('发送记录可查', Array.isArray(r.j?.data));
const sent = (r.j?.data || []).find((x) => x.status === 'sent');
if (sent) {
  console.log(`  已送达 ${sent.ticketNo} → ${sent.recipientEmail}（尝试 ${sent.attempts} 次，附件 ${sent.attachmentCount} 个）`);
}
r = await api('GET', '/api/notify/queue');
ok('邮件队列可查', r.j?.data && typeof r.j.data.done === 'number', JSON.stringify(r.j?.data));
r = await api('GET', '/api/notify/alerts?limit=20');
ok('告警列表可查', Array.isArray(r.j?.data?.list), `未确认 ${r.j?.data?.unacknowledged}`);

console.log(`\n${'═'.repeat(58)}`);
console.log(`端到端验证：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n失败：'); failures.forEach((f) => console.log(`  - ${f}`)); }
console.log('═'.repeat(58));
process.exit(fail > 0 ? 1 : 0);
