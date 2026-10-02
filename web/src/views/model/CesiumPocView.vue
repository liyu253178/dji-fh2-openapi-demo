<template>
  <div class="cpoc">
    <!-- ============ 工具条 ============ -->
    <div class="card">
      <div class="card-body bar">
        <el-select
          v-model="modelId"
          size="small"
          placeholder="选择本地已缓存模型"
          style="width: 260px"
          :loading="modelsLoading"
        >
          <el-option v-for="m in models" :key="m.id" :label="m.name" :value="m.id">
            <span>{{ m.name }}</span>
            <span class="opt-meta">{{ m.file_type === 'model_3d' ? '3D' : '2D' }} · {{ fmtMB(m.bytes) }}</span>
          </el-option>
        </el-select>

        <el-button
          size="small"
          type="primary"
          :loading="state === 'loading'"
          :disabled="!modelId"
          @click="loadModel"
        >
          {{ state === 'ready' ? '重新加载' : '加载模型' }}
        </el-button>

        <span class="sep" />

        <el-radio-group v-model="mode" size="small" @change="onModeChange">
          <el-radio-button value="3d">三维</el-radio-button>
          <el-radio-button value="2d">二维</el-radio-button>
        </el-radio-group>

        <el-radio-group v-model="imagery" size="small" @change="onImageryChange">
          <el-radio-button value="none">无底图（离线）</el-radio-button>
          <el-radio-button value="amap">高德影像（GCJ-02）</el-radio-button>
        </el-radio-group>

        <span class="sep" />

        <el-radio-group v-model="tool" size="small" @change="onToolChange">
          <el-radio-button value="">浏览</el-radio-button>
          <el-radio-button value="distance">距离</el-radio-button>
          <el-radio-button value="area">面积</el-radio-button>
        </el-radio-group>
        <el-button size="small" :disabled="!tool || !points.length" @click="undoPoint">撤销</el-button>
        <el-button size="small" :disabled="!points.length" @click="clearPoints">清除</el-button>

        <span class="sep" />

        <el-button-group size="small">
          <el-button v-for="v in VIEWS" :key="v.key" @click="applyView(v.key)">{{ v.name }}</el-button>
        </el-button-group>

        <el-button size="small" :disabled="state !== 'ready'" @click="runBenchmark()">
          {{ benching ? '测帧率中…' : '跑分（旋转3秒）' }}
        </el-button>
      </div>

      <!-- 量测读数 -->
      <div v-if="tool" class="card-body result-bar">
        <div v-if="readouts.length" class="result-lines">
          <span v-for="(l, i) in readouts" :key="i" class="rl">{{ l }}</span>
        </div>
        <div v-else class="muted small">
          {{ tool === 'distance' ? '在模型表面点两个点量距离' : '在模型表面依次点至少三个点成面' }}
        </div>
        <div v-if="lastPick" class="small coord-line">最后取点：{{ lastPick }}</div>
      </div>
    </div>

    <!-- ============ 三维舞台 ============ -->
    <div class="stage">
      <div ref="host" class="globe"></div>

      <!-- 加载/错误浮层 -->
      <div v-if="state === 'loading'" class="overlay center">
        <div class="spin" />
        <div class="ov-t">正在加载三维底座…</div>
        <div class="ov-s">{{ progressText }}</div>
      </div>
      <div v-else-if="state === 'error'" class="overlay center">
        <div class="ov-t err">加载失败</div>
        <div class="ov-s err-body">{{ errText }}</div>
        <div class="ov-s muted">{{ errHint }}</div>
      </div>

      <!-- 指标面板（G2 性能 / 运行时环境） -->
      <div class="metrics card">
        <div class="m-title">实测指标<span class="m-tag">POC</span></div>
        <div class="m-row"><span>底座</span><b>CesiumJS {{ metrics.version || '—' }}</b></div>
        <div class="m-row"><span>可交互耗时</span><b>{{ metrics.interactiveMs === null ? '—' : metrics.interactiveMs + ' ms' }}</b></div>
        <div class="m-row"><span>平均帧率</span><b>{{ metrics.fps === null ? '—' : metrics.fps.toFixed(1) + ' fps' }}{{ metrics.frames ? ` (${metrics.frames} 帧)` : '' }}</b></div>
        <div class="m-row"><span>已载瓦片</span><b>{{ metrics.tilesLoaded }} / {{ metrics.tilesTotal }}</b></div>
        <div class="m-row"><span>绘制指令</span><b>{{ metrics.commands }}</b></div>
        <div class="m-row"><span>瓦片缓存上限</span><b>{{ fmtMB(metrics.cacheBytes) }}</b></div>
        <div class="m-row"><span>Ion 令牌</span><b :class="metrics.ionDisabled ? 'ok' : 'bad'">{{ metrics.ionDisabled ? '已禁用（离线可用）' : '未禁用' }}</b></div>
        <div class="m-row"><span>渲染设备</span><b class="ellip" :title="metrics.renderer">{{ metrics.renderer || '—' }}</b></div>
        <div class="m-row"><span>坐标来源</span><b class="ellip" :title="metrics.coordSource">{{ metrics.coordSource || '—' }}</b></div>
        <div v-if="metrics.gcjShiftM" class="m-row">
          <span>GCJ 纠偏量</span><b>{{ metrics.gcjShiftM.toFixed(1) }} m</b>
        </div>
      </div>

      <!-- 诚实留白：未验证项直接标在界面上 -->
      <div class="gaps card">
        <div class="m-title">本轮仍未验证</div>
        <ul>
          <li>无地理参考的 Y-up 局部坐标模型如何摆放（需人工 modelMatrix）</li>
          <li>GCJ-02 纠偏精度未经高德真值比对，仅做了自洽性检查</li>
          <li>与现有 three.js 方案的同机对比需在同一台机器上跑两遍才算数</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * Cesium 三维底座 POC（阶段 0）
 *
 * 这是一条**独立路由**，随时可删，不影响任何现有页面。
 * 目的不是替换 Leaflet/three.js，而是把《Cesium 底座引入论证》里
 * 三个不确定项打成实测数字：asset.version 0.0 能否加载、性能如何、离线可不可行。
 *
 * 设计要点：
 *  - 完全离线：禁 Ion、不要地形、底图默认可为「无」，只依赖自托管静态资源 + 本地模型缓存
 *  - 模型来源走 /api/model/local（读磁盘清单），断网/未配置 TK 也能选到模型
 *  - 瓦片走路径式路由 /api/model/:id/tiles/*，让 tileset.json 内部的相对 uri 自然成立
 *  - 所有关键耗时/帧率写进 window.__CESIUM_POC__，供 verify 脚本读取，不靠肉眼
 */
import { ref, shallowRef, reactive, onMounted, onBeforeUnmount } from 'vue';
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { modelApi } from '../../api/dji.js';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../../utils/geo.js';
import { ecefToLlh, llhToEcef, looksLikeEcef } from '../../utils/ecef.js';

/** 离线前提：禁掉 Ion。任何 Ion 资源请求在私有化/内网环境都会失败。 */
Cesium.Ion.defaultAccessToken = '';
if (Cesium.Ion.defaultServer) Cesium.Ion.defaultServer = undefined;

const host = ref(null);
const modelId = ref('');
const models = ref([]);
const modelsLoading = ref(false);
const mode = ref('3d');
const imagery = ref('none');
const tool = ref('');
const state = ref('idle'); // idle | loading | ready | error
const progressText = ref('');
const errText = ref('');
const errHint = ref('');
const points = ref([]);
const readouts = ref([]);
const lastPick = ref('');
const benching = ref(false);

const VIEWS = [
  { key: 'top', name: '俯视' },
  { key: 'front', name: '正视' },
  { key: 'back', name: '后视' },
  { key: 'left', name: '左视' },
  { key: 'right', name: '右视' },
  { key: 'home', name: '复位' },
];

const metrics = reactive({
  version: '',
  interactiveMs: null,
  fps: null,
  frames: 0,
  // 同一窗口内的 rAF 回调次数。与 frames（引擎真实渲染帧）并列，
  // 用来区分「渲染没跑」和「浏览器被节流」：raf 很高但 frames=0 → 引擎侧问题；
  // 两者都低 → 窗口被节流/遮挡。没有这个对照，0 帧无法归因。
  framesRaf: 0,
  benchDone: false,
  tilesLoaded: 0,
  tilesTotal: 0,
  commands: 0,
  cacheBytes: 0,
  ionDisabled: false,
  renderer: '',
  coordSource: '',
  gcjShiftM: null,
});

let viewer = null;
let tileset = null;
let handler = null;
let metricsTimer = null;
let rafHooked = false;
const entities = [];

const fmtMB = (b) => (b ? `${(b / 1048576).toFixed(b > 10485760 ? 0 : 1)} MB` : '—');
const err = (msg) => {
  errText.value = msg;
  errHint.value = '检查后端是否已启动、模型缓存是否完整，然后点「重新加载」。';
  state.value = 'error';
};

/* ------------------------------------------------------------------ *
 * 高德 GCJ-02 底图
 *
 * 高德瓦片的行列号是按 GCJ-02 经纬度切的；而地球是 WGS84。
 * Cesium 拿 WGS84 坐标来问「这属于哪块瓦片」，如果直接交给标准 WebMercator
 * TilingScheme，取回来的瓦片画的是「GCJ 的 P」，而 P 真正的位置在 WGS84 里
 * 还要往东偏几百米——底图整体错位几百米就是这么来的。
 *
 * 解法：自定义 TilingScheme，把「问瓦片」这一步改成
 *   WGS84 坐标 → 先转 GCJ-02 → 再算行列号
 * 取瓦片时反向：行列号 → GCJ 经纬度 → 转回 WGS84 得到这张瓦片该铺的位置。
 * 这样地球还是 WGS84 的地球，只是取图时对齐到了 GCJ 的格网。
 * ------------------------------------------------------------------ */
class Gcj02WebMercatorTilingScheme extends Cesium.WebMercatorTilingScheme {
  positionToTileXY(position, level, result) {
    const lon = Cesium.Math.toDegrees(position.longitude);
    const lat = Cesium.Math.toDegrees(position.latitude);
    const [glon, glat] = wgs84ToGcj02(lon, lat);
    return super.positionToTileXY(
      Cesium.Cartographic.fromRadians(
        Cesium.Math.toRadians(glon),
        Cesium.Math.toRadians(glat)
      ),
      level,
      result
    );
  }

  tileXYToRectangle(x, y, level, result) {
    const gcj = super.tileXYToRectangle(x, y, level, new Cesium.Rectangle());
    // 四角 GCJ→WGS84 取包络。纠偏量在瓦片尺度上近似平移，四角差异可忽略。
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const [lonDeg, latDeg] of [
      [Cesium.Math.toDegrees(gcj.west), Cesium.Math.toDegrees(gcj.south)],
      [Cesium.Math.toDegrees(gcj.east), Cesium.Math.toDegrees(gcj.south)],
      [Cesium.Math.toDegrees(gcj.east), Cesium.Math.toDegrees(gcj.north)],
      [Cesium.Math.toDegrees(gcj.west), Cesium.Math.toDegrees(gcj.north)],
    ]) {
      const [wlon, wlat] = gcj02ToWgs84(lonDeg, latDeg);
      west = Math.min(west, wlon);
      east = Math.max(east, wlon);
      south = Math.min(south, wlat);
      north = Math.max(north, wlat);
    }
    const rect = result ?? new Cesium.Rectangle();
    rect.west = Cesium.Math.toRadians(west);
    rect.east = Cesium.Math.toRadians(east);
    rect.south = Cesium.Math.toRadians(south);
    rect.north = Cesium.Math.toRadians(north);
    return rect;
  }
}

/** 两个经纬度点之间的地面距离（米）——用测地线，不用直线 */
function groundDistanceM(lon1, lat1, lon2, lat2) {
  const g = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(lon1, lat1),
    Cesium.Cartographic.fromDegrees(lon2, lat2)
  );
  return g.surfaceDistance;
}

const getViewer = () => viewer;

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */
function createViewer() {
  viewer = new Cesium.Viewer(host.value, {
    // 不挂任何默认影像：底图由下面的 setImagery 决定，「无底图」是合法的离线态
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    animation: false,
    timeline: false,
    infoBox: false,
    selectionIndicator: false,
    // 按需渲染：静止时 GPU 不空转，这是对治「风扇狂转」的关键一档
    requestRenderMode: true,
    maximumRenderTimeChange: 0.5,
    // 不引入地形（D3）：离线地形需自备 quantized-mesh，够用再说
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    contextOptions: { webgl: { alpha: false, preserveDrawingBuffer: true } },
  });

  const scene = viewer.scene;
  // 关掉大气/天空盒/雾：无底图时这些只会把模型衬得更糊，也少几批绘制
  scene.skyBox.show = false;
  scene.skyAtmosphere.show = false;
  scene.fog.enabled = false;
  scene.globe.showGroundAtmosphere = false;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#12141a');
  scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0a0c');
  // 量测取点走 GPU 深度缓冲，必须让拾取对地形/模型做深度测试
  scene.globe.depthTestAgainstTerrain = true;
  scene.highDynamicRange = false;
  scene.msaaSamples = 1;

  // 相机键位对齐大疆智图：左键平移、右键/滚轮缩放、中键旋转
  const c = scene.screenSpaceCameraController;
  c.translateEventTypes = [Cesium.CameraEventType.LEFT_DRAG];
  c.zoomEventTypes = [Cesium.CameraEventType.RIGHT_DRAG, Cesium.CameraEventType.WHEEL];
  c.rotateEventTypes = [Cesium.CameraEventType.MIDDLE_DRAG];
  c.tiltEventTypes = [Cesium.CameraEventType.MIDDLE_DRAG];
  c.lookEventTypes = [];
  c.inertiaSpin = 0.6;
  c.inertiaTranslate = 0.6;
  c.inertiaZoom = 0.6;
  c.minimumZoomDistance = 0.5;
  c.maximumZoomDistance = 20000000;

  metrics.version = Cesium.VERSION;

  const gl = scene.context?._gl || scene.context?._originalGLContext;
  try {
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    metrics.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) || '';
    metrics.ionDisabled = !Cesium.Ion.defaultAccessToken;
    metrics.renderer = String(metrics.renderer).slice(0, 64);
  } catch {
    metrics.renderer = '读取失败';
  }

  handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction(onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // 每 500ms 刷一次运行时数字（按需渲染下靠事件驱动，不能只靠 rAF）
  metricsTimer = window.setInterval(pollMetrics, 500);
  pollMetrics();

  window.__CESIUM_POC__ = {
    ready: true,
    // 只挂验收脚本真正要用到的几个类，**不要挂整个 Cesium 命名空间**——
    // 整体挂出去会让 rollup 失去 tree-shaking 依据，实测 chunk 从 4.2MB 涨到 4.97MB。
    Cesium: {
      Cartographic: Cesium.Cartographic,
      Cartesian2: Cesium.Cartesian2,
      Cartesian3: Cesium.Cartesian3,
      EllipsoidGeodesic: Cesium.EllipsoidGeodesic,
      Math: Cesium.Math,
    },
    get metrics() {
      return { ...metrics, modelId: modelId.value, state: state.value };
    },
    viewer,
  };
  rafHooked = true;
}

function pollMetrics() {
  if (!viewer || viewer.isDestroyed()) return;
  const s = viewer.scene;
  // Cesium 1.145 的帧状态字段是 commandList（不是 commandsLength）
  metrics.commands = s.frameState?.commandList?.length ?? metrics.commands;
  if (tileset && !tileset.isDestroyed()) {
    const st = tileset.statistics;
    // 注意字段名：Cesium 没有 numberOfTilesLoaded。
    // 正确的是 numberOfTilesWithContentReady（已就绪的瓦片）。
    metrics.tilesLoaded = st?.numberOfTilesWithContentReady ?? 0;
    metrics.tilesTotal = st?.numberOfTilesTotal ?? 0;
  }
  // 注意：__CESIUM_POC__.metrics 是只读 getter（直接读实时值），
  // 这里不能再赋值，否则抛 TypeError 并被 loadModel 的 catch 吞掉，
  // 表现为「模型明明加载成功却报错」——这个坑踩过一次了。
}

/* ------------------------------------------------------------------ *
 * 底图
 * ------------------------------------------------------------------ */
function setImagery(kind) {
  if (!viewer) return;
  const layers = viewer.imageryLayers;
  layers.removeAll();
  metrics.gcjShiftM = null;
  if (kind === 'none') return;

  const scheme = new Gcj02WebMercatorTilingScheme();
  layers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({
      // 高德影像，行列号按 GCJ-02；纠偏由上面的 TilingScheme 负责
      url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
      subdomains: ['1', '2', '3', '4'],
      tilingScheme: scheme,
      maximumLevel: 18,
      credit: '高德影像 · GCJ-02 纠偏',
    })
  );
  // 量化「不纠偏会偏多少」：同一位置在 GCJ 与 WGS84 下的位移量
  const c = footprintCenter();
  if (c) {
    const [glon, glat] = wgs84ToGcj02(c.lon, c.lat);
    metrics.gcjShiftM = groundDistanceM(c.lon, c.lat, glon, glat);
  }
}

/* ------------------------------------------------------------------ *
 * 模型加载
 * ------------------------------------------------------------------ */
function footprintCenter() {
  if (!tileset || tileset.isDestroyed() || !tileset.boundingSphere) return null;
  const carto = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
    height: carto.height,
    radius: tileset.boundingSphere.radius,
  };
}

async function loadModel() {
  if (!viewer || !modelId.value) return;
  state.value = 'loading';
  errText.value = '';
  clearPoints();
  removeTileset();

  const t0 = performance.now();
  progressText.value = '读取模型清单…';
  try {
    const r = await modelApi.files(modelId.value);
    if (!r?.ok || !r.data) throw new Error(r?.message || '模型清单不可用');
    const entry = (r.data.tilesetRoots || [])[0] || r.data.tileset;
    if (!entry) throw new Error('该模型包内没有 tileset.json，无法用三维引擎加载');

    progressText.value = '解析 tileset…';
    const url = modelApi.tilesUrl(modelId.value, entry);
    // ⚠️ Cesium 1.145 已把 maximumMemoryUsage 拆成 cacheBytes + maximumCacheOverflowBytes。
    //    论证文档 R6 预判的「API 会改名」在这里实锤，升级时必须过一遍。
    tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
      maximumScreenSpaceError: 16,
      cacheBytes: 512 * 1024 * 1024,
      maximumCacheOverflowBytes: 512 * 1024 * 1024,
      skipLevelOfDetail: true,
      dynamicScreenSpaceError: true,
      preloadWhenHidden: false,
      // 司空 2 的 tileset 里 geometricError 常是 1e10 级异常值，
      // 关掉阴影并允许背面剔除能显著减少无效绘制
      shadows: Cesium.ShadowMode.DISABLED,
      backFaceCulling: true,
    });
    metrics.cacheBytes = 512 * 1024 * 1024;

    // 统计一次点击到「首屏瓦片就位」的真实耗时——这是 G2 的主指标
    const firstPaint = new Promise((resolve) => {
      const off = tileset.initialTilesLoaded.addEventListener(() => {
        off();
        resolve(performance.now());
      });
      // 兜底：20s 内没等到就按当前时间记，避免界面永远转圈
      window.setTimeout(() => {
        off();
        resolve(performance.now());
      }, 20000);
    });

    viewer.scene.primitives.add(tileset);
    // 局部坐标（Y-up）模型没有地理参考：如实告知，不硬凑位置
    seedLocation();
    await viewer.zoomTo(tileset, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), 0));
    setImagery(imagery.value);

    const painted = await firstPaint;
    metrics.interactiveMs = Math.round(painted - t0);
    state.value = 'ready';
    pollMetrics();
  } catch (e) {
    // 加载失败本身就是 POC 的有效结论（例如 asset.version 0.0 不被支持）
    err(e?.message || String(e));
  }
}

/** 判断模型是不是 ECEF（有地理参考），并把结论写进指标面板 */
function seedLocation() {
  const bs = tileset.boundingSphere;
  const llh = ecefToLlh(bs.center.x, bs.center.y, bs.center.z);
  const isEcef = looksLikeEcef(bs.center.x, bs.center.y, bs.center.z);
  const self = llhToEcef(llh[0], llh[1], llh[2]);
  const diff = Math.hypot(self[0] - bs.center.x, self[1] - bs.center.y, self[2] - bs.center.z);
  metrics.coordSource = isEcef
    ? `Cesium 投影球心 → ${llh[0].toFixed(6)}°E ${llh[1].toFixed(6)}°N（与本项目 ecef.js 反算差 ${diff.toExponential(2)} m）`
    : '局部坐标（无地理参考），落位需人工指定';
  window.__CESIUM_POC__.location = { llh, isEcef, selfCheckDiffM: diff };
}

function removeTileset() {
  if (tileset && viewer && !viewer.isDestroyed()) {
    viewer.scene.primitives.remove(tileset);
    tileset = null;
  }
  metrics.tilesLoaded = 0;
  metrics.interactiveMs = null;
  metrics.fps = null;
  metrics.frames = 0;
  metrics.framesRaf = 0;
  metrics.benchDone = false;
}

/* ------------------------------------------------------------------ *
 * 视角
 * ------------------------------------------------------------------ */
function applyView(kind) {
  if (!viewer || !tileset) return;
  const r = tileset.boundingSphere.radius || 100;
  const P = {
    top: [0, -89, 2.0],
    front: [0, -12, 1.8],
    back: [Math.PI, -12, 1.8],
    left: [-Math.PI / 2, -12, 1.8],
    right: [Math.PI / 2, -12, 1.8],
    home: [0, -35, 2.6],
  }[kind] || [0, -35, 2.6];
  viewer.camera.flyToBoundingSphere(tileset.boundingSphere, {
    offset: new Cesium.HeadingPitchRange(P[0], Cesium.Math.toRadians(P[1]), r * P[2]),
    duration: 0.8,
  });
}

function onModeChange(v) {
  if (!viewer) return;
  if (v === '2d') viewer.scene.morphTo2D(0.8);
  else viewer.scene.morphTo3D(0.8);
}

function onImageryChange(v) {
  setImagery(v);
}

/* ------------------------------------------------------------------ *
 * 量测（与现有页面同一口径：直线/水平/高差 + 投影面积）
 * ------------------------------------------------------------------ */
function pickAt(pos) {
  const scene = viewer.scene;
  let p = scene.pickPosition(pos);
  if (!Cesium.defined(p)) p = scene.camera.pickEllipsoid(pos, scene.globe.ellipsoid);
  return p;
}

function onLeftClick(click) {
  if (!tool.value || state.value !== 'ready') return;
  const world = pickAt(click.position);
  if (!Cesium.defined(world)) return;
  points.value = [...points.value, world];
  const carto = Cesium.Cartographic.fromCartesian(world);
  lastPick.value =
    `${Cesium.Math.toDegrees(carto.longitude).toFixed(6)}°E ` +
    `${Cesium.Math.toDegrees(carto.latitude).toFixed(6)}°N · ${carto.height.toFixed(2)} m`;
  redrawMeasure();
}

function clearPoints() {
  points.value = [];
  readouts.value = [];
  lastPick.value = '';
  entities.splice(0).forEach((e) => viewer?.entities.remove(e));
}

function undoPoint() {
  points.value = points.value.slice(0, -1);
  redrawMeasure();
}

/** 面积：先把顶点投到过质心的 ENU 平面上，再算平面多边形面积（即投影面积） */
function projectedArea(positions) {
  if (positions.length < 3) return 0;
  const center = Cesium.BoundingSphere.fromPoints(positions).center;
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
  const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
  const flat = positions.map((p) => Cesium.Matrix4.multiplyByPoint(inv, p, new Cesium.Cartesian3()));
  let s = 0;
  for (let i = 0; i < flat.length; i += 1) {
    const a = flat[i];
    const b = flat[(i + 1) % flat.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function redrawMeasure() {
  if (!viewer) return;
  entities.splice(0).forEach((e) => viewer.entities.remove(e));
  const pts = points.value;
  readouts.value = [];
  if (!pts.length) return;

  if (tool.value === 'distance' && pts.length >= 2) {
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const ca = Cesium.Cartographic.fromCartesian(a);
    const cb = Cesium.Cartographic.fromCartesian(b);
    const straight = Cesium.Cartesian3.distance(a, b);
    const geo = new Cesium.EllipsoidGeodesic(ca, cb);
    const horizontal = geo.surfaceDistance;
    const vertical = cb.height - ca.height;
    const slope = horizontal > 1e-6 ? (vertical / horizontal) * 100 : 0;
    readouts.value = [
      `直线 ${straight.toFixed(3)} m`,
      `水平 ${horizontal.toFixed(3)} m`,
      `高差 ${vertical >= 0 ? '+' : ''}${vertical.toFixed(3)} m`,
      `坡度 ${slope.toFixed(2)} %`,
    ];
  }

  if (tool.value === 'area') {
    if (pts.length >= 3) {
      const m2 = projectedArea(pts);
      const mu = m2 / 666.6667;
      readouts.value = [
        `投影面积 ${m2.toFixed(2)} ㎡`,
        `≈ ${mu.toFixed(4)} 亩`,
        `顶点 ${pts.length} 个`,
      ];
    } else {
      readouts.value = [`已取 ${pts.length} 点，至少需要 3 点成面`];
    }
  }

  // 顶点
  pts.forEach((p, i) => {
    entities.push(
      viewer.entities.add({
        position: p,
        point: { pixelSize: 8, color: Cesium.Color.fromCssColorString('#ff6a00'), disableDepthTestDistance: 0 },
        label: {
          text: String(i + 1),
          font: '11px sans-serif',
          fillColor: Cesium.Color.WHITE,
          pixelOffset: new Cesium.Cartesian2(10, -10),
          disableDepthTestDistance: 0,
        },
      })
    );
  });
  if (pts.length >= 2) {
    entities.push(
      viewer.entities.add({
        polyline: {
          positions: tool.value === 'area' && pts.length >= 3 ? [...pts, pts[0]] : pts,
          width: 2,
          material: Cesium.Color.fromCssColorString('#ff6a00'),
          clampToGround: false,
        },
      })
    );
  }
  if (tool.value === 'area' && pts.length >= 3) {
    entities.push(
      viewer.entities.add({
        polygon: {
          hierarchy: pts,
          perPositionHeight: true,
          material: Cesium.Color.fromCssColorString('#ff6a00').withAlpha(0.25),
        },
      })
    );
  }
}

function onToolChange() {
  clearPoints();
}

/* ------------------------------------------------------------------ *
 * G2 · 帧率跑分
 * ------------------------------------------------------------------ */
async function runBenchmark(durationMs = 3000) {
  if (!viewer || !tileset) return;
  // ⚠️ 必须挡住「事件对象被当成参数」这种情况：
  // 模板里写成 @click="runBenchmark"（不带括号）时，Vue 会把 MouseEvent 当第一个实参传进来，
  // default 参数不会生效；接着 setTimeout(res, MouseEvent) 被转成 0ms，
  // 跑分窗口瞬间结束 → 帧号差值为 0 → 报出「0 fps」这种假数据。
  // 这类 bug 不会报错，只会静默给出错误结论，所以这里显式兜一层。
  const ms = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 3000;
  benching.value = true;
  const scene = viewer.scene;
  const wasRequestRender = scene.requestRenderMode;
  scene.requestRenderMode = false; // 连续渲染才有帧率可测

  // ⚠️ 预热：必须等渲染循环真的转起来再开始数帧。
  // 冷启动时（大包刚加载完、主线程还在解析瓦片）可能连续数百毫秒一帧都不渲染，
  // 此时立刻取 frameNumber 会得到「0 帧 / 0 fps」——它看起来像「渲染不动」，
  // 实际只是循环还没转起来。实测过：同一份代码，首次运行 0 帧、第二次 60fps。
  // 做法：先等满 3 帧 postRender 再计数，最多等 2 秒；等不到就照实数，
  // 绝不把「没预热」包装成「性能好」。
  await new Promise((res) => {
    let n = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      off();
      window.clearTimeout(timer);
      res();
    };
    const off = scene.postRender.addEventListener(() => {
      n += 1;
      if (n >= 3) finish();
    });
    const timer = window.setTimeout(finish, 2000);
  });

  // 数帧：挂 postRender 事件（Cesium 公开 API，预热阶段已验证会触发）。
  //
  // ⚠️ 不要改用 scene.frameState.frameNumber：Scene 没有公开的 frameState 属性，
  // （内部是 _frameState），可选链会静默取到 undefined → ?? 0，
  // 首尾相减恒等于 0，于是「0 fps」这个结论被报出来却没有任何报错。
  // 实测踩到过：预热明明等到了 3 帧 postRender，计数仍是 0——
  // 两个数据源不一致本身就是最明显的破绽，遇到「0 帧」先查是不是取错了数。
  let frames = 0;
  const offCount = scene.postRender.addEventListener(() => {
    frames += 1;
  });
  // 并列记一份 rAF 回调数，用于归因（见 metrics.framesRaf 注释）
  let rafFrames = 0;
  let rafOn = true;
  const rafTick = () => {
    if (!rafOn) return;
    rafFrames += 1;
    window.requestAnimationFrame(rafTick);
  };
  window.requestAnimationFrame(rafTick);

  // 边转边测：静止画面测出来的帧率没有参考价值
  const sphere = tileset.boundingSphere;
  const r = sphere.radius || 100;
  const t0 = performance.now();
  let heading = 0;
  const spin = window.setInterval(() => {
    heading += 0.05;
    viewer.camera.flyToBoundingSphere(sphere, {
      offset: new Cesium.HeadingPitchRange(heading, Cesium.Math.toRadians(-35), r * 2.4),
      duration: 0.2,
    });
  }, 200);

  await new Promise((res) => window.setTimeout(res, ms));
  window.clearInterval(spin);
  const dt = performance.now() - t0;
  offCount();
  rafOn = false;
  scene.requestRenderMode = wasRequestRender;
  metrics.frames = frames;
  metrics.framesRaf = rafFrames;
  // 取不到就是取不到：0 帧时保持 null，让验收脚本判定失败，而不是写个 0 充数
  metrics.fps = frames > 0 ? frames / (dt / 1000) : null;
  metrics.benchDone = true;
  benching.value = false;
  pollMetrics();
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
async function loadLocalModels() {
  modelsLoading.value = true;
  try {
    const r = await modelApi.local();
    const list = (r?.data?.list || []).filter((m) => m.file_type === 'model_3d');
    models.value = list;
    const prefer = list.find((m) => m.id === '335363146') || list[0];
    if (prefer) modelId.value = prefer.id;
  } catch (e) {
    err(`${e?.message || e}`);
  } finally {
    modelsLoading.value = false;
  }
}

onMounted(async () => {
  createViewer();
  await loadLocalModels();
  if (modelId.value) loadModel();
});

onBeforeUnmount(() => {
  if (metricsTimer) window.clearInterval(metricsTimer);
  handler?.destroy();
  handler = null;
  try {
    viewer?.destroy();
  } catch {
    /* 卸载期销毁失败无需处理 */
  }
  viewer = null;
  tileset = null;
  delete window.__CESIUM_POC__;
});
</script>

<style scoped>
.cpoc {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  height: 100%;
  min-height: 0;
}
.card {
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-lg);
}
.card-body {
  padding: var(--sp-3);
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.sep {
  width: 1px;
  height: 18px;
  background: var(--c-line);
  margin: 0 var(--sp-1);
}
.opt-meta {
  float: right;
  color: var(--c-text-2);
  font-size: var(--fs-xs);
  margin-left: var(--sp-3);
}
.result-bar {
  border-top: 1px solid var(--c-line-soft);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.result-lines {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-4);
}
.rl {
  color: var(--c-brand-2);
  font-size: var(--fs-md);
  font-variant-numeric: tabular-nums;
}
.coord-line {
  color: var(--c-text-1);
}
.muted {
  color: var(--c-text-2);
}
.small {
  font-size: var(--fs-sm);
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  border: 1px solid var(--c-line);
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--c-bg-0);
}
.globe {
  position: absolute;
  inset: 0;
}
/* Cesium 默认控件配色与平台深色底不搭，收掉不需要的装饰 */
.globe :deep(.cesium-viewer-bottom),
.globe :deep(.cesium-widget-credits) {
  display: none !important;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  background: rgba(10, 10, 12, 0.72);
  z-index: 5;
}
.ov-t {
  color: var(--c-text-0);
  font-size: var(--fs-lg);
}
.ov-t.err {
  color: var(--c-err);
}
.ov-s {
  font-size: var(--fs-sm);
  color: var(--c-text-1);
  max-width: 560px;
  text-align: center;
}
.err-body {
  color: var(--c-err);
}
.spin {
  width: 26px;
  height: 26px;
  border: 2px solid var(--c-line);
  border-top-color: var(--c-brand);
  border-radius: 50%;
  animation: cpoc-spin 0.9s linear infinite;
}
@keyframes cpoc-spin {
  to {
    transform: rotate(360deg);
  }
}

.metrics,
.gaps {
  position: absolute;
  right: var(--sp-3);
  width: 268px;
  padding: var(--sp-3);
  background: var(--c-bg-float);
  backdrop-filter: blur(6px);
  z-index: 4;
}
.metrics {
  top: var(--sp-3);
}
.gaps {
  bottom: var(--sp-3);
}
.m-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-md);
  color: var(--c-text-0);
  margin-bottom: var(--sp-2);
}
.m-tag {
  font-size: var(--fs-xs);
  color: var(--c-brand-2);
  border: 1px solid var(--c-brand-dim);
  background: var(--c-brand-dim);
  border-radius: var(--r-sm);
  padding: 0 5px;
}
.m-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  font-size: var(--fs-sm);
  line-height: 1.9;
}
.m-row > span {
  color: var(--c-text-2);
  flex: none;
}
.m-row > b {
  color: var(--c-text-0);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.m-row > b.ok {
  color: var(--c-ok);
}
.m-row > b.bad {
  color: var(--c-warn);
}
.ellip {
  display: inline-block;
  max-width: 158px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gaps ul {
  margin: 0;
  padding-left: 16px;
  color: var(--c-text-1);
  font-size: var(--fs-xs);
  line-height: 1.8;
}
</style>
