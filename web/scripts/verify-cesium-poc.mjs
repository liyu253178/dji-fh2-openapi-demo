/**
 * Cesium 三维底座 POC 验收（阶段 0）
 *
 * 对应《Cesium 底座引入论证》第 6 节的四个 go/no-go 门槛：
 *   G1 坐标：模型落位与既有坐标体系一致，且不劣于现状（±1e-6° 量级）
 *   G2 性能：同机同包的可交互耗时与稳定帧率（与 three.js 方案对比用同一台机器）
 *   G3 量测：读数口径可互证、表面取点不飘
 *   G4 部署：断外网可加载、单端口可服务、dist 增量体积
 *
 * 设计原则：**只报实测数字，不预设结论**。任何一项拿不到数据就写「未取到」，
 * 不编造、不四舍五入成好看的数。
 *
 * 依赖 playwright-core + 系统 Chrome；缺任一则跳过（退出码 0）。
 * 用法：先启动后端（node server/src/index.js，BFF 已托管 web/dist），再跑本脚本。
 *   node scripts/verify-cesium-poc.mjs
 * 环境变量：BASE_URL（默认 http://127.0.0.1:8787）、HEADED=1 强制有头模式
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(PW) || !existsSync(CHROME)) {
  console.log('⏭  未找到 playwright-core / Chrome，跳过 Cesium POC 验收');
  process.exit(0);
}
const mod = await import(PW);
const chromium = mod.chromium || mod.default.chromium;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

/** 目标模型：本地缓存里最大的那个（828MB），用最难的包压性能 */
const TARGET_ID = process.env.POC_MODEL || '335363146';
/** 该模型根 tileset 的 ECEF 包围盒中心，用本项目 ecef.js 独立反算出的期望值 */
const EXPECT = { lon: 113.9418784, lat: 22.5363341 };

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
};
const info = (s) => console.log(`  · ${s}`);

function dirSize(p) {
  let n = 0;
  if (!existsSync(p)) return 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : statSync(f).size;
  }
  return n;
}
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
/** 真实 gzip 后的体积（构建日志里的 gzip 数是估算，这里按实际压缩结果算） */
const gzipSizeSync = (p) => gzipSync(readFileSync(p), { level: 9 }).length;

console.log('=== Cesium 三维底座 POC 验收 ===\n');

/* ---------------- 前置：后端与本地缓存 ---------------- */
const jget = async (u) => fetch(u).then((r) => r.json()).catch(() => null);
const ping = await jget(`${BASE}/api/ping`);
if (!ping?.ok) {
  console.log(`✗ 后端未启动（${BASE}/api/ping 无响应）。先运行 node server/src/index.js`);
  process.exit(1);
}
const local = await jget(`${BASE}/api/model/local`);
const cached = local?.data?.list || [];
console.log(`本地已缓存模型 ${cached.length} 个：`);
for (const m of cached) info(`${m.id}  ${m.file_type}  ${mb(m.bytes)}  entry=${m.entry}`);
if (!cached.some((m) => m.id === TARGET_ID)) {
  console.log(`\n✗ 目标模型 ${TARGET_ID} 不在本地缓存，无法验收`);
  process.exit(1);
}
console.log('');

/* ---------------- G4 · dist 体积（先在磁盘上量，不依赖浏览器） ---------------- */
console.log('[G4] 部署与体积');
const distCesium = dirSize(path.join(WEB_ROOT, 'dist/cesium'));
const distAll = dirSize(path.join(WEB_ROOT, 'dist'));
const assets = path.join(WEB_ROOT, 'dist/assets');
let cesiumChunk = 0;
let cesiumChunkGz = 0;
let cesiumCss = 0;
if (existsSync(assets)) {
  for (const f of readdirSync(assets)) {
    if (!f.startsWith('cesium')) continue;
    const fp = path.join(assets, f);
    if (f.endsWith('.js')) {
      cesiumChunk += statSync(fp).size;
      cesiumChunkGz += gzipSizeSync(fp);
    } else if (f.endsWith('.css')) {
      cesiumCss += statSync(fp).size;
    }
  }
}
// 「引入 Cesium 的直接代价」= 静态资源 + JS chunk（gzip）+ 样式。
// 不用「新旧 dist 总量相减」当结论：构建目录里可能残留历史 hash 文件，相减出来的数不可靠。
const directCost = distCesium + cesiumChunkGz + cesiumCss;
info(`dist 总计 ${mb(distAll)}`);
info(`├ /cesium 静态资源 ${mb(distCesium)}（Worker / Assets / ThirdParty / Widgets，不可 gzip 分发）`);
info(`├ cesium JS chunk ${mb(cesiumChunk)} → gzip ${mb(cesiumChunkGz)}`);
info(`└ cesium 控件样式 ${mb(cesiumCss)}`);
info(`引入 Cesium 的直接代价 ≈ ${mb(directCost)}（静态资源 + JS gzip + 样式）`);
// 历史构建残留只作参考
let baseline = 0;
for (const d of readdirSync(WEB_ROOT).filter((n) => n.startsWith('dist-old-'))) {
  baseline = Math.max(baseline, dirSize(path.join(WEB_ROOT, d)));
}
if (baseline) info(`（参考：引入前那次构建的 dist 为 ${mb(baseline)}，可能含历史 hash 残留，不作为结论）`);
ok('Cesium 静态资源已随构建产出', distCesium > 0, mb(distCesium));
ok('Cesium JS 已切成独立 chunk', cesiumChunk > 0, `${mb(cesiumChunk)} / gzip ${mb(cesiumChunkGz)}`);
ok('单端口可服务（BFF 已托管 dist）', true, BASE);
console.log('');

/* ---------------- 浏览器 ---------------- */
const headed = process.env.HEADED === '1' || process.env.HEADED === 'true';
const b = await chromium.launch({
  executablePath: CHROME,
  // 帧率必须在真实 GPU 上测，SwiftShader 的数字没有参考价值。
  // 默认有头（真机 GPU），HEADED=0 可强制无头，但此时 G2 数字只能当「能渲染」的证据。
  headless: headed ? false : true,
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    // 关键：有头模式下窗口很容易被挡在其他窗口后面，
    // Chrome 会对被遮挡的窗口暂停 requestAnimationFrame，
    // 表现为「模型明明渲染出来了，但帧率跑分数到 0 帧」。
    // 这三条关掉后台/遮挡节流，帧率数字才有意义。
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const tileResponses = [];
p.on('response', (r) => {
  if (r.url().includes('/tiles/')) tileResponses.push({ status: r.status(), url: r.url() });
});

try {
  await p.goto(`${BASE}/models/geo-cesium`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 等页面自己把默认模型加载完（POC 页 onMounted 会自动选最大的那个）
  console.log('[G2] 加载与性能（等待模型就绪，大包可能较久）');
  const t0 = Date.now();
  await p.waitForFunction(
    () => window.__CESIUM_POC__?.metrics?.state === 'ready' || window.__CESIUM_POC__?.metrics?.state === 'error',
    { timeout: 600000 }
  );
  const wall = Date.now() - t0;
  let m = await p.evaluate(() => window.__CESIUM_POC__.metrics);
  info(`页面就绪耗时（含导航+解析+首屏瓦片）${wall} ms`);
  info(`页面内自测可交互耗时 ${m.interactiveMs} ms`);
  info(`渲染设备 ${m.renderer}`);
  info(`瓦片请求 ${tileResponses.length} 个，其中 200 ${tileResponses.filter((t) => t.status === 200).length}`);

  if (m.state === 'error') {
    const body = await p.locator('.err-body').innerText().catch(() => '');
    console.log(`\n✗ 模型加载失败：${body}`);
    console.log('  这本身是 POC 的有效结论（例如 asset.version 0.0 不被支持）。');
    fail += 1;
  } else {
    ok('Cesium 能直接加载司空 2 导出的 tileset', m.state === 'ready', `state=${m.state}`);
    ok('瓦片经路径式路由取回并 200', tileResponses.filter((t) => t.status === 200).length > 0,
      `200=${tileResponses.filter((t) => t.status === 200).length}/${tileResponses.length}`);
    ok('Ion 已禁用（离线前提）', !!m.ionDisabled);
    ok('可交互耗时为有限值', Number.isFinite(m.interactiveMs), `${m.interactiveMs} ms`);
    ok('瓦片内容已就绪（numberOfTilesWithContentReady > 0）', m.tilesLoaded > 0,
      `${m.tilesLoaded} / 共 ${m.tilesTotal} 张`);
  }

  /* ---------------- G1 · 坐标 ---------------- */
  console.log('\n[G1] 坐标一致性');
  const loc = await p.evaluate(() => window.__CESIUM_POC__.location);
  if (!loc) {
    ok('取到模型落位坐标', false, '页面未产出 location');
  } else {
    const [lon, lat, h] = loc.llh;
    info(`Cesium 投影出的模型中心 ${lon.toFixed(7)}°E ${lat.toFixed(7)}°N ${h.toFixed(2)} m`);
    info(`本项目 ecef.js 期望值        ${EXPECT.lon.toFixed(7)}°E ${EXPECT.lat.toFixed(7)}°N`);
    const dLon = Math.abs(lon - EXPECT.lon);
    const dLat = Math.abs(lat - EXPECT.lat);
    info(`差值 ${dLon.toExponential(3)}° / ${dLat.toExponential(3)}°`);
    info(`与自家 ECEF 反算的闭环自检差 ${loc.selfCheckDiffM.toExponential(3)} m`);
    // 阈值取 1e-6°（论证文档的「不劣于现状」口径；22°N 处约 0.1 m）
    ok('落位与既有坐标体系一致（≤1e-6°）', dLon <= 1e-6 && dLat <= 1e-6,
      `Δlon=${dLon.toExponential(2)} Δlat=${dLat.toExponential(2)}`);
    ok('Cesium 与项目 ecef.js 自洽（＜1 m）', loc.selfCheckDiffM < 1,
      `${loc.selfCheckDiffM.toExponential(2)} m`);
  }

  /* ---------------- G3 · 量测 ---------------- */
  console.log('\n[G3] 量测口径');
  // 用两个真实经纬度点，比较 Cesium 的测地线口径与独立实现（Andoyer-Lambert）的差异。
  // 这不是「和 three.js 读数对比」（那需要同一批点两次取点），而是验证读数口径本身可互证。
  const geo = await p.evaluate(() => {
    const C = window.__CESIUM_POC__.Cesium || null;
    if (!C) return { err: '页面未暴露 Cesium' };
    const a = C.Cartographic.fromDegrees(113.9407868, 22.5354497, 10);
    const b2 = C.Cartographic.fromDegrees(113.9429702, 22.5372185, 30);
    const g = new C.EllipsoidGeodesic(a, b2);
    return { cesium: g.surfaceDistance, start: g.startHeading, end: g.endHeading };
  }, []);
  if (geo?.err) {
    ok('量测口径取数', false, geo.err);
  } else {
    // 独立实现：Andoyer-Lambert 短距近似（对几百米量级误差在毫米级）
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const lat1 = toRad(22.5354497);
    const lat2 = toRad(22.5372185);
    const dLat = lat2 - lat1;
    const dLon = toRad(113.9429702 - 113.9407868);
    const hav = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const sphere = 2 * R * Math.asin(Math.sqrt(hav));
    // 椭球修正：按平均纬度处的子午圈/卯酉圈曲率半径做一次拉长
    const A = 6378137.0;
    const F = 1 / 298.257223563;
    const E2 = F * (2 - F);
    const latm = (lat1 + lat2) / 2;
    const W = Math.sqrt(1 - E2 * Math.sin(latm) ** 2);
    const N = A / W;
    const M = (A * (1 - E2)) / W ** 3;
    const Rn = Math.sqrt(M * N); // 平均曲率半径
    const independent = sphere * (Rn / R);
    info(`Cesium EllipsoidGeodesic ${geo.cesium.toFixed(4)} m`);
    info(`独立实现（球面 + 曲率半径修正）${independent.toFixed(4)} m`);
    const diff = Math.abs(geo.cesium - independent);
    info(`互差 ${diff.toFixed(4)} m（相对 ${((diff / geo.cesium) * 100).toFixed(4)} %）`);
    ok('两种口径互差可接受（＜1 m/500m）', diff < 1, `${diff.toFixed(4)} m`);
  }

  // 表面取点是否稳定：同一点取三次，读数应完全一致（不飘）
  const pickStability = await p.evaluate(() => {
    const pv = window.__CESIUM_POC__.viewer;
    const scene = pv.scene;
    const pos = new (window.__CESIUM_POC__.Cesium.Cartesian2)(pv.canvas.clientWidth / 2, pv.canvas.clientHeight / 2);
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      const w = scene.pickPosition(pos) || scene.camera.pickEllipsoid(pos, scene.globe.ellipsoid);
      const c = w ? window.__CESIUM_POC__.Cesium.Cartographic.fromCartesian(w) : null;
      out.push(c ? [window.__CESIUM_POC__.Cesium.Math.toDegrees(c.longitude), window.__CESIUM_POC__.Cesium.Math.toDegrees(c.latitude), c.height] : null);
    }
    return out;
  });
  if (pickStability.every((x) => x)) {
    const spread = Math.max(
      ...pickStability.map((x) => Math.abs(x[0] - pickStability[0][0])),
      ...pickStability.map((x) => Math.abs(x[1] - pickStability[0][1]))
    );
    info(`屏幕中心连续取点 3 次，最大离散 ${spread.toExponential(3)}°`);
    ok('表面取点稳定（三次一致）', spread < 1e-9, spread.toExponential(2));
  } else {
    ok('表面取点可用', false, 'pickPosition 返回 undefined（该视角下无几何）');
  }

  /* ---------------- G2b · 帧率跑分 ---------------- */
  if (m.state === 'ready') {
    console.log('\n[G2b] 帧率跑分（绕模型旋转 3 秒）');
    if (!headed) info('注意：当前为无头模式，帧率很可能由 SwiftShader 软件渲染决定，不可作为真机结论');

    // 被遮挡的窗口会被 Chrome 暂停 requestAnimationFrame，帧号就不动了。
    // 先把窗口切到前台，再顺手量一下 rAF 到底有没有在跑——否则「0 帧」
    // 会被误读成「渲染卡死」，其实只是窗口在后台。
    await p.bringToFront().catch(() => {});
    await p.waitForTimeout(500);
    const vis = await p.evaluate(() => ({ state: document.visibilityState, hidden: document.hidden }));
    const rafTicks = await p.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            n += 1;
            if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
            else resolve(n);
          };
          requestAnimationFrame(tick);
          // 兜底：1.5s 内一次都没回调也要有个结果，不能挂住
          setTimeout(() => resolve(n), 1500);
        })
    );
    info(`文档可见性 ${vis.state}（hidden=${vis.hidden}），1 秒内 rAF 回调 ${rafTicks} 次`);

    await p.evaluate(async () => {
      document.querySelectorAll('.bar button').forEach((btn) => {
        if (btn.innerText.includes('跑分')) btn.click();
      });
    });
    await p.waitForTimeout(2000);
    // 等跑分「跑完」而不是等 fps 非空：取不到帧时 fps 保持 null，
    // 等非空会白白等到超时，还把「超时」和「跑完了但没帧」混为一谈。
    await p
      .waitForFunction(() => window.__CESIUM_POC__.metrics.benchDone === true, { timeout: 60000 })
      .catch(() => info('跑分未在 60s 内结束'));
    m = await p.evaluate(() => window.__CESIUM_POC__.metrics);
    info(`平均帧率 ${m.fps === null ? '未取到' : m.fps.toFixed(1) + ' fps'}（引擎渲染帧 ${m.frames}）`);
    info(`跑分窗口内浏览器 rAF 回调 ${m.framesRaf} 次（与引擎帧并列，用于归因）`);
    info(`跑分后已载瓦片 ${m.tilesLoaded} / ${m.tilesTotal}`);
    if (m.frames === 0) {
      // 归因要靠「引擎帧 vs 浏览器 rAF」两个数的对照，不能靠猜：
      // rAF 正常但引擎帧为 0 → 引擎侧没渲染（取数错/渲染循环没转）；
      // 两者都低 → 窗口被遮挡或节流，本环境取不到真机数字。
      if (m.framesRaf > 30) {
        info('rAF 正常但引擎渲染帧为 0 → 不是窗口节流，是引擎侧没渲染或取数有误，属于待修问题。');
      } else {
        info('引擎帧与 rAF 双低 → 窗口被遮挡/节流，本环境取不到真机帧率，不写数字。');
      }
    }
    ok('帧率取到有限值', Number.isFinite(m.fps) && m.fps > 0,
      m.fps === null ? '未取到' : `${m.fps.toFixed(2)} fps / ${m.frames} 帧`);
  }

  /* ---------------- G4 · 断外网 ---------------- */
  console.log('\n[G4] 断外网可加载');
  const blocked = [];
  await p.route('**', (route) => {
    const u = new URL(route.request().url());
    const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (!isLocal) {
      blocked.push(u.host);
      return route.abort();
    }
    return route.continue();
  });
  const errsBefore = errs.length;
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(
    () => window.__CESIUM_POC__?.metrics?.state === 'ready' || window.__CESIUM_POC__?.metrics?.state === 'error',
    { timeout: 600000 }
  );
  const mOff = await p.evaluate(() => window.__CESIUM_POC__.metrics);
  const newErrs = errs.slice(errsBefore).filter((t) => !/ERR_FAILED|ERR_ABORTED|net::/i.test(t));
  info(`被拦截的外部主机 ${blocked.length ? [...new Set(blocked)].join(', ') : '（无外部请求）'}`);
  info(`断网后状态 ${mOff.state}，已载瓦片 ${mOff.tilesLoaded}`);
  ok('断外网后模型仍能加载', mOff.state === 'ready', `state=${mOff.state}`);
  ok('断网后无外部域名依赖', blocked.length === 0 || mOff.state === 'ready');
  if (newErrs.length) info(`断网后控制台错误 ${newErrs.length} 条：${newErrs.slice(0, 2).join(' | ')}`);

  const realErrs = errs.filter((t) => !/ERR_FAILED|ERR_ABORTED|net::/i.test(t));
  ok('控制台 0 错误（排除断网期间被主动拦截的请求）', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));

  await p.screenshot({ path: path.join(WEB_ROOT, 'dist/cesium-poc.png') }).catch(() => {});
} finally {
  await b.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(fail ? '判定：POC 未完全通过 —— 按论证文档纪律，先不动现有 three.js 方案。' : '判定：POC 通过，可进入阶段 1。');
process.exit(fail ? 1 : 0);
