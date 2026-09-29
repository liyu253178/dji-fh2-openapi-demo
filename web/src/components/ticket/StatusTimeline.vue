<template>
  <div class="tl">
    <!-- 已发生的流转 -->
    <div v-for="l in sorted" :key="l.id" class="row">
      <span class="dot" :class="dotOf(l)" />
      <div class="body">
        <div class="l1">
          <span class="t">{{ l.toLabel || l.toStatus }}</span>
          <span class="time">{{ fmt(l.createdAt) }}</span>
        </div>
        <p class="rm">{{ l.remark || '—' }}</p>
      </div>
      <span class="op">{{ l.operator || '—' }}</span>
    </div>

    <!-- 未来可推进：灰虚线（allowedTransitions 由后端给出，前端不硬编码） -->
    <div v-if="allowed.length" class="row future">
      <span class="dot ghost" />
      <div class="body">
        <p class="tip">可推进（来自后端 allowedTransitions，前端不硬编码）</p>
        <div class="btns">
          <span v-for="t in allowed" :key="t" class="ghost-btn">
            {{ labelOf(t) }}
            <em>· {{ hintOf(t) }}</em>
            <i v-if="t === 'rejected'">= 4环「不成立」是佐证分叉</i>
          </span>
        </div>
      </div>
      <el-button size="small" type="primary" @click="$emit('advance')">推进</el-button>
    </div>
  </div>
</template>

<script setup>
/** 状态时间线：已发生（实线）+ 未来可推进（灰虚线） */
import { computed } from 'vue';

const props = defineProps({
  logs: { type: Array, default: () => [] },
  allowed: { type: Array, default: () => [] },
});
defineEmits(['advance']);

const LABEL = {
  draft: '草稿',
  dispatched: '已派发',
  accepted: '已接收',
  processing: '整改中',
  submitted: '已提交整改',
  rejected: '已退回',
  cancelled: '已作废',
};
const HINT = {
  accepted: '确认「属地 · 联系人 · 邮件地址已收到」',
  processing: '确认「开始现场核查」',
  submitted: '确认「已上传整改完成整改」',
  rejected: '附「不成立」理由，退回审核员',
  dispatched: '含 3 件 / 邮件待发',
  cancelled: '作废需填原因',
};

const sorted = computed(() => [...props.logs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
const labelOf = (t) => LABEL[t] || t;
const hintOf = (t) => HINT[t] || '';
const dotOf = (l) => {
  if (/失败|错误/.test(l.remark || '')) return 'err';
  if (l.operator === 'system') return 'sys';
  return 'ok';
};
const fmt = (t) => (t ? String(t).slice(5, 16).replace('T', ' ') : '');
</script>

<style scoped>
.tl {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.row {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  gap: var(--sp-2);
  align-items: start;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
}
.dot.ok {
  background: var(--c-ok);
}
.dot.err {
  background: var(--c-err);
}
.dot.sys {
  background: var(--c-err);
}
.dot.ghost {
  border: 1px dashed var(--c-text-2);
  background: transparent;
}
.l1 {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.t {
  font-size: var(--fs-md);
  color: var(--c-text-0);
}
.time {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.rm {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
  color: var(--c-text-1);
}
.op {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.future .tip {
  margin: 0 0 6px;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.ghost-btn {
  padding: 3px 8px;
  border: 1px dashed var(--c-line);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--c-text-1);
}
.ghost-btn em {
  font-style: normal;
  color: var(--c-text-2);
}
.ghost-btn i {
  font-style: normal;
  color: var(--c-warn);
  margin-left: 4px;
}
</style>
