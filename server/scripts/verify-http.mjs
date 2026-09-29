/**
 * W3 HTTP 接口验证：打真实 HTTP 请求，覆盖校验拦截与错误响应
 * 前置：服务已在 8899 端口运行
 */
const B = process.env.BASE || 'http://127.0.0.1:8899';
let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; failures.push(n); console.log(`  ❌ ${n}${e ? ' — ' + e : ''}`); } };
const section = (t) => console.log(`\n${'─'.repeat(56)}\n▶ ${t}\n${'─'.repeat(56)}`);

async function call(method, path, body) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch { /* 非 JSON */ }
  return { status: r.status, j, raw: t.slice(0, 200) };
}

section('1. 面积估算');
let r = await call('POST', '/api/review/area-estimate', {
  p1: { lat: 22.5363, lon: 113.9419 },
  p2: { lat: 22.5365, lon: 113.9421 },
});
console.log(`  → ${JSON.stringify(r.j?.data)}`);
ok('两点构矩形成功', r.status === 200 && r.j?.data?.areaM2 > 0);
ok('面积约 458 ㎡', Math.abs((r.j?.data?.areaM2 || 0) - 458) / 458 < 0.05, `${r.j?.data?.areaM2}`);
ok('带中文面积文案', !!r.j?.data?.areaText);
ok('带数据依据说明', !!r.j?.data?.dataVersion);
r = await call('POST', '/api/review/area-estimate', { p1: { lat: 22.5363, lon: 113.9419 } });
ok('缺参数被拒(400)', r.status === 400, `HTTP ${r.status}`);

section('2. 问题类型字典');
r = await call('GET', '/api/review/issue-types');
const types = r.j?.data || [];
ok('返回 8 类', types.length === 8, `${types.length}`);
ok('含默认责任层级与时限', !!types[0].defaultOrg && types[0].defaultDays > 0);
ok('含必填标记', types.some((t) => t.requireArea) && types.some((t) => !t.requireArea));
console.log(`  → ${types.slice(0, 3).map((t) => `${t.name}/${t.defaultDays}天`).join('、')} …`);

section('3. 图斑校验拦截');
const cases = [
  ['缺标题', { issueType: 'ILLEGAL_BUILD', lat: 22.5, lon: 113.9, areaM2: 100, landType: '耕地' }, '请填写标题'],
  ['无问题类型', { title: 'x', lat: 22.5, lon: 113.9 }, '请选择问题类型'],
  ['未知问题类型', { issueType: 'NOT_EXIST', title: 'x', lat: 22.5, lon: 113.9 }, '不在字典'],
  ['坐标无效', { issueType: 'DUST', title: 'x', lat: 0, lon: 0 }, '坐标无效'],
  ['违法建设缺面积', { issueType: 'ILLEGAL_BUILD', title: 'x', lat: 22.5, lon: 113.9, landType: '耕地' }, '框选范围'],
  ['违法建设缺地类', { issueType: 'ILLEGAL_BUILD', title: 'x', lat: 22.5, lon: 113.9, areaM2: 100 }, '当前地类'],
  ['关联不存在影像', { issueType: 'DUST', title: 'x', lat: 22.5, lon: 113.9, imageIds: [99999] }, '不存在'],
];
for (const [name, body, expect] of cases) {
  const r = await call('POST', '/api/review/patches', body);
  const msg = r.j?.message || '';
  ok(`${name} 被拒`, r.status === 400 && msg.includes(expect), `HTTP ${r.status} ${msg}`);
}

section('4. 工单接口');
r = await call('GET', '/api/tickets');
ok('列表可查(空)', r.status === 200 && r.j?.data?.total === 0);
r = await call('GET', '/api/tickets/999999');
ok('不存在的工单返回 404', r.status === 404, `HTTP ${r.status}`);
r = await call('PATCH', '/api/tickets/999999/status', { to: 'processing' });
ok('对不存在工单流转返回 404', r.status === 404, `HTTP ${r.status}`);
r = await call('POST', '/api/tickets', { patchId: 999999 });
ok('用不存在图斑建单被拒', r.status === 400, `HTTP ${r.status}`);
r = await call('POST', '/api/tickets', {});
ok('缺 patchId 被拒', r.status === 400 && (r.j?.message || '').includes('patchId'));

section('5. 台账统计');
r = await call('GET', '/api/tickets/stats/summary');
const s = r.j?.data;
ok('汇总可查', r.status === 200 && typeof s?.total === 'number');
ok('含全部 7 个状态字段', s && ['draft', 'dispatched', 'accepted', 'processing', 'submitted', 'rejected', 'cancelled'].every((k) => k in s));
ok('含逾期计数', s && 'overdue' in s);
r = await call('GET', '/api/tickets/stats/by-region');
ok('行政区分布可查', r.status === 200 && Array.isArray(r.j?.data));
r = await call('GET', '/api/tickets/stats/by-type');
ok('类型分布可查', r.status === 200 && Array.isArray(r.j?.data));

section('6. 审核队列');
r = await call('GET', '/api/review/queue');
ok('队列可查(空)', r.status === 200 && r.j?.data?.total === 0);
r = await call('GET', '/api/review/queue?status=draft');
ok('按状态筛选', r.status === 200);
r = await call('GET', '/api/review/patches/999999');
ok('不存在图斑返回 404', r.status === 404, `HTTP ${r.status}`);
r = await call('POST', '/api/review/suggest-images', { lat: 0, lon: 0 });
ok('无效坐标推荐被拒', r.status === 400, `HTTP ${r.status}`);

section('7. 存量接口未受影响');
r = await call('GET', '/api/ping');
ok('ping 正常', r.status === 200 && r.j?.ok === true);
r = await call('GET', '/api/task/list');
ok('存量任务接口仍生效', r.status === 200 && r.j?.message?.includes('缺少必填参数'));
r = await call('GET', '/api/asset/sync/status');
ok('资产同步状态可查', r.status === 200 && r.j?.data?.running === false);
r = await call('GET', '/api/admin/db-status');
ok('数据库状态可查', r.status === 200 && r.j?.data?.health?.ok === true);

console.log(`\n${'═'.repeat(56)}`);
console.log(`HTTP 验证：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log('\n失败：'); failures.forEach((f) => console.log(`  - ${f}`)); }
console.log('═'.repeat(56));
process.exit(fail > 0 ? 1 : 0);
