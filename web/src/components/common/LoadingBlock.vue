<template>
  <!-- 骨架屏：列表/详情首屏，避免整页遮罩导致布局跳动 -->
  <div v-if="type === 'skeleton'" class="skeleton" :style="{ height }">
    <div
      v-for="i in rows"
      :key="i"
      class="sk-row"
      :style="{ width: i % 3 === 0 ? '62%' : i % 2 === 0 ? '88%' : '100%' }"
    />
  </div>
  <!-- 局部转圈：区域高度 > 100px 时用 -->
  <div v-else class="spin" :style="{ height }">
    <el-icon class="ring" :size="22"><Loading /></el-icon>
    <span class="txt">{{ text }}</span>
  </div>
</template>

<script setup>
defineProps({
  text: { type: String, default: '加载中…' },
  height: { type: String, default: '160px' },
  type: { type: String, default: 'skeleton' }, // skeleton | spin
  rows: { type: Number, default: 4 },
});
</script>

<style scoped>
.spin {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
}
.ring {
  color: var(--c-brand);
  animation: duav-spin 0.9s linear infinite;
}
@keyframes duav-spin {
  to {
    transform: rotate(360deg);
  }
}
.txt {
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
}
.sk-row {
  height: 14px;
  border-radius: var(--r-sm);
  background: linear-gradient(90deg, var(--c-bg-2) 25%, var(--c-bg-3) 37%, var(--c-bg-2) 63%);
  background-size: 400% 100%;
  animation: duav-shimmer 1.4s ease infinite;
}
@keyframes duav-shimmer {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}
</style>
