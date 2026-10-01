<template>
  <div class="plan">
    <!-- 左：地图 -->
    <div class="plan-map">
      <BaseMap
        ref="mapRef"
        :center="center"
        :zoom="15"
        :basemap="'amap_img'"
        :markers="airportMarkers"
        @ready="onMapReady"
        @basemap="onBasemap"
      />

      <!-- 统计浮层：放在右下并抬高，避开左下绘图工具条与 Leaflet 版权条 -->
      <div v-if="preview" class="map-stat">
        <div class="ms-row">
          <b>{{ preview.plan.stats.stripCount }}</b><span>{{ corridor ? '扫线' : '航带' }}</span>
          <b>{{ preview.plan.stats.waypointCount }}</b><span>航点</span>
          <b>{{ (preview.plan.stats.lengthM / 1000).toFixed(2) }}</b><span>km</span>
        </div>
        <div class="ms-row small">
          间距 {{ preview.plan.stats.spacing }}m · 片基 {{ preview.plan.stats.base }}m · 约
          {{ preview.plan.stats.photoCount }} 张
        </div>
      </div>

      <!-- 绘图工具条：左下角，与右上角底图切换互不遮挡；绘制按钮随航线类型切换 -->
      <div class="map-tools">
        <span
          class="chip"
          :class="{ on: !!drawing }"
          @click="toggleDraw(corridor ? 'centerline' : 'polygon')"
        >
          {{ drawing ? '● 点击加点' : corridor ? '绘制中心线' : '绘制测区' }}
        </span>
        <span class="chip" :class="{ off: !wgsPoints.length }" @click="undoPoint">撤销一点</span>
        <span class="chip" @click="clearShape">清除</span>
        <span class="chip ghost">
          {{ drawing ? '双击地图结束绘制' : `已选 ${wgsPoints.length} 点 · WGS84` }}
        </span>
      </div>

      <!-- 已成型图形的缩放：直接对应「扩展 / 缩小范围」 -->
      <div v-if="wgsPoints.length && !drawing" class="map-scale">
        <span class="chip" title="以中心为基准放大 10%" @click="scaleShape(1.1)">＋放大</span>
        <span class="chip" title="以中心为基准缩小 10%" @click="scaleShape(1 / 1.1)">－缩小</span>
        <span class="chip ghost">拖动顶点改形状 · 拖动 ✥ 整体平移</span>
      </div>
    </div>

    <!-- 右：参数面板（航线类型常驻顶部，其余折叠分组） -->
    <div class="plan-side">
      <div class="card type-card">
        <div class="row">
          <label>航线类型</label>
          <el-radio-group v-model="form.templateType" size="small" @change="onTypeChange">
            <el-radio-button value="mapping2d">正射航线</el-radio-button>
            <el-radio-button value="doubleGrid">倾斜航线</el-radio-button>
            <el-radio-button value="corridor">带状航线</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <el-collapse v-model="panels">
        <el-collapse-item name="type" title="机型与镜头">
          <div class="row">
            <el-select
              v-model="form.aircraftKey"
              size="small"
              style="flex: 1"
              :loading="airLoading"
              placeholder="加载机队机型…"
            >
              <el-option
                v-for="m in models"
                :key="m.key"
                :label="`${m.name} · ${m.count} 架`"
                :value="m.key"
              />
            </el-select>
          </div>

          <div class="row" style="margin-top: 10px">
            <el-checkbox-group v-model="form.lens" size="small">
              <el-checkbox v-for="l in LENSES" :key="l.key" :value="l.key">
                {{ l.name }}<span class="muted small">（{{ l.focalEq }}mm）</span>
              </el-checkbox>
            </el-checkbox-group>
          </div>
          <div class="tip">
            多镜头同时采集时间距取最窄的视场，保证每一路都满足重叠率。
          </div>
        </el-collapse-item>

        <el-collapse-item name="param" title="作业参数">
          <div class="param">
            <label>航高（m）</label>
            <el-input-number v-model="form.height" :min="20" :max="500" :step="10" size="small" controls-position="right" />
          </div>
          <div class="param">
            <label>地面分辨率</label>
            <el-input-number v-model="form.gsdCm" :min="0" :max="50" :step="0.5" size="small" controls-position="right" />
          </div>
          <div class="sub-tip">
            cm/px；填 0 表示按航高作业，填具体值则由它反算相对航高
          </div>
          <div v-if="!corridor" class="param">
            <label>云台俯仰（°）</label>
            <el-input-number v-model="form.gimbalPitch" :min="-90" :max="-10" :step="5" size="small" controls-position="right" />
          </div>
          <div v-if="!corridor" class="sub-tip">
            −90° 为正射；倾斜摄影建议 −45°～−60°，此时两遍航线的间距会被分别解算
          </div>
          <div class="param">
            <label>航速（m/s）</label>
            <el-input-number v-model="form.speed" :min="1" :max="15" :step="1" size="small" controls-position="right" />
          </div>
          <div class="param">
            <label>航向重叠（%）</label>
            <el-input-number v-model="form.overlapH" :min="50" :max="90" size="small" controls-position="right" />
          </div>
          <div class="param">
            <label>旁向重叠（%）</label>
            <el-input-number v-model="form.overlapW" :min="50" :max="90" size="small" controls-position="right" />
          </div>
          <div v-if="!corridor" class="param">
            <label>主航线角（°）</label>
            <el-input-number v-model="form.direction" :min="0" :max="359" size="small" controls-position="right" />
          </div>
          <div v-if="!corridor" class="param">
            <label>外扩（m）</label>
            <el-input-number v-model="form.margin" :min="0" :max="200" :step="5" size="small" controls-position="right" />
          </div>

          <!-- 带状：画完中心线后明确问「左右各外扩多少米」 -->
          <template v-if="corridor">
            <div class="param" :class="{ hl: needHalfWidth }">
              <label>左右各外扩（m）</label>
              <el-input-number
                v-model="form.corridorHalfWidth"
                :min="5"
                :max="1000"
                :step="5"
                size="small"
                controls-position="right"
              />
            </div>
            <div class="param">
              <label>两端外延（m）</label>
              <el-input-number v-model="form.extend" :min="0" :max="500" :step="10" size="small" controls-position="right" />
            </div>
            <div class="sub-tip">总带宽 = 左右外扩 × 2，当前 {{ form.corridorHalfWidth * 2 }} m</div>
          </template>

          <el-alert
            v-if="needHalfWidth"
            class="ask"
            type="info"
            :closable="false"
            show-icon
            title="中心线已画好，请设置左右外扩"
            :description="`已绘制 ${wgsPoints.length} 个顶点。默认左右各外扩 20 m（总带宽 40 m），确认后点「预览航线」，系统会按走廊面生成垂直于中心线的工字形航线。`"
          />
          <div v-if="corridor && preview" class="tip">
            扫线垂直于中心线走向，扫线之间沿走廊边缘连接 —— 整体呈「工」字形，可跟着河道/道路拐弯。
          </div>
        </el-collapse-item>

        <el-collapse-item name="result" title="测算结果与提交">
          <template v-if="preview">
            <div class="kv">
              <span>{{ corridor ? '扫线' : '航带' }} / 航点</span>
              <b>{{ preview.plan.stats.stripCount }} / {{ preview.plan.stats.waypointCount }}</b>
              <template v-if="gridPasses">
                <span>主航向间距</span><b>{{ gridPasses[0].spacing }} m</b>
                <span>正交航向间距</span><b>{{ gridPasses[1].spacing }} m</b>
              </template>
              <template v-else>
                <span>{{ corridor ? '扫线间距' : '航线间距' }}</span>
                <b>{{ preview.plan.stats.spacing }} m</b>
              </template>
              <span>片基</span><b>{{ preview.plan.stats.base }} m</b>
              <span>地面分辨率</span><b>{{ preview.geometry?.gsdCm ?? '--' }} cm/px</b>
              <span>里程</span><b>{{ (preview.plan.stats.lengthM / 1000).toFixed(2) }} km</b>
              <template v-if="preview.plan.stats.sortieCount > 1">
                <span>架次数</span><b>{{ preview.plan.stats.sortieCount }} 个</b>
              </template>
              <template v-if="gridPasses">
                <span>组间转移</span><b>{{ preview.plan.stats.transitionsM }} m</b>
              </template>
              <span>预计时长</span><b>{{ preview.plan.stats.durationText }}</b>
              <span>拍照间隔</span><b>{{ preview.plan.stats.shootInterval }} s</b>
              <span>照片数（估）</span><b>{{ preview.plan.stats.photoCount }} 张</b>
            </div>
            <div v-if="preview.measure?.areaM2" class="tip">
              测区约 {{ (preview.measure.areaM2 / 10000).toFixed(2) }} 公顷
            </div>
            <div v-if="gridPasses" class="tip muted">
              {{
                gridPasses[0].spacing === gridPasses[1].spacing
                  ? '两遍航线同为正射采集，有效覆盖一致，间距相同。'
                  : `倾斜摄影下两遍的有效覆盖不同：${gridPasses[0].spacing} m / ${gridPasses[1].spacing} m，按各自的几何解算，保证两个方向的重叠率都达标。`
              }}
            </div>
            <div class="tip muted">{{ preview.spacingSource.text }}</div>
            <div v-if="preview.adjusted" class="warn">
              航点数超过上限，已按更大间距重算（实际间距 {{ preview.plan.stats.spacing }} m）——重叠率会比设定值更高，不会漏拍。
            </div>
            <div v-for="w in preview.warnings || []" :key="w" class="warn">{{ w }}</div>
            <div v-if="preview.compare?.available" class="tip">
              与同型号参考航线对比：{{ preview.compare.message }}
            </div>
          </template>
          <div v-else class="muted small">先绘制范围并点「预览航线」</div>

          <div class="submit">
            <el-input v-model="form.name" size="small" placeholder="航线名称" />
            <div class="submit-btns">
              <el-button size="small" :loading="planning" @click="doPlan(false)">预览航线</el-button>
              <el-button size="small" type="primary" :loading="generating" @click="doGenerate">
                生成并验证
              </el-button>
            </div>
            <label class="auto">
              <el-switch v-model="autoReplan" size="small" />
              <span>范围改动后自动重算航线</span>
            </label>
          </div>
          <div v-if="result" class="result" :class="result.ok ? 'ok' : 'bad'">{{ result.message }}</div>
        </el-collapse-item>
      </el-collapse>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import L from 'leaflet';
import { ElMessage } from 'element-plus';
import BaseMap from '../../components/BaseMap.vue';
import { useSessionStore } from '../../stores/session';
import { waylineApi, errMsg } from '../../api/dji';
import { toMapLatLng, gcj02ToWgs84 } from '../../utils/geo';

const store = useSessionStore();

/** 镜头选项与后端 lensProfile 保持一致 */
const LENSES = [
  { key: 'wide', name: '广角', focalEq: 24 },
  { key: 'medium', name: '中长焦', focalEq: 70 },
  { key: 'tele', name: '长焦', focalEq: 168 },
  { key: 'ir', name: '红外热成像', focalEq: 53 },
];

const form = reactive({
  templateType: 'mapping2d',
  aircraftKey: '',
  lens: ['wide'],
  height: 100,
  speed: 8,
  overlapH: 80,
  overlapW: 70,
  direction: 0,
  margin: 0,
  /** 0 = 不启用，按航高作业；>0 则由 GSD 反算航高 */
  gsdCm: 0,
  /** 云台俯仰：-90 正射，倾斜摄影常用 -45 */
  gimbalPitch: -90,
  corridorHalfWidth: 20,
  extend: 20,
  name: '',
});

const panels = ref(['type', 'param', 'result']);
const models = ref([]);
const airLoading = ref(false);
const planning = ref(false);
const generating = ref(false);
const preview = ref(null);
const result = ref(null);
const autoReplan = ref(true);

/** 井字（倾斜航线）两遍各自解算出的几何，用于在结果里对账 */
const gridPasses = computed(() =>
  preview.value?.geometry?.passes?.length === 2 ? preview.value.geometry.passes : null
);

const corridor = computed(() => form.templateType === 'corridor');
/** 带状：中心线画完了但还没出结果 —— 这时明确问「左右外扩多少」 */
const needHalfWidth = computed(
  () => corridor.value && !drawing.value && wgsPoints.value.length >= 2 && !preview.value
);

/* ---------------- 地图与手绘 ---------------- */
const mapRef = ref(null);
let map = null;
let shapeLayer = null;
let handleLayer = null;
let routeLayer = null;
let crs = 'gcj02';
const drawing = ref(null); // polygon | centerline | null
/** 手绘结果一律存 WGS84：WPML 只认 WGS84 */
const wgsPoints = ref([]);
const closed = ref(false);

/** 机场位置：规划机场附近的航线时要看得见机场在哪 */
const airportMarkers = computed(() =>
  (store.airports || [])
    .map((a) => {
      const s = store.states?.[a.sn];
      const d = s?.device_state || {};
      const lat = d.latitude ?? d.home_latitude;
      const lng = d.longitude ?? d.home_longitude;
      if (!lat || !lng || (lat === 0 && lng === 0)) return null;
      return {
        type: 'airport',
        sn: a.sn,
        name: a.callsign || a.sn,
        lat: Number(lat),
        lng: Number(lng),
        online: !!a.online,
        extra: [a.model, a.projectName].filter(Boolean).join(' · '),
      };
    })
    .filter(Boolean)
);

const center = computed(() => {
  const a = airportMarkers.value[0];
  return a ? toMapLatLng(a.lat, a.lng, crs) || [23.09, 113.49] : [23.09, 113.49];
});

/** [lng,lat] WGS84 → [lat,lng] 底图坐标 */
const toLL = (p) => toMapLatLng(p[1], p[0], crs);
/** 底图坐标 [lat,lng] → [lng,lat] WGS84 */
const toWgs = (lat, lng) => (crs === 'gcj02' ? gcj02ToWgs84(lng, lat) : [lng, lat]);

function onMapReady(m) {
  map = m;
  shapeLayer = L.layerGroup().addTo(map);
  handleLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  map.on('dblclick', finishDraw);
  renderAll();
}

function onBasemap({ crs: c }) {
  crs = c || 'gcj02';
  renderAll();
}

function onMapClick(e) {
  if (!drawing.value) return;
  const [lng, lat] = toWgs(e.latlng.lat, e.latlng.lng);
  wgsPoints.value.push([lng, lat]);
  closed.value = false;
  preview.value = null;
  renderAll();
}

function finishDraw() {
  if (!drawing.value) return;
  if (drawing.value === 'polygon') closed.value = true;
  drawing.value = null;
  renderAll();
}

function toggleDraw(mode) {
  if (drawing.value === mode) {
    finishDraw();
    return;
  }
  if (drawing.value && wgsPoints.value.length) wgsPoints.value = [];
  closed.value = false;
  drawing.value = mode;
  preview.value = null;
  renderAll();
}

function undoPoint() {
  wgsPoints.value.pop();
  closed.value = false;
  preview.value = null;
  renderAll();
}

function clearShape() {
  wgsPoints.value = [];
  closed.value = false;
  drawing.value = null;
  preview.value = null;
  renderAll();
}

/** 以质心为基准整体缩放（Δlon/Δlat 同比例缩放等价于米制等比缩放） */
function scaleShape(k) {
  const pts = wgsPoints.value;
  if (pts.length < 2) return;
  const n = pts.length;
  const c = pts.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  wgsPoints.value = pts.map((p) => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k]);
  renderAll();
  onGeometryChanged();
}

/* ---------------- 图形渲染 ---------------- */
function renderShape() {
  if (!shapeLayer) return;
  shapeLayer.clearLayers();
  const pts = wgsPoints.value;
  const ll = pts.map(toLL).filter(Boolean);
  if (!ll.length) return;
  if (corridor.value) {
    // 带状：中心线始终画折线
    if (ll.length >= 2) {
      L.polyline(ll, { color: '#22d3ee', weight: 2, dashArray: '6,5' }).addTo(shapeLayer);
    }
  } else if (ll.length >= 3) {
    // 面自动成型：第 3 个点落下就是面（三角形），第 4 点变四边形，
    // 继续加点继续扩展——不需要先「双击闭合」才可见
    L.polygon(ll, {
      color: '#22d3ee',
      weight: 2,
      fillColor: '#22d3ee',
      fillOpacity: 0.12,
    }).addTo(shapeLayer);
  } else if (ll.length === 2) {
    L.polyline(ll, { color: '#22d3ee', weight: 2, dashArray: '6,5' }).addTo(shapeLayer);
  }
}

/**
 * 编辑手柄：顶点可拖动改形状，✥ 可整体平移，边中点的空心点点击插入新顶点。
 *
 * 这里一律用 L.marker + divIcon 而不是 circleMarker —— Leaflet 的 Path（圆形/多边形）
 * 原生不支持 draggable，只有 Marker 支持，用 circleMarker 会得到「拖不动」的假手柄。
 */
function renderHandles() {
  if (!handleLayer) return;
  handleLayer.clearLayers();
  const pts = wgsPoints.value;
  const n = pts.length;
  const min = corridor.value ? 2 : 3;
  if (n < min) return;

  pts.forEach((p, i) => {
    const m = L.marker(toLL(p), {
      icon: L.divIcon({
        html: '<i class="pv"></i>',
        className: 'plan-handle',
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      }),
      draggable: true,
      keyboard: false,
    });
    m.bindTooltip(`顶点 ${i + 1}（可拖动）`, { direction: 'top' });
    m.on('drag', (e) => {
      const q = e.target.getLatLng();
      wgsPoints.value[i] = toWgs(q.lat, q.lng);
      renderShape(); // 拖动过程中只重画图形，重画手柄会把正在拖的 marker 销毁
    });
    m.on('dragend', () => {
      renderAll();
      onGeometryChanged();
    });
    m.addTo(handleLayer);
  });

  // 边中点：点击插入顶点
  const edgeCount = closed.value && !corridor.value ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const mm = L.marker(toLL(mid), {
      icon: L.divIcon({
        html: '<i class="pm"></i>',
        className: 'plan-handle plan-handle-mid',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      keyboard: false,
    });
    mm.bindTooltip('点击插入顶点', { direction: 'top' });
    mm.on('click', (e) => {
      e.originalEvent?.stopPropagation?.();
      insertVertex(i + 1, mid);
    });
    mm.addTo(handleLayer);
  }

  // 整体平移手柄：放在质心
  const c = pts.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  const mh = L.marker(toLL(c), {
    icon: L.divIcon({
      html: '<i class="pmv">✥</i>',
      className: 'plan-handle plan-handle-move',
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
    draggable: true,
    keyboard: false,
  });
  mh.bindTooltip('拖动整体平移', { direction: 'top' });
  let start = null;
  mh.on('dragstart', (e) => {
    start = { ll: e.target.getLatLng(), base: pts.map(toLL) };
  });
  mh.on('drag', (e) => {
    if (!start) return;
    const cur = e.target.getLatLng();
    const dLat = cur.lat - start.ll.lat;
    const dLng = cur.lng - start.ll.lng;
    wgsPoints.value = start.base.map(([lat, lng]) => toWgs(lat + dLat, lng + dLng));
    renderShape();
  });
  mh.on('dragend', () => {
    start = null;
    renderAll();
    onGeometryChanged();
  });
  mh.addTo(handleLayer);
}

function insertVertex(idx, wgsPt) {
  const next = [...wgsPoints.value];
  next.splice(idx, 0, wgsPt);
  wgsPoints.value = next;
  renderAll();
  onGeometryChanged();
}

function renderRoute() {
  if (!routeLayer) return;
  routeLayer.clearLayers();
  const p = preview.value;
  if (!p) return;

  // 带状：先把缓冲出来的走廊面画出来，让用户看见「外扩后到底是哪块地」
  if (p.bufferPolygon?.length >= 3) {
    L.polygon(p.bufferPolygon.map(toLL).filter(Boolean), {
      color: '#4ade80',
      weight: 1.5,
      dashArray: '4,4',
      fillColor: '#4ade80',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(routeLayer);
  }

  // 工字形完整路径（带状）；面状/井字用 strips 画
  if (p.plan.flightPath?.length >= 2) {
    L.polyline(p.plan.flightPath.map(toLL).filter(Boolean), {
      color: '#ffb020',
      weight: 2,
      opacity: 0.95,
      interactive: false,
    }).addTo(routeLayer);
  } else {
    for (const s of p.plan.strips || []) {
      const ll = s.map(toLL).filter(Boolean);
      if (ll.length >= 2) {
        L.polyline(ll, { color: '#ffb020', weight: 1.5, opacity: 0.9, interactive: false }).addTo(routeLayer);
      }
    }
  }

  for (const w of p.plan.waypoints || []) {
    L.circleMarker(toLL([w.lon, w.lat]), {
      radius: 1.8,
      color: '#ff6a00',
      weight: 0,
      fillOpacity: 0.9,
      interactive: false,
    }).addTo(routeLayer);
  }
}

function renderAll() {
  renderShape();
  renderHandles();
  renderRoute();
}

/* ---------------- 自动重算 ---------------- */
let replanTimer = 0;
/**
 * 范围变了就自动按新范围重算航线。
 * 只在「已经出过一版航线」时触发——否则用户每拖一下就弹一次请求，
 * 而他自己可能只是想把图形摆正。
 */
function onGeometryChanged() {
  if (!autoReplan.value || !preview.value) return;
  clearTimeout(replanTimer);
  replanTimer = setTimeout(() => doPlan(true), 350);
}

watch(
  () => [
    form.height,
    form.speed,
    form.overlapH,
    form.overlapW,
    form.direction,
    form.margin,
    form.corridorHalfWidth,
    form.extend,
    form.lens.join(','),
    form.aircraftKey,
  ],
  () => onGeometryChanged()
);

/* ---------------- 机型 ---------------- */
async function loadAircraft() {
  airLoading.value = true;
  const r = await waylineApi.aircraft();
  airLoading.value = false;
  if (!r?.ok) {
    ElMessage.error(errMsg(r, '机队机型获取失败'));
    return;
  }
  models.value = r.data?.models || [];
  if (!form.aircraftKey && models.value.length) form.aircraftKey = models.value[0].key;
}

/**
 * 切换航线类型：图形保留，直接按当前图形重算。
 * 正射 ↔ 倾斜共用同一个面；带状把已有顶点当中心线用——
 * 客户不需要为换一种航线重新画一遍范围。
 */
function onTypeChange() {
  if (drawing.value) drawing.value = null;
  closed.value = !corridor.value && wgsPoints.value.length >= 3;
  // 带状但还没有可用顶点：自动进入中心线绘制，省一次点击
  if (corridor.value && wgsPoints.value.length < 2) drawing.value = 'centerline';
  preview.value = null;
  renderAll();
  doPlan(true); // 静默：图形不够（如中心线只有 1 点）就不弹提示
}

/* ---------------- 预览 / 生成 ---------------- */
function buildPayload() {
  const params = {
    templateType: form.templateType,
    height: form.height,
    speed: form.speed,
    overlapH: form.overlapH,
    overlapW: form.overlapW,
    direction: form.direction,
    margin: form.margin,
    lens: form.lens,
  };
  if (form.gsdCm > 0) params.gsdCm = form.gsdCm;
  if (!corridor.value) params.gimbalPitch = form.gimbalPitch;
  const body = { aircraftKey: form.aircraftKey, params };
  if (corridor.value) {
    body.centerline = wgsPoints.value;
    params.corridorHalfWidth = form.corridorHalfWidth;
    params.extend = form.extend;
  } else {
    body.polygon = wgsPoints.value;
  }
  return body;
}

function validateShape() {
  const n = wgsPoints.value.length;
  if (corridor.value && n < 2) return '请先在地图上绘制中心线（至少 2 个点，双击结束）';
  if (!corridor.value && n < 3) return '请绘制测区（至少 3 个点即成面，可继续加点扩大范围）';
  if (!form.aircraftKey) return '请选择目标机型';
  if (!form.lens?.length) return '请至少选择一个镜头';
  return '';
}

async function doPlan(silent = false) {
  const msg = validateShape();
  if (msg) {
    if (!silent) ElMessage.warning(msg);
    else preview.value = null;
    return;
  }
  planning.value = true;
  const r = await waylineApi.plan(buildPayload());
  planning.value = false;
  if (!r?.ok) {
    if (!silent) ElMessage.error(errMsg(r, '规划失败'));
    preview.value = null;
    renderAll();
    return;
  }
  preview.value = r.data;
  renderAll();
}

async function doGenerate() {
  const msg = validateShape();
  if (msg) return ElMessage.warning(msg);
  if (!form.name) return ElMessage.warning('请填写航线名称');
  generating.value = true;
  result.value = null;
  const r = await waylineApi.generate({ ...buildPayload(), name: form.name });
  generating.value = false;
  result.value = { ok: !!r?.ok, message: r?.message || (r?.ok ? '已提交并通过验证' : '提交失败') };
  if (r?.ok) ElMessage.success('已上传司空 2 并通过机型校验');
  else ElMessage.error(errMsg(r, '生成或验证失败'));
}

watch(
  () => store.projectUuid,
  () => loadAircraft()
);

onMounted(loadAircraft);

onBeforeUnmount(() => {
  clearTimeout(replanTimer);
  if (map) {
    map.off('click', onMapClick);
    map.off('dblclick', finishDraw);
  }
});
</script>

<style scoped>
.plan { display: flex; gap: 12px; height: calc(100vh - 132px); }
.plan-map { position: relative; flex: 1; min-width: 380px; border: 1px solid var(--c-line); border-radius: 10px; overflow: hidden; }
.plan-side { width: 366px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.type-card { padding: 10px 12px; }
.plan-side :deep(.el-collapse-item__header) { font-size: 13px; }
.plan-side :deep(.el-collapse-item__content) { padding-bottom: 14px; }

.map-tools { position: absolute; left: 10px; bottom: 10px; z-index: 500; display: flex; gap: 6px; flex-wrap: wrap; max-width: 72%; }
.map-scale { position: absolute; left: 10px; bottom: 46px; z-index: 500; display: flex; gap: 6px; flex-wrap: wrap; max-width: 72%; }
.chip {
  background: rgba(10, 16, 26, 0.86); color: var(--c-text-1); border: 1px solid var(--c-line);
  border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer; user-select: none; white-space: nowrap;
}
.chip:hover { border-color: var(--c-brand); }
.chip.on { background: var(--c-brand); color: #06121f; border-color: var(--c-brand); }
.chip.ghost { cursor: default; opacity: 0.8; }
.chip.off { opacity: 0.45; cursor: not-allowed; }

/* 统计浮层：抬高 26px 避开 Leaflet 版权条 */
.map-stat {
  position: absolute; right: 10px; bottom: 26px; z-index: 500;
  background: rgba(10, 16, 26, 0.88); border: 1px solid var(--c-line);
  border-radius: 8px; padding: 8px 12px;
}
.ms-row { display: flex; align-items: baseline; gap: 4px; color: var(--c-text-2); }
.ms-row b { font-size: 15px; color: var(--c-text-1); margin-left: 6px; }
.ms-row.small { font-size: 11px; margin-top: 2px; }

.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.row label { font-size: 12px; color: var(--c-text-2); flex: none; }
.param { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.param label { font-size: 12px; color: var(--c-text-2); }
.param.hl {
  background: rgba(47, 124, 255, 0.12); border: 1px solid var(--c-brand);
  border-radius: 6px; padding: 4px 8px; margin: 0 -8px 8px;
}
.sub-tip { font-size: 11px; color: var(--c-text-3); margin: -2px 0 8px; }
.ask { margin-top: 10px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 12px; color: var(--c-text-2); margin-top: 8px; }
.kv b { color: var(--c-text-1); font-weight: 500; }
.tip { font-size: 11px; color: var(--c-text-3); line-height: 1.6; margin-top: 8px; }
.warn { font-size: 11px; color: var(--c-warn); line-height: 1.6; margin-top: 6px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: var(--c-text-3); }
.small { font-size: 11px; }

.submit { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.submit-btns { display: flex; gap: 8px; }
.auto { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-text-3); }
.result { font-size: 12px; padding: 6px 8px; border-radius: 6px; line-height: 1.6; }
.result.ok { background: rgba(34, 197, 94, 0.12); color: var(--c-ok); }
.result.bad { background: rgba(239, 68, 68, 0.12); color: var(--c-err); }
</style>

<!-- Leaflet 动态创建的 DOM 拿不到 scoped 的 data 属性，编辑手柄样式必须写成全局 -->
<style>
.plan-handle { background: transparent; border: none; }
.plan-handle .pv {
  display: block; width: 12px; height: 12px; border-radius: 50%;
  background: #22d3ee; border: 2px solid #06121f;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.55); cursor: move;
}
.plan-handle .pm {
  display: block; width: 8px; height: 8px; border-radius: 50%;
  background: rgba(6, 18, 31, 0.85); border: 1.5px solid #22d3ee; cursor: copy;
}
.plan-handle-mid { opacity: 0.75; }
.plan-handle-mid:hover { opacity: 1; }
.plan-handle .pmv {
  display: grid; place-items: center; width: 22px; height: 22px;
  border-radius: 50%; background: rgba(6, 18, 31, 0.9); border: 1.5px solid #ffb020;
  color: #ffb020; font-size: 13px; font-style: normal; line-height: 1; cursor: move;
}
</style>
