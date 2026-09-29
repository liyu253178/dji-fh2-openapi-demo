<template>
  <div class="thumb" :class="{ selected: selected }" @click="$emit('click', image)">
    <el-checkbox
      v-if="selectable"
      class="cb"
      :model-value="selected"
      @change="$emit('toggle', image.id)"
      @click.stop
    />
    <span class="idx">{{ index + 1 }}</span>
    <span v-if="previewable" class="lens" :class="image.lensType">{{ lensLabel }}</span>
    <span v-else class="lens aux">辅助文件</span>
    <template v-if="previewable">
      <span v-if="image.gpsStatus === 'RTK'" class="gps ok">RTK</span>
      <span v-else-if="image.gpsStatus" class="gps warn">{{ image.gpsStatus }}</span>
      <span v-else class="gps err">⚠ 无定位</span>
    </template>
    <span v-if="image.reviewState !== 'none'" class="st" :class="image.reviewState" />
    <!-- 非影像文件（PPK 等）没有缩略图，直接给占位，避免每次都发一个必然 404 的请求 -->
    <img
      v-if="previewable"
      :src="url"
      :alt="image.fileName"
      loading="lazy"
      @error="onErr"
    />
    <div v-else class="img-err aux">非影像文件<br />{{ image.fileType || 'aux' }}</div>
    <div v-if="previewable && failed" class="img-err">加载失败</div>
  </div>
</template>

<script setup>
/** 单张缩略图：序号 + 镜头类型 + 定位质量 + 审核状态点 */
import { ref, computed } from 'vue';
import { assetApi } from '../../api/duav';

const props = defineProps({
  image: { type: Object, required: true },
  index: { type: Number, default: 0 },
  selected: { type: Boolean, default: false },
  selectable: { type: Boolean, default: true },
});
defineEmits(['click', 'toggle']);

const failed = ref(false);
const url = computed(() => assetApi.imageUrl(props.image.id, 'thumb'));
const lensLabel = computed(() => (props.image.lensType === 'infrared' ? '红外' : '可见光'));
/** PPK 等辅助文件没有缩略图（hasOriginal=false），不渲染 img、不发请求 */
const previewable = computed(() => props.image.hasOriginal !== false);

function onErr() {
  failed.value = true;
}
</script>

<style scoped>
.thumb {
  position: relative;
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  overflow: hidden;
  cursor: pointer;
  background: var(--c-bg-2);
  aspect-ratio: 4 / 3;
}
.thumb:hover {
  border-color: var(--c-brand);
}
.thumb.selected {
  border-color: var(--c-brand);
  box-shadow: 0 0 0 1px var(--c-brand);
}
.cb {
  position: absolute;
  top: 2px;
  left: 2px;
  z-index: 3;
}
.idx {
  position: absolute;
  top: 2px;
  right: 2px;
  z-index: 2;
  padding: 0 4px;
  border-radius: 3px;
  font-size: var(--fs-xs);
  color: var(--c-text-1);
  background: rgba(0, 0, 0, 0.55);
}
.lens {
  position: absolute;
  bottom: 2px;
  left: 2px;
  z-index: 2;
  padding: 0 4px;
  border-radius: 3px;
  font-size: var(--fs-xs);
}
/**
 * ⚠️ 可读性修复：原本 color 用的是 var(--c-info)=#3b82f6，与背景 rgba(59,130,246,.85)
 *    是同一个蓝色 —— 蓝字蓝底，对比度≈1:1，文字完全看不见，
 *    缩略图上就是一块纯蓝色方块。改用深一档的蓝底 + 白字（对比度≈4.9:1）。
 */
.lens.visible {
  color: #fff;
  background: #2f6fd0;
}
.lens.infrared {
  color: #1a1a1e;
  background: var(--c-warn);
}
/* 非影像文件（PPK 等）：中性灰，不带镜头语义 */
.lens.aux {
  color: var(--c-text-2);
  background: rgba(255, 255, 255, 0.14);
}
.gps {
  position: absolute;
  top: 18px;
  right: 2px;
  z-index: 2;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  background: rgba(0, 0, 0, 0.6);
}
.gps.ok {
  color: var(--c-ok);
}
.gps.warn {
  color: var(--c-warn);
}
.gps.err {
  color: var(--c-err);
}
.st {
  position: absolute;
  bottom: 2px;
  right: 2px;
  z-index: 2;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.st.patched {
  background: var(--c-ok);
}
.st.dispatched {
  background: var(--c-info);
}
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.img-err {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  background: var(--c-bg-2);
}
.img-err.aux {
  text-align: center;
  line-height: 1.6;
}
</style>
