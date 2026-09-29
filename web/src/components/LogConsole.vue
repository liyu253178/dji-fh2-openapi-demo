<template>
  <div style="display: flex; flex-direction: column; height: 100%">
    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap">
      <el-select v-model="level" size="small" style="width: 110px">
        <el-option label="全部" value="all" />
        <el-option label="成功" value="success" />
        <el-option label="信息" value="info" />
        <el-option label="调试" value="debug" />
        <el-option label="警告" value="warning" />
        <el-option label="错误" value="error" />
      </el-select>
      <el-input v-model="keyword" size="small" placeholder="过滤关键字" clearable style="width: 160px" />
      <el-checkbox v-model="follow" size="small">自动滚动</el-checkbox>
      <div style="flex: 1"></div>
      <el-button size="small" @click="load">刷新</el-button>
      <el-button size="small" type="danger" plain @click="clear">清空</el-button>
    </div>

    <div
      ref="box"
      class="card"
      style="flex: 1; overflow-y: auto; background: #060b14; min-height: 120px"
    >
      <div v-if="!rows.length" class="muted small" style="padding: 16px">暂无日志</div>
      <div v-for="r in rows" :key="r.id" :class="['log-line', r.level]">
        <span class="t">{{ r.time }}</span>
        <span class="lv">{{ levelText(r.level) }}</span>
        <span class="m">
          <span style="color: var(--text-2)">[{{ r.tag }}]</span> {{ r.message }}
          <span v-if="r.detail" style="opacity: .55">
            {{ short(r.detail) }}
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { adminApi } from '../api/dji';

const props = defineProps({
  limit: { type: Number, default: 300 },
  /** 是否订阅后端 SSE 实时推送 */
  stream: { type: Boolean, default: true },
});

const rows = ref([]);
const level = ref('all');
const keyword = ref('');
const follow = ref(true);
const box = ref(null);
let es = null;

const levelText = (l) =>
  ({ success: 'OK', info: 'INFO', debug: 'DEBUG', warning: 'WARN', error: 'ERROR' }[l] || l);

function short(detail) {
  try {
    return JSON.stringify(detail).slice(0, 220);
  } catch {
    return String(detail).slice(0, 220);
  }
}

async function load() {
  const r = await adminApi.logs({ level: level.value, keyword: keyword.value, limit: props.limit });
  if (r?.ok) {
    rows.value = r.data || [];
    scrollToEnd();
  }
}

async function clear() {
  await adminApi.clearLogs();
  rows.value = [];
}

function scrollToEnd() {
  if (!follow.value) return;
  nextTick(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight;
  });
}

function connectStream() {
  if (!props.stream) return;
  es = new EventSource('/api/logs/stream');
  es.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      const lv = level.value;
      if (lv !== 'all' && entry.level !== lv) return;
      const k = keyword.value.trim().toLowerCase();
      if (k && !JSON.stringify(entry).toLowerCase().includes(k)) return;
      rows.value.push(entry);
      if (rows.value.length > props.limit) rows.value.shift();
      scrollToEnd();
    } catch {
      /* ignore */
    }
  };
  es.addEventListener('clear', () => (rows.value = []));
}

watch([level, keyword], () => load());

onMounted(() => {
  load();
  connectStream();
});
onBeforeUnmount(() => es && es.close());
</script>
