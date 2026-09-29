<template>
  <div class="row" style="align-items: stretch; gap: 14px">
    <!-- 左：设备列表 -->
    <div class="card" style="flex: 0 0 340px; display: flex; flex-direction: column">
      <div class="card-head">
        <span>设备列表</span>
        <span class="sub">
          {{ store.airports.length }} 机场 / {{ store.drones.length }} 飞行器<template
            v-if="store.baseStations?.length || store.relays?.length"
          > / {{ (store.baseStations?.length || 0) + (store.relays?.length || 0) }} 其它</template>
        </span>
      </div>
      <div style="flex: 1; overflow: auto; padding: 8px">
        <div
          v-for="d in devices"
          :key="d.sn"
          class="card"
          style="margin-bottom: 8px; cursor: pointer; border-color: selected?.sn === d.sn ? 'var(--brand)' : 'var(--line-soft)'"
          @click="select(d)"
        >
          <div style="padding: 10px 12px">
            <div style="display: flex; align-items: center; gap: 6px">
              <span class="tag" :class="kindTagClass(d.kind)">{{ kindText(d.kind) }}</span>
              <span style="font-size: 13px; font-weight: 600">{{ d.callsign || d.sn }}</span>
              <div style="flex: 1"></div>
              <span class="tag" :class="d.online ? 'ok' : 'err'"><span class="dot"></span>{{ d.online ? '在线' : '离线' }}</span>
            </div>
            <div class="small muted mono" style="margin-top: 4px">{{ d.sn }}</div>
            <div class="small muted" style="margin-top: 2px">
              {{ modelText({ name: d.model, key: d.modelKey }) }}
              <span v-if="d.kind === 'drone' && d.dockSn">· 归属机场 {{ d.dockSn.slice(-6) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!devices.length" class="muted small" style="padding: 16px">
          暂无设备，请在顶部选择项目
        </div>
      </div>
      <div style="padding: 8px">
        <el-button size="small" style="width: 100%" @click="store.loadDevices()">刷新设备</el-button>
      </div>
    </div>

    <!-- 右：详情与控制 -->
    <div class="col" style="display: flex; flex-direction: column; gap: 14px; min-width: 0">
      <!-- 物模型 -->
      <div class="card">
        <div class="card-head">
          <span>物模型 / 实时状态</span>
          <span class="sub">{{ selected?.sn || '未选择设备' }}</span>
        </div>
        <div class="card-body">
          <div v-if="!selected" class="muted small">请从左侧选择设备</div>
          <div v-else-if="!state" class="muted small">加载中…</div>
          <div v-else-if="state.error" class="small" style="color: var(--err)">{{ state.error }}</div>
          <div v-else>
            <!-- 分组指标：字段路径与单位换算见 utils/telemetry.js -->
            <div v-if="!metricGroups.length" class="muted small">该设备未上报可展示的物模型字段</div>
            <div v-for="g in metricGroups" :key="g.title" class="metric-group">
              <div class="metric-title">{{ g.title }}</div>
              <div class="metric-grid">
                <div v-for="item in g.items" :key="item.k" class="metric-cell">
                  <div class="metric-k">{{ item.k }}</div>
                  <div class="metric-v" :style="item.color ? { color: item.color } : {}">{{ item.v }}</div>
                </div>
              </div>
            </div>
            <el-collapse style="margin-top: 10px">
              <el-collapse-item title="查看完整物模型 JSON">
                <pre class="mono small" style="background: var(--bg-2); padding: 10px; border-radius: 6px; max-height: 300px; overflow: auto">{{ JSON.stringify(state, null, 2) }}</pre>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useSessionStore } from '../stores/session';
import { buildMetricGroups } from '../utils/telemetry';
import { modelText } from '../utils/dict';

const store = useSessionStore();
const selected = ref(null);

/** 设备类型文案与标签色（设备类型无关：机场/飞行器/地面站/中继站） */
const KIND_TEXT = { airport: '机场', drone: '飞行器', base_station: '地面站', relay: '中继站' };
const KIND_TAG = { airport: 'ok', drone: 'info', base_station: 'warn', relay: 'info' };
const kindText = (k) => KIND_TEXT[k] || k || '设备';
const kindTagClass = (k) => KIND_TAG[k] || '';

// 设备类型无关：机场（含 Dock/机库）、飞行器、地面站、中继站都从 store 里汇总
const devices = computed(() => [
  ...store.airports,
  ...store.drones,
  ...(store.baseStations || []),
  ...(store.relays || []),
]);
const state = computed(() => (selected.value ? store.states[selected.value.sn] : null));

/**
 * 父设备物模型：飞行器的「图传信号」「备降转移高」在所属机场的物模型里，
 * 官方示例也是从 parent 读，否则这两个字段永远取不到。
 */
const parentState = computed(() => {
  const rel = selected.value?.dockSn;
  return rel ? store.states[rel]?.device_state || null : null;
});

/** 分组指标：机场 22 项 / 地面站 10 项 / 飞行器 7+5+7 项，字段路径见 utils/telemetry.js */
const metricGroups = computed(() =>
  buildMetricGroups(selected.value?.deviceClass, state.value?.device_state, parentState.value)
);

function select(d) {
  selected.value = d;
  store.loadState(d.sn);
}

watch(
  () => devices.value,
  (list) => {
    if (!selected.value && list.length) select(list[0]);
  },
  { immediate: true }
);
</script>

<style scoped>
/* 物模型分组指标：按设备类型分组，每组一个键值网格 */
.metric-group { margin-bottom: 12px; }
.metric-title {
  font-size: 12px; color: var(--c-text-2); font-weight: 500;
  padding-bottom: 6px; margin-bottom: 8px;
  border-bottom: 1px dashed var(--c-line-soft);
}
.metric-grid {
  display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
}
.metric-cell {
  background: var(--c-bg-2); border: 1px solid var(--c-line-soft);
  border-radius: var(--r-sm); padding: 7px 10px;
}
.metric-k { font-size: 11px; color: var(--c-text-2); line-height: 1.5; }
.metric-v { font-size: 14px; font-weight: 500; line-height: 1.5; word-break: break-all; }
</style>
