<template>
  <div class="empty-state">
    <el-icon class="ico" :size="30">
      <component :is="icon" />
    </el-icon>
    <p class="title">{{ title }}</p>
    <p v-if="description" class="desc">{{ description }}</p>
    <el-button v-if="actionText" size="small" type="primary" @click="$emit('action')">
      {{ actionText }}
    </el-button>
  </div>
</template>

<script setup>
/** 空状态：说明「什么没有 + 为什么 + 怎么办」 */
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  actionText: { type: String, default: '' },
  icon: { type: String, default: 'FolderOpened' },
});
defineEmits(['action']);
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 44px 16px;
  text-align: center;
}
.ico {
  color: var(--c-text-2);
}
.title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--c-text-1);
}
.desc {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-2);
  max-width: 420px;
  line-height: 1.7;
}
</style>
