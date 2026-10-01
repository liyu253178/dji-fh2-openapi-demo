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
          <el-button v-if="overlayState === 'ready'" size="small" @click="removeOverlay">移除</el-button>
        </template>

        <el-radio-group v-model="measure" size="small" @change="onMeasureChange">
          <el-radio-button value="">关闭量测</el-radio-button>
          <el-radio-button value="distance">距离</el-radio-button>
          <el-radio-button value="area">面积</el-radio-button>
          <el-radio-button value="height">高差</el-radio-button>
        </el-radio-group>

        <el-button size="small" :disabled="!measure" @click="undoPoint">撤销一点</el-button>
        <el-button size="small" :disabled="!measure" @click="finishMeasure">结束</el-button>
        <el-button size="small" :disabled="!measure" @click="clearMeasure">清除</el-button>
      </div>

      <!-- 量测结果：按大疆智图的口径出数（直线/水平/垂直/坡度、投影+拟合面积） -->
      <div v-if="measure" class="card-body result-bar">
        <div v-if="measureLines.length" class="result-lines">
          <span v-for="(l, i) in measureLines" :key="i" class="rl">{{ l }}</span>
        </div>
        <div v-else class="muted small">{{ MEASURE_HINT[measure] }}</div>
        <div v-if="lastCoord" class="small coord-line">最后取点：{{ lastCoord }}</div>
      </div>

      <div class="card-body tip-line">
        <template v-if="view === '2d'">
          2D 视图：多源卫星影像底图（高德 / 吉林一号）。<b>选好模型后点「加载至底图」</b>，
          正射影像按 <b>map_report 报告中的实测角点</b>铺到底图（高德为 GCJ-02，叠加时已纠偏）。
          橙色虚线框是模型的真实覆盖范围。
        </template>
        <template v-else>
          3D 视图：按<b>大疆智图</b>的键位操作 —— 左键拖动平移、滚轮或右键拖动缩放、按住滚轮拖动旋转。
          鼠标停在模型上会显示该点的<b>经纬度与椭球高</b>，用来核对配准是否正确。
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
        <el-slider v-model="opacity" size="small" :min="10" :max="100" style="width: 110px" @input="onOpacity" />
        <span class="muted small">{{ opacity }}%</span>
      </div>
      <div v-else-if="overlayState === 'error'" class="map-warn">{{ overlayError }}</div>
      <div v-else-if="overlayState === 'loading'" class="map-tip">{{ loadTip }}</div>
      <div v-else class="map-tip">未叠加模型 · 选择模型后点「加载至底图」</div>

      <!-- 模型真实覆盖范围 + 坐标信息，随时可查 -->
      <div v-if="footprint" class="foot-bar">
        <span class="fb-title">模型真实范围</span>
        <span class="mono">{{ fmtCoord(footprint.minLat) }}, {{ fmtCoord(footprint.minLon) }} →
          {{ fmtCoord(footprint.maxLat) }}, {{ fmtCoord(footprint.maxLon) }}</span>
        <span class="muted small">{{ footprintText }}</span>
        <span class="muted small">{{ footprint.sourceText }}</span>
      </div>
      <div v-else-if="footError" class="map-warn map-warn-foot">{{ footError }}</div>
    </div>

    <!-- 3D -->
    <div v-show="view === '3d'" class="stage">
      <ModelViewer
        v-if="modelId && view === '3d'"
        ref="viewerRef"
        :model-id="modelId"
        :model-name="currentName"
        :measure-mode="measure"
        class="viewer"
        @measure="onMeasure"
        @geo="onModelGeo"
      />
      <div v-else-if="!modelId" class="empty muted small">请先在上方选择一个三维模型</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onBeforeUnmount } from 'vue';
import L from 'leaflet';
import BaseMap from '../components/BaseMap.vue';
import ModelViewer from '../components/ModelViewer.vue';
import { modelApi, errMsg } from '../api/dji';
import { ElMessage } from 'element-plus';
import { gcj02ToWgs84, wgs84ToGcj02 } from '../utils/geo';
import { boxVolumeToBounds, fmtArea } from '../utils/ecef';
import { useSessionStore } from '../stores/session';

const store = useSessionStore();

const BASE_OPTIONS = [
  { key: 'amap_img', name: '高德·影像' },
  { key: 'amap_vec', name: '高德·矢量' },
  { key: 'jl1', name: '吉林一号' },
];

const MEASURE_HINT = {
  distance: '依次点击模型表面取点，实时给出直线 / 水平 / 垂直距离与坡度；右键结束',
  area: '依次点击围成多边形，给出投影面积与拟合面积；右键结束',
  height: '先点低处再点高处，给出两点高差（3D 视图在模型表面取点）',
};

const models = ref([]);
const modelId = ref('');
const view = ref('2d');
const basemap = ref('amap_img');
const measure = ref('');
const measureLines = ref([]);
const lastCoord = ref('');

/** 叠加状态：idle | loading | ready | error */
const overlayState = ref('idle');
const overlayError = ref('');
const overlayInfo = ref('');
const loadTip = ref('正在读取模型瓦片信息…');
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
let footLayer = null;
let hasUserPanned = false;
const pts = ref([]);
let layer = null;

/** 模型的真实地理范围（WGS84），二维走报告角点、三维走 tileset 包围盒 */
const footprint = ref(null);
const footError = ref('');
/** 每处理过一次后就被 set false，避免重复调用 */
let footAutoFit = false;

function onMapReady(m) {
  map = m;
  layer = L.layerGroup().addTo(map);
  footLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  // 只认用户真实的拖拽：程序化 fitBounds 也会触发 zoomstart，把它算进去
  // 会导致「叠加后自动定位」被永远跳过（实测就是这么坏的）
  map.on('dragstart', () => {
    hasUserPanned = true;
  });
  render2d();
}

function onBasemap({ crs: c }) {
  if (c) crs = c;
  render2d();
  drawFootprint();
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
 * 把「模型的 WGS84 坐标」换算到当前底图的坐标系。
 *
 * 高德等国内底图是 GCJ-02，影像瓦片按报告实测通常是 WGS84，两者差 300–600 m：
 * - 瓦片是 WGS84 + 底图 GCJ-02 → 转过去
 * - 瓦片已是 GCJ-02 + 底图 WGS84（吉林一号）→ 反解回来
 * - 两者一致 → 不动
 */
function toMapCrs(lon, lat) {
  const tilesAreGcj = overlayMeta.value?.gcjTiles === true || metaCache.value?.gcjTiles === true;
  if (crs === 'gcj02' && !tilesAreGcj) return wgs84ToGcj02(lon, lat);
  if (crs === 'wgs84' && tilesAreGcj) return gcj02ToWgs84(lon, lat);
  return [lon, lat];
}

/**
 * 正射影像瓦图层：底图与瓦片坐标系不一致时做行列号纠偏。
 *
 * 影像瓦片本身通常是 WGS84（司空 2 报告里 "GCJ tiles": false），而高德底图是 GCJ-02。
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

const overlayMeta = ref(null);
const metaCache = ref(null);

/**
 * 算出模型的真实覆盖范围。
 *  - 二维模型：优先用 map_report.json 里实测的 topLeft / bottomRight，
 *    没有报告时按最深层的实际行列号反算（注意必须用 minX，传 0 会让西边界落到 -180）。
 *  - 三维模型：读根 tileset.json 的 boundingVolume（ECEF），八角换算成经纬度矩形。
 *    局部坐标（Y-up）的模型没有地理参考，如实报错而不硬凑一个位置。
 */
async function computeFootprint(filesData) {
  const d = filesData || {};
  if (d.raster2d) {
    const m = d.raster2d;
    const tl = m.topLeft;
    const br = m.bottomRight;
    if (tl?.lat && tl?.lon && br?.lat && br?.lon) {
      return {
        minLon: Math.min(tl.lon, br.lon),
        maxLon: Math.max(tl.lon, br.lon),
        minLat: Math.min(tl.lat, br.lat),
        maxLat: Math.max(tl.lat, br.lat),
        sourceText: '坐标来源：建图报告实测角点',
      };
    }
    const z = Number(m.maxLevel);
    const nw = tile2ll(Number(m.minX), Number(m.minY), z);
    const se = tile2ll(Number(m.maxX) + 1, Number(m.maxY) + 1, z);
    return {
      minLon: nw[0],
      minLat: se[1],
      maxLon: se[0],
      maxLat: nw[1],
      sourceText: '坐标来源：瓦片行列号反算（无报告）',
    };
  }
  const roots = Array.isArray(d.tilesetRoots) ? d.tilesetRoots.filter(Boolean) : [];
  if (!roots.length) return null;
  const res = await fetch(modelApi.assetSrc(modelId.value, roots[0]));
  if (!res.ok) return null;
  const j = await res.json();
  const up = String(j?.asset?.gltfUpAxis || '').toUpperCase();
  const bv = j?.root?.boundingVolume;
  if (!bv) return null;
  if (up !== 'Z') {
    return { hasGeo: false, reason: '该三维模型是局部坐标系（Y-up），包内没有地理参考，无法在底图上定位' };
  }
  if (bv.box && bv.box.length >= 12) {
    const b = boxVolumeToBounds(bv.box);
    return { ...b, sourceText: '坐标来源：3D Tiles 包围盒 ECEF 反算' };
  }
  if (bv.region && bv.region.length >= 6) {
    return {
      minLon: bv.region[0],
      minLat: bv.region[1],
      maxLon: bv.region[2],
      maxLat: bv.region[3],
      minH: bv.region[4],
      maxH: bv.region[5],
      sourceText: '坐标来源：3D Tiles region',
    };
  }
  return null;
}

function drawFootprint() {
  if (!map || !footLayer) return;
  footLayer.clearLayers();
  const fp = footprint.value;
  if (!fp) return;
  const sw = toMapCrs(fp.minLon, fp.minLat);
  const ne = toMapCrs(fp.maxLon, fp.maxLat);
  if (!Number.isFinite(sw[0]) || !Number.isFinite(ne[0])) return;
  L.rectangle([sw, ne], {
    color: '#ffb020',
    weight: 2,
    dashArray: '6,4',
    fillColor: '#ffb020',
    fillOpacity: 0.06,
  }).addTo(footLayer);
  const cc = toMapCrs((fp.minLon + fp.maxLon) / 2, (fp.minLat + fp.maxLat) / 2);
  L.marker(cc, {
    icon: L.divIcon({
      className: 'fp-center',
      html: `<span>${currentName.value || '模型'}</span>`,
      iconSize: [72, 18],
      iconAnchor: [36, 9],
    }),
  }).addTo(footLayer);
  if (!hasUserPanned && !footAutoFit) {
    // Leaflet 的 fitBounds 吃 [lat, lng] 对；sw/ne 是 toMapCrs 出来的 [lng, lat]，必须换序
    map.fitBounds(
      [
        [sw[1], sw[0]],
        [ne[1], ne[0]],
      ],
      { padding: [40, 40] }
    );
    footAutoFit = true;
  }
}

const footprintText = computed(() => {
  const fp = footprint.value;
  if (!fp) return '';
  const lat0 = ((fp.minLat + fp.maxLat) / 2) * (Math.PI / 180);
  const w = (fp.maxLon - fp.minLon) * 111412.84 * Math.cos(lat0);
  const h = (fp.maxLat - fp.minLat) * 111132.92;
  const area = Number.isFinite(w * h) ? fmtArea(w * h) : '';
  return `约 ${Math.round(w)} m × ${Math.round(h)} m${area ? ` · ${area}` : ''}`;
});

function fmtCoord(v) {
  return Number(v).toFixed(6);
}

async function loadToBasemap() {
  if (!modelId.value) return ElMessage.warning('请先选择一个模型');
  if (!map) return ElMessage.warning('底图尚未就绪');
  overlayState.value = 'loading';
  overlayError.value = '';
  loadTip.value =
    '正在下载并解压模型包（首次打开需要几分钟，之后走服务端缓存秒开），请稍候…';
  const r = await modelApi.files(modelId.value);
  if (!r?.ok) {
    overlayState.value = 'error';
    overlayError.value = r?.message || `模型包读取失败：${errMsg(r, '')}`;
    return;
  }
  const meta = r.data?.raster2d;
  if (!meta) {
    overlayState.value = 'error';
    overlayError.value =
      '该模型包内没有二维正射影像瓦片（{z}/{x}/{y}.png）。三维模型的范围覆盖已在底图上用橙框标出，模型本身请切到 3D 视图查看与量测。';
    return;
  }
  overlayMeta.value = meta;
  metaCache.value = meta;
  drawOverlay(meta);
  overlayInfo.value = [
    meta.gsd ? `GSD ${Number(meta.gsd).toFixed(4)} m/px` : '',
    `${Number(meta.tileCount || 0).toLocaleString()} 张瓦片`,
    meta.gcjTiles === true ? 'GCJ-02 瓦片' : 'WGS84 瓦片',
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
  const { maxLevel, minLevel, base } = meta;
  const z = Number(maxLevel);
  // 范围：优先报告实测角点，否则用最深层的实际行列号（必须用 minX，不能用 0）
  let west;
  let north;
  let east;
  let south;
  const tl = meta.topLeft;
  const br = meta.bottomRight;
  if (tl?.lat && tl?.lon && br?.lat && br?.lon) {
    west = Math.min(tl.lon, br.lon);
    east = Math.max(tl.lon, br.lon);
    north = Math.max(tl.lat, br.lat);
    south = Math.min(tl.lat, br.lat);
  } else {
    const nw = tile2ll(Number(meta.minX), Number(meta.minY), z);
    const se = tile2ll(Number(meta.maxX) + 1, Number(meta.maxY) + 1, z);
    west = nw[0];
    north = nw[1];
    east = se[0];
    south = se[1];
  }
  // 角点是 WGS84 / 与底图一致的坐标，统一过一遍坐标系换算
  const aC = toMapCrs(west, north);
  const bC = toMapCrs(east, south);
  const bounds = L.latLngBounds([aC[1], aC[0]], [bC[1], bC[0]]);
  if (!bounds.isValid()) {
    overlayState.value = 'error';
    overlayError.value = '二维瓦片行列号异常，无法定位范围';
    return;
  }
  const tilesAreGcj = meta.gcjTiles === true;
  overlayLayer = new ShiftTileLayer(modelApi.tileSrc(modelId.value, `${base}/{z}/{x}/{y}.png`), {
    minZoom: Number(minLevel),
    maxNativeZoom: z,
    maxZoom: Math.min(z + 2, 22),
    tileSize: 256,
    bounds,
    noWrap: true,
    opacity: opacity.value / 100,
    needShift: crs === 'gcj02' && !tilesAreGcj,
    attribution: '正射影像 · 司空 2 二维模型',
    // 缺瓦片是常态（模型只覆盖一块范围），静默失败不要在控制台刷红
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  }).addTo(map);
  if (!hasUserPanned) map.fitBounds(bounds, { padding: [24, 24] });
  drawFootprint();
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
  if (!measure.value || measure.value === 'height') {
    measureLines.value = [];
    return;
  }
  if (measure.value === 'distance') {
    let sum = 0;
    for (let i = 1; i < p.length; i++) sum += haversine(p[i - 1], p[i]);
    measureLines.value = p.length < 2 ? ['再点一个点'] : [`直线 ${sum.toFixed(2)} m`, `${p.length} 个测点`];
    return;
  }
  if (measure.value === 'area') {
    if (p.length < 3) {
      measureLines.value = [`还需 ${3 - p.length} 个点`];
      return;
    }
    const xy = p.map((q) => toLocal(q, p[0]));
    let s = 0;
    for (let i = 0, n = xy.length; i < n; i++) {
      const a = xy[i];
      const b = xy[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    measureLines.value = [`投影面积 ${fmtArea(Math.abs(s) / 2)}`];
  }
}

/* ---------------- 3D 量测 ---------------- */
const viewerRef = ref(null);
function onMeasure({ lines, points }) {
  if (view.value !== '3d') return;
  measureLines.value = lines || [];
  const last = (points || []).filter((p) => p.lat != null).pop();
  lastCoord.value = last ? `${last.lat.toFixed(6)}, ${last.lon.toFixed(6)} · ${last.h.toFixed(1)} m` : '';
}

/** 三维 viewer 自己解算出的范围更准（用到全部瓦片），以其为准覆盖一次 */
function onModelGeo(g) {
  if (!g?.hasGeo) return;
  footprint.value = {
    minLon: g.minLon,
    maxLon: g.maxLon,
    minLat: g.minLat,
    maxLat: g.maxLat,
    sourceText: '坐标来源：3D Tiles 全瓦片 ECEF 反算',
  };
  drawFootprint();
}

function onMeasureChange() {
  clearMeasure();
}
function undoPoint() {
  if (view.value === '3d') viewerRef.value?.undoPoint?.();
  else {
    pts.value.pop();
    render2d();
    compute2d();
  }
}
function finishMeasure() {
  if (view.value === '3d') viewerRef.value?.finishMeasure?.();
}
function clearMeasure() {
  pts.value = [];
  measureLines.value = [];
  lastCoord.value = '';
  render2d();
  viewerRef.value?.resetMeasure?.();
}
function onModelChange() {
  clearMeasure();
  removeOverlay();
  footprint.value = null;
  footError.value = '';
  footAutoFit = false;
  hasUserPanned = false;
  if (footLayer) footLayer.clearLayers();
  overlayState.value = 'loading';
  overlayError.value = '';
  loadTip.value = '正在读取模型包地理信息…';
  // 足迹先算出来（只读一个根 tileset.json / 报告，开销极小），
  // 让用户先在底图上确认位置，再决定要不要加载整幅正射影像。
  modelApi
    .files(modelId.value)
    .then(async (r) => {
      if (!r?.ok) {
        overlayState.value = 'idle';
        return;
      }
      metaCache.value = r.data?.raster2d || null;
      const fp = await computeFootprint(r.data || {});
      overlayState.value = 'idle';
      if (fp?.hasGeo === false) {
        footError.value = fp.reason;
        return;
      }
      if (fp && Number.isFinite(fp.minLon)) {
        footprint.value = fp;
        drawFootprint();
      }
    })
    .catch(() => {
      overlayState.value = 'idle';
    });
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

/** 供自动化校验使用，不影响界面 */
const debug = reactive({ overlay: overlayState, footprint });

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
.tip-line b { color: var(--c-text-2); font-weight: 600; }
.stage { position: relative; height: calc(100vh - 300px); min-height: 420px; border: 1px solid var(--c-line); border-radius: 10px; overflow: hidden; }
.viewer { width: 100%; height: 100%; }
.empty { display: grid; place-items: center; height: 100%; }
.opt-type { float: right; color: var(--c-text-3); font-size: 11px; margin-left: 10px; }

/* 量测结果条：对齐大疆智图「多个读数并列」的观感 */
.result-bar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding-top: 0; }
.result-lines { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.rl {
  font-size: 13px; color: var(--c-brand); font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.coord-line { color: var(--c-text-3); font-variant-numeric: tabular-nums; }

/* 浮层统一放顶部，避开右上角的底图切换工具条 */
.overlay-bar {
  position: absolute; left: 12px; top: 12px; z-index: 620;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: rgba(10, 16, 26, 0.9); border: 1px solid var(--c-line);
  border-radius: 8px; padding: 6px 10px; max-width: calc(100% - 24px);
}
.ob-name { font-size: 12px; color: var(--c-text-1); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot-bar {
  position: absolute; left: 12px; bottom: 12px; z-index: 620;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: rgba(10, 16, 26, 0.9); border: 1px solid rgba(255, 176, 32, 0.5);
  border-radius: 8px; padding: 5px 10px; max-width: calc(100% - 24px);
  font-size: 12px; color: var(--c-text-2);
}
.fb-title { color: #ffb020; font-weight: 600; }
.foot-bar .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--c-text-1); }
.map-warn {
  position: absolute; left: 12px; right: 12px; top: 12px; z-index: 620;
  background: rgba(10, 16, 26, 0.92); border: 1px solid var(--c-warn);
  color: var(--c-warn); border-radius: 6px; padding: 6px 10px; font-size: 12px; line-height: 1.6;
}
.map-warn-foot { top: auto; bottom: 12px; }
.map-tip {
  position: absolute; left: 12px; top: 12px; z-index: 620;
  background: rgba(10, 16, 26, 0.88); border: 1px solid var(--c-line);
  color: var(--c-text-2); border-radius: 6px; padding: 5px 10px; font-size: 12px;
}
.muted { color: var(--c-text-3); }
.small { font-size: 11px; }
</style>

<style>
/* 覆盖范围中心点标注（Leaflet divIcon 不在 scoped 作用域内） */
.fp-center span {
  display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px;
  background: rgba(255, 176, 32, 0.9); color: #1a1204; white-space: nowrap;
}
</style>
