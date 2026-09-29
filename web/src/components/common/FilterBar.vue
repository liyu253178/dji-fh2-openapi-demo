<template>
  <div class="filter-bar">
    <div class="row">
      <slot />
      <span v-if="extras" class="extras">{{ extras }}</span>
      <div class="spacer" />
      <el-button size="small" @click="$emit('reset')">重置</el-button>
      <el-button size="small" type="primary" @click="$emit('search')">查询</el-button>
    </div>
  </div>
</template>

<script setup>
/** 通用筛选栏：横向排列 + 右侧重置/查询 */
defineProps({ extras: { type: String, default: '' } });
defineEmits(['search', 'reset']);
</script>

<style scoped>
.filter-bar {
  padding: var(--sp-3) var(--sp-4);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  margin-bottom: var(--sp-3);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.extras {
  font-size: var(--fs-sm);
  color: var(--c-warn);
}
</style>
