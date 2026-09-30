<template>
  <div style="position: relative; width: 100%; height: 100%">
    <div ref="mapEl" style="width: 100%; height: 100%"></div>

    <div class="map-toolbar">
      <button
        class="map-chip collapse"
        :title="toolbarExpanded ? '收起底图切换' : '展开底图切换'"
        @click.stop="toolbarExpanded = !toolbarExpanded"
      >
        {{ toolbarExpanded ? '◀' : '☰' }}
      </button>
      <div v-if="toolbarExpanded" class="map-chips">
        <div
          v-for="b in BASEMAPS"
          :key="b.key"
          class="map-chip"
          :class="{ active: curKey === b.key }"
          @click="switchBase(b)"
        >
          {{ b.name }}
        </div>
      </div>
    </div>

    <div
      v-if="!hasAnyPoint"
      class="map-chip"
      style="left: 10px; right: auto; top: 10px; cursor: default"
    >
      暂无坐标（需设备在线且物模型有经纬度）
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick, computed } from 'vue';
import L from 'leaflet';
import { toMapLatLng } from '../utils/geo';
import dockMarker from '../assets/marker-dock.png';

/** 预设底图（高德系列为 GCJ-02，吉林一号为 WGS84） */
const BASEMAPS = [
  {
    key: 'amap_vec',
    name: '矢量·带注记',
    crs: 'gcj02',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
  },
  {
    key: 'amap_vec_nolabel',
    name: '矢量·无注记',
    crs: 'gcj02',
    url: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x={x}&y={y}&z={z}&scl=1&ltype=3',
    subdomains: ['1', '2', '3', '4'],
  },
  {
    key: 'amap_img',
    name: '影像·无注记',
    crs: 'gcj02',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
  },
  {
    key: 'amap_road',
    name: '道路·带注记',
    crs: 'gcj02',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scale=1&style=8',
    subdomains: ['1', '2', '3', '4'],
  },
  {
    key: 'amap_road_nolabel',
    name: '道路·无注记',
    crs: 'gcj02',
    url: 'https://wprd0{s}.is.autonavi.com/appmaptile?x={x}&y={y}&z={z}&lang=zh_cn&size=1&scl=1&style=8&ltype=11',
    subdomains: ['1', '2', '3', '4'],
  },
  {
    key: 'jl1',
    name: '吉林一号',
    crs: 'wgs84',
    url: 'https://api.jl1mall.com/getMap/{z}/{x}/{-y}?mk=3ddec00f5f435270285ffc7ad1a60ce5&tk=50d6270999cf817cebc636fb8a259ceb',
  },
];

const props = defineProps({
  /** [{sn,name,type:'airport'|'drone'|'home',lat,lng,heading,online,extra}] */
  markers: { type: Array, default: () => [] },
  /** [{name, points:[[lat,lng],...], color, dashed}] */
  polylines: { type: Array, default: () => [] },
  /** [{ lat, lng, radius(米), color, name }] 覆盖范围圈（如机巢作业半径） */
  circles: { type: Array, default: () => [] },
  center: { type: Array, default: null },
  zoom: { type: Number, default: 15 },
  autoFit: { type: Boolean, default: true },
  basemap: { type: String, default: 'amap_vec' },
  showToolbar: { type: Boolean, default: true },
});

const emit = defineEmits(['marker-click', 'ready']);

const mapEl = ref(null);
const curKey = ref(props.basemap);
const toolbarExpanded = ref(true);
let map = null;
let baseLayer = null;
let markerLayer = null;
let lineLayer = null;
let circleLayer = null;
let ro = null;

const hasAnyPoint = computed(() => props.markers.some((m) => m.lat && m.lng));

function currentBase() {
  return BASEMAPS.find((b) => b.key === curKey.value) || BASEMAPS[0];
}

function iconHtml(m) {
  const shadow = 'filter:drop-shadow(0 2px 6px rgba(0,0,0,.55))';
  if (m.type === 'drone') {
    const color = m.online ? '#22d3ee' : '#9ca3af';
    return `<div style="width:30px;height:30px;display:grid;place-items:center;${shadow}">
      <div style="transform:rotate(${m.heading || 0}deg);width:26px;height:26px;">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="${color}" stroke="#ffffff" stroke-width="1">
          <path d="M12 2 L12 8 M12 8 L4 13 L4 16 L10 16 L12 13 L14 16 L20 16 L20 13 L12 8 Z"/>
        </svg>
      </div></div>`;
  }
  if (m.type === 'home') {
    return `<div style="width:22px;height:22px;border-radius:50%;background:#ffb020;border:2px solid #ffffff;display:grid;place-items:center;color:#1a1200;font-size:11px;font-weight:700;${shadow}">H</div>`;
  }
  // 问题点（工单详情等业务场景）：橙色圆点 + 白描边，深浅底图都清晰
  if (m.type === 'point') {
    return `<div style="width:14px;height:14px;border-radius:50%;background:#ff6a00;border:2px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,.55)"></div>`;
  }
  // 机巢：用 Dock 3 实拍图做标记。
  // 白色机身直接放上去在浅色底图（高德矢量）上几乎看不见，
  // 所以垫一层深色圆盘 + 白描边，保证深浅底图都清晰；离线时整体转灰降透明。
  const alpha = m.online ? 1 : 0.55;
  const gray = m.online ? 0 : 1;
  return `<div class="mk-airport" style="opacity:${alpha}">
    <img src="${dockMarker}" alt="" style="filter:grayscale(${gray}) drop-shadow(0 1px 2px rgba(0,0,0,.5))" />
    <span class="mk-dot" style="background:${m.online ? '#35d07f' : '#9ca3af'}"></span>
  </div>`;
}

/**
 * 飞行器在舱内时，它的坐标与所属机场完全重合，返航点也在同一个位置。
 * 三个标记叠上去，机场实拍图标会被飞行器图标盖住。
 *
 * 处理：位置几乎重合（约 20m 内）时不单独画，而是把飞行器信息并入机场标记的提示；
 * 返航点则直接省略（「返航点＝机场」是废话）。语义上也更对：
 * 飞行器停在机库里时，它并不是一个独立的地图对象。
 * 1e-4 度约 11m（纬度），阈值取 2e-4（约 20m）足够宽容。
 */
function sameSpot(a, b) {
  if (!a || !b) return false;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 2e-4 && Math.abs(Number(a.lng) - Number(b.lng)) < 2e-4;
}

function drawLayers() {
  if (!map) return;
  const base = currentBase();
  if (markerLayer) markerLayer.clearLayers();
  if (lineLayer) lineLayer.clearLayers();
  if (circleLayer) circleLayer.clearLayers();

  const all = (props.markers || []).filter((m) => toMapLatLng(m.lat, m.lng, base.crs));
  const airports = all.filter((m) => m.type === 'airport');
  /** 被机场「吸收」的飞行器：机场 key → 追加到提示里的文本 */
  const merged = new Map();
  const drawable = all.filter((m) => {
    if (m.type !== 'drone' && m.type !== 'home') return true;
    const host = airports.find((a) => sameSpot(m, a));
    if (!host) return true;
    if (m.type === 'drone') {
      const key = host.sn || host.name;
      const prev = merged.get(key) || '';
      merged.set(key, `${prev ? `${prev}<br/>` : ''}飞行器在舱内：${m.name || m.sn || ''}${m.extra ? ` · ${m.extra}` : ''}`);
    }
    return false;
  });

  let bounds = null;
  for (const m of drawable) {
    const ll = toMapLatLng(m.lat, m.lng, base.crs);
    if (!ll) continue;
  // 机巢用实拍图，需要比默认图标更大的画布才看得清；飞行器/家点仍用 30px
  const size = m.type === 'airport' ? 44 : m.type === 'point' ? 16 : 30;
  const marker = L.marker(ll, {
    icon: L.divIcon({
      html: iconHtml(m),
      className: m.type === 'airport' ? 'fh2-marker fh2-marker-airport' : 'fh2-marker',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    }),
  });
    const rows = [
      `<b>${m.name || m.sn || ''}</b>`,
      m.sn ? `SN: ${m.sn}` : '',
      m.extra || '',
      merged.get(m.sn || m.name) || '',
    ]
      .filter(Boolean)
      .join('<br/>');
    marker.bindTooltip(rows, { direction: 'top', opacity: 0.95 });
    marker.bindPopup(rows);
    marker.on('click', () => emit('marker-click', m));
    marker.addTo(markerLayer);
    bounds = bounds ? bounds.extend(ll) : L.latLngBounds(ll, ll);
  }

  for (const line of props.polylines || []) {
    const pts = (line.points || [])
      .map((p) => toMapLatLng(p[0], p[1], base.crs))
      .filter(Boolean);
    if (pts.length < 2) continue;
    const pl = L.polyline(pts, {
      color: line.color || '#2f7cff',
      weight: line.weight || 3,
      opacity: 0.9,
      dashArray: line.dashed ? '6,6' : null,
    });
    if (line.name) pl.bindTooltip(line.name);
    pl.addTo(lineLayer);
    bounds = bounds ? bounds.extend(L.latLngBounds(pts)) : L.latLngBounds(pts);
  }

  // 覆盖范围圈（如机巢作业半径）：虚线描边 + 半透明填充
  for (const c of props.circles || []) {
    const ll = toMapLatLng(c.lat, c.lng, base.crs);
    if (!ll || !c.radius) continue;
    const ring = L.circle(ll, {
      radius: c.radius,
      color: c.color || '#4a8cff',
      weight: 1.5,
      opacity: 0.75,
      fillColor: c.color || '#4a8cff',
      fillOpacity: 0.07,
      dashArray: '5,6',
      interactive: false,
    });
    if (c.name) ring.bindTooltip(`${c.name} · 半径 ${(c.radius / 1000).toFixed(1)} km`, { sticky: true });
    ring.addTo(circleLayer);
  }

  if (bounds && props.autoFit && (props.markers.length > 1 || props.polylines.length)) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
  } else if (bounds && props.autoFit) {
    map.setView(bounds.getCenter(), props.zoom);
  } else if (!bounds && props.center) {
    map.setView(props.center, props.zoom);
  }
}

function switchBase(b) {
  if (!map) return;
  curKey.value = b.key;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(b.url, {
    subdomains: b.subdomains || ['a', 'b', 'c'],
    maxZoom: 18,
    minZoom: 3,
    attribution: b.key === 'jl1' ? '吉林一号' : '© 高德地图',
  }).addTo(map);
  baseLayer.bringToBack();
  drawLayers();
}

function resize() {
  if (map) map.invalidateSize();
}

onMounted(async () => {
  await nextTick();
  const b = currentBase();
  map = L.map(mapEl.value, {
    center: props.center || [30.5, 114.3],
    zoom: props.zoom,
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
  });
  markerLayer = L.layerGroup().addTo(map);
  lineLayer = L.layerGroup().addTo(map);
  circleLayer = L.layerGroup().addTo(map);
  circleLayer = L.layerGroup().addTo(map);
  switchBase(b);

  // 容器尺寸变化自动重算，避免地图组件“丢失/空白”
  ro = new ResizeObserver(() => resize());
  ro.observe(mapEl.value);
  setTimeout(resize, 120);
  emit('ready', map);
  drawLayers();
});

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (map) map.remove();
});

watch(() => [props.markers, props.polylines, props.circles], () => drawLayers(), { deep: true });
watch(
  () => props.center,
  (c) => c && map && map.setView(c, props.zoom)
);

/** 循环切换底图（供座舱「切换星图」按钮调用） */
function nextBasemap() {
  const i = BASEMAPS.findIndex((b) => b.key === curKey.value);
  switchBase(BASEMAPS[(i + 1) % BASEMAPS.length]);
}

defineExpose({
  resize,
  fitAll: () => drawLayers(),
  getMap: () => map,
  nextBasemap,
});
</script>

<style>
.fh2-marker { background: transparent; border: none; }

/* 机巢标记：Dock 实拍图 + 深色圆盘底衬。
   白色机身在浅色底图（高德矢量）上几乎看不见，深色底衬保证深浅底图都清晰；
   右下角小圆点表达在线状态，避免给照片整体染色。
   注意：img 必须写死像素 —— divIcon 容器宽度不是确定值，用百分比会退化成
   图片自身尺寸（256px）把外圈撑爆。 */
.mk-airport {
  position: relative; box-sizing: border-box;
  display: grid; place-items: center;
  border-radius: 50%;
  background: rgba(12, 12, 14, 0.66);
  border: 1.5px solid rgba(255, 255, 255, 0.92);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}
.mk-airport img {
  display: block;
  width: 32px; height: 32px;
  max-width: none; max-height: none;
  object-fit: contain;
}
.mk-airport .mk-dot {
  position: absolute; right: 0; bottom: 0;
  width: 10px; height: 10px; border-radius: 50%;
  border: 1.5px solid #fff;
  box-sizing: border-box;
}

/* 在线机巢：外圈呼吸光环 + 状态点脉冲。
   离线时机位不发光（灰点常亮），避免「看着像有戏但其实飞不了」。
   光环挂在 .fh2-marker-airport（divIcon 的 className）上，图标本身不参与动画，
   避免 transform 动画与 Leaflet 的定位 transform 打架。 */
.fh2-marker-airport { background: transparent; border: none; }
.fh2-marker-airport::before {
  content: '';
  position: absolute; left: 50%; top: 50%;
  width: 44px; height: 44px;
  margin: -22px 0 0 -22px;
  border-radius: 50%;
  border: 1.5px solid rgba(53, 208, 127, 0.55);
  animation: mk-pulse 2.6s cubic-bezier(0.2, 0.6, 0.35, 1) infinite;
  pointer-events: none;
}
.fh2-marker-airport .mk-dot {
  animation: mk-blink 1.8s ease-in-out infinite;
}
@keyframes mk-pulse {
  0%   { transform: scale(0.62); opacity: 0.9; }
  70%  { transform: scale(1.5);  opacity: 0; }
  100% { transform: scale(1.5);  opacity: 0; }
}
@keyframes mk-blink {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(53, 208, 127, 0.55); }
  50%      { opacity: 0.55; box-shadow: 0 0 0 5px rgba(53, 208, 127, 0); }
}
/* 尊重系统的「减少动态效果」设置：关掉动画但保留静态光环轮廓 */
@media (prefers-reduced-motion: reduce) {
  .fh2-marker-airport::before,
  .fh2-marker-airport .mk-dot { animation: none; }
}
.leaflet-tooltip {
  background: rgba(13, 21, 38, 0.95);
  border: 1px solid #22314f;
  color: #e8eefb;
  font-size: 12px;
}
.leaflet-popup-content-wrapper, .leaflet-popup-tip {
  background: rgba(13, 21, 38, 0.97);
  color: #e8eefb;
  border-color: #22314f;
}
.leaflet-popup-content { color: #e8eefb; font-size: 12px; margin: 10px 12px; }
</style>
