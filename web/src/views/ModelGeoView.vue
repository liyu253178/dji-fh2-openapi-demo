<template>
  <div class="geo">
    <!-- 工具条 -->
    <div class="card">
      <div class="card-body bar">
        <el-select
          v-model="modelId"
          size="small"
          placeholder="选择模型"
          style="width: 240px"
          @change="onModelChange"
        >
          <el-option v-for="m in models" :key="m.id" :label="m.name || m.id" :value="m.id">
            <span>{{ m.name || m.id }}</span>
            <span class="opt-type">{{ m.file_type === 'model_3d' ? '3D' : '2D' }}</span>
          </el-option>
        </el-select>

        <el-radio-group v-model="view" size="small" @change="onViewChange">
          <el-radio-button value="2d">2D 底图</el-radio-button>
          <el-radio-button value="3d">3D 模型</el-radio-button>
        </el-radio-group>

        <template v-if="view === '2d'">
          <el-select v-model="basemap" size="small" style="width: 132px">
            <el-option v-for="b in BASE_OPTIONS" :key="b.key" :label="b.name" :value="b.key" />
          </el-select>
          <!-- 关键动作：选好模型后手动点「加载至底图」才真正叠加，避免选中即拉取整个瓦树 -->
          <el-button
            size="small"
            type="primary"
            :loading="overlayState === 'loading'"
            :disabled="!modelId"
            @click="loadToBasemap"
          >
            {{ overlayState === 'ready' ? '重新加载至底图' : '加载至底图' }}
          </el-button>
          <el-button
            v-if="overlayState === 'ready'"
            size="small"
            @click="removeOverlay"
          >
            移除
          </el-button>
        </template>

        <el-radio-group v-model="measure" size="small" @change="onMeasureChange">
          <el-radio-button value="">关闭量测</el-radio-button>
          <el-radio-button value="distance">距离</el-radio-button>
          <el-radio-button value="area">面积</el-radio-button>
          <el-radio-button value="height">高差</el-radio-button>
        </el-radio-group>

        <el-button size="small" :disabled="!measure" @click="clearMeasure">清除</el-button>
        <div style="flex: 1"></div>
        <span class="measure-text" :class="{ on: measureText }">{{ measureText || '未开启量测' }}</span>
      </div>

      <div class="card-body tip-line">
        <template v-if="view === '2d'">
          2D 视图：多源卫星影像底图（高德 / 吉林一号）。
          <b>选好模型后点「加载至底图」</b>，正射影像会按真实经纬度铺到底图上（高德底图为 GCJ-02，
          叠加时已做坐标纠偏对齐）。点击地图取点量测距离与面积。
        </template>
        <template v-else>
          3D 视图：渲染司空 2 三维模型（b3dm / glb / pnts 点云），点击模型表面取点量测距离、面积与高差。
          场景已归一到米制空间，量测结果即真实米数。
        </template>
      </div>
    </div>

    <!-- 2D -->
    <div v-show="view === '2d'" class="stage">
      <BaseMap ref="mapRef" :basemap="basemap" :center="center" :zoom="16" @ready="onMapReady" @basemap="onBasemap" />

      <div v-if="overlayState === 'ready'" class="overlay-bar">
        <span class="ob-name" :title="currentName">已叠加：{{ currentName }}</span>
        <span class="muted small">{{ overlayInfo }}</span>
        <span class="muted small">不透明度</span>
        <el-slider v-model="opacity" size="small" :min="10" :max="100" style="width: 120px" @input="onOpacity" />
        <span class="muted small">{{ opacity }}%</span>
      </div>
      <div v-else-if="overlayState === 'error'" class="map-warn">{{ overlayError }}</div>
      <div v-else-if="overlayState === 'loading'" class="map-tip">正在读取模型瓦片信息…</div>
      <div v-else class="map-tip">未叠加模型 · 选择模型后点「加载至底图」</div>
    </div>

    <!-- 3D -->
    <div v-show="view === '3d'" class="stage">
      <ModelViewer
        v-if="modelId"
        ref="viewerRef"
        :model-id="modelId"
        :model-name="currentName"
        :measure-mode="measure"
        class="viewer"
        @measure="onMeasure"
      />
      <div v-else class="empty muted small">请先在上方选择一个三维模型</div>
      <div v-if="measure" class="measure-hint">正在量测：{{ MEASURE_HINT[measure] }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import L from 'leaflet';
import BaseMap from '../components/BaseMap.vue';
import ModelViewer from '../components/ModelViewer.vue';
import { modelApi, errMsg } from '../api/dji';
import { ElMessage } from 'element-plus';
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/geo';
import { useSessionStore } from '../stores/session';

const store = useSessionStore();

const BASE_OPTIONS = [
  { key: 'amap_img', name: '高德·影像' },
  { key: 'amap_vec', name: '高德·矢量' },
  { key: 'jl1', name: '吉林一号' },
];

const MEASURE_HINT = {
  distance: '依次点击取点，累计折线长度',
  area: '依次点击围成多边形，闭合成面后给出投影面积',
  height: '先点低处再点高处，给出两点高差（3D 视图中在模型表面取点）',
};

const models = ref([]);
const modelId = ref('');
const view = ref('2d');
const basemap = ref('amap_img');
const measure = ref('');
const measureText = ref('');

/** 叠加状态：idle | loading | ready | error */
const overlayState = ref('idle');
const overlayError = ref('');
const overlayInfo = ref('');
const opacity = ref(85);

const currentName = computed(() => models.value.find((m) => m.id === modelId.value)?.name || '');
const center = computed(() => {
  const a = (store.airports || []).find((x) => x.sn && store.states?.[x.sn]?.device_state?.latitude);
  const d = a ? store.states[a.sn].device_state : null;
  if (d?.latitude && d?.longitude) return [Number(d.latitude), Number(d.longitude)];
  return [23.09, 113.49];
});

/* ---------------- 2D：底图与叠加 ---------------- */
const mapRef = ref(null);
let map = null;
let crs = 'gcj02';
let overlayLayer = null;
let overlayBounds = null;
const pts = ref([]);
let layer = null;

function onMapReady(m) {
  map = m;
  layer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  render2d();
}

function onBasemap({ crs: c }) {
  if (c) crs = c;
  render2d();
  // 底图坐标系变了，正射影像的瓦片纠偏要跟着重算
  if (overlayState.value === 'ready' && overlayMeta.value) drawOverlay(overlayMeta.value);
}

/* ---- 瓦片与经纬度互转（标准 Web Mercator XYZ） ---- */
function tile2ll(x, y, z) {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  return [lon, lat];
}
function ll2tile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const s = Math.sin((lat * Math.PI) / 180);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return [x, y];
}

/**
 * 正射影像瓦图层：底图是 GCJ-02（高德）时做行列号纠偏。
 *
 * 影像瓦片本身是 WGS84（司空 2 报告里 "GCJ tiles": false），而高德底图是 GCJ-02。
 * 直接按 WGS84 行列号铺上去，整幅成果会相对底图偏移 300–600 m —— 叠加比对就失去意义。
 * 做法：Leaflet 给的是「底图坐标系下的行列号」，取该瓦片中心经纬度 → 反解成 WGS84 →
 * 换回 WGS84 行列号再去请求影像瓦片。
 */
const ShiftTileLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    let x = coords.x;
    let y = coords.y;
    const z = coords.z;
    if (this.options.needShift) {
      const [lon, lat] = tile2ll(x, y, z);
      const [wlon, wlat] = gcj02ToWgs84(lon, lat);
      [x, y] = ll2tile(wlon, wlat, z);
    }
    const data = { ...this.options, x, y, z, s: this.options.subdomains[(x + y) % this.options.subdomains.length] };
    return L.Util.template(this._url, L.extend(data, this.options));
  },
});

/** 影像覆盖范围：GCJ-02 底图下要把 WGS84 角点换算过去，bounds 才和底图对得上 */
function wgsBoundsToMap(minLon, minLat, maxLon, maxLat) {
  const a = crs === 'gcj02' ? wgs84ToGcj02(minLon, minLat) : [minLon, minLat];
  const b = crs === 'gcj02' ? wgs84ToGcj02(maxLon, maxLat) : [maxLon, maxLat];
  return L.latLngBounds([a[1], a[0]], [b[1], b[0]]);
}

const overlayMeta = ref(null);

async function loadToBasemap() {
  if (!modelId.value) return ElMessage.warning('请先选择一个模型');
  if (!map) return ElMessage.warning('底图尚未就绪');
  overlayState.value = 'loading';
  overlayError.value = '';
  const r = await modelApi.files(modelId.value);
  if (!r?.ok) {
    overlayState.value = 'error';
    overlayError.value = r?.message || '模型包读取失败';
    return;
  }
  const meta = r.data?.raster2d;
  if (!meta) {
    overlayState.value = 'error';
    overlayError.value =
      '该模型包内没有二维正射影像瓦片（{z}/{x}/{y}.png）。三维模型包不带地理参考，无法精确叠加到底图 —— 请切到 3D 视图查看与量测。';
    return;
  }
  overlayMeta.value = meta;
  drawOverlay(meta);
  overlayInfo.value = [
    meta.gsd ? `GSD ${Number(meta.gsd).toFixed(4)} m/px` : '',
    `${Number(meta.tileCount || 0).toLocaleString()} 张瓦片`,
  ]
    .filter(Boolean)
    .join(' · ');
  overlayState.value = 'ready';
  ElMessage.success('已叠加到底图');
}

function drawOverlay(meta) {
  if (!map) return;
  if (overlayLayer) {
    map.removeLayer(overlayLayer);
    overlayLayer = null;
  }
  const { maxLevel, minLevel, minX, maxX, minY, maxY, base } = meta;
  const z = Number(maxLevel);
  const nw = tile2ll(0, minY, z);
  const se = tile2ll(maxX + 1, maxY + 1, z);
  const bounds = wgsBoundsToMap(nw[0], se[1], se[0], nw[1]);
  if (!bounds.isValid()) {
    overlayState.value = 'error';
    overlayError.value = '二维瓦片行列号异常，无法定位范围';
    return;
  }
  overlayBounds = bounds;
  overlayLayer = new ShiftTileLayer(modelApi.tileSrc(modelId.value, `${base}/{z}/{x}/{y}.png`), {
    minZoom: Number(minLevel),
    maxNativeZoom: z,
    maxZoom: Math.min(z + 2, 22),
    tileSize: 256,
    bounds,
    noWrap: true,
    opacity: opacity.value / 100,
    needShift: crs === 'gcj02',
    attribution: '正射影像 · 司空 2 二维模型',
    // 缺瓦片是常态（模型只覆盖一块范围），静默失败不要在控制台刷红
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  }).addTo(map);
  map.fitBounds(bounds, { padding: [24, 24] });
}

function onOpacity(v) {
  overlayLayer?.setOpacity(Number(v) / 100);
}

function removeOverlay() {
  if (overlayLayer && map) map.removeLayer(overlayLayer);
  overlayLayer = null;
  overlayMeta.value = null;
  overlayState.value = 'idle';
}

/* ---------------- 2D 量测 ---------------- */
function onMapClick(e) {
  if (!measure.value || measure.value === 'height') return;
  const [lng, lat] = crs === 'gcj02' ? gcj02ToWgs84(e.latlng.lng, e.latlng.lat) : [e.latlng.lng, e.latlng.lat];
  pts.value.push([lng, lat]);
  render2d();
  compute2d();
}

function render2d() {
  if (!layer) return;
  layer.clearLayers();
  // 量测点存的是 WGS84，底图是 GCJ-02 时要纠偏，否则画出来的线跟点的位置差几百米
  const ll = pts.value.map(([lng, lat]) => {
    const [glng, glat] = crs === 'gcj02' ? wgs84ToGcj02(lng, lat) : [lng, lat];
    return [glat, glng];
  });
  if (ll.length >= 2) L.polyline(ll, { color: '#22d3ee', weight: 2 }).addTo(layer);
  if (measure.value === 'area' && ll.length >= 3) {
    L.polygon(ll, { color: '#ffb020', weight: 2, fillOpacity: 0.15 }).addTo(layer);
  }
  for (const p of ll) {
    L.circleMarker(p, { radius: 4, color: '#22d3ee', weight: 1, fillColor: '#22d3ee', fillOpacity: 1 }).addTo(layer);
  }
}

const EARTH_R = 6378137;
function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}
/** 局部切平面投影（米）：以第一个点为原点 */
function toLocal(p, origin) {
  const lat0 = (origin[1] * Math.PI) / 180;
  const mPerLat = 111132.92 - 559.82 * Math.cos(2 * lat0);
  const mPerLng = 111412.84 * Math.cos(lat0);
  return [(p[0] - origin[0]) * mPerLng, (p[1] - origin[1]) * mPerLat];
}

function compute2d() {
  const p = pts.value;
  if (!measure.value || measure.value === 'height') return (measureText.value = '');
  if (measure.value === 'distance') {
    let sum = 0;
    for (let i = 1; i < p.length; i++) sum += haversine(p[i - 1], p[i]);
    measureText.value = p.length < 2 ? '再点一个点' : `距离 ${sum.toFixed(2)} m（${p.length} 点）`;
    return;
  }
  if (measure.value === 'area') {
    if (p.length < 3) return (measureText.value = `还需 ${3 - p.length} 个点`);
    const xy = p.map((q) => toLocal(q, p[0]));
    let s = 0;
    for (let i = 0, n = xy.length; i < n; i++) {
      const a = xy[i];
      const b = xy[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    const area = Math.abs(s) / 2;
    measureText.value = `面积 ${area.toFixed(2)} ㎡（${(area / 10000).toFixed(3)} 公顷）`;
  }
}

/* ---------------- 3D 量测 ---------------- */
const viewerRef = ref(null);
function onMeasure({ text }) {
  if (view.value === '3d') measureText.value = text || '';
}
function onMeasureChange() {
  clearMeasure();
}
function clearMeasure() {
  pts.value = [];
  measureText.value = '';
  render2d();
  viewerRef.value?.resetMeasure?.();
}
function onModelChange() {
  clearMeasure();
  removeOverlay();
}
function onViewChange() {
  clearMeasure();
}

async function loadModels() {
  const r = await modelApi.list();
  if (!r?.ok) {
    ElMessage.error(errMsg(r, '模型列表获取失败'));
    return;
  }
  models.value = r.data?.list || r.data || [];
}

onMounted(() => {
  loadModels();
});

onBeforeUnmount(() => {
  if (map) map.off('click', onMapClick);
});
</script>

<style scoped>
.geo { display: flex; flex-direction: column; gap: 12px; }
.bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tip-line { font-size: 11px; color: var(--c-text-3); line-height: 1.6; padding-top: 0; }
.stage { position: relative; height: calc(100vh - 258px); min-height: 420px; border: 1px solid var(--c-line); border-radius: 10px; overflow: hidden; }
.viewer { width: 100%; height: 100%; }
.empty { display: grid; place-items: center; height: 100%; }
.measure-text { font-size: 13px; color: var(--c-text-3); font-variant-numeric: tabular-nums; }
.measure-text.on { color: var(--c-brand); font-weight: 600; }
.opt-type { float: right; color: var(--c-text-3); font-size: 11px; margin-left: 10px; }

/* 浮层统一放顶部，避开右上角的底图切换工具条和底部版权条 */
.overlay-bar {
  position: absolute; left: 12px; top: 12px; z-index: 620;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: rgba(10, 16, 26, 0.9); border: 1px solid var(--c-line);
  border-radius: 8px; padding: 6px 10px; max-width: calc(100% - 24px);
}
.ob-name { font-size: 12px; color: var(--c-text-1); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.map-warn {
  position: absolute; left: 12px; right: 12px; top: 12px; z-index: 620;
  background: rgba(10, 16, 26, 0.92); border: 1px solid var(--c-warn);
  color: var(--c-warn); border-radius: 6px; padding: 6px 10px; font-size: 12px; line-height: 1.6;
}
.map-tip {
  position: absolute; left: 12px; top: 12px; z-index: 620;
  background: rgba(10, 16, 26, 0.88); border: 1px solid var(--c-line);
  color: var(--c-text-2); border-radius: 6px; padding: 5px 10px; font-size: 12px;
}
.measure-hint {
  position: absolute; left: 12px; bottom: 12px; z-index: 620;
  background: rgba(10, 16, 26, 0.88); border: 1px solid var(--c-line);
  border-radius: 6px; padding: 5px 10px; font-size: 12px; color: var(--c-text-2);
}
.muted { color: var(--c-text-3); }
.small { font-size: 11px; }
</style>
