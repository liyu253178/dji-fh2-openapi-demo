<template>
  <div class="viewer">
    <!-- data-* 仅用于自动化校验瓦片是否真的加载并渲染出来 -->
    <div
      v-show="mode === '3d'"
      ref="canvasWrap"
      class="viewer-canvas"
      :data-mode="mode"
      :data-desired="desiredCount"
      :data-loaded="loadedCount"
      :data-bbox="bboxInfo"
    ></div>

    <!-- 没有可渲染的三维数据时回退：预览图仍放进同一个窗口里看 -->
    <div v-if="mode === 'image'" class="viewer-fallback">
      <img v-if="!imgError" :src="previewSrc" alt="模型预览图" @error="imgError = true" />
      <div v-else class="muted small">预览图不可用</div>
    </div>

    <div v-if="stage" class="viewer-stage small">{{ stage }}</div>
    <div v-if="error" class="viewer-error small">{{ error }}</div>

    <div v-if="mode === '3d'" class="viewer-views">
      <span class="vv-label">视角</span>
      <span class="vv-btn" :class="{ on: autoRotate }" title="点击开始自动旋转，再点其他视角停止" @click="toggleAutoRotate">⟳</span>
      <span class="vv-btn" :class="{ on: activeView === 'top' }" title="俯视图（从上往下看）" @click="setView('top')">俯视</span>
      <span class="vv-btn" :class="{ on: activeView === 'front' }" title="正视图" @click="setView('front')">正视</span>
      <span class="vv-btn" :class="{ on: activeView === 'back' }" title="后视图" @click="setView('back')">后视</span>
      <span class="vv-btn" :class="{ on: activeView === 'left' }" title="左视图" @click="setView('left')">左视</span>
      <span class="vv-btn" :class="{ on: activeView === 'right' }" title="右视图" @click="setView('right')">右视</span>
      <span class="vv-btn" title="回到初始视角" @click="setView('home')">复位</span>
    </div>

    <div v-if="mode === '3d'" class="viewer-tip small muted">
      <b>左键</b>拖动平移 · <b>滚轮</b>或<b>右键</b>拖动缩放 · <b>按住滚轮</b>拖动旋转（与大疆智图一致）
    </div>

    <!-- 悬停读数：证明配准正确的第一手证据 -->
    <div v-if="mode === '3d' && hoverText" class="viewer-coord small">{{ hoverText }}</div>

    <!-- 量测浮层：跟着光标走，不用抬头去工具栏看数字 -->
    <div
      v-if="measureTip"
      class="viewer-measure small"
      :style="{ left: `${tipPos.x + 14}px`, top: `${tipPos.y + 14}px` }"
    >
      <div v-for="(line, i) in measureTip" :key="i">{{ line }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { modelApi } from '../api/dji';
import { ecefToLlh, looksLikeEcef, radiusToDegrees, fmtLlh, fmtArea } from '../utils/ecef';

const props = defineProps({
  modelId: { type: [String, Number], required: true },
  modelName: { type: String, default: '' },
  /**
   * 量测模式：'' | 'distance' | 'area' | 'height'
   * 开启后点击模型取点，按模式实时计算并 emit('measure')。
   * 场景是「平移到原点 + Z-up 转正」后的米制空间，所以点与点之差就是米。
   */
  measureMode: { type: String, default: '' },
});

/**
 * measure 量测结果（父组件据此显示数值）
 * geo     模型的真实地理范围（ECEF 反算），父组件据此在卫星底图上画足迹；
 *         模型没有地理参考时给 { hasGeo:false }，父组件就不画——不猜、不估。
 */
const emit = defineEmits(['measure', 'geo']);

/** 视角快捷状态 */
const autoRotate = ref(false);
const activeView = ref('');
/** 悬停处的经纬高读数（只有带地理参考的模型才有） */
const hoverText = ref('');
/** 跟随光标的量测读数（多行） */
const measureTip = ref(null);
const tipPos = ref({ x: 0, y: 0 });

/** 量测：拾取点与辅助线都挂在 measureGroup 下，清除时一次性 dispose */
let measureGroup = null;
const measurePts = [];
/** 当前模型包围盒最大边长（米），用于自适应测点大小 */
let modelSize = 0;

/** 供父组件调用：清空量测 / 撤销上一个点 / 结束本次测量 */
function resetMeasure() {
  clearMeasure();
}
defineExpose({ resetMeasure, undoPoint, finishMeasure, setView, toggleAutoRotate });

const canvasWrap = ref(null);
const mode = ref('');
const stage = ref('');
const error = ref('');
const imgError = ref(false);
const previewSrc = ref('');
/** 供自动化校验：当前应显示 / 已渲染的瓦片数 */
const desiredCount = ref(0);
const loadedCount = ref(0);
/** 供自动化校验：渲染后模型的包围盒尺寸 / 中心（size|center） */
const bboxInfo = ref('');

/**
 * LOD 判据：瓦片包围球在屏幕上的投影直径（像素）超过阈值就继续细化。
 * 司空 2 导出的 tileset 里 geometricError 经常是异常值（1e10），
 * 用它做判据会「永远细化」或「永不细化」，所以这里改用投影像素。
 */
const MAX_PIXELS = 220;
/**
 * 显存预算（估算的解压后字节数），不是瓦片个数。
 *
 * 之前只限「瓦片数 900」，但瓦片大小差异极大（0.5MB~20MB 都有），
 * 900 个大瓦片能把浏览器堆内存顶到 1GB 以上直接崩掉——这正是
 * 「大模型打不开」的真正原因。改成按字节预算：超了就按最久未用淘汰，
 * 显存占用就有了硬上限。
 */
const MAX_GPU_BYTES = 900 * 1024 * 1024;
const MAX_LOADED = 600;
const MAX_PARALLEL = 6;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let frameId = 0;
let ro = null;
/** 外层：只负责把 ECEF 的 Z-up 转成 three.js 的 Y-up */
let world = null;
/** 内层：把模型中心平移到原点，避免 ECEF 大坐标导致浮点抖动 */
let group = null;
let tree = null;
let upAxis = 'Y';
/** 世界坐标 → 渲染坐标 的平移量（模型中心对齐到原点） */
const origin = new THREE.Vector3();
/** 世界坐标 → 渲染坐标 的朝向修正（Z-up → Y-up） */
const upFix = new THREE.Matrix4();
/** nodeId -> { node, scene|null, loading, failed, lastUsed, bytes } */
const nodeState = new Map();
/** 当前已上传到 GPU 的瓦片字节数合计（显存预算记账） */
let gpuBytes = 0;

/**
 * 彻底释放一个瓦片占用的 GPU 资源。
 *
 * 只 dispose 几何体和材质是不够的：glTF 的贴图挂在材质上但需要单独
 * dispose 纹理，否则显存不会真正回收——反复进出大模型时旧纹理堆积，
 * 这是「大模型看着像内存泄漏」的常见原因。
 */
function releaseScene(scene) {
  scene?.traverse?.((o) => {
    o.geometry?.dispose?.();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      for (const key of Object.keys(m)) {
        const v = m[key];
        // 只处理贴图类（Texture 有 dispose 且带 image），避开颜色/矩阵等
        if (v && typeof v.dispose === 'function' && v.isTexture) v.dispose();
      }
      m.dispose?.();
    }
  });
  // 点云瓦片共享一个自建材质（挂在 userData 上，遍历拿不到），单独释放
  scene?.userData?.material?.dispose?.();
}
/** 当前这一帧需要显示的瓦片 */
const desired = new Set();
const queue = [];
let active = 0;
let frameCount = 0;
let updateTimer = 0;
let sharedDraco = null;
/** KTX2/Basis 转码器（懒加载，需要 renderer 才能 detectSupport） */
let sharedKTX2 = null;
/** 包内 tileset.json 的内容（外部瓦片集需要就地展开） */
const tilesetCache = new Map();
/** 本轮展开时还没拿到的外部瓦片集，下一轮补拉 */
const pendingTilesets = new Set();

/**
 * b3dm = 28 字节头 + featureTable(JSON+binary) + batchTable(JSON+binary) + glTF(GLB)
 * 跳过头部剩下的就是标准 GLB，直接交给 GLTFLoader，
 * 这样不用引入 Cesium 也能渲染司空 2 的三维瓦片。
 */
function extractGlbFromB3dm(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, 28);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'b3dm') throw new Error('不是 b3dm 瓦片');
  const ftJson = dv.getUint32(12, true);
  const ftBin = dv.getUint32(16, true);
  const btJson = dv.getUint32(20, true);
  const btBin = dv.getUint32(24, true);
  const start = 28 + ftJson + ftBin + btJson + btBin;
  if (start >= u8.byteLength) throw new Error('b3dm 内没有 glTF 数据');
  return u8.slice(start).buffer;
}

function createLoader() {
  const loader = new GLTFLoader();
  if (!sharedDraco) {
    sharedDraco = new DRACOLoader();
    // 解码器随应用一起托管（public/draco/），不依赖 gstatic.com：
    // 内网 / 政务外网环境访问不了 CDN，而且 CDN 抖动会拖垮整个解码链路。
    sharedDraco.setDecoderPath('/draco/');
  }
  loader.setDRACOLoader(sharedDraco);
  if (sharedKTX2) loader.setKTX2Loader(sharedKTX2);
  return loader;
}

/** KTX2/Basis 纹理支持（three 自带转码器，同样本地化托管） */
function ensureKTX2(renderer) {
  if (sharedKTX2) return sharedKTX2;
  try {
    const k = new KTX2Loader()
      .setTranscoderPath('/basis/')
      .detectSupport(renderer);
    sharedKTX2 = k;
    return k;
  } catch (e) {
    // 老 WebGL / 不支持时降级：没有 KTX2 纹理的模型不受影响
    console.warn('[ModelViewer] KTX2 转码器不可用：', e?.message || e);
    return null;
  }
}

/**
 * pnts 点云瓦片 → three 的 Points 对象
 *
 * 此前完全不支持 pnts：模型包里一旦有点云（LAS 上传后司空 2 会转成 pnts），
 * 该瓦片会被 loadTile 当成未知格式而静默丢弃，用户看到「模型缺一块」。
 *
 * pnts 结构与 b3dm 同源（28 字节头 + featureTable + batchTable + glb），
 * 差别在 glTF 里是 POINTS 原始模式而非 mesh，这里用 PointsMaterial 渲染。
 */
function extractGlbFromPnts(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, 28);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'pnts') throw new Error('不是 pnts 瓦片');
  const ftJson = dv.getUint32(12, true);
  const ftBin = dv.getUint32(16, true);
  const btJson = dv.getUint32(20, true);
  const btBin = dv.getUint32(24, true);
  const start = 28 + ftJson + ftBin + btJson + btBin;
  if (start >= u8.byteLength) throw new Error('pnts 内没有 glTF 数据');
  return u8.slice(start).buffer;
}

/** 点云：glTF 场景里通常是 Mesh，这里转成可渲染的 Points */
function pntsToPoints(gltf) {
  const out = new THREE.Group();
  const mat = new THREE.PointsMaterial({ size: 0.6, sizeAttenuation: true, vertexColors: true });
  out.userData.material = mat;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    // GLTFLoader 对 mode=0(POINTS) 的 primitive 会直接生成 THREE.Points，
    // 只有当它没识别成 Points 时才还是 Mesh —— 两种都要接住，
    // 否则点云瓦片会「加载成功但一个点都没画」（之前只判 isMesh 就是这个坑）。
    const isMesh = o.isMesh || o.isPoints;
    if (!isMesh || !o.geometry) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    // 带颜色的点云优先取顶点色；没有就按高度做伪彩（蓝→绿→黄）
    let colors = o.geometry.getAttribute('color');
    // pnts 规范里 RGB 是 unsigned byte，必须归一化到 0~1，
    // 否则顶点色全落在 0~1/255 区间 → 画面几乎全黑
    if (colors && colors.array instanceof Uint8Array) {
      const f = new Float32Array(colors.count * 3);
      for (let i = 0; i < colors.count; i += 1) {
        f[i * 3] = colors.getX(i) / 255;
        f[i * 3 + 1] = colors.getY(i) / 255;
        f[i * 3 + 2] = colors.getZ(i) / 255;
      }
      colors = new THREE.BufferAttribute(f, 3);
    }
    if (!colors) {
      colors = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < pos.count; i += 1) {
        const y = pos.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const span = maxY - minY || 1;
      for (let i = 0; i < pos.count; i += 1) {
        const t = (pos.getY(i) - minY) / span;
        colors.setXYZ(i, 0.15 + t * 0.85, 0.35 + t * 0.6, 0.85 - t * 0.7);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', pos);
    geo.setAttribute('color', colors);
    // 只拷属性、不烘世界变换：瓦片的世界变换由 pump() 统一乘 node.matrix，
    // 和 b3dm 走同一条路径。这里若先把 matrixWorld 烘进坐标，
    // 后面再乘一次 node.matrix 就会二次位移（表现为画面全黑）。
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; // 点云包围球常被整体平移算偏，关掉视锥剔除更稳
    out.add(pts);
  });
  return out;
}

async function loadTile(uri) {
  const url = modelApi.assetSrc(props.modelId, uri);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`瓦片下载失败 ${res.status}`);
  // 记账用压缩前的传输体积（同一量级，够做预算控制），拿不到就按 0 记
  const bytes = Number(res.headers.get('content-length') || 0);
  const buf = await res.arrayBuffer();
  const loader = createLoader();

  let obj = null;
  if (/\.pnts$/i.test(uri)) {
    const gltf = await new Promise((resolve, reject) =>
      loader.parse(extractGlbFromPnts(buf), '', resolve, reject)
    );
    obj = pntsToPoints(gltf);
  } else if (/\.b3dm$/i.test(uri)) {
    const gltf = await new Promise((resolve, reject) =>
      loader.parse(extractGlbFromB3dm(buf), '', resolve, reject)
    );
    obj = gltf.scene;
  } else if (/\.glb$/i.test(uri)) {
    const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
    obj = gltf.scene;
  } else {
    const gltf = await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    obj = gltf.scene;
  }
  if (!obj) throw new Error('瓦片解析后没有可渲染内容');
  // 挂一个 bytes 字段，供显存预算与 HUD 展示使用
  obj.userData.bytes = bytes;
  return { scene: obj };
}

function dirOf(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i) : '';
}

function joinRel(base, uri) {
  const u = String(uri || '').replace(/\\/g, '/');
  if (!base) return u;
  return `${base}/${u}`;
}

/**
 * 把 tileset.json 解析成带世界矩阵与包围球的节点树。
 * - transform 逐层相乘得到世界矩阵（ECEF）
 * - content.uri 指向 .json 时按「外部瓦片集」就地展开
 * - 包围球用于算屏幕投影尺寸，决定是否细化到子瓦片
 */
function buildTree(tileset, baseDir, parentMatrix, parentRefine, counter) {
  const idx = counter || { n: 0 };
  const local = tileset?.transform ? new THREE.Matrix4().fromArray(tileset.transform) : new THREE.Matrix4();
  const matrix = new THREE.Matrix4().multiplyMatrices(parentMatrix || new THREE.Matrix4(), local);
  const refine = String(tileset?.refine || parentRefine || 'REPLACE').toUpperCase();

  const t = {
    id: idx.n++,
    uri: '',
    matrix,
    refine,
    geometricError: Number(tileset?.geometricError ?? 0),
    children: [],
    centerWorld: null,
    centerRendered: null,
    radius: 0,
  };

  const bv = tileset?.boundingVolume;
  if (bv?.box && bv.box.length >= 12) {
    const c = new THREE.Vector3(bv.box[0], bv.box[1], bv.box[2]).applyMatrix4(matrix);
    const ax = new THREE.Vector3(bv.box[3], bv.box[4], bv.box[5]);
    const ay = new THREE.Vector3(bv.box[6], bv.box[7], bv.box[8]);
    const az = new THREE.Vector3(bv.box[9], bv.box[10], bv.box[11]);
    t.centerWorld = c;
    // 盒子的外接球半径 = 三条半轴长度的平方和开根（不是简单相加，否则会高估 60%）
    t.radius = Math.hypot(ax.length(), ay.length(), az.length());
  } else if (bv?.sphere && bv.sphere.length >= 4) {
    const c = new THREE.Vector3(bv.sphere[0], bv.sphere[1], bv.sphere[2]).applyMatrix4(matrix);
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);
    t.centerWorld = c;
    t.radius = bv.sphere[3] * Math.max(scale.x, scale.y, scale.z);
  } else if (bv?.region && bv.region.length >= 6) {
    // region: [west, south, east, north, minH, maxH]，退化为粗略球体
    const lon = (bv.region[0] + bv.region[2]) / 2;
    const lat = (bv.region[1] + bv.region[3]) / 2;
    const R = 6378137;
    const cl = Math.cos((lat * Math.PI) / 180);
    t.centerWorld = new THREE.Vector3(
      R * cl * Math.cos((lon * Math.PI) / 180),
      R * cl * Math.sin((lon * Math.PI) / 180),
      R * Math.sin((lat * Math.PI) / 180)
    ).applyMatrix4(matrix);
    t.radius = Math.max(R * ((bv.region[2] - bv.region[0]) * Math.PI) / 180, bv.region[5] - bv.region[4], 100);
  }

  const uri = tileset?.content?.uri;
  if (uri && /\.json$/i.test(uri)) {
    // 外部瓦片集：司空 2 会把深层瓦片拆成大量子 json（BlockA_L18_17.json 这类），
    // 就地展开成同一棵树，否则只能渲染到最粗的一层
    const subPath = joinRel(baseDir, uri);
    const sub = tilesetCache.get(subPath);
    if (sub) {
      const subDir = dirOf(subPath);
      const built = buildTree(sub.root, subDir, matrix, refine, idx);
      // 外部根通常只是分组节点；如果它自己带可渲染内容，也一起挂上去
      t.children = built.uri ? [built, ...built.children] : built.children;
    } else {
      pendingTilesets.add(subPath);
    }
  } else if (uri) {
    t.uri = joinRel(baseDir, uri);
  }

  const own = (tileset?.children || []).map((c) => buildTree(c, baseDir, matrix, refine, idx));
  t.children = [...t.children, ...own];
  return t;
}

/** 瓦片包围球在屏幕上的投影直径（像素）：越大说明这层还不够精细 */
function projectedPixels(node) {
  if (!node.centerRendered || !node.radius) return node.children.length ? Infinity : 0;
  const dist = camera.position.distanceTo(node.centerRendered);
  if (!Number.isFinite(dist)) return 0;
  if (dist <= node.radius) return Infinity;
  const h = renderer?.domElement?.clientHeight || 600;
  const denom = 2 * Math.tan((camera.fov * Math.PI) / 180 / 2);
  return (node.radius * h) / (dist * denom);
}

function initThree() {
  if (renderer || !canvasWrap.value) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvasWrap.value.clientWidth || 600, canvasWrap.value.clientHeight || 380);
  canvasWrap.value.appendChild(renderer.domElement);
  // KTX2 转码器要靠 renderer 探测 GPU 支持，必须在 renderer 建好之后初始化
  ensureKTX2(renderer);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  /**
   * 鼠标方案对齐《大疆智图用户手册》「视角操作」一节：
   *   平移 = 按住左键拖动
   *   缩放 = 滚动滚轮，或按住右键拖动
   *   旋转 = 按住滚轮（中键）拖动
   * three 的 OrbitControls 默认是「左键旋转 / 右键平移」，与智图正好相反，
   * 习惯智图的人过来会觉得完全不可控，所以这里显式改成智图的键位。
   */
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT: THREE.MOUSE.DOLLY,
  };
  // 滚轮缩放速度：默认 1.0 在大场景里一格就跑很远，收一半更好控
  controls.zoomSpeed = 0.85;
  controls.rotateSpeed = 0.85;
  controls.panSpeed = 0.9;
  // 注意：change 事件会把事件对象当参数传进来，这里必须包一层，
  // 否则 immediate 会被事件对象判成 true，拖动时每帧都重算 LOD
  controls.addEventListener('change', () => {
    needRender = true;
    scheduleUpdate();
  });

  scene.add(new THREE.AmbientLight(0xffffff, 0.95));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.75);
  d1.position.set(1, 1.6, 1);
  scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.35);
  d2.position.set(-1, 0.8, -1);
  scene.add(d2);

  world = new THREE.Group();
  scene.add(world);
  group = new THREE.Group();
  world.add(group);
  measureGroup = new THREE.Group();
  // 量测辅助线画在 world 下：跟着模型一起被转正/平移，坐标与模型一致
  world.add(measureGroup);
  renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);
  renderer.domElement.addEventListener('pointermove', onCanvasPointerMove);
  renderer.domElement.addEventListener('contextmenu', onCanvasContextMenu);

  /**
   * 按需渲染，而不是无脑 60fps 重画。
   *
   * 大模型场景里每帧都要重绘几百万三角面，GPU 一直满载会导致风扇狂转、
   * 拖动掉帧，甚至把整个页面拖卡（用户反馈的「渲染慢」多数是这里来的）。
   * 静止时不重画：只有 controls 发生变化（拖动 / 阻尼衰减 / 自动旋转）
   * 或有新瓦片、新测点进来时才画一帧。
   */
  const loop = () => {
    frameId = requestAnimationFrame(loop);
    // OrbitControls.update() 返回 true 表示这一帧相机确实变了
    if (controls.update() || autoRotate.value) needRender = true;
    if (hoverPickPending) {
      hoverPickPending = false;
      doHoverPick();
    }
    if (!needRender) return;
    needRender = false;
    frameCount += 1;
    renderer.render(scene, camera);
  };
  loop();

  ro = new ResizeObserver(() => resize());
  ro.observe(canvasWrap.value);
}

/* ---------------- 拾取与量测（对齐大疆智图） ---------------- */
/** 按需渲染标记：只有相机变化 / 新内容进来才重画 */
let needRender = true;
/** 悬停拾取待处理标记：真正的射线求交放到渲染帧里做，且按节流间隔执行 */
let hoverPickPending = false;
let lastPickMs = 0;
const raycaster = new THREE.Raycaster();
/** 上一次指针位置（客户端坐标），节流后的拾取用 */
const pointer = { clientX: 0, clientY: 0, downX: 0, downY: 0, button: -1 };
/** 橡皮筋预览线：每次移动都会重建，单独留引用便于 dispose */
let previewLine = null;
/** 模型的真实地理范围（ECEF 反算），无地理参考时为 null */
let geoInfo = null;
/** world 旋转的逆矩阵：渲染坐标 → ECEF */
const upFixInv = new THREE.Matrix4();

/** 渲染坐标 → ECEF → 经纬高（需要模型本身带地理参考） */
function renderedToLlh(p) {
  if (!geoInfo?.hasGeo) return null;
  const e = p.clone().applyMatrix4(upFixInv).add(origin);
  const [lon, lat, h] = ecefToLlh(e.x, e.y, e.z);
  return { lon, lat, h };
}

/**
 * 遍历所有瓦片，把 ECEF 包围球换算成经纬度范围。
 *
 * asset.gltfUpAxis === "Z" 且中心矢量模长在地球半径量级，才认它是真 ECEF；
 * 自制 tileset / 局部坐标模型（Y-up）没有地理参考，
 * 这类情况下宁可如实返回 hasGeo:false，也不能拿局部坐标去反算经纬度糊弄人。
 */
function computeGeo() {
  if (upAxis !== 'Z' || !tree?.centerWorld) return null;
  const isEcef = looksLikeEcef(tree.centerWorld.x, tree.centerWorld.y, tree.centerWorld.z);
  if (!isEcef) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let hasH = false;
  let minH = Infinity;
  let maxH = -Infinity;
  const walk = (n) => {
    if (!n) return;
    if (n.centerWorld) {
      const [lon, lat, h] = ecefToLlh(n.centerWorld.x, n.centerWorld.y, n.centerWorld.z);
      const d = radiusToDegrees(lat, n.radius || 0);
      minLon = Math.min(minLon, lon - d.dLon);
      maxLon = Math.max(maxLon, lon + d.dLon);
      minLat = Math.min(minLat, lat - d.dLat);
      maxLat = Math.max(maxLat, lat + d.dLat);
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
      hasH = true;
    }
    n.children?.forEach(walk);
  };
  walk(tree);
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || minLon === Infinity) return null;
  const c = ecefToLlh(tree.centerWorld.x, tree.centerWorld.y, tree.centerWorld.z);
  return {
    hasGeo: true,
    minLon,
    maxLon,
    minLat,
    maxLat,
    lon: c[0],
    lat: c[1],
    height: c[2],
    minH: hasH ? minH : null,
    maxH: hasH ? maxH : null,
    radiusM: Math.round(tree.radius || 0),
  };
}

/**
 * 射线拾取：先用包围球粗筛再精确求交。
 *
 * 直接 intersectObject(world, true) 会把几百个瓦片的所有三角面遍历一遍，
 * 悬停预览时每帧一次的开销肉眼可见地卡（这就是「量测很卡」的直接原因）。
 * 先按瓦片包围球过滤，只对真正可能命中的瓦片做三角面级求交。
 */
function raycastModel(clientX, clientY) {
  if (!renderer || !camera || !group) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
  // 点云的拾取阈值要跟着模型尺度走，点太稀时默认阈值永远拾取不到
  raycaster.params.Points.threshold = Math.max(0.2, (modelSize || 100) / 300);
  const sphere = new THREE.Sphere();
  const targets = [];
  for (const child of group.children) {
    let hit = false;
    child.traverse((o) => {
      if (hit || !o.geometry || !o.visible) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere;
      if (!bs) return;
      sphere.center.copy(bs.center).applyMatrix4(o.matrixWorld);
      sphere.radius = bs.radius * Math.max(o.matrixWorld.getMaxScaleOnAxis(), 1e-6);
      if (raycaster.ray.intersectsSphere(sphere)) hit = true;
    });
    if (hit) targets.push(child);
  }
  if (!targets.length) return null;
  const hits = raycaster.intersectObjects(targets, true);
  return hits.length ? hits[0] : null;
}

function onCanvasPointerMove(e) {
  pointer.clientX = e.clientX;
  pointer.clientY = e.clientY;
  hoverPickPending = true;
}

/** 节流后的悬停处理：更新橡皮筋预览 + 经纬高读数 */
function doHoverPick() {
  const now = performance.now();
  if (now - lastPickMs < 40) return;
  lastPickMs = now;
  if (!renderer || !camera) return;
  const rect = renderer.domElement.getBoundingClientRect();
  tipPos.value = { x: pointer.clientX - rect.left, y: pointer.clientY - rect.top };

  // 没开量测且模型没有地理参考时不必拾取，省掉一次全场景求交
  if (!props.measureMode && !geoInfo?.hasGeo) {
    hoverText.value = '';
    measureTip.value = null;
    clearPreview();
    return;
  }
  const picked = raycastModel(pointer.clientX, pointer.clientY);
  const llh = picked ? renderedToLlh(picked.point) : null;
  hoverText.value = picked
    ? llh
      ? fmtLlh(llh.lon, llh.lat, llh.h)
      : '已命中模型 · 该模型不带地理参考，无法给出经纬度'
    : '';
  drawPreview(picked);
}

/** 橡皮筋预览：从上一个测点拉一条虚线到光标位置，光标离开模型时沿射线取等效点 */
function drawPreview(picked) {
  clearPreview();
  if (!props.measureMode || !measurePts.length) {
    measureTip.value = null;
    return;
  }
  const last = measurePts[measurePts.length - 1];
  let tip = picked ? picked.point.clone() : null;
  if (!tip) {
    // 光标不在模型上：沿射线取到「与上一个测点同深度」的位置，线不会突然消失
    const rect = renderer.domElement.getBoundingClientRect();
    const nx = ((pointer.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((pointer.clientY - rect.top) / rect.height) * 2 + 1;
    const tmp = new THREE.Raycaster();
    tmp.setFromCamera(new THREE.Vector2(nx, ny), camera);
    tip = tmp.ray.at(camera.position.distanceTo(last), new THREE.Vector3());
  }
  const geo = new THREE.BufferGeometry().setFromPoints([last, tip]);
  previewLine = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x8ab4ff, dashSize: 0.8, gapSize: 0.5 }));
  previewLine.computeLineDistances();
  measureGroup.add(previewLine);
  measureTip.value = previewValue(tip, true);
  needRender = true;
}

function clearPreview() {
  if (!previewLine || !measureGroup) return;
  measureGroup.remove(previewLine);
  previewLine.geometry?.dispose?.();
  previewLine.material?.dispose?.();
  previewLine = null;
  needRender = true;
}

/**
 * 按大疆智图「标注与测量」的口径出数：
 *   距离 = 直线距离（三维空间长度）+ 水平距离（投影到水平面）+ 垂直距离 + 坡度
 *   面积 = 投影面积（沿高程方向投影）+ 拟合面积（多点拟合平面上的真实面积）
 * 预览态带上最后一段，最终态是当前所有测点的结果。
 */
function previewValue(tip, isPreview) {
  const pts = isPreview ? [...measurePts, tip] : measurePts;
  if (pts.length < 2) return isPreview ? ['再点击一个位置'] : null;
  const mode = props.measureMode;
  const out = [];
  if (mode === 'distance') {
    let lineSum = 0;
    let flatSum = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      lineSum += a.distanceTo(b);
      flatSum += Math.hypot(b.x - a.x, b.z - a.z);
    }
    const dh = pts[pts.length - 1].y - pts[0].y;
    const slope = flatSum > 1e-6 ? (dh / flatSum) * 100 : 0;
    out.push(`直线 ${lineSum.toFixed(2)} m`);
    out.push(`水平 ${flatSum.toFixed(2)} m`);
    out.push(`垂直 ${dh.toFixed(2)} m`);
    out.push(`坡度 ${slope.toFixed(1)} %`);
    if (isPreview) out.push('右键结束测量');
    return out;
  }
  if (mode === 'height') {
    const dh = pts[pts.length - 1].y - pts[0].y;
    out.push(`高差 ${Math.abs(dh).toFixed(2)} m`);
    out.push(`起点→终点 ${dh >= 0 ? '升高' : '降低'}`);
    return out;
  }
  if (mode === 'area') {
    if (pts.length < 3) {
      out.push(`还需 ${3 - pts.length} 个点`);
      if (isPreview) out.push('右键结束测量');
      return out;
    }
    out.push(`投影面积 ${fmtArea(projectedArea(pts))}`);
    const fit = fittedArea(pts);
    if (fit) out.push(`拟合面积 ${fmtArea(fit)}`);
    if (isPreview) out.push('右键结束测量');
    return out;
  }
  return null;
}

/** 投影面积：水平面（X-Z）上的鞋带公式，等同于大疆智图的「投影面积」 */
function projectedArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s) / 2;
}

/**
 * 拟合面积：先按 Newell 法求出多点拟合平面的法向量，
 * 再把点投影到该平面内做二维鞋带公式——这才是不平整表面上的真实面积。
 */
function fittedArea(pts) {
  if (pts.length < 3) return null;
  const n = new THREE.Vector3();
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.length() < 1e-9) return projectedArea(pts); // 退化成平面：拟合面积 = 投影面积
  const nz = n.normalize();
  // 在拟合平面内构造正交基（u 尽量贴近世界 X 轴，避免退化）
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(nz.dot(u)) > 0.9) u.set(0, 0, 1);
  u.crossVectors(nz, u).normalize();
  const v = new THREE.Vector3().crossVectors(nz, u).normalize();
  let s = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.dot(u) * b.dot(v) - b.dot(u) * a.dot(v);
  }
  return Math.abs(s) / 2;
}

/**
 * 取点：左键单击（位移 < 4px）加一个测点，右键单击（同样判定）结束本次测量。
 * 位移阈值是为了把「拖动视角」和「点击取点」分开，否则转个身就多出一堆测点。
 */
function onCanvasPointerDown(e) {
  pointer.button = e.button;
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
  const isDrag = () => Math.hypot(pointer.clientX - pointer.downX, pointer.clientY - pointer.downY) > 4;
  if (e.button === 2 && props.measureMode) {
    // 右键：拖动是缩放（智图键位），只有「没怎么动」的右键才算结束测量
    const up = (ev) => {
      renderer.domElement.removeEventListener('pointerup', up);
      if (isDrag()) return;
      if (measurePts.length) finishMeasure();
      void ev;
    };
    renderer.domElement.addEventListener('pointerup', up);
    return;
  }
  if (e.button !== 0 || !props.measureMode || !renderer || !camera) return;
  const up = (ev) => {
    renderer.domElement.removeEventListener('pointerup', up);
    if (Math.hypot(ev.clientX - pointer.downX, ev.clientY - pointer.downY) > 4) return;
    const picked = raycastModel(ev.clientX, ev.clientY);
    // 没点到模型就不加测点：宁可没反应，也不能在背景平面上生成一个假点
    if (picked) addMeasurePoint(picked.point.clone());
  };
  renderer.domElement.addEventListener('pointerup', up);
}

/** 右键默认弹浏览器菜单，量测时它会挡住「右键结束」手势 */
function onCanvasContextMenu(e) {
  if (props.measureMode) e.preventDefault();
}


/** dots[i] 对应 measurePts[i]，lines[i] 对应 i→i+1 段，撤销时按这个顺序回退 */
const dots = [];
const lines = [];
let measureFinished = false;

function addMeasurePoint(p) {
  // 上一次已经右键结束过：再点就是新一轮，先把旧的清掉，避免两条折线混在一起
  if (measureFinished) {
    clearMeasure();
    measureFinished = false;
  }
  measurePts.push(p);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(measurePointRadius(), 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffb020 })
  );
  dot.position.copy(p);
  measureGroup.add(dot);
  dots.push(dot);

  if (measurePts.length > 1) {
    const geo = new THREE.BufferGeometry().setFromPoints([measurePts[measurePts.length - 2], p]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x22d3ee }));
    measureGroup.add(line);
    lines.push(line);
  }
  needRender = true;
  emitMeasure();
}

/** 撤销上一个测点（对应智图界面上的「删除所选点」图标） */
function undoPoint() {
  if (measureFinished) return clearMeasure();
  const dot = dots.pop();
  if (dot) {
    measureGroup.remove(dot);
    dot.geometry?.dispose?.();
    dot.material?.dispose?.();
  }
  const line = lines.pop();
  if (line) {
    measureGroup.remove(line);
    line.geometry?.dispose?.();
    line.material?.dispose?.();
  }
  measurePts.pop();
  needRender = true;
  emitMeasure();
}

/** 右键结束：把当前结果定下来，图形留在画面上供对照 */
function finishMeasure() {
  measureFinished = true;
  clearPreview();
  measureTip.value = null;
  emitMeasure();
}

/** 测点小球半径：按模型尺度取，避免大模型上小到看不见 */
function measurePointRadius() {
  const size = modelSize || 100;
  return Math.max(0.15, size / 400);
}

function emitMeasure() {
  const mode = props.measureMode;
  const points = measurePts.map((p) => {
    const llh = renderedToLlh(p);
    return { x: p.x, y: p.y, z: p.z, lon: llh?.lon ?? null, lat: llh?.lat ?? null, h: llh?.h ?? null };
  });
  const linesArr = previewValue(null, false) || [];
  let value = 0;
  if (mode === 'distance') {
    for (let i = 1; i < measurePts.length; i += 1) value += measurePts[i].distanceTo(measurePts[i - 1]);
  } else if (mode === 'height' && measurePts.length >= 2) {
    value = Math.abs(measurePts[measurePts.length - 1].y - measurePts[measurePts.length - 2].y);
  } else if (mode === 'area' && measurePts.length >= 3) {
    value = projectedArea(measurePts);
  }
  emit('measure', {
    mode,
    points,
    value,
    text: measurePts.length ? linesArr.join(' · ') : '',
    lines: linesArr,
    finished: measureFinished,
  });
}

/** 清空量测（切换模式 / 换模型时调用） */
function clearMeasure() {
  measurePts.length = 0;
  dots.length = 0;
  lines.length = 0;
  measureFinished = false;
  clearPreview();
  measureTip.value = null;
  hoverText.value = '';
  if (!measureGroup) return;
  for (const o of [...measureGroup.children]) {
    measureGroup.remove(o);
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose?.();
  }
  needRender = true;
  emit('measure', { mode: props.measureMode, points: [], value: 0, text: '', lines: [], finished: false });
}

/* ---------------- 视角快捷（对齐智图「俯视图 / 正视图 / 自动旋转」） ---------------- */
/** 各视角的相机方向：单位球坐标 azimuth/polar，polar=0 为正上方 */
const VIEWS = {
  top: [0, 0.001], // 正上方（留一点角度避免 up 向量退化）
  front: [0, Math.PI / 2],
  back: [Math.PI, Math.PI / 2],
  left: [-Math.PI / 2, Math.PI / 2],
  right: [Math.PI / 2, Math.PI / 2],
  home: [Math.PI / 4, Math.PI / 3],
};

function applySpherical(azimuth, polar, distance) {
  const radius = Math.max(tree?.radius || modelSize || 10, 1);
  const d = distance || radius * 2.6;
  const target = controls.target;
  const sinP = Math.sin(polar);
  camera.position.set(
    target.x + d * sinP * Math.sin(azimuth),
    target.y + d * Math.cos(polar),
    target.z + d * sinP * Math.cos(azimuth)
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  controls.update();
  needRender = true;
  scheduleUpdate(true);
}

function setView(key) {
  const v = VIEWS[key];
  if (!v || !controls) return;
  activeView.value = key;
  if (key === 'home') {
    activeView.value = '';
    const radius = Math.max(tree?.radius || modelSize || 10, 1);
    controls.target.set(0, 0, 0);
    applySpherical(Math.PI / 4, Math.PI / 3, radius * 2.6);
    return;
  }
  // 切到别的视角要停掉自动旋转，与智图行为一致
  if (controls.autoRotate) controls.autoRotate = false;
  autoRotate.value = false;
  applySpherical(v[0], v[1]);
}

function toggleAutoRotate() {
  if (!controls) return;
  const on = !controls.autoRotate;
  controls.autoRotate = on;
  controls.autoRotateSpeed = 1.2;
  autoRotate.value = on;
  activeView.value = '';
  needRender = true;
  scheduleUpdate(true);
}

function resize() {
  if (!renderer || !canvasWrap.value) return;
  const w = canvasWrap.value.clientWidth;
  const h = canvasWrap.value.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  scheduleUpdate(true);
}

function scheduleUpdate(immediate = false) {
  if (updateTimer) clearTimeout(updateTimer);
  if (immediate) {
    updateTimer = 0;
    updateVisibility();
    return;
  }
  updateTimer = setTimeout(() => {
    updateTimer = 0;
    updateVisibility();
  }, 120);
}

/** 按 LOD 遍历：投影尺寸过大的节点继续细化，其余渲染自身内容 */
function traverse(node) {
  if (!node) return;
  const hasChildren = node.children.length > 0;
  // 没有自身内容的分组节点必须继续细化，否则会出现空洞
  const mustRefine = hasChildren && !node.uri;
  const tooBig = hasChildren && projectedPixels(node) > MAX_PIXELS;
  if (mustRefine || tooBig) {
    for (const c of node.children) traverse(c);
    // REPLACE 语义：细化后父节点内容不再显示
    return;
  }
  if (node.uri) desired.add(node.id);
  if (node.refine === 'ADD') {
    // ADD 语义：父节点保留，继续叠加子节点
    for (const c of node.children) traverse(c);
  }
}

function updateVisibility() {
  if (!tree || !camera) return;
  desired.clear();
  traverse(tree);

  // 不再需要的瓦片先摘掉（解析结果留在缓存里，避免来回缩放重复下载）
  for (const [id, st] of nodeState) {
    if (desired.has(id)) continue;
    if (st.scene && st.scene.parent) group.remove(st.scene);
  }

  // 近处优先：先加载屏幕上占比最大的瓦片，视觉上更快变清晰
  const wanted = [...desired]
    .map((id) => ({ id, st: nodeState.get(id) }))
    .filter((x) => x.st && !x.st.scene && !x.st.loading && !x.st.failed)
    .sort((a, b) => projectedPixels(b.st.node) - projectedPixels(a.st.node));
  queue.length = 0;
  queue.push(...wanted.map((x) => x.st.node));

  for (const id of desired) {
    const st = nodeState.get(id);
    if (!st) continue;
    st.lastUsed = frameCount;
    if (st.scene && !st.scene.parent) {
      group.add(st.scene);
      needRender = true;
    }
  }

  // 显存预算：超限就按最久未用淘汰（只淘汰当前不需要、且确有显存可回收的）
  // 只控瓦片个数不够——瓦片体积差异巨大（0.5MB~20MB 都有），
  // 600 个大瓦片一样能把堆内存顶到 1GB 以上，所以按字节记账才有硬上限。
  if (gpuBytes > MAX_GPU_BYTES || nodeState.size > MAX_LOADED) {
    const victims = [...nodeState.entries()]
      .filter(([id, st]) => !desired.has(id) && st.scene)
      .sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
    for (const [id, st] of victims) {
      if (gpuBytes <= MAX_GPU_BYTES * 0.8 && nodeState.size <= MAX_LOADED) break;
      if (st.scene?.parent) group.remove(st.scene);
      gpuBytes -= st.bytes || 0;
      releaseScene(st.scene);
      st.scene = null;
      st.bytes = 0;
      st.failed = false;
      // 释放后清出记账表：下次需要时会重新下载（几何/纹理本就在 GPU 上，
      // 留着 nodeState 引用只是让已释放的资源看起来还在）
      nodeState.delete(id);
    }
  }

  pump();
  refreshStage();
}

function refreshStage() {
  const shown = [...desired].filter((id) => nodeState.get(id)?.scene).length;
  desiredCount.value = desired.size;
  loadedCount.value = shown;
  const busy = queue.length || active;
  // 把显存占用也摆出来：大模型加载慢时用户最容易怀疑「卡死」，
  // 给出「已显示 N/M · 显存 xx MB」比一个转圈有用得多。
  const mem = gpuBytes > 1024 * 1024 ? `${(gpuBytes / 1024 / 1024).toFixed(0)} MB` : `${Math.round(gpuBytes / 1024)} KB`;
  stage.value = busy
    ? `正在加载更精细的瓦片…（已显示 ${shown} / ${desired.size} · 显存 ${mem}）`
    : '';
  // 全部瓦片都失败时必须说清楚，不能让用户对着黑窗口猜
  if (!busy && desired.size > 0 && shown === 0) {
    const failed = [...desired].filter((id) => nodeState.get(id)?.failed).length;
    error.value = failed
      ? `${failed} 个瓦片全部加载失败（可能是不支持的格式或源文件损坏），已退回预览图`
      : '';
  }
  if (!busy) updateBounds();
}

/**
 * 稳定的时候量一次包围盒：中心应接近原点（ECEF 大坐标已平移掉）
 *
 * 注意：点云（THREE.Points）没有可用的 computeBoundingBox 时 setFromObject
 * 会得到空盒，这里额外用几何属性直接算一遍，否则点云相机会停在原点、
 * 画面全黑（表现为「瓦片加载了但什么也看不见」）。
 */
function updateBounds() {
  if (!group || !camera) return;
  let box = null;
  try {
    box = new THREE.Box3().setFromObject(group);
  } catch {
    return;
  }
  if (box.isEmpty() || !Number.isFinite(box.min.x)) {
    // 兜底：遍历点云/网格的 position 属性求并集
    const bb = new THREE.Box3();
    group.traverse((o) => {
      const pos = o.geometry?.getAttribute?.('position');
      if (!pos) return;
      for (let i = 0; i < pos.count; i += 1) {
        const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
        bb.expandByPoint(v);
      }
    });
    box = bb;
  }
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // 量测测点的大小要跟着模型尺度走，否则大模型上测点小到看不见
  modelSize = Math.max(size.x, size.y, size.z) || 0;
  const f = (v) => v.toFixed(1);
  bboxInfo.value = `${f(size.x)},${f(size.y)},${f(size.z)}|${f(center.x)},${f(center.y)},${f(center.z)}`;
}

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const node = queue.shift();
    const st = nodeState.get(node.id);
    if (!st || st.scene || st.loading || st.failed) continue;
    st.loading = true;
    active += 1;
    loadTile(node.uri)
      .then((res) => {
        st.loading = false;
        active -= 1;
        const obj = res?.scene;
        if (!obj) return;
        // 瓦片内容按自身 transform 落到世界坐标（ECEF）；Z-up→Y-up 由外层 world 统一处理
        obj.applyMatrix4(node.matrix);
        // 关键：applyMatrix4 改的是 matrix，需要显式分解/刷新，
        // 否则子物体的 matrixWorld 仍是旧的，父级平移（group.position=-origin）
        // 不会作用到它身上 —— 表现是「瓦片加载成功、包围盒算出来是 ECEF 大坐标、
        // 相机在原点附近，画面全黑」。点云尤其明显（frustumCulled 关了也照样黑）。
        obj.updateMatrix();
        obj.updateMatrixWorld(true);
        st.scene = obj;
        st.bytes = obj.userData.bytes || 0;
        gpuBytes += st.bytes;
        st.lastUsed = frameCount;
        if (desired.has(node.id)) group.add(obj);
        needRender = true; // 新瓦片进场景，静止状态下也要补画一帧
        pump();
        refreshStage();
      })
      .catch(() => {
        st.loading = false;
        st.failed = true;
        active -= 1;
        pump();
      });
  }
}

function registerNodes(node) {
  if (!node) return;
  if (node.uri) nodeState.set(node.id, { node, scene: null, loading: false, failed: false, lastUsed: 0 });
  node.children?.forEach(registerNodes);
}

/** 世界坐标 → 渲染坐标（先平移到原点，再按 upAxis 转正） */
function applyFrame(node) {
  if (!node) return;
  if (node.centerWorld) node.centerRendered = node.centerWorld.clone().sub(origin).applyMatrix4(upFix);
  node.children?.forEach(applyFrame);
}

/** 从清单里挑出根 tileset：优先用后端算好的 roots，兜底取路径最短的那个 */
function pickRoots(data) {
  const roots = Array.isArray(data.tilesetRoots) ? data.tilesetRoots.filter(Boolean) : [];
  if (roots.length) return roots;
  const all = Array.isArray(data.tilesets) ? data.tilesets.filter(Boolean) : [];
  if (all.length) return [all.slice().sort((a, b) => a.split('/').length - b.split('/').length)[0]];
  return data.tileset ? [data.tileset] : [];
}

async function fetchTilesets(paths) {
  const list = (paths || []).filter((p) => p && !tilesetCache.has(p)).slice(0, 400);
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(
      list.slice(i, i + 8).map(async (p) => {
        try {
          const res = await fetch(modelApi.assetSrc(props.modelId, p));
          if (!res.ok) return;
          const j = await res.json();
          if (j?.root) tilesetCache.set(p, j);
        } catch {
          /* 单个 tileset 读不动就跳过 */
        }
      })
    );
  }
}

/**
 * 反复展开外部瓦片集直到没有新的引用。
 * 司空 2 的子块 json 会层层嵌套（L16 → L18 → L19…），一轮拿不全，
 * 所以这里按轮次补齐，每轮只拉上一轮新发现的 json。
 */
async function expandTree(roots) {
  const counter = { n: 0 };
  let built = null;
  for (let round = 0; round < 10; round += 1) {
    pendingTilesets.clear();
    counter.n = 0;
    built = mergeRoots(roots, counter);
    const missing = [...pendingTilesets].filter((p) => !tilesetCache.has(p));
    if (!missing.length) break;
    await fetchTilesets(missing);
  }
  return built;
}

/** 多个根时合成一个虚拟 root，把所有分块挂到同一棵树上 */
function mergeRoots(roots, counter) {
  if (roots.length === 1) {
    const one = tilesetCache.get(roots[0]);
    return one ? buildTree(one.root, dirOf(roots[0]), new THREE.Matrix4(), 'REPLACE', counter) : null;
  }
  const parts = [];
  for (const r of roots) {
    const j = tilesetCache.get(r);
    if (!j) continue;
    parts.push(buildTree(j.root, dirOf(r), new THREE.Matrix4(), 'REPLACE', counter));
  }
  if (!parts.length) return null;
  const box = new THREE.Box3();
  for (const p of parts) if (p.centerWorld) box.expandByPoint(p.centerWorld);
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  let radius = 0;
  for (const p of parts) {
    if (!p.centerWorld) continue;
    radius = Math.max(radius, center.distanceTo(p.centerWorld) + p.radius);
  }
  return {
    id: counter.n++,
    uri: '',
    matrix: new THREE.Matrix4(),
    refine: 'REPLACE',
    geometricError: 0,
    children: parts,
    centerWorld: center,
    centerRendered: null,
    radius: radius || 100,
  };
}

async function build() {
  stage.value = '正在准备模型包…';
  error.value = '';
  mode.value = '';
  imgError.value = false;
  previewSrc.value = modelApi.previewSrc(props.modelId);

  const r = await modelApi.files(props.modelId);
  if (!r?.ok) {
    error.value = r?.message || '模型包获取失败';
    mode.value = 'image';
    stage.value = '';
    return;
  }
  const data = r.data || {};

  // 二维模型不在这里渲染（走 Raster2DViewer 的瓦片层），直接退回预览图
  if (data.raster2d) {
    mode.value = 'image';
    stage.value = '';
    return;
  }

  const roots = pickRoots(data);
  tilesetCache.clear();
  await fetchTilesets((data.tilesets || []).length ? data.tilesets : roots);

  let root = null;
  if (roots.length && tilesetCache.size) {
    upAxis = 'Z';
    for (const [, j] of tilesetCache) {
      const ax = String(j?.asset?.gltfUpAxis || '').toUpperCase();
      if (ax) upAxis = ax;
    }
    stage.value = '正在解析瓦片索引…';
    root = await expandTree(roots);
  }

  if (!root) {
    // 包内没有可用的 tileset.json：退化成「平铺加载所有 b3dm / glb」
    const flat = [...(data.gltf || []), ...(data.b3dm || []), ...(data.pnts || [])].slice(0, 60);
    if (!flat.length) {
      error.value = '模型包内没有可渲染的三维文件（b3dm / pnts 点云 / glb / gltf）';
      mode.value = 'image';
      stage.value = '';
      return;
    }
    initThree();
    upAxis = 'Y';
    upFix.identity();
    origin.set(0, 0, 0);
    group.position.set(0, 0, 0);
    let loaded = 0;
    for (const p of flat) {
      try {
        const r = await loadTile(p);
        if (!r?.scene) continue;
        group.add(r.scene);
        loaded += 1;
      } catch {
        /* 忽略单个失败 */
      }
    }
    if (!loaded) {
      error.value = '三维文件解析失败，已回退到预览图';
      mode.value = 'image';
      stage.value = '';
      return;
    }
    mode.value = '3d';
    fitToGroup();
    resize();
    return;
  }

  tree = root;
  registerNodes(tree);

  // 坐标系处理：司空 2 导出的 tileset 是 Z-up（ECEF 大坐标），
  // 但也可能是 Y-up 的局部坐标（自制 tileset / 点云）。
  // 这里以 asset.gltfUpAxis 为准，不能一律当 ECEF 处理——
  // 否则 Y-up 的模型会被平移错位置，表现为「瓦片都加载了但画面全黑」。
  const isEcef = upAxis === 'Z';
  // 模型中心对齐到原点：整体平移，避免 ECEF 大坐标带来的浮点抖动
  origin.copy(tree.centerWorld || new THREE.Vector3());
  // Z-up（ECEF）→ Y-up（three.js）：绕 X 轴 -90°，必须作用在整个模型上，
  // 不能作用到单个瓦片后再乘 ECEF 变换，否则姿态会歪
  upFix.identity();
  if (isEcef) upFix.makeRotationX(-Math.PI / 2);
  // 渲染坐标 → ECEF 的逆变换（upFix 是纯旋转，逆矩阵即转置），量测取点要靠它算经纬度
  upFixInv.copy(upFix).transpose();

  initThree();
  world.rotation.setFromRotationMatrix(upFix);
  world.updateMatrixWorld(true);
  group.position.copy(origin).negate();
  applyFrame(tree);

  // 相机取景：用实际包围球半径，Y-up 时半径可能极小（局部坐标），
  // 给一个下限避免相机贴脸导致什么都看不见
  const radius = Math.max(tree.radius || 0, 1);
  camera.position.set(radius * 1.6, radius * 1.1, radius * 1.6);
  camera.near = Math.max(radius / 1000, 0.01);
  camera.far = radius * 100 + 1000;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();

  mode.value = '3d';
  resize();
  updateVisibility();

  // 解析完瓦片索引就能算真实地理范围了：反算出的中心经纬度应与模型实际位置一致，
  // 这是「模型有没有配准到正确位置」唯一的自校验手段，父组件据此在底图上画足迹。
  geoInfo = computeGeo();
  emit('geo', geoInfo || { hasGeo: false });
}

/** 平铺模式（无 tileset）下的居中与相机 */
function fitToGroup() {
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  group.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 10;
  camera.position.set(maxDim * 0.8, maxDim * 0.6, maxDim * 0.8);
  camera.near = Math.max(maxDim / 1000, 0.01);
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

function dispose() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = 0;
  if (frameId) cancelAnimationFrame(frameId);
  frameId = 0;
  if (ro) ro.disconnect();
  ro = null;
  // 关键：把还挂在场景里的瓦片逐个 releaseScene，
  // 只 renderer.dispose() 不会回收几何体/纹理/显存，
  // 来回切几个大模型就会把浏览器内存吃满（表现就是越用越卡、最后白屏）。
  let freed = 0;
  for (const [, st] of nodeState) {
    if (st.scene) {
      releaseScene(st.scene);
      freed += 1;
    }
  }
  nodeState.clear();
  gpuBytes = 0;
  desired.clear();
  queue.length = 0;
  active = 0;
  tree = null;
  if (freed) console.info(`[ModelViewer] 已释放 ${freed} 个瓦片的 GPU 资源`);
  if (renderer?.domElement) {
    renderer.domElement.removeEventListener('pointerdown', onCanvasPointerDown);
    renderer.domElement.removeEventListener('pointermove', onCanvasPointerMove);
    renderer.domElement.removeEventListener('contextmenu', onCanvasContextMenu);
  }
  previewLine = null;
  geoInfo = null;
  activeView.value = '';
  autoRotate.value = false;
  hoverText.value = '';
  measureTip.value = null;
  if (renderer) {
    renderer.dispose();
    // forceContextLoss：让浏览器立刻归还 WebGL 上下文占用的显存，
    // 否则关闭抽屉后显存要等 GC 才回收
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  }
  renderer = null;
  scene = null;
  camera = null;
  controls = null;
  world = null;
  group = null;
}

onMounted(build);
onBeforeUnmount(() => {
  dispose();
  sharedDraco?.dispose();
  sharedDraco = null;
  // KTX2 转码器持有 wasm 内存，不释放会在多次开关模型后累积
  sharedKTX2?.dispose?.();
  sharedKTX2 = null;
});
watch(() => props.measureMode, () => clearMeasure());

watch(
  () => props.modelId,
  () => {
    clearMeasure();
    dispose();
    build();
  }
);
</script>

<style scoped>
.viewer { position: relative; width: 100%; height: 100%; }
.viewer-canvas { width: 100%; height: 100%; min-height: 380px; border-radius: 8px; overflow: hidden; }
.viewer-fallback {
  width: 100%; height: 100%; min-height: 380px; display: grid; place-items: center;
  background: var(--c-bg-2); border: 1px solid var(--c-line); border-radius: 8px; overflow: hidden;
}
.viewer-fallback img { max-width: 100%; max-height: 100%; object-fit: contain; }
.viewer-stage {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  color: var(--c-text-1); background: rgba(0, 0, 0, 0.55); padding: 6px 12px; border-radius: 6px;
}
.viewer-error {
  position: absolute; left: 12px; right: 12px; top: 12px;
  color: var(--c-warn); background: rgba(0, 0, 0, 0.55); padding: 6px 10px; border-radius: 6px;
}
.viewer-tip {
  position: absolute; right: 12px; bottom: 10px; z-index: 5;
  background: rgba(10, 16, 26, 0.82); border: 1px solid var(--c-line);
  border-radius: 6px; padding: 4px 8px; pointer-events: none;
}
.viewer-tip b { color: var(--c-brand); font-weight: 600; }

/* 光标处的经纬高读数：用来当场验证「模型配准到了正确位置」 */
.viewer-coord {
  position: absolute; left: 12px; bottom: 10px; z-index: 5;
  background: rgba(10, 16, 26, 0.82); border: 1px solid var(--c-line);
  border-radius: 6px; padding: 4px 8px; pointer-events: none;
  color: var(--c-text-2); font-variant-numeric: tabular-nums;
}
/* 跟随光标的量测读数，省得抬头去工具栏找数字 */
.viewer-measure {
  position: absolute; z-index: 6; pointer-events: none;
  background: rgba(10, 16, 26, 0.92); border: 1px solid var(--c-brand);
  color: var(--c-text-1); border-radius: 6px; padding: 5px 9px; line-height: 1.7;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* 视角快捷按钮：对齐大疆智图的自动旋转 / 俯视 / 正视 */
.viewer-views {
  position: absolute; right: 12px; top: 12px; z-index: 6;
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  background: rgba(10, 16, 26, 0.86); border: 1px solid var(--c-line);
  border-radius: 8px; padding: 5px 7px;
}
.vv-label { font-size: 11px; color: var(--c-text-3); margin-right: 2px; }
.vv-btn {
  font-size: 11px; padding: 3px 7px; border-radius: 5px; cursor: pointer;
  color: var(--c-text-2); border: 1px solid transparent; user-select: none;
}
.vv-btn:hover { color: var(--c-brand); border-color: var(--c-line); background: rgba(255, 255, 255, 0.04); }
.vv-btn.on { color: var(--c-brand); border-color: var(--c-brand); background: rgba(34, 211, 238, 0.12); }
</style>
