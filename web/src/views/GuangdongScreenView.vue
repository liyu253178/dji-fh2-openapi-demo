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
        <!-- 底图固定高德影像（2026-10-02 产品决策）：不再提供「无底图（离线）」选项，
             setBasemap 的 'none' 分支仅作为代码兜底保留 -->
        <el-radio-group v-model="basemap" size="small" @change="onBasemapChange">
          <el-radio-button value="amap">高德影像</el-radio-button>
        </el-radio-group>
        <span class="tip">
          边界：DataV.GeoAtlas 2024 版区划 · WGS84 · 21 地市 / {{ districtTotal || '—' }} 区县
          · 当前层级：<b>{{ levelText }}</b>
          <template v-if="drilledCity">
            · 正在展示 <b>{{ drilledCity }}</b> 的区县级图层（双击其他地市可直接切换）
          </template>
          <template v-else-if="districtStatus === 'loading'">（区县数据加载中…）</template>
          <template v-else-if="districtStatus === 'error'">（区县数据加载失败，已保留地市级）</template>
          <template v-else>（滚轮缩放到 {{ (LOD_KM) }} km 以下自动展开区县，或双击任意地市下钻）</template>
        </span>
        <el-button
          v-if="drilledCity"
          type="primary"
          size="small"
          class="back-btn"
          @click="backToProvince"
        >
          返回全省
        </el-button>
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
 *  3. 底图固定高德影像（2026-10-02 产品决策，需要外网）；'none' 分支仅作代码兜底，
 *     如果将来要回内网离线部署，把 basemap 初始值改回 'none' 即可。
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
const basemap = ref('amap'); // 底图固定高德影像，不再提供无底图选项
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
const probe = {
  cities: 0,
  entities: 0,
  devicePoints: 0,
  cityTickets: [],
  cityLabels: 0, // 行政区名标注数（市）
  districtTotal: 0, // 区县级面要素数
  districtShown: 0, // 当前实际显示的区县实体数
  districtLabels: 0,
  level: 'city', // 'city' | 'district'
  cameraHeight: 0, // 相机高度（米），实测值
  districtOfCityCheck: '', // 区县归属抽查结果（坐标系一致性自检）
  districtSample: '', // 抽查样例，如「广州市/天河区」
  drilledCity: '', // 当前下钻目标市
  drillable: true, // 是否已绑定双击下钻事件
};

/* ---------------- 区县层级（缩放 LOD） ----------------
 * 区县数据 835KB，不进首屏：只在相机降到阈值以下时才 fetch。
 * 放在 public/ 而不是打包进 bundle，就是为了这条——首屏代价必须是 0。
 */
const DISTRICT_URL = `${import.meta.env.BASE_URL}geo/440000.districts.json`;
/** 相机高度低于此值（米）进入区县层级。广东南北跨度约 660km，260km 大致对应「看到单个市域」 */
const LOD_DISTRICT_HEIGHT = 260000;
const LOD_KM = Math.round(LOD_DISTRICT_HEIGHT / 1000);

/** 区县面数据：加载一次后常驻，之后只切 show，不来回重建 */
let districtData = null;
let districtLoading = false;
/** @type {{entity: object, poly: number[][]}[]} 市立体块，切换层级时要改高度/显隐 */
const citySolids = [];
/** @type {{entity: object, poly: number[][], h: number}[]} 市描边 */
const cityEdges = [];
/** @type {{entity: object, poly: number[][]}[]} 市名标注（常显，不随层级隐藏） */
const cityLabels = [];
/** @type {object[]} 全部区县实体（面/边/名），构建后只切 show */
const districtEntities = [];
/** @type {Map<string, object[]>} 按市分组的区县实体，用于双击下钻 */
const districtByCity = new Map();
const level = ref('city');
const districtTotal = ref(0);
const districtStatus = ref('idle'); // idle | loading | ready | error
const drilledCity = ref(''); // 当前下钻到的市名（空表示省域/地市视角）
const levelText = computed(() => {
  if (drilledCity.value) return '区县（下钻）';
  return level.value === 'district' ? '区县' : '地市';
});
let lodListener = null;
/** 双击事件处理器 */
let dblClickHandler = null;

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

/**
 * 多边形环 → 标注锚点。
 * 优先用官方 center；没有时退化成「环的经度/纬度范围中点」而不是算术平均点——
 * 算术平均会被密集顶点拉偏，凹形行政区上尤其明显。
 */
function labelAnchor(ring, center) {
  if (Array.isArray(center) && center.length === 2) return center;
  let minx = 180;
  let maxx = -180;
  let miny = 90;
  let maxy = -90;
  for (const [x, y] of ring) {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  return [(minx + maxx) / 2, (miny + maxy) / 2];
}

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
      const solid = viewer.entities.add({
        name: `city:${name}`,
        polygon: { hierarchy: new Cesium.PolygonHierarchy(positions), extrudedHeight: h, material },
      });
      citySolids.push({ entity: solid, poly: poly[0], isActive, cityName: name });
      // 顶边描边：拉伸块没有描边会糊成一片
      const edge = viewer.entities.add({
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
      cityEdges.push({ entity: edge, poly: poly[0], h, cityName: name });
      n += 1;
    }
    // 行政区名：浮在拉伸块顶面之上，否则会被块自己盖住
    const outerRing = f.geometry.coordinates[0]?.[0] || [];
    const [clng, clat] = labelAnchor(outerRing, f.properties.center);
    const lb = viewer.entities.add({
      name: `citylabel:${name}`,
      position: Cesium.Cartesian3.fromDegrees(clng, clat, h + 2000),
      label: {
        text: name,
        font: '600 15px sans-serif',
        fillColor: Cesium.Color.fromCssColorString(isActive ? '#e6fbff' : '#cbd5e1'),
        outlineColor: Cesium.Color.fromCssColorString('#020813'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#041223aa'),
        backgroundPadding: new Cesium.Cartesian2(5, 2),
        // 太远时缩小，避免省域视角下 21 个名字糊成一团
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.0, 2.5e6, 0.55),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6.0e6),
      },
    });
    cityLabels.push({ entity: lb, poly: outerRing, h, cityName: name });
  }
  probe.cities = gdGeo.features.length;
  probe.cityLabels = cityLabels.length;
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

/**
 * 构建区县实体。
 * 只构建一次：之后进/出区县层级靠 show 切换，不做「移除—重建」——
 * 124 个区县 × 3 类实体来回重建会让缩放过程明显卡顿。
 */
function buildDistricts() {
  if (!districtData || !viewer) return;
  districtEntities.length = 0;
  districtByCity.clear();
  for (const f of districtData.features) {
    const name = f.properties.name;
    const city = f.properties.cityName || '';
    const cityGroup = districtByCity.get(city) || [];
    const created = [];
    for (const poly of f.geometry.coordinates) {
      const ring = poly[0];
      const positions = Cesium.Cartesian3.fromDegreesArray(ring.flat());
      if (positions.length < 3) continue;
      const face = viewer.entities.add({
        name: `dist:${name}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          // 不拉伸：区县层级是「看区划」，贴地填色才有行政边界的读法
          material: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.16),
        },
        show: false,
      });
      const edge = viewer.entities.add({
        name: `distedge:${name}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            ring.flatMap(([lng, lat]) => [lng, lat, 400])
          ),
          width: 1.5,
          material: Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.8),
        },
        show: false,
      });
      districtEntities.push(face, edge);
      created.push(face, edge);
    }
    const [clng, clat] = labelAnchor(
      f.geometry.coordinates[0]?.[0] || [],
      f.properties.center
    );
    const lb = viewer.entities.add({
      name: `distlabel:${name}`,
      position: Cesium.Cartesian3.fromDegrees(clng, clat, 1500),
      label: {
        text: name,
        // 13px 起步：150km 相机高度下 scaleByDistance 还会再乘 ~0.8，
        // 11px 实测会缩到 7px 左右，肉眼读不了（首版验收截图踩过）
        font: '600 13px sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#e0f2fe'),
        outlineColor: Cesium.Color.fromCssColorString('#020813'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        // 区县名只在「再近一点」才出现，避免中距离下 124 个名字互相压字
        scaleByDistance: new Cesium.NearFarScalar(5.0e4, 1.0, 6.0e5, 0.7),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5.0e5),
      },
      show: false,
    });
    districtEntities.push(lb);
    created.push(lb);
    if (city) {
      cityGroup.push(...created);
      districtByCity.set(city, cityGroup);
    }
    // 归属自检留痕：区县名带上市名，验收脚本据此抽查「区县确实在它的市里」
    if (city && !probe.districtSample) probe.districtSample = `${city}/${name}`;
  }
  probe.districtTotal = districtData.features.length;
  probe.districtLabels = districtEntities.filter((e) => e.label).length;
  districtTotal.value = districtData.features.length;
}

/** 按需拉取区县数据：只有真的缩到区县层级才发起请求 */
async function ensureDistricts() {
  if (districtData || districtLoading) return;
  districtLoading = true;
  districtStatus.value = 'loading';
  try {
    const res = await fetch(DISTRICT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    districtData = await res.json();
    buildDistricts();
    checkDistrictInCity();
    districtStatus.value = 'ready';
  } catch (e) {
    // 加载失败不能让大屏变成「什么都没有」：停在市级并明确告知，不静默降级
    districtStatus.value = 'error';
    console.warn('[screen] 区县数据加载失败，保持地市级：', e?.message || e);
  } finally {
    districtLoading = false;
    applyLod();
  }
}

/**
 * 坐标系一致性自检：每个区县的中心点必须落在它所属市的多边形内。
 * 这条看似多余，实际是唯一能自动发现「市/区县两层数据坐标系不一致」的手段——
 * 一旦错位（比如一层 GCJ、一层 WGS84），抽查会失败而不是悄悄画歪。
 */
function checkDistrictInCity() {
  const byCity = new Map();
  for (const f of gdGeo.features) byCity.set(f.properties.name, f);
  let bad = 0;
  const samples = [];
  for (const f of districtData.features) {
    const [lng, lat] = labelAnchor(
      f.geometry.coordinates[0]?.[0] || [],
      f.properties.center
    );
    const city = byCity.get(f.properties.cityName);
    if (!city) continue;
    if (!pointInFeature(lng, lat, city)) {
      bad += 1;
      if (samples.length < 3) samples.push(`${f.properties.cityName}/${f.properties.name}`);
    }
  }
  probe.districtOfCityCheck = bad === 0 ? `ok（${districtData.features.length} 个区县全部落在其所属市域内）` : `异常 ${bad} 个：${samples.join('、')}`;
}

/** 按当前层级切换：市级看拉伸块，区县级看平面区划，两者不重叠显示 */
function applyLod() {
  if (!viewer) return;
  const isDistrict = level.value === 'district';
  const isDrilled = !!drilledCity.value;
  // 下钻时：目标市隐藏立体块（让位给它的区县平面），其他市保留立体块作为「可点击切换」的入口。
  // 这样下钻状态下双击别的市就能直接切过去，不必先返回全省。
  for (const c of citySolids) {
    c.entity.show = isDrilled ? c.cityName !== drilledCity.value : !isDistrict;
  }
  for (const e of cityEdges) {
    // 区县层级或下钻时把市界描边压到贴地：立体块已经隐藏，描边还悬在 45km 会「飘在半空」
    const isDown = isDistrict || isDrilled;
    e.entity.polyline.positions = Cesium.Cartesian3.fromDegreesArrayHeights(
      e.poly.flatMap(([lng, lat]) => [lng, lat, isDown ? 400 : e.h])
    );
  }
  for (const l of cityLabels) {
    l.entity.position = Cesium.Cartesian3.fromDegrees(
      ...labelAnchor(l.poly, null),
      isDistrict || isDrilled ? 6000 : l.h + 2000
    );
    // 下钻时所有市名都保留：用户要靠名字认出并双击切换到别的市
    l.entity.show = true;
  }
  if (isDrilled) {
    // 下钻：只显示目标市的区县，隐藏其他
    const target = districtByCity.get(drilledCity.value) || [];
    for (const e of districtEntities) e.show = target.includes(e);
  } else {
    for (const e of districtEntities) e.show = isDistrict;
  }
  probe.level = isDrilled ? 'district-drilled' : level.value;
  probe.districtShown = isDrilled
    ? (districtByCity.get(drilledCity.value) || []).filter((e) => e.show).length
    : isDistrict
      ? districtEntities.length
      : 0;
  probe.drilledCity = drilledCity.value;
}

/** 相机高度驱动的层级判定。用 camera.changed 而不是 postRender，省掉每帧计算。
 *  当用户通过双击下钻到具体市时，暂停相机高度驱动的层级切换，避免视角调整时被自动切回。 */
function updateLod() {
  if (!viewer || drilledCity.value) return;
  const h = viewer.camera.positionCartographic.height;
  probe.cameraHeight = Math.round(h);
  const next = h < LOD_DISTRICT_HEIGHT ? 'district' : 'city';
  if (next !== level.value) {
    level.value = next;
    if (next === 'district') ensureDistricts();
    else applyLod();
    // 进区县时 ensureDistricts 内部会在数据到位后再 applyLod 一次
  }
}

/** 计算一组 WGS84 坐标的包围矩形 [west, south, east, north] */
function bboxFromFeatures(features) {
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  for (const f of features) {
    for (const poly of f.geometry.coordinates) {
      for (const ring of poly) {
        for (const [lng, lat] of ring) {
          if (lng < w) w = lng;
          if (lng > e) e = lng;
          if (lat < s) s = lat;
          if (lat > n) n = lat;
        }
      }
    }
  }
  return [w, s, e, n];
}

/** 双击下钻到指定市：加载区县数据、隐藏其他市、飞行到该市范围 */
async function drillDown(cityName) {
  if (!viewer || !cityName) return;
  const cityFeature = gdGeo.features.find((f) => f.properties.name === cityName);
  if (!cityFeature) return;
  await ensureDistricts();
  if (!districtByCity.has(cityName)) return;
  drilledCity.value = cityName;
  level.value = 'district';
  applyLod();
  // 飞入该市：用区县数据或市边界计算 bbox，留 10% 边距
  const cityDistricts = districtData.features.filter((f) => f.properties.cityName === cityName);
  const features = cityDistricts.length ? cityDistricts : [cityFeature];
  const [w, s, e, n] = bboxFromFeatures(features);
  const padding = 0.12;
  const rect = Cesium.Rectangle.fromDegrees(
    w - (e - w) * padding,
    s - (n - s) * padding,
    e + (e - w) * padding,
    n + (n - s) * padding
  );
  viewer.camera.flyTo({
    destination: rect,
    duration: 1.2,
    easingFunction: Cesium.EasingFunction.QUART_OUT,
  });
}

/** 返回全省（地市）视角 */
function backToProvince() {
  if (!viewer) return;
  drilledCity.value = '';
  level.value = 'city';
  applyLod();
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(108.6, 19.5, 118.3, 26.4),
    duration: 1.2,
    easingFunction: Cesium.EasingFunction.QUART_OUT,
  });
}

/** 绑定双击下钻：双击市立体块/边界/标注 → 进入该市区县图层 */
function bindDrillDown() {
  if (!viewer || dblClickHandler) return;
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    if (!picked?.id?.name) return;
    const name = String(picked.id.name);
    // city: / edge: / citylabel: 前缀都对应同一个市
    const match = name.match(/^(city|edge|citylabel):(.+)$/);
    if (!match) return;
    const cityName = match[2];
    drillDown(cityName);
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  dblClickHandler = handler;
  probe.drillable = true;
}

function rebuildEntities() {
  if (!viewer) return;
  viewer.entities.removeAll();
  citySolids.length = 0;
  cityEdges.length = 0;
  cityLabels.length = 0;
  districtEntities.length = 0;
  districtByCity.clear();
  buildCities();
  buildDevices();
  // 区县数据若已加载过，要跟着重建，否则刷新后区县层就空了
  if (districtData) {
    buildDistricts();
    probe.districtLabels = districtEntities.filter((e) => e.label).length;
  }
  applyLod();
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
  // 缩放驱动的地市/区县层级切换。percentageChanged 调大一点，
  // 否则相机每动一丝就触发一次判定（缩放过程中会疯狂调用）
  viewer.camera.percentageChanged = 0.05;
  lodListener = () => updateLod();
  viewer.camera.changed.addEventListener(lodListener);
  updateLod();
  bindDrillDown();
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
  window.__GD_SCREEN__ = {
    probe,
    ready: true,
    getViewer: () => viewer,
    drillDown,
    backToProvince,
  };
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  window.clearInterval(clockTimer);
  if (animRaf) window.cancelAnimationFrame(animRaf);
  barChart?.dispose();
  lineChart?.dispose();
  if (viewer && !viewer.isDestroyed()) {
    if (lodListener) viewer.camera.changed.removeEventListener(lodListener);
    if (dblClickHandler && !dblClickHandler.isDestroyed()) {
      dblClickHandler.destroy();
    }
    viewer.destroy();
  }
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
.back-btn {
  margin-left: 8px;
  background: linear-gradient(90deg, #0ea5e9, #22d3ee);
  border: none;
  color: #020813;
  font-weight: 600;
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
