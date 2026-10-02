/**
 * HTTP 守卫验证（P0-1 回归断言）
 *
 * 验证三件事：
 * 1. async 路由抛错不再杀死进程，而是落成 500 JSON（而不是请求挂起 / 进程退出）
 * 2. 嵌套 subRouter 下的 async handler 同样被覆盖
 * 3. index.js 里每个 /api 挂载点都经过了 hardenRouter（防止新增路由漏包）
 *
 * 运行：node scripts/verify-http-guards.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');

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

console.log('\n=== HTTP 守卫验证 ===\n');

// ---------- 1. 源码层：挂载点必须全部经过 hardenRouter ----------
console.log('1. 源码层：/api 挂载点覆盖检查');
const indexSrc = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
const mountRe = /app\.use\(\s*['"](\/api[^'"]*)['"]\s*,\s*([^,)]+)/g;
const mounts = [...indexSrc.matchAll(mountRe)];
check('存在 /api 挂载点', mounts.length > 0, `实际 ${mounts.length} 个`);
// apiNotFound / requireToken 是全局中间件不是业务路由，不需要加固
const NON_BUSINESS = new Set(['apiNotFound', 'requireToken']);
const unhardened = mounts.filter((m) => !NON_BUSINESS.has(m[2].trim()) && !/hardenRouter\(/.test(m[2]));
check(
  '所有 /api 挂载点都被 hardenRouter 包裹',
  unhardened.length === 0,
  unhardened.map((m) => `${m[1]} → ${m[2]}`).join('; ')
);
check('注册了统一错误中间件 errorHandler', /app\.use\(\s*errorHandler\s*\)/.test(indexSrc));
check('注册了 /api 404 兜底 apiNotFound', /app\.use\(\s*['"]\/api['"]\s*,\s*apiNotFound\s*\)/.test(indexSrc));
check('安装了进程级守卫 installProcessGuards', /installProcessGuards\(\s*\)/.test(indexSrc));

// 错误中间件必须挂在静态托管之后（否则静态资源的异常接不住）
const idxError = indexSrc.lastIndexOf('app.use(errorHandler)');
const idxStatic = indexSrc.indexOf('express.static(DIST');
check('errorHandler 位于静态托管之后', idxStatic === -1 || idxError > idxStatic, `error@${idxError} static@${idxStatic}`);

// ---------- 2. 运行层：真实 express 行为 ----------
console.log('\n2. 运行层：异常必须落成响应，且进程存活');
const express = (await import('express')).default;
const { hardenRouter, errorHandler, apiNotFound } = await import('../src/http.js');

const app = express();
const boom = new Error('模拟设备网络抖动');

const sub = express.Router();
sub.get('/boom', async () => {
  throw boom;
});

const r = express.Router();
r.get('/ok', async (req, res) => res.json({ ok: true }));
r.get('/boom', async () => {
  throw boom;
});
r.get('/sync-boom', (req, res) => {
  throw new Error('同步异常');
});
r.post('/async-next', async (req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  res.json({ ok: true, body: req.body });
});
r.use('/sub', sub);

app.use(express.json());
app.use('/api/test', hardenRouter(r));
app.use('/api', apiNotFound);
app.use(errorHandler);

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function hit(p, init) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应保持 null */
  }
  return { status: res.status, json, text };
}

const okRes = await hit('/api/test/ok');
check('正常 async 路由不受影响', okRes.status === 200 && okRes.json?.ok === true);

const boomRes = await hit('/api/test/boom');
check('async 抛错返回 500 而不是挂起', boomRes.status === 500, `实际 ${boomRes.status}`);
check('错误响应是 JSON', boomRes.json !== null);
check('错误响应同时带 ok:false 与 code:非0', boomRes.json?.ok === false && Number(boomRes.json?.code) !== 0, JSON.stringify(boomRes.json));
check('错误响应带出 message', boomRes.json?.message === '模拟设备网络抖动', boomRes.json?.message);

const subRes = await hit('/api/test/sub/boom');
check('嵌套 subRouter 的 async 抛错同样被捕获', subRes.status === 500 && subRes.json?.ok === false, `实际 ${subRes.status}`);

const syncRes = await hit('/api/test/sync-boom');
check('同步异常仍由 Express 捕获（行为不变）', syncRes.status === 500 && syncRes.json?.ok === false, `实际 ${syncRes.status}`);

const postRes = await hit('/api/test/async-next', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ a: 1 }),
});
check('async handler 的 req.body 正常', postRes.json?.body?.a === 1);

const nfRes = await hit('/api/nope');
check('未匹配 /api 路径返回 404 JSON', nfRes.status === 404 && nfRes.json?.ok === false, `实际 ${nfRes.status}`);

// 关键：以上多次异常后进程仍在，说明没有被 unhandled rejection 终止
check('多次异常后进程仍然存活', process.uptime() > 0);

server.close();

// ---------- 3. hardenRouter 幂等与幂等性 ----------
console.log('\n3. hardenRouter 幂等性');
const r2 = express.Router();
r2.get('/x', async (req, res) => res.json({ ok: true }));
const layer1 = r2.stack[0].route.stack[0].handle;
hardenRouter(r2);
const layer2 = r2.stack[0].route.stack[0].handle;
hardenRouter(r2);
const layer3 = r2.stack[0].route.stack[0].handle;
check('首次加固会替换 handler', layer1 !== layer2);
check('重复加固幂等（不再嵌套包裹）', layer2 === layer3);

// ---------- 汇总 ----------
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过\n');
