<template>
  <div class="error-state">
    <el-icon class="ico" :size="30" color="var(--c-warn)"><WarningFilled /></el-icon>
    <p class="title">{{ title }}</p>
    <p v-if="detail" class="detail">{{ detail }}</p>
    <div class="acts">
      <el-button size="small" type="primary" @click="$emit('retry')">{{ retryText }}</el-button>
      <el-button v-if="stack" size="small" text class="stack-btn" @click="showStack = !showStack">
        {{ showStack ? '收起详情' : '查看详情' }}
      </el-button>
    </div>
    <pre v-if="showStack" class="stack">{{ stack }}</pre>
  </div>
</template>

<script setup>
import { ref } from 'vue';

/** 错误状态：说人话 + 给可行动的建议 */
defineProps({
  title: { type: String, default: '出错了' },
  detail: { type: String, default: '' },
  stack: { type: String, default: '' },
  retryText: { type: String, default: '重试' },
});
defineEmits(['retry']);
const showStack = ref(false);
</script>

<style scoped>
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 36px 16px;
  text-align: center;
}
.title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--c-text-0);
}
.detail {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-warn);
  max-width: 520px;
  line-height: 1.7;
}
.acts {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}
.stack-btn {
  color: var(--c-text-2);
}
.stack {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2) var(--sp-3);
  max-width: 560px;
  max-height: 160px;
  overflow: auto;
  text-align: left;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  background: var(--c-bg-0);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  white-space: pre-wrap;
}
</style>
