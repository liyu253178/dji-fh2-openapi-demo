<template>
  <div class="thumb" :class="{ selected: selected }">
    <el-checkbox
      v-if="selectable"
      class="cb"
      :model-value="selected"
      @change="$emit('toggle', image.id)"
      @click.stop
    />
    <span class="idx">{{ index + 1 }}</span>
    <span class="lens" :class="image.lensType">{{ lensLabel }}</span>
    <span v-if="image.gpsStatus === 'RTK'" class="gps ok">RTK</span>
    <span v-else-if="image.gpsStatus" class="gps warn">{{ image.gpsStatus }}</span>
    <span v-else class="gps err">⚠ 无定位</span>
    <span v-if="image.reviewState !== 'none'" class="st" :class="image.reviewState" />
    <img
      :src="url"
      :alt="image.fileName"
      loading="lazy"
      @click="$emit('click', image)"
      @error="onErr"
    />
    <div v-if="failed" class="img-err">加载失败</div>
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
.lens.visible {
  color: var(--c-info);
  background: rgba(59, 130, 246, 0.85);
}
.lens.infrared {
  color: #1a1a1e;
  background: var(--c-warn);
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
</style>
