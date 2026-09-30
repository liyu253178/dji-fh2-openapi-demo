<template>
  <div class="r2d">
    <div ref="mapEl" class="r2d-map" />
    <div v-if="loading" class="r2d-tip">正在准备二维瓦片…</div>
    <div v-else-if="error" class="r2d-err">{{ error }}</div>
    <div v-else class="r2d-hud small">
      <span>正射影像 · {{ info }}</span>
      <span class="muted">滚轮缩放 · 拖动平移（层级 {{ levelText }}）</span>
    </div>
  </div>
</template>

<script setup>
/**
 * 二维模型（正射影像瓦片金字塔）预览
 *
 * 司空 2 的 2D 模型不是三维瓦片，而是大疆测绘建图产出的影像金字塔：
 * 包内是 `{z}/{x}/{y}.png`（256px），z=12…23，x/y 就是标准 Web Mercator 行列号，
 * 报告里 "GCJ tiles":false 表示瓦片本身是 WGS84。
 * 所以直接用 Leaflet 的瓦片层渲染即可，不需要 three.js。
 *
 * 与三维窗口（ModelViewer）的区别：这里看的是「正射影像图」，可与底图叠加比对；
 * 比例尺来自 map_report.json 的 TDOM GSD（地面采样距离）。
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import L from 'leaflet';
import { modelApi } from '../api/dji';

const props = defineProps({
  modelId: { type: [String, Number], required: true },
  modelName: { type: String, default: '' },
});

const mapEl = ref(null);
const loading = ref(true);
const error = ref('');
const info = ref('');
const levelText = ref('');

let map = null;
let layer = null;
let ro = null;

/** 瓦片行列号 → 经纬度（标准 Web Mercator XYZ，注意是 π 而不是 π/2） */
function tile2ll(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return [lat, lon];
}

async function build() {
  loading.value = true;
  error.value = '';
  info.value = '';
  levelText.value = '';
  if (map) {
    map.remove();
    map = null;
    layer = null;
  }

  const r = await modelApi.files(props.modelId);
  if (!r?.ok) {
    error.value = r?.message || '模型包获取失败';
    loading.value = false;
    return;
  }
  const meta = r.data?.raster2d;
  if (!meta) {
    error.value = '该模型包内没有可识别的二维影像瓦片（{z}/{x}/{y}.png）';
    loading.value = false;
    return;
  }

  const { minLevel, maxLevel, minX, maxX, minY, maxY, base } = meta;
  // 用最深层的行列范围反推覆盖矩形（外扩半格，避免边缘缺一列）
  const z = maxLevel;
  const bounds = L.latLngBounds(
    [tile2ll(0, maxY + 1, z)[0], tile2ll(minX, 0, z)[1]],
    [tile2ll(0, minY, z)[0], tile2ll(maxX + 1, 0, z)[1]]
  );
  if (!bounds.isValid()) {
    error.value = '二维瓦片行列号异常，无法定位范围';
    loading.value = false;
    return;
  }

  map = L.map(mapEl.value, {
    center: bounds.getCenter(),
    zoom: maxLevel - 3,
    zoomControl: true,
    attributionControl: true,
    // 影像瓦片是 WGS84（报告里 GCJ tiles=false），底图仅作参考，不做纠偏
    crs: L.CRS.EPSG3857,
    maxZoom: Math.min(maxLevel + 2, 22),
  });

  layer = L.tileLayer(
    // 包内是 {z}/{x}/{y}.png；用 tileSrc 保住占位符不被编码掉
    modelApi.tileSrc(props.modelId, `${base}/{z}/{x}/{y}.png`),
    {
      minZoom: minLevel,
      maxNativeZoom: maxLevel,
      maxZoom: Math.min(maxLevel + 2, 22),
      tileSize: 256,
      bounds,
      noWrap: true,
      attribution: '正射影像 · 司空 2 二维模型',
      // 缺瓦片是常态（模型只覆盖一块范围），静默失败不要在控制台刷红
      errorTileUrl:
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    }
  ).addTo(map);

  map.fitBounds(bounds, { padding: [12, 12] });

  const gsdTxt = meta.gsd ? `GSD ${Number(meta.gsd).toFixed(4)} m/px` : '';
  info.value = [gsdTxt, `${Number(meta.tileCount).toLocaleString()} 张瓦片`].filter(Boolean).join(' · ');
  levelText.value = `${minLevel}–${maxLevel}`;
  loading.value = false;

  map.on('zoomend', () => {
    const lv = map.getZoom();
    levelText.value = lv >= maxLevel ? `${maxLevel}（最精细）` : String(lv);
  });
  ro = new ResizeObserver(() => map?.invalidateSize());
  ro.observe(mapEl.value);
}

onMounted(build);
onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  map?.remove();
  map = null;
});
watch(() => props.modelId, build);
</script>

<style scoped>
.r2d { position: relative; width: 100%; height: 100%; min-height: 380px; }
.r2d-map { position: absolute; inset: 0; background: var(--c-bg-2); }
.r2d-hud {
  position: absolute; left: 10px; right: 10px; bottom: 8px; z-index: 500;
  display: flex; justify-content: space-between; gap: 10px;
  padding: 4px 8px; border-radius: 6px; pointer-events: none;
  color: var(--c-text-1); background: rgba(0, 0, 0, 0.55);
}
.r2d-tip {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  padding: 6px 12px; border-radius: 6px;
  color: var(--c-text-1); background: rgba(0, 0, 0, 0.55);
}
.r2d-err {
  position: absolute; left: 12px; right: 12px; top: 12px;
  padding: 8px 10px; border-radius: 6px;
  color: var(--c-warn); background: rgba(0, 0, 0, 0.6);
}
</style>
