<template>
  <div ref="root" class="gd-screen">
    <!-- Cesium 画布：整页铺底，面板浮在上面 -->
    <div ref="host" class="globe" />

    <!-- 顶部标题条 -->
    <header class="top">
      <div class="brand">
        <span class="title">广东省低空飞行态势</span>
        <span class="sub">DUAV · 省域指挥大屏</span>
      </div>
      <div class="clock">{{ clock }}</div>
    </header>

    <!-- 顶部指标（全部来自真实接口，取不到就显示 —，绝不填假数） -->
    <div class="kpis">
      <div v-for="k in kpis" :key="k.label" class="kpi">
        <div class="kpi-val">
          <!--
            ⚠️ 两个坑，都是实测踩出来的，改这个块之前先读：
            1) 数字那个 span 必须用 v-show，不能用 v-if/v-else 和「—」互斥切换。
               v-if 切分支时指令会挂在被复用的元素上，之后值从 null 变成真实数字，
               指令的 updated 钩子不再触发 → 界面永远停在挂载时的 0（实测就是这样）。
               用 v-show 让指令始终挂在同一个稳定元素上，updated 才会正常跑。
            2) span 里只能写静态占位「0」，不能写 {{ k.value }}：
               v-count 会重写 textContent（等于换掉整个文本节点），而 Vue 的插值补丁
               仍握着旧文本节点引用，再写就写到了已脱离 DOM 的节点上。
               与 DashboardView 保持同一写法。
          -->
          <span v-show="k.value === null" class="dash">—</span>
          <!--
            数字不用 v-count 指令，改用组件内的 kpiAnim（见 animateKpis）。
            原因（实测，未深究到底层）：v-count 在这个页面里指令钩子确实收到了正确的值
            （mounted to=2 / to=47 都打出来了），但 DOM 上的文本始终停在挂载时的 0，
            加 :key 强制重建元素也一样。数字是大屏的脸面，不能靠"也许下次就好了"，
            所以改成由 Vue 自己渲染插值——文本归 Vue 管，就不会出现值和界面不一致。
          -->
          <span v-show="k.value !== null">{{ fmtNum(kpiAnim[k.label]) }}</span>
          <i v-if="k.unit" class="unit">{{ k.unit }}</i>
        </div>
        <div class="kpi-label">{{ k.label }}</div>
      </div>
    </div>

    <!-- 左下：地市工单分布 -->
    <section class="panel left">
      <h3>地市工单分布</h3>
      <div ref="barRef" class="chart chart-bar" />
      <p v-if="!cityTickets.length" class="empty">
        暂无工单的地域数据
        <span class="why">（工单地址来自逆地理解析，无地址时不计入）</span>
      </p>
      <p class="note">
        按街道名匹配到地级市，未匹配 <b>{{ ticketUnmatched }}</b> 条
      </p>
    </section>

    <!-- 右下：告警与设备 -->
    <section class="panel right">
      <h3>实时告警<span class="badge">{{ alerts.length }}</span></h3>
      <ul v-if="alerts.length" class="alerts">
        <li v-for="(a, i) in alerts" :key="i">
          <span class="dot" :class="a.level === 'error' ? 'err' : 'warn'" />
          <span class="atxt">{{ a.text }}</span>
        </li>
      </ul>
      <p v-else class="empty">当前无告警</p>

      <h3 class="mt">设备状态</h3>
      <ul class="devs">
        <li v-for="d in devices" :key="d.sn">
          <span class="dot" :class="d.online ? 'ok' : 'off'" />
          <span class="dname">{{ d.name }}</span>
          <span class="dmeta">{{ d.model }} · {{ d.online ? '在线' : '离线' }}</span>
        </li>
        <li v-if="!devices.length" class="empty">未取到设备</li>
      </ul>
    </section>

    <!-- 底部：趋势 -->
    <section class="panel bottom">
      <h3>近 7 天架次趋势</h3>
      <div ref="lineRef" class="chart chart-line" />
      <p v-if="trendAllZero" class="empty">
        近 7 天无飞行任务记录
        <span class="why">（口径：按任务完成时间统计，含手动与自动任务）</span>
      </p>
    </section>

    <!-- 底图切换 + 口径说明 -->
    <footer class="foot">
      <div class="foot-left">
        <el-radio-group v-model="basemap" size="small" @change="onBasemapChange">
          <el-radio-button value="none">无底图（离线）</el-radio-button>
          <el-radio-button value="amap">高德影像</el-radio-button>
        </el-radio-group>
        <span class="tip">
          边界：DataV.GeoAtlas 2024 版区划 · WGS84 · 21 地市
        </span>
      </div>
      <div class="foot-right">
        指标来自 /api/ops/* 与 /api/tickets/*，无数据显示空态，不做估算填充
      </div>
    </footer>
  </div>
</template>

<script setup>
/**
 * 广东省域态势大屏（/screen）
 *
 * 三条不可妥协的原则（沿用本项目一贯口径）：
 *  1. 指标全部来自真实接口；取不到显示「—」或空态，绝不用随机数/估算填充。
 *  2. 地市高亮只按「该市有无在线设备」判定，这是算出来的，不是编出来的。
 *  3. 底图默认「无」，保证内网离线可用；高德影像是可选增强，需要外网。
 *
 * 底座用 Cesium（见 docs/Cesium 底座引入论证.md 阶段 0 POC 已全项通过）：
 * 与方案 A 的平面装饰地图相比，真三维地球的收益是可以直接叠自有三维模型成果，
 * 代价是 +7.9MB 体积（已切成独立 chunk，不进业务页首屏）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

import gdGeo from '../assets/geo/440000.wgs84.json';
import { opsApi } from '../api/dji';
import { ticketApi } from '../api/duav';
import { makeGcj02TilingScheme, offlineViewerOptions } from '../utils/cesiumGcj';

/** 离线前提：禁 Ion（内网私有化部署下 Ion 必不通，且会卡住页面） */
Cesium.Ion.defaultAccessToken = '';
if (Cesium.Ion.defaultServer) Cesium.Ion.defaultServer = undefined;

const root = ref(null);
const host = ref(null);
const basemap = ref('none');
const clock = ref('');

const CITY_ACTIVE = '#22d3ee';
const CITY_IDLE = '#1e3a5f';
const EDGE = '#67e8f9';

const overview = ref(null);
const snapshot = ref(null);
const regionStats = ref([]);
let viewer = null;
let timer = null;
let clockTimer = null;
let barChart = null;
let lineChart = null;
const barRef = ref(null);
const lineRef = ref(null);
/** 供验收脚本读取的实测数字 */
const probe = { cities: 0, entities: 0, devicePoints: 0, cityTickets: [] };

/* ---------------- 数据派生 ---------------- */

const devices = computed(() => {
  const list = snapshot.value?.devices || [];
  return list.map((d) => ({
    sn: d.sn,
    name: d.callsign || d.sn,
    model: d.model || d.modelKey || '',
    online: !!d.online,
    kind: d.kind,
    lat: d.position?.lat ?? null,
    lng: d.position?.lng ?? null,
  }));
});

const kpis = computed(() => {
  const o = overview.value;
  const d = o?.devices || {};
  const f = o?.flight || {};
  return [
    { label: '在线机场', value: d.onlineAirports ?? null, unit: `/ ${d.airports ?? '—'}` },
    { label: '在线飞行器', value: d.onlineDrones ?? null, unit: `/ ${d.drones ?? '—'}` },
    { label: '架次', value: f.sorties ?? null, unit: '' },
    { label: '飞行里程', value: f.distanceKm ?? null, unit: 'km' },
    { label: '航线', value: o?.resources?.waylines ?? null, unit: '' },
    { label: '告警', value: o?.resources?.alerts ?? null, unit: '' },
  ];
});

const alerts = computed(() => {
  const list = overview.value?.alerts || [];
  return list.slice(0, 6).map((a) => ({
    level: a.level === 'error' ? 'error' : 'warn',
    // 接口里 message 常为空，此时退回 code，不编造文案
    text: a.message || a.code || '未命名告警',
  }));
});

/**
 * KPI 数字滚动：由组件自己用 rAF 推进，渲染走 Vue 插值
 *
 * 不复用 v-count 指令的原因见模板里的注释（实测该指令在本页写完 DOM 后不再更新）。
 * 这里刻意让「数字」完全由 Vue 渲染：动画只改响应式状态，不碰 textContent，
 * 界面上看到的数就是状态里的数，不会出现值和显示不一致。
 */
const kpiAnim = reactive({});
let animRaf = null;
const fmtNum = (v) => {
  if (v === null || v === undefined) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
function animateKpis() {
  if (animRaf) window.cancelAnimationFrame(animRaf);
  const targets = kpis.value.map((k) => [k.label, k.value]);
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (reduce) {
    for (const [label, to] of targets) kpiAnim[label] = to;
    return;
  }
  const from = {};
  for (const [label, to] of targets) from[label] = Number(kpiAnim[label]) || 0;
  const t0 = performance.now();
  const dur = 900;
  const ease = (t) => 1 - (1 - t) ** 3;
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    for (const [label, to] of targets) {
      if (to === null) continue;
      kpiAnim[label] = Number.isInteger(to)
        ? Math.round(from[label] + (to - from[label]) * ease(p))
        : Number((from[label] + (to - from[label]) * ease(p)).toFixed(1));
    }
    animRaf = p < 1 ? window.requestAnimationFrame(tick) : null;
  };
  animRaf = window.requestAnimationFrame(tick);
}

const trend = computed(() => overview.value?.trend || []);
const trendAllZero = computed(() => trend.value.length > 0 && trend.value.every((t) => !t.count));

/**
 * 街道级地址 → 地级市（方案 A：名称包含匹配）
 *
 * /api/tickets/stats/by-region 返回的是「广州市黄埔区穗东街道」这种街道级名称，
 * 直接与 21 个地市名 join 会全部落空。街道名必含市名，所以用包含匹配。
 * 匹配不上的单独计数并在界面上写明，不静默丢弃。
 */
const cityTickets = computed(() => {
  const rows = regionStats.value || [];
  const names = gdGeo.features.map((f) => f.properties.name);
  const map = new Map();
  let unmatched = 0;
  for (const r of rows) {
    const s = String(r.region || '');
    const hit = names.find((n) => s.includes(n.replace(/市$/, '')));
    if (!hit) {
      unmatched += Number(r.count) || 0;
      continue;
    }
    map.set(hit, (map.get(hit) || 0) + (Number(r.count) || 0));
  }
  probe.cityTickets = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return probe.cityTickets;
});
const ticketUnmatched = computed(() => {
  const total = (regionStats.value || []).reduce((n, r) => n + (Number(r.count) || 0), 0);
  const matched = cityTickets.value.reduce((n, [, c]) => n + c, 0);
  return total - matched;
});

/** 哪些市有在线设备：用真实经纬度做点在面判定，不是按名字猜 */
function pointInFeature(lng, lat, feature) {
  let inside = false;
  for (const poly of feature.geometry.coordinates) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

const activeCities = computed(() => {
  const set = new Set();
  for (const d of devices.value) {
    if (!d.online || d.lat == null || d.lng == null) continue;
    for (const f of gdGeo.features) {
      if (pointInFeature(d.lng, d.lat, f)) {
        set.add(f.properties.name);
        break;
      }
    }
  }
  return set;
});

/* ---------------- Cesium ---------------- */

const Gcj02Scheme = makeGcj02TilingScheme(Cesium);

function buildCities() {
  const active = activeCities.value;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  let n = 0;
  for (const f of gdGeo.features) {
    const name = f.properties.name;
    const isActive = active.has(name);
    const h = isActive ? 45000 : 18000;
    for (const poly of f.geometry.coordinates) {
      const positions = Cesium.Cartesian3.fromDegreesArray(poly[0].flat());
      if (positions.length < 3) continue;
      const base = Cesium.Color.fromCssColorString(isActive ? CITY_ACTIVE : CITY_IDLE);
      const alpha = isActive ? 0.45 : 0.28;
      // 呼吸只给「有在线设备」的市：它是状态提示，不是装饰噪音
      const material =
        isActive && !reduceMotion
          ? new Cesium.ColorMaterialProperty(
              new Cesium.CallbackProperty(() => {
                const t = performance.now() / 1000;
                return base.withAlpha(alpha + 0.18 * (0.5 + 0.5 * Math.sin(t * 2)));
              }, false)
            )
          : base.withAlpha(alpha);
      viewer.entities.add({
        name: `city:${name}`,
        polygon: { hierarchy: new Cesium.PolygonHierarchy(positions), extrudedHeight: h, material },
      });
      // 顶边描边：拉伸块没有描边会糊成一片
      viewer.entities.add({
        name: `edge:${name}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            poly[0].flatMap(([lng, lat]) => [lng, lat, h])
          ),
          width: 2,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString(isActive ? EDGE : '#3b82f6').withAlpha(
              isActive ? 0.9 : 0.45
            ),
          }),
        },
      });
      n += 1;
    }
  }
  probe.cities = gdGeo.features.length;
  probe.entities = n;
}

function buildDevices() {
  let n = 0;
  for (const d of devices.value) {
    if (d.lat == null || d.lng == null) continue;
    const color = d.online ? Cesium.Color.fromCssColorString('#22c55e') : Cesium.Color.fromCssColorString('#94a3b8');
    // 光柱：从地面拉到 8km，让点位在省域视角下也看得见
    viewer.entities.add({
      name: `beam:${d.name}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([d.lng, d.lat, 0, d.lng, d.lat, 8000]),
        width: 2,
        material: color.withAlpha(d.online ? 0.75 : 0.3),
      },
    });
    viewer.entities.add({
      name: `dev:${d.name}`,
      position: Cesium.Cartesian3.fromDegrees(d.lng, d.lat, 8200),
      point: { pixelSize: 10, color, outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
      label: {
        text: d.name,
        font: '12px sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#00000099'),
        pixelOffset: new Cesium.Cartesian2(0, -26),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1500000),
      },
    });
    n += 1;
  }
  probe.devicePoints = n;
}

function rebuildEntities() {
  if (!viewer) return;
  viewer.entities.removeAll();
  buildCities();
  buildDevices();
}

function setBasemap(kind) {
  if (!viewer) return;
  const layers = viewer.imageryLayers;
  layers.removeAll();
  if (kind === 'none') return;
  layers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      subdomains: ['1', '2', '3', '4'],
      tilingScheme: new Gcj02Scheme(),
      maximumLevel: 18,
    })
  );
}
const onBasemapChange = (v) => setBasemap(v);

function createViewer() {
  viewer = new Cesium.Viewer(host.value, {
    ...offlineViewerOptions({ requestRender: false }),
    // 关键：不要 Ion 默认影像，baseLayer:false 让地球一开始就只有底色。
    // ⚠️ 不要写 globe:false —— 那会把整个地球关掉，只剩黑屏。
    baseLayer: false,
  });
  const scene = viewer.scene;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#06162e');
  scene.globe.showGroundAtmosphere = true;
  scene.skyAtmosphere.show = true;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#020813');
  scene.screenSpaceCameraController.minimumZoomDistance = 50000;
  // 省域视角下不需要倾斜到地平线以下
  scene.screenSpaceCameraController.maximumTiltAngle = (85 * Math.PI) / 180;
  viewer.camera.setView({
    destination: Cesium.Rectangle.fromDegrees(108.6, 19.5, 118.3, 26.4),
  });
}

/* ---------------- 图表 ---------------- */

function renderBar() {
  if (!barRef.value) return;
  barChart = barChart || echarts.init(barRef.value);
  const rows = cityTickets.value.slice(0, 8);
  barChart.setOption(
    {
      grid: { left: 60, right: 16, top: 8, bottom: 8 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: '#ffffff12' } }, axisLabel: { color: '#8fa3bf', fontSize: 10 } },
      yAxis: {
        type: 'category',
        data: rows.map(([n]) => n).reverse(),
        axisLabel: { color: '#cbd5e1', fontSize: 11 },
        axisLine: { lineStyle: { color: '#ffffff20' } },
      },
      series: [
        {
          type: 'bar',
          data: rows.map(([, c]) => c).reverse(),
          barWidth: 10,
          itemStyle: { color: '#22d3ee', borderRadius: [0, 4, 4, 0] },
        },
      ],
    },
    true
  );
}

function renderLine() {
  if (!lineRef.value) return;
  lineChart = lineChart || echarts.init(lineRef.value);
  const t = trend.value;
  lineChart.setOption(
    {
      grid: { left: 40, right: 16, top: 10, bottom: 22 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: t.map((x) => x.label),
        axisLabel: { color: '#8fa3bf', fontSize: 10 },
        axisLine: { lineStyle: { color: '#ffffff20' } },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: '#ffffff12' } },
        axisLabel: { color: '#8fa3bf', fontSize: 10 },
      },
      series: [
        {
          type: 'line',
          data: t.map((x) => x.count),
          smooth: true,
          symbolSize: 5,
          lineStyle: { color: '#22d3ee', width: 2 },
          itemStyle: { color: '#22d3ee' },
          areaStyle: { color: 'rgba(34,211,238,0.15)' },
        },
      ],
    },
    true
  );
}

/* ---------------- 生命周期 ---------------- */

async function loadAll() {
  const [o, s, r] = await Promise.all([
    opsApi.overview().catch(() => null),
    opsApi.snapshot().catch(() => null),
    ticketApi.statsByRegion().catch(() => null),
  ]);
  if (o?.data) overview.value = o.data;
  if (s?.data) snapshot.value = s.data;
  // 把派生后的真实值也暴露给验收脚本：界面数字对不上时，
  // 一眼就能分辨是「数据没到」还是「渲染没写进去」，不用靠猜
  probe.kpis = kpis.value.map((k) => ({ label: k.label, value: k.value }));
  // 注意：工单统计接口是 { code:0, data:[...] }，不是 { ok, data }
  if (r?.data) regionStats.value = r.data;
  animateKpis();
  rebuildEntities();
  renderBar();
  renderLine();
}

const tick = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  clock.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

onMounted(async () => {
  createViewer();
  setBasemap(basemap.value);
  tick();
  clockTimer = window.setInterval(tick, 1000);
  await loadAll();
  timer = window.setInterval(loadAll, 60000);
  window.__GD_SCREEN__ = { probe, ready: true, getViewer: () => viewer };
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  window.clearInterval(clockTimer);
  if (animRaf) window.cancelAnimationFrame(animRaf);
  barChart?.dispose();
  lineChart?.dispose();
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
  delete window.__GD_SCREEN__;
});
</script>

<style scoped>
.gd-screen {
  position: relative;
  width: 100%;
  height: calc(100vh - 56px);
  overflow: hidden;
  background: #020813;
  color: #e2e8f0;
  font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
.globe {
  position: absolute;
  inset: 0;
}
.globe :deep(.cesium-widget-credits) {
  display: none;
}

.top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 62px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  background: linear-gradient(180deg, #020813ee, #02081300);
  pointer-events: none;
}
.brand .title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 2px;
  background: linear-gradient(90deg, #a5f3fc, #22d3ee);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.brand .sub {
  margin-left: 12px;
  font-size: 12px;
  color: #64748b;
  letter-spacing: 1px;
}
.clock {
  font-size: 14px;
  color: #94a3b8;
  font-variant-numeric: tabular-nums;
}

.kpis {
  position: absolute;
  top: 58px;
  left: 20px;
  right: 20px;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  max-width: 900px;
}
.kpi {
  background: #0b1a2ecc;
  border: 1px solid #1e3a5f;
  border-radius: 6px;
  padding: 8px 10px;
  backdrop-filter: blur(4px);
}
.kpi-val {
  font-size: 22px;
  font-weight: 700;
  color: #22d3ee;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.kpi-val .dash {
  color: #475569;
}
.kpi-val .unit {
  font-size: 11px;
  font-weight: 400;
  color: #64748b;
  margin-left: 3px;
  font-style: normal;
}
.kpi-label {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
}

.panel {
  position: absolute;
  background: #0b1a2ed9;
  border: 1px solid #1e3a5f;
  border-radius: 8px;
  padding: 12px 14px;
  backdrop-filter: blur(6px);
}
.panel h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #cbd5e1;
  letter-spacing: 1px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.panel h3.mt {
  margin-top: 14px;
}
.badge {
  background: #b4530933;
  color: #fbbf24;
  border-radius: 8px;
  padding: 0 6px;
  font-size: 11px;
}
.left {
  left: 20px;
  bottom: 118px;
  width: 300px;
}
.right {
  right: 20px;
  bottom: 118px;
  width: 300px;
}
.bottom {
  left: 50%;
  transform: translateX(-50%);
  bottom: 22px;
  width: 520px;
}

.chart-bar {
  height: 190px;
}
.chart-line {
  height: 100px;
}
.empty {
  font-size: 12px;
  color: #64748b;
  margin: 6px 0 0;
}
.empty .why {
  color: #475569;
}
.note {
  font-size: 11px;
  color: #64748b;
  margin: 6px 0 0;
}

.alerts,
.devs {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 150px;
  overflow: auto;
}
.alerts li,
.devs li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 3px 0;
  color: #cbd5e1;
}
.atxt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dmeta {
  margin-left: auto;
  color: #64748b;
  font-size: 11px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.dot.ok {
  background: #22c55e;
}
.dot.off {
  background: #64748b;
}
.dot.warn {
  background: #fbbf24;
}
.dot.err {
  background: #ef4444;
}

.foot {
  position: absolute;
  left: 20px;
  right: 20px;
  bottom: 4px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: #475569;
}
.foot-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tip {
  color: #475569;
}

@media (max-width: 1440px) {
  .left,
  .right {
    width: 260px;
  }
  .bottom {
    width: 420px;
  }
  .kpis {
    max-width: 720px;
  }
}
</style>
