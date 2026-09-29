<template>
  <div class="page-header">
    <div class="left">
      <el-button v-if="backTo" size="small" text class="back" @click="goBack">‹ 返回</el-button>
      <div class="titles">
        <h2 class="t">{{ title }}</h2>
        <p v-if="subtitle" class="s">{{ subtitle }}</p>
      </div>
      <slot name="tags" />
    </div>
    <div class="right">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup>
import { useRouter } from 'vue-router';

const props = defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  backTo: { type: String, default: '' },
});
const router = useRouter();
function goBack() {
  if (props.backTo) router.push(props.backTo);
  else router.back();
}
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
  flex-wrap: wrap;
}
.left {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.back {
  color: var(--c-text-1);
}
.titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.t {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--c-text-0);
}
.s {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.right {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
</style>
