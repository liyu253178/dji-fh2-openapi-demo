/**
 * 安全基线与鉴权验证（P0-3 回归断言）
 *
 * 覆盖：
 *   1. checkUpstream：内网 / 本机 / 云元数据地址一律拒绝，公网域名放行
 *   2. checkProxyPath：只允许 /openapi/ 前缀，挡掉 ../ 与拼接素材
 *   3. requireToken：未配置令牌时放行；配置后缺令牌 401、错令牌 401、携带正确令牌放行
 *      （支持 Header / Bearer / query 三种方式，后者为 EventSource 场景）
 *
 * 运行：node scripts/verify-security.mjs
 */
import express from 'express';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n=== 安全基线验证 ===\n');

// ---------------------------------------------------------------
console.log('1. 上行地址检查（SSRF 防线）');
// 注意：checkUpstream 的行为不依赖环境变量进程状态，直接取默认版
const { checkUpstream, checkProxyPath } = await import('../src/security.js');

const publicOk = ['https://es-flight-api-cn.djigate.com', 'http://example.com:8080', 'https://djigate.com/'];
for (const base of publicOk) {
  check(`公网地址放行：${base}`, checkUpstream(base).ok === true, JSON.stringify(checkUpstream(base)));
}

const bad = [
  'http://127.0.0.1',
  'http://127.0.0.1:8080',
  'http://localhost',
  'http://localhost:9000',
  'http://LOCALHOST/admin',
  'https://10.0.0.5',
  'http://192.168.1.1',
  'http://172.16.0.1',
  'http://172.31.255.254',
  'http://169.254.169.254/latest/meta-data',
  'http://100.100.100.200',
  'http://metadata.google.internal/computeMetadata/v1',
  'https://[::1]',
  'https://[fd00::1]',
  'https://[::ffff:127.0.0.1]',
  'file:///etc/passwd',
  'gopher://127.0.0.1:6379/_INFO',
  '',
  'not a url',
  'http://',
];
for (const base of bad) {
  const r = checkUpstream(base);
  check(`拒绝：${base || '(空)'}`, r.ok === false, r.ok ? '竟然放行了' : '');
}

// 私网豁免：司空 2 私有云部署场景
check(
  'allowPrivate 时放行私网',
  checkUpstream('http://192.168.10.20', { allowPrivate: true }).ok === true
);
check(
  '即使 allowPrivate，云元数据段仍拒绝',
  checkUpstream('http://169.254.169.254', { allowPrivate: true }).ok === false
);
check(
  '即使 allowPrivate，localhost 仍拒绝',
  checkUpstream('http://localhost', { allowPrivate: true }).ok === false
);

// ---------------------------------------------------------------
console.log('\n2. 调试代理路径白名单');
const goodPaths = ['/openapi/v0.1/project', '/openapi/v0.1/device/HMS/state'];
for (const p of goodPaths) {
  check(`放行：${p}`, checkProxyPath(p).ok === true);
}
const badPaths = [
  '/project',
  'openapi/v0.1/project',
  '/openapi/../../etc/passwd',
  '/openapi/v0.1/a b',
  '/openapi/v0.1/<script>',
  '/openapi/v0.1/\\x',
  '',
  '/internal/admin',
];
for (const p of badPaths) {
  check(`拒绝：${p || '(空)'}`, checkProxyPath(p).ok === false);
}

// ---------------------------------------------------------------
console.log('\n3. 访问令牌中间件');

/** 起一个带 requireToken 的最小服务，返回 {base, close} */
async function startApp(token) {
  process.env.API_TOKEN = token;
  // security.js 在模块加载时读取 API_TOKEN，需要按用例重新加载模块
  const mod = await import(`../src/security.js?reload=${Date.now()}`);
  const app = express();
  app.use('/api', mod.requireToken);
  app.get('/api/ping', (req, res) => res.json({ ok: true, auth: !!req.authenticated }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    enabled: mod.authEnabled,
    close: () => server.close(),
  };
}

async function hit(base, init) {
  const res = await fetch(base + '/api/ping', init);
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 未配置令牌：保持既有本地用法
{
  const s = await startApp('');
  check('未设置 API_TOKEN 时 authEnabled=false', s.enabled() === false);
  const r = await hit(s.base);
  check('未设置 API_TOKEN 时正常放行', r.status === 200 && r.json?.ok === true, `status=${r.status}`);
  s.close();
}

// 配置了令牌：三种携带方式 + 两种拒绝场景
{
  const TOKEN = 'test-token-abc-123';
  const s = await startApp(TOKEN);
  check('设置 API_TOKEN 后 authEnabled=true', s.enabled() === true);

  check('无令牌 → 401', (await hit(s.base)).status === 401);
  check('错误令牌 → 401', (await hit(s.base, { headers: { 'X-Access-Token': 'wrong' } })).status === 401);
  check(
    '长度不同的令牌 → 401',
    (await hit(s.base, { headers: { 'X-Access-Token': 'test-token' } })).status === 401
  );

  const viaHeader = await hit(s.base, { headers: { 'X-Access-Token': TOKEN } });
  check('X-Access-Token 放行', viaHeader.status === 200 && viaHeader.json?.auth === true);

  const viaBearer = await hit(s.base, { headers: { Authorization: `Bearer ${TOKEN}` } });
  check('Authorization: Bearer 放行', viaBearer.status === 200 && viaBearer.json?.auth === true);

  // 注意：这里直接给完整 URL，不要复用 hit()，否则 base 后面又拼一次 /api/ping
  const viaQuery = await fetch(`${s.base}/api/ping?access_token=${TOKEN}`).then(async (res) => ({
    status: res.status,
    json: await res.json().catch(() => null),
  }));
  check('query access_token 放行（SSE 场景）', viaQuery.status === 200 && viaQuery.json?.auth === true);

  const unauth = await hit(s.base);
  check('401 响应体带 ok:false 与 code:401', unauth.json?.ok === false && unauth.json?.code === 401, JSON.stringify(unauth.json));

  s.close();
}

// ---------------------------------------------------------------
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过\n');
