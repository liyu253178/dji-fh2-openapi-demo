<template>
  <span class="status-tag" :class="[`s-${tone}`, { plain }]" :title="tip || label">
    <i v-if="dot" class="dot" />
    {{ label }}
  </span>
</template>

<script setup>
/**
 * 状态标签：色号与文字都取自 token，不写死颜色。
 * 工单七态（设计稿）：
 *   draft 灰 / dispatched 蓝 / accepted 绿 / processing 黄
 *   submitted 绿实心 / rejected 红 / cancelled 灰
 */
const props = defineProps({
  status: { type: String, default: '' },
  map: { type: Object, default: null }, // { status: { label, tone, plain, dot, tip } }
  plain: { type: Boolean, default: false },
});

const DEFAULT = {
  // 工单
  draft: { label: '草稿', tone: 'muted', plain: true, tip: '尚未派发' },
  dispatched: { label: '已派发', tone: 'info', tip: '邮件已发出，待接收' },
  accepted: { label: '已接收', tone: 'ok', plain: true, tip: '属地已接收' },
  processing: { label: '整改中', tone: 'warn', plain: true, tip: '正在整改' },
  submitted: { label: '已提交整改', tone: 'ok', tip: '已提交整改结果（一期终态）' },
  rejected: { label: '已退回', tone: 'danger', tip: '属地认为不成立' },
  cancelled: { label: '已作废', tone: 'muted', plain: true, tip: '已作废' },
  // 图斑
  ticketed: { label: '已生成工单', tone: 'info' },
  none: { label: '未标注', tone: 'muted', plain: true },
  patched: { label: '已标注', tone: 'ok' },
  // 邮件
  sent: { label: '已送达', tone: 'ok' },
  pending: { label: '待发送', tone: 'muted', plain: true },
  failed: { label: '发送失败', tone: 'danger' },
  partial: { label: '部分失败', tone: 'warn' },
  // 同步
  ok: { label: '成功', tone: 'ok' },
  success: { label: '成功', tone: 'ok' },
  terminated: { label: '已终止', tone: 'muted' },
  starting_failure: { label: '启动失败', tone: 'danger' },
  no_gps: { label: '无定位', tone: 'warn' },
  failed_parse: { label: '解析失败', tone: 'danger' },
};

const cfg = props.map?.[props.status] || DEFAULT[props.status] || {
  label: props.status || '—',
  tone: 'muted',
  plain: true,
};
const label = cfg.label;
const tone = cfg.tone;
const dot = cfg.dot ?? false;
const tip = cfg.tip || '';
</script>

<style scoped>
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  line-height: 1.6;
  white-space: nowrap;
}
.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.s-info {
  color: var(--c-info);
  background: rgba(59, 130, 246, 0.14);
}
.s-ok {
  color: var(--c-ok);
  background: rgba(53, 208, 127, 0.16);
}
.s-warn {
  color: var(--c-warn);
  background: rgba(255, 176, 32, 0.16);
}
.s-danger {
  color: var(--c-err);
  background: rgba(255, 77, 79, 0.16);
}
.s-muted {
  color: var(--c-text-1);
  background: rgba(255, 255, 255, 0.06);
}
.s-brand {
  color: var(--c-brand);
  background: var(--c-brand-dim);
}
.plain {
  background: transparent;
  border: 1px solid currentColor;
}
</style>
