/**
 * 广东省域态势大屏验收（/screen）
 *
 * 对齐 docs/广东省域大屏-技术论证.md 第七节：
 *   1. 21 个地级市全部渲染
 *   2. 指标来自真实接口；无数据显示空态而不是假数据
 *   3. 1366 / 1920 / 2560 三档分辨率无溢出、无重叠
 *   4. 控制台 0 错误
 *   5. 独立页面，不影响主大屏
 *
 * 另外补三条本项目特有的硬要求（都是踩过坑后才加的）：
 *   - 页面数字必须与接口返回一致（防止 UI 里混入硬编码假数据）
 *   - 地市高亮必须是「算出来的」（点在面判定），不是按名字猜
 *   - Cesium 不能请求任何外部域名（离线前提）
 *
 * 依赖 playwright-core + 系统 Chrome，缺失则跳过（退出码 0）。
 * 用法：先起后端（node server/src/index.js），再 node scripts/verify-screen.mjs
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(PW) || !existsSync(CHROME)) {
  console.log('⏭  未找到 playwright-core / Chrome，跳过省域大屏验收');
  process.exit(0);
}
const mod = await import(PW);
const chromium = mod.chromium || mod.default.chromium;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';

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

const jget = async (u) => fetch(u).then((r) => r.json()).catch(() => null);
const ping = await jget(`${BASE}/api/ping`);
if (!ping?.ok) {
  console.log(`✗ 后端未启动（${BASE}/api/ping 无响应）`);
  process.exit(1);
}

// 接口侧先取一份真值，用来核对页面上的数字不是硬编码
const ov = await jget(`${BASE}/api/ops/overview`);
const snap = await jget(`${BASE}/api/ops/snapshot`);
const region = await jget(`${BASE}/api/tickets/stats/by-region`);
const expectDevices = (snap?.data?.devices || []).filter(
  (d) => d.position?.lat != null && d.position?.lng != null
).length;
info(`接口真值：机场 ${ov?.data?.devices?.airports}，在线机场 ${ov?.data?.devices?.onlineAirports}，告警 ${ov?.data?.resources?.alerts}，带坐标设备 ${expectDevices}`);

console.log('\n=== 广东省域态势大屏验收 ===\n');

const b = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
});
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
const external = [];
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
p.on('request', (r) => {
  const u = new URL(r.url());
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') external.push(u.host);
});

try {
  await p.goto(`${BASE}/screen`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => window.__GD_SCREEN__?.ready === true, { timeout: 120000 });
  await p.waitForTimeout(3000); // 等地市实体与图表渲染完

  /* ---------------- 1. 地市渲染 ---------------- */
  console.log('[1] 行政区渲染');
  const probe = await p.evaluate(() => window.__GD_SCREEN__.probe);
  ok('21 个地级市全部建模', probe.cities === 21, `${probe.cities} 个市 / ${probe.entities} 个面`);
  ok('带坐标的设备已落点', probe.devicePoints === expectDevices, `${probe.devicePoints} / 接口 ${expectDevices}`);

  /* ---------------- 2. 真实数据核对 ---------------- */
  console.log('\n[2] 指标与接口一致（防硬编码假数据）');
  // ⚠️ 必须只读「数值」那个 span，不能读 .kpi-val 整串：
  // 整串里含单位（如「0/ 2」），用 includes 匹配接口值会被单位里的数字蒙对，造成假阳性。
  // 另外 v-count 有 900ms 滚动动画，断言前要等它滚完，否则读到的是中间值。
  const readKpi = () =>
    p.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('.kpi')) {
        const label = el.querySelector('.kpi-label')?.innerText?.trim();
        // 必须排除 .dash（「—」占位 span 常驻 DOM，靠 v-show 隐藏），否则读到「—」→ NaN
        const num = el.querySelector('.kpi-val span:not(.dash)');
        out[label] = num ? Number(num.innerText.trim()) : null;
      }
      return out;
    });
  await p.waitForTimeout(1500); // 等数字滚动结束
  const shown = await readKpi();
  info(`页面 KPI：${Object.entries(shown).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  const eq = (label, want) => {
    const got = shown[label];
    ok(`${label} 与接口一致`, got === want, `页面 ${got} / 接口 ${want}`);
  };
  // 告警数会随时间变化，用页面自己拿到的那份接口值比对，不跨时刻比
  const pageOv = await p.evaluate(() => fetch('/api/ops/overview').then((r) => r.json()).then((j) => j.data));
  eq('在线机场', pageOv?.devices?.onlineAirports);
  eq('在线飞行器', pageOv?.devices?.onlineDrones);
  eq('告警', pageOv?.resources?.alerts);
  eq('航线', pageOv?.resources?.waylines);

  const regionRows = region?.data || [];
  const totalTickets = regionRows.reduce((n, r) => n + (Number(r.count) || 0), 0);
  const cityRows = probe.cityTickets.length;
  if (totalTickets > 0) {
    ok('街道级工单已匹配到地市', cityRows > 0, `${cityRows} 个市有工单，接口共 ${totalTickets} 条`);
  } else {
    info('接口无工单地域数据，跳过匹配断言（页面应显示空态）');
    ok('无数据时显示空态而非假数据', await p.locator('.left .empty').count() > 0);
  }

  /* ---------------- 3. 空态与口径 ---------------- */
  console.log('\n[3] 空态与口径说明');
  const trendZero = (ov?.data?.trend || []).every((t) => !t.count);
  if (trendZero) {
    ok('趋势全 0 时给出口径说明', (await p.locator('.bottom .empty').count()) > 0, '近 7 天无任务');
  } else {
    info('趋势有数据，跳过空态断言');
  }
  ok('页脚标明了数据来源与区划版本',
    (await p.locator('.foot').innerText()).includes('WGS84'));

  /* ---------------- 4. 三档分辨率 ---------------- */
  console.log('\n[4] 分辨率自适应');
  for (const [w, h] of [[1366, 768], [1920, 1080], [2560, 1440]]) {
    await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(600);
    const over = await p.evaluate(() => {
      const d = document.documentElement;
      return d.scrollWidth - d.clientWidth;
    });
    // 面板是否互相压住：左下与右下两块在 1366 下最容易撞车
    const collide = await p.evaluate(() => {
      const l = document.querySelector('.panel.left')?.getBoundingClientRect();
      const r = document.querySelector('.panel.right')?.getBoundingClientRect();
      if (!l || !r) return false;
      return l.right > r.left && l.bottom > r.top && l.top < r.bottom;
    });
    ok(`${w}×${h} 无横向溢出`, over <= 0, `溢出 ${over}px`);
    ok(`${w}×${h} 左右面板不重叠`, !collide);
    await p.screenshot({ path: path.join(WEB_ROOT, `dist/screen-${w}.png`) }).catch(() => {});
  }
  await p.setViewportSize({ width: 1920, height: 1080 });

  /* ---------------- 5. 行政区名 + 区县层级（缩放 LOD） ---------------- */
  console.log('\n[5] 行政区名与区县层级');
  // Cesium 的 label 画在 canvas 里，DOM 上查不到，只能从实体上读文本——
  // 但「文本存在」不等于「画出来了」，所以这一节再配一张截图做人眼确认。
  const readLabels = (prefix) =>
    p.evaluate((pfx) => {
      const v = window.__GD_SCREEN__.getViewer();
      const out = [];
      for (const e of v.entities.values) {
        if (typeof e.name === 'string' && e.name.startsWith(pfx) && e.label) {
          const t = e.label.text?.getValue?.();
          out.push({ text: t, show: e.show });
        }
      }
      return out;
    }, prefix);

  const cityNames = await readLabels('citylabel:');
  const cityTexts = cityNames.map((l) => l.text);
  ok('21 个地市名已标注', cityTexts.length === 21, `实际 ${cityTexts.length} 个`);
  ok(
    '市名是真实区划名（抽查）',
    ['广州市', '深圳市', '佛山市'].every((n) => cityTexts.includes(n)),
    cityTexts.slice(0, 4).join('、') + ' …'
  );

  const beforeZoom = await p.evaluate(() => window.__GD_SCREEN__.probe);
  info(`首屏相机高度 ${Math.round(beforeZoom.cameraHeight / 1000)} km，层级 ${beforeZoom.level}`);
  ok(
    '首屏不加载区县数据（835KB 按需加载）',
    beforeZoom.districtTotal === 0,
    `首屏区县要素 ${beforeZoom.districtTotal}`
  );

  // 缩到广州市域上空：高度 150km < 260km 阈值，应切到区县级
  await p.evaluate(() => {
    const v = window.__GD_SCREEN__.getViewer();
    // 页面里没有全局 Cesium，从已有对象的构造函数反查 Cartesian3
    const C3 = v.camera.position.constructor;
    v.camera.setView({ destination: C3.fromDegrees(113.3, 23.2, 150000) });
  });
  await p.waitForFunction(() => window.__GD_SCREEN__.probe.level === 'district', { timeout: 30000 })
    .catch(() => {});
  await p.waitForFunction(() => window.__GD_SCREEN__.probe.districtTotal > 0, { timeout: 30000 })
    .catch(() => {});
  await p.waitForTimeout(1500);

  const inDistrict = await p.evaluate(() => window.__GD_SCREEN__.probe);
  ok('缩放到阈值以下切换到区县级', inDistrict.level === 'district',
    `相机高度 ${Math.round(inDistrict.cameraHeight / 1000)} km`);
  ok('区县已渲染', inDistrict.districtTotal > 100, `${inDistrict.districtTotal} 个区县`);
  ok('区县实体已显示', inDistrict.districtShown > 0, `${inDistrict.districtShown} 个实体`);
  ok('区县名已标注', inDistrict.districtLabels > 100, `${inDistrict.districtLabels} 个标注`);
  ok(
    '区县归属自检通过（坐标系一致性）',
    String(inDistrict.districtOfCityCheck).startsWith('ok'),
    inDistrict.districtOfCityCheck || '（未执行）'
  );
  const distNames = (await readLabels('distlabel:')).map((l) => l.text);
  ok(
    '区县名是真实区划名（抽查）',
    ['天河区', '越秀区', '南山区'].every((n) => distNames.includes(n)),
    distNames.slice(0, 4).join('、') + ' …'
  );
  await p.screenshot({ path: path.join(WEB_ROOT, 'dist/screen-district.png') }).catch(() => {});

  // 拉回省域视角：区县应隐藏，避免与市级拉伸块叠着画
  await p.evaluate(() => {
    const v = window.__GD_SCREEN__.getViewer();
    const C3 = v.camera.position.constructor;
    v.camera.setView({ destination: C3.fromDegrees(113.5, 23.5, 900000) });
  });
  await p.waitForTimeout(2000);
  const backCity = await p.evaluate(() => window.__GD_SCREEN__.probe);
  ok('拉回省域视角回到地市级', backCity.level === 'city',
    `相机高度 ${Math.round(backCity.cameraHeight / 1000)} km`);
  ok('回到市级后区县实体已隐藏', backCity.districtShown === 0, `${backCity.districtShown} 个仍显示`);

  /* ---------------- 6. 双击下钻（市 → 区县） ---------------- */
  console.log('\n[6] 双击下钻：市 → 区县');
  // 先回到省域地市视角
  await p.evaluate(() => {
    const v = window.__GD_SCREEN__.getViewer();
    const C3 = v.camera.position.constructor;
    v.camera.setView({ destination: C3.fromDegrees(113.5, 23.5, 900000) });
  });
  await p.waitForTimeout(1500);

  // 双击广州市立体块：模拟拾取广州市实体并触发下钻
  await p.evaluate(() => {
    const v = window.__GD_SCREEN__.getViewer();
    const city = v.entities.values.find((e) => e.name === 'city:广州市');
    if (city) window.__GD_SCREEN__.drillDown && window.__GD_SCREEN__.drillDown('广州市');
  });
  await p.waitForFunction(() => window.__GD_SCREEN__.probe.drilledCity === '广州市', { timeout: 30000 })
    .catch(() => {});
  await p.waitForTimeout(1500);

  const afterDrill = await p.evaluate(() => window.__GD_SCREEN__.probe);
  ok('双击后进入下钻状态', afterDrill.level === 'district-drilled', `层级 ${afterDrill.level}`);
  ok('下钻目标市为广州市', afterDrill.drilledCity === '广州市', afterDrill.drilledCity || '空');
  const gzDistricts = await p.evaluate(() => {
    const v = window.__GD_SCREEN__.getViewer();
    return v.entities.values.filter((e) => typeof e.name === 'string' && e.name.startsWith('dist:') && e.show).length;
  });
  ok('广州市下辖区县已显示', gzDistricts >= 10, `${gzDistricts} 个区县面/边显示`);
  const solidState = await p.evaluate(() => {
    const v = window.__GD_SCREEN__.getViewer();
    const gz = v.entities.values.find((e) => e.name === 'city:广州市');
    const others = v.entities.values.filter(
      (e) => typeof e.name === 'string' && e.name.startsWith('city:') && e.name !== 'city:广州市'
    );
    return {
      gzShown: !!gz?.show,
      othersShown: others.filter((e) => e.show).length,
      othersTotal: others.length,
    };
  });
  ok('目标市立体块已隐藏（让位给区县平面）', solidState.gzShown === false);
  ok(
    '其他市立体块保持可见（可直接双击切换）',
    solidState.othersShown === solidState.othersTotal && solidState.othersTotal > 0,
    `${solidState.othersShown}/${solidState.othersTotal} 个市仍可点击`
  );
  await p.screenshot({ path: path.join(WEB_ROOT, 'dist/screen-drill-guangzhou.png') }).catch(() => {});

  /* ---------------- 6b. 下钻状态下切换到另一个市 ---------------- */
  console.log('\n[6b] 下钻状态下切换到另一个市');
  await p.evaluate(() => {
    window.__GD_SCREEN__.drillDown && window.__GD_SCREEN__.drillDown('深圳市');
  });
  await p.waitForFunction(() => window.__GD_SCREEN__.probe.drilledCity === '深圳市', { timeout: 30000 })
    .catch(() => {});
  await p.waitForTimeout(1500);

  const afterSwitch = await p.evaluate(() => window.__GD_SCREEN__.probe);
  ok('直接切换到深圳市', afterSwitch.drilledCity === '深圳市', afterSwitch.drilledCity || '空');
  ok('切换后仍处于下钻层级', afterSwitch.level === 'district-drilled', `层级 ${afterSwitch.level}`);
  const switchState = await p.evaluate(() => {
    const v = window.__GD_SCREEN__.getViewer();
    const gz = v.entities.values.find((e) => e.name === 'city:广州市');
    const sz = v.entities.values.find((e) => e.name === 'city:深圳市');
    const shownDist = v.entities.values
      .filter((e) => typeof e.name === 'string' && e.name.startsWith('dist:') && e.show)
      .map((e) => e.name);
    return {
      gzShown: !!gz?.show,
      szShown: !!sz?.show,
      shownDistCount: shownDist.length,
    };
  });
  ok('深圳市立体块已隐藏', switchState.szShown === false);
  ok('广州市立体块已恢复（可再次切回）', switchState.gzShown === true);
  ok(
    '切换后仅深圳市区县可见',
    switchState.shownDistCount > 0 && switchState.shownDistCount < gzDistricts + 30,
    `${switchState.shownDistCount} 个区县面/边显示`
  );
  await p.screenshot({ path: path.join(WEB_ROOT, 'dist/screen-drill-shenzhen.png') }).catch(() => {});

  // 点击「返回全省」
  await p.click('.back-btn').catch(() => {});
  await p.waitForFunction(() => !window.__GD_SCREEN__.probe.drilledCity, { timeout: 30000 })
    .catch(() => {});
  await p.waitForTimeout(1500);
  const afterBack = await p.evaluate(() => window.__GD_SCREEN__.probe);
  ok('返回全省后恢复地市级', afterBack.level === 'city', `层级 ${afterBack.level}`);
  ok('返回全省后下钻目标清空', afterBack.drilledCity === '', afterBack.drilledCity || '空');
  ok('返回全省后区县实体已隐藏', afterBack.districtShown === 0, `${afterBack.districtShown} 个仍显示`);

  /* ---------------- 7. 离线与控制台 ---------------- */
  console.log('\n[7] 离线与控制台');
  ok('未请求任何外部域名', external.length === 0, external.length ? [...new Set(external)].join(', ') : '（无）');
  const realErrs = errs.filter((t) => !/ERR_FAILED|ERR_ABORTED|net::/i.test(t));
  ok('控制台 0 错误', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));
} finally {
  await b.close();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log(fail ? '判定：省域大屏未通过验收。' : '判定：省域大屏通过验收。');
process.exit(fail ? 1 : 0);
