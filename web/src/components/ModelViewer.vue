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

    <div v-if="mode === '3d'" class="viewer-tip small muted">
      左键拖动旋转 · 滚轮缩放 · 右键拖动平移（视角越近会自动加载越精细的瓦片）
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { modelApi } from '../api/dji';

const props = defineProps({
  modelId: { type: [String, Number], required: true },
  modelName: { type: String, default: '' },
});

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
}
/** 当前这一帧需要显示的瓦片 */
const desired = new Set();
const queue = [];
let active = 0;
let frameCount = 0;
let updateTimer = 0;
let sharedDraco = null;
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
  return loader;
}

async function loadTile(uri) {
  const url = modelApi.assetSrc(props.modelId, uri);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`瓦片下载失败 ${res.status}`);
  // 记账用压缩前的传输体积（同一量级，够做预算控制），拿不到就按 0 记
  const bytes = Number(res.headers.get('content-length') || 0);
  const buf = await res.arrayBuffer();
  const loader = createLoader();
  const parsed = /\.b3dm$/i.test(uri)
    ? new Promise((resolve, reject) => loader.parse(extractGlbFromB3dm(buf), '', resolve, reject))
    : /\.glb$/i.test(uri)
      ? new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject))
      : new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
  const gltf = await parsed;
  // gltf 场景挂一个 bytes 字段，供显存预算与 HUD 展示使用
  if (gltf?.scene) gltf.scene.userData.bytes = bytes;
  return gltf;
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

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // 注意：change 事件会把事件对象当参数传进来，这里必须包一层，
  // 否则 immediate 会被事件对象判成 true，拖动时每帧都重算 LOD
  controls.addEventListener('change', () => scheduleUpdate());

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

  const loop = () => {
    frameId = requestAnimationFrame(loop);
    frameCount += 1;
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  ro = new ResizeObserver(() => resize());
  ro.observe(canvasWrap.value);
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
    if (st.scene && !st.scene.parent) group.add(st.scene);
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
  if (!busy) updateBounds();
}

/** 稳定的时候量一次包围盒：中心应接近原点（ECEF 大坐标已平移掉） */
function updateBounds() {
  if (!group || !camera) return;
  let box = null;
  try {
    box = new THREE.Box3().setFromObject(group);
  } catch {
    return;
  }
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
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
      .then((gltf) => {
        st.loading = false;
        active -= 1;
        const obj = gltf?.scene;
        if (!obj) return;
        // 瓦片内容按自身 transform 落到世界坐标（ECEF）；Z-up→Y-up 由外层 world 统一处理
        obj.applyMatrix4(node.matrix);
        st.scene = obj;
        st.bytes = obj.userData.bytes || 0;
        gpuBytes += st.bytes;
        st.lastUsed = frameCount;
        if (desired.has(node.id)) group.add(obj);
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
    const flat = [...(data.gltf || []), ...(data.b3dm || [])].slice(0, 60);
    if (!flat.length) {
      error.value = '模型包内没有可渲染的三维文件（b3dm / glb / gltf）';
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
        const gltf = await loadTile(p);
        if (!gltf?.scene) continue;
        group.add(gltf.scene);
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

  // 模型中心对齐到原点：整体平移，避免 ECEF 大坐标带来的浮点抖动
  origin.copy(tree.centerWorld || new THREE.Vector3());
  // Z-up（ECEF）→ Y-up（three.js）：绕 X 轴 -90°，必须作用在整个模型上，
  // 不能作用到单个瓦片后再乘 ECEF 变换，否则姿态会歪
  upFix.identity();
  if (upAxis === 'Z') upFix.makeRotationX(-Math.PI / 2);

  initThree();
  world.rotation.setFromRotationMatrix(upFix);
  world.updateMatrixWorld(true);
  group.position.copy(origin).negate();
  applyFrame(tree);

  const radius = tree.radius || 100;
  camera.position.set(radius * 1.1, radius * 0.75, radius * 1.1);
  camera.near = Math.max(radius / 1000, 0.01);
  camera.far = radius * 100 + 1000;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();

  mode.value = '3d';
  resize();
  updateVisibility();
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
});
watch(
  () => props.modelId,
  () => {
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
.viewer-tip { position: absolute; left: 12px; bottom: 10px; }
</style>
