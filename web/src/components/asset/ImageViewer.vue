<template>
  <div
    ref="boxRef"
    class="viewer"
    :class="{ drawing: drawing }"
    @mousedown="onDown"
    @mousemove="onMove"
    @mouseup="onUp"
    @mouseleave="onUp"
    @wheel.prevent="onWheel"
  >
    <LoadingBlock v-if="loading" type="spin" height="100%" text="加载影像…" />

    <ErrorState
      v-else-if="loadError"
      title="图片加载失败"
      :detail="errorDetail"
      @retry="retry"
    />

    <template v-else>
      <!-- 变换层：缩放 + 平移（全景模式隐藏） -->
      <div v-show="!panoActive" class="stage" :style="stageStyle">
        <img
          ref="imgRef"
          :src="url"
          :alt="alt"
          draggable="false"
          @load="onImgLoad"
          @error="innerError = true"
        />
        <!-- 框选矩形（设计稿：橙色半透明） -->
        <div
          v-if="rect.w && rect.h"
          class="rect"
          :style="{
            left: `${rect.x}px`,
            top: `${rect.y}px`,
            width: `${rect.w}px`,
            height: `${rect.h}px`,
          }"
        />
      </div>

      <!-- 全景球面查看（宽高比 ≥ 1.9 的等距柱状投影图自动启用） -->
      <PanoViewer v-if="panoActive" :url="url" />

      <button
        v-if="isPano"
        class="mode-toggle"
        :class="{ ghost: panoActive }"
        title="全景模式不支持框选标注，标注请切回平面"
        @click="panoMode = !panoMode"
        @mousedown.stop
      >
        {{ panoMode ? '平面模式' : '全景模式' }}
      </button>

      <div v-if="pair" class="pair-tag">配对：{{ pair }}</div>
    </template>

    <p v-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>

<script setup>
/**
 * 单图查看器
 * 交互（按设计稿定案）：
 *   左键拖拽 = 框选 · 空格 或 中键 = 平移 · 滚轮 = 缩放 · 双击 = 适应/原始
 */
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import PanoViewer from './PanoViewer.vue';

const props = defineProps({
  url: { type: String, default: '' },
  alt: { type: String, default: '' },
  /** 缩略图小图叠加显示时用：显示覆盖范围与中心点 */
  overlay: { type: Object, default: null },
  pair: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  loadError: { type: Boolean, default: false },
  /** 左上角像素 → 地理坐标的映射函数（由父级注入） */
  pixelToLonLat: { type: Function, default: null },
});
const emit = defineEmits(['drawn', 'reload', 'viewchange']);

const boxRef = ref(null);
const imgRef = ref(null);
/**
 * ⚠️ 实测缺陷（黑屏无提示）：loadError / loading 曾被同时声明成 props，
 *    模板里却用 `@error="loadError = true"` 直接赋值。Vue 3 中对 prop 赋值会静默失败，
 *    于是图片 404 时既进不了错误态、也没有任何提示，只剩 .viewer 的深色底 ——
 *    看起来就像「影像全部同步失败」。现改为 props 仅作外部受控开关，
 *    内部状态用独立 ref，二者取或。
 */
const innerLoading = ref(false);
const innerError = ref(false);
const loading = computed(() => props.loading || innerLoading.value);
const loadError = computed(() => props.loadError || innerError.value);
const errorDetail = ref('可能是原图已被清理或签名失效');
const scale = ref(1);
const offset = ref({ x: 0, y: 0 });
const natural = reactive({ w: 0, h: 0 });
const drawing = ref(false);
const start = reactive({ x: 0, y: 0 });
const rect = reactive({ x: 0, y: 0, w: 0, h: 0 });
const spaceDown = ref(false);
const isPano = ref(false); // 宽高比 ≥ 1.9 视为等距柱状全景图
const panoMode = ref(true); // 全景图默认进沉浸模式，可切回平面标注
const panoActive = computed(() => isPano.value && panoMode.value);
const hint = computed(() =>
  panoActive.value
    ? '拖拽转动视角 · 滚轮缩放视野 · 右上角「平面模式」切回标注'
    : '左键拖拽框选 · 空格/中键平移 · 滚轮缩放 · 双击还原'
);

const MIN = 0.5;
const MAX = 8;

const stageStyle = computed(() => ({
  transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${scale.value})`,
  transformOrigin: '0 0',
}));

function onImgLoad() {
  innerError.value = false;
  if (imgRef.value) {
    natural.w = imgRef.value.naturalWidth;
    natural.h = imgRef.value.naturalHeight;
    // 等距柱状全景图典型为 2:1；阈值放宽到 1.9 兼容 1.5:1 的裁切款
    isPano.value = natural.h > 0 && natural.w / natural.h >= 1.9;
    if (!isPano.value) panoMode.value = true; // 非全景图复位，避免下次残留
  }
  fit();
}

/** 错误态重试：先清内部错误标记，再交给父级换 URL（多为签名过期） */
function retry() {
  innerError.value = false;
  emit('reload');
}

function fit() {
  if (!boxRef.value || !natural.w) return;
  const bw = boxRef.value.clientWidth;
  const bh = boxRef.value.clientHeight;
  const s = Math.min(bw / natural.w, bh / natural.h);
  scale.value = Math.max(MIN, s);
  offset.value = {
    x: (bw - natural.w * scale.value) / 2,
    y: (bh - natural.h * scale.value) / 2,
  };
}

function onWheel(e) {
  if (panoActive.value) return; // 全景模式滚轮归 PanoViewer（缩放视野）
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const ns = Math.min(MAX, Math.max(MIN, scale.value * factor));
  // 以鼠标位置为锚点缩放
  const r = boxRef.value.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  offset.value = {
    x: mx - ((mx - offset.value.x) / scale.value) * ns,
    y: my - ((my - offset.value.y) / scale.value) * ns,
  };
  scale.value = ns;
}

let panning = null;
function onDown(e) {
  if (panoActive.value) return; // 全景模式：事件交给 PanoViewer，不框选
  if (e.button === 1 || spaceDown.value) {
    // 中键或按住空格 = 平移
    panning = { x: e.clientX - offset.value.x, y: e.clientY - offset.value.y };
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  const r = boxRef.value.getBoundingClientRect();
  const sx = (e.clientX - r.left - offset.value.x) / scale.value;
  const sy = (e.clientY - r.top - offset.value.y) / scale.value;
  drawing.value = true;
  start.x = sx;
  start.y = sy;
  rect.x = sx;
  rect.y = sy;
  rect.w = 0;
  rect.h = 0;
}

function onMove(e) {
  if (panning) {
    offset.value = { x: e.clientX - panning.x, y: e.clientY - panning.y };
    return;
  }
  if (!drawing.value) return;
  const r = boxRef.value.getBoundingClientRect();
  const cx = (e.clientX - r.left - offset.value.x) / scale.value;
  const cy = (e.clientY - r.top - offset.value.y) / scale.value;
  rect.x = Math.min(start.x, cx);
  rect.y = Math.min(start.y, cy);
  rect.w = Math.abs(cx - start.x);
  rect.h = Math.abs(cy - start.y);
  // 约束在图片范围内
  rect.w = Math.min(rect.w, natural.w - rect.x);
  rect.h = Math.min(rect.h, natural.h - rect.y);
}

function onUp(e) {
  if (panning) {
    panning = null;
    return;
  }
  if (!drawing.value) return;
  drawing.value = false;
  // 太小视为误点击
  if (rect.w < 6 || rect.h < 6) {
    rect.w = 0;
    rect.h = 0;
    return;
  }
  emit('drawn', {
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    naturalW: natural.w,
    naturalH: natural.h,
  });
}

function onDblClick() {
  scale.value === 1 ? fit() : ((scale.value = 1), (offset.value = { x: 0, y: 0 }));
}

function onKey(e) {
  if (e.code === 'Space') spaceDown.value = true;
}
function onKeyUp(e) {
  if (e.code === 'Space') spaceDown.value = false;
}
function onResize() {
  fit();
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('resize', onResize);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('resize', onResize);
});

defineExpose({ fit, natural });
</script>

<style scoped>
.viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--c-bg-0);
  border-radius: var(--r-sm);
  user-select: none;
}
.viewer.drawing {
  cursor: crosshair;
}
.stage {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
}
.stage img {
  display: block;
  max-width: none;
  pointer-events: none;
}
.rect {
  position: absolute;
  background: rgba(255, 106, 0, 0.25);
  border: 2px solid var(--c-brand);
  pointer-events: none;
}
.pair-tag {
  position: absolute;
  top: var(--sp-2);
  left: var(--sp-2);
  padding: 2px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--c-text-0);
  background: rgba(0, 0, 0, 0.6);
}
.mode-toggle {
  position: absolute;
  top: var(--sp-2);
  right: var(--sp-2);
  z-index: 6;
  padding: 4px 12px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  cursor: pointer;
}
.mode-toggle:hover {
  background: rgba(0, 0, 0, 0.75);
}
.mode-toggle.ghost {
  background: rgba(0, 0, 0, 0.35);
}
.hint {
  position: absolute;
  bottom: var(--sp-2);
  left: 0;
  right: 0;
  margin: 0;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  pointer-events: none;
}
</style>
