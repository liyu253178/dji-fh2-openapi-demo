<template>
  <div ref="el" class="pano" :class="{ grabbing: dragging }">
    <div v-if="err" class="pano-err">
      <p>全景渲染失败（WebGL 不可用或纹理加载出错）</p>
      <p class="sub">可点击右上角「平面模式」查看原图</p>
    </div>
  </div>
</template>

<script setup>
/**
 * 等距柱状投影（equirectangular）全景查看器
 * - 交互：左键拖拽 = 转动视角 · 滚轮 = 缩放视野（fov 30~95）
 * - 带惯性阻尼：目标值与当前值插值，松手后平滑停下
 * - 识别由父级做（宽高比 ≥ 1.9），本组件只负责渲染
 */
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as THREE from 'three';

const props = defineProps({
  url: { type: String, default: '' },
});

const el = ref(null);
const err = ref(false);
const dragging = ref(false);

let renderer = null;
let scene = null;
let camera = null;
let mesh = null;
let texture = null;
let raf = 0;
let ro = null;

// 视角状态：当前值向目标值插值
let lon = 0;
let lat = 0;
let tLon = 0;
let tLat = 0;
let fov = 78;
let tFov = 78;
let down = null; // { x, y, lon, lat }

const target = new THREE.Vector3();

function animate() {
  raf = requestAnimationFrame(animate);
  // 阻尼插值
  lon += (tLon - lon) * 0.14;
  lat += (tLat - lat) * 0.14;
  fov += (tFov - fov) * 0.14;
  if (camera) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon);
    target.set(
      500 * Math.sin(phi) * Math.cos(theta),
      500 * Math.cos(phi),
      500 * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(target);
  }
  if (renderer && scene) renderer.render(scene, camera);
}

function loadTexture(url) {
  if (!url || !scene) return;
  err.value = false;
  new THREE.TextureLoader().load(
    url,
    (t) => {
      if (texture) texture.dispose();
      texture = t;
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      if (mesh) {
        mesh.material.map = t;
        mesh.material.needsUpdate = true;
      } else {
        const geo = new THREE.SphereGeometry(500, 64, 40);
        const mat = new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide });
        mesh = new THREE.Mesh(geo, mat);
        scene.add(mesh);
      }
    },
    undefined,
    () => {
      err.value = true;
    }
  );
}

function onDown(e) {
  if (e.button !== 0) return;
  dragging.value = true;
  down = { x: e.clientX, y: e.clientY, lon: tLon, lat: tLat };
}

function onMove(e) {
  if (!down) return;
  const k = 0.11 * (fov / 78); // fov 越小（放大）转动越慢
  tLon = down.lon - (e.clientX - down.x) * k;
  tLat = Math.max(-85, Math.min(85, down.lat + (e.clientY - down.y) * k));
}

function onUp() {
  dragging.value = false;
  down = null;
}

function onWheel(e) {
  tFov = Math.max(30, Math.min(95, tFov + (e.deltaY > 0 ? 4 : -4)));
}

function bindEvents(dom) {
  dom.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  dom.addEventListener('wheel', onWheel, { passive: true });
}

function unbindEvents(dom) {
  if (!dom) return;
  dom.removeEventListener('pointerdown', onDown);
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  dom.removeEventListener('wheel', onWheel);
}

function resize() {
  if (!renderer || !el.value) return;
  const w = el.value.clientWidth;
  const h = el.value.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

onMounted(() => {
  try {
    const w = el.value.clientWidth || 1;
    const h = el.value.clientHeight || 1;
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    el.value.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(fov, w / h, 1, 1100);
    bindEvents(renderer.domElement);
    ro = new ResizeObserver(resize);
    ro.observe(el.value);
    loadTexture(props.url);
    animate();
  } catch {
    err.value = true;
  }
});

onUnmounted(() => {
  cancelAnimationFrame(raf);
  unbindEvents(renderer && renderer.domElement);
  if (ro) ro.disconnect();
  if (texture) texture.dispose();
  if (mesh) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  if (renderer) {
    renderer.dispose();
    renderer.domElement && renderer.domElement.remove();
  }
  renderer = null;
  scene = null;
  camera = null;
  mesh = null;
  texture = null;
});

watch(
  () => props.url,
  (u) => {
    // 换图：重置视角，重新加载纹理（组件不重建）
    tLon = 0;
    tLat = 0;
    tFov = 78;
    lon = 0;
    lat = 0;
    fov = 78;
    loadTexture(u);
  }
);
</script>

<style scoped>
.pano {
  position: absolute;
  inset: 0;
  background: var(--c-bg-0);
  cursor: grab;
  overflow: hidden;
}
.pano.grabbing {
  cursor: grabbing;
}
.pano :deep(canvas) {
  display: block;
}
.pano-err {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--c-text-1);
  font-size: var(--fs-sm);
}
.pano-err .sub {
  color: var(--c-text-2);
  font-size: var(--fs-xs);
}
</style>
