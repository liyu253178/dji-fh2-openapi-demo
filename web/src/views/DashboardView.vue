<template>
  <div class="dash">
    <!-- 全屏地图铺底 -->
    <div class="dash-map">
      <BaseMap ref="mapRef" :markers="markers" :circles="nestCircles" :zoom="10" @marker-click="onMarkerClick" />
    </div>

    <!-- 左上：最近作业记录（可折叠 / 可切换机场 / 本月航线执行柱状图） -->
    <div class="panel panel-tasks" :class="{ collapsed: recordsCollapsed }">
      <div class="panel-head">
        <span>作业记录</span>
        <el-select
          v-model="selectedAirportSn"
          size="small"
          style="width: 116px"
          placeholder="全部机场"
        >
          <el-option label="全部机场" value="" />
          <el-option v-for="a in store.airports" :key="a.sn" :label="a.callsign || a.sn" :value="a.sn" />
        </el-select>
        <div style="flex: 1"></div>
        <button class="collapse-btn" :title="recordsCollapsed ? '展开' : '收起'" @click="toggleRecords">
          {{ recordsCollapsed ? '▴' : '▾' }}
        </button>
      </div>
      <div v-show="!recordsCollapsed" class="panel-body">
        <div v-if="recordLoading && !recentRecords.length" class="empty">
          <div class="small muted">加载中…</div>
        </div>
        <div v-else-if="!recentRecords.length" class="empty">
          <div class="small muted">近 7 天暂无作业记录</div>
        </div>
        <div v-for="s in recentRecords" :key="s.uuid" class="panel-row" @click="goToRecords">
          <div style="flex: 1; min-width: 0">
            <div style="display: flex; align-items: center; gap: 8px">
              <span class="code">{{ s.code }}</span>
              <span class="name" :title="s.name">{{ s.name }}</span>
              <span class="tag" :class="s.tagClass">{{ s.statusText }}</span>
            </div>
            <div class="meta">{{ s.meta }}</div>
          </div>
        </div>

        <div class="chart-title small muted">本月航线执行次数</div>
        <div ref="chartRef" class="rec-chart"></div>
      </div>
    </div>

    <!-- 右上：机巢状态（跟随项目 / 点击地图图标切换） -->
    <div class="panel panel-nest">
      <div class="panel-head">
        <el-select
          v-if="store.airports.length > 1"
          v-model="selectedNestSn"
          size="small"
          style="width: 118px"
          placeholder="选择机巢"
        >
          <el-option v-for="a in store.airports" :key="a.sn" :label="a.callsign || a.sn" :value="a.sn" />
        </el-select>
        <span v-else>机巢状态</span>
        <span class="tag" :class="nest.online ? 'ok' : 'err'">
          <span class="dot"></span>{{ nest.online ? '在线' : '离线' }}
        </span>
      </div>
      <div class="panel-body">
        <div class="kv"><span class="k">无人机</span><span class="v">{{ nest.droneModel }} · 真高 {{ nest.height }}</span></div>
        <div class="kv"><span class="k">电池电量</span><span class="v" :style="{ color: batteryColor }">{{ nest.battery }}</span></div>
        <div class="kv"><span class="k">RTK 定位</span><span class="v">{{ nest.rtk }} · 卫星 {{ nest.satellites }}</span></div>
        <div class="kv"><span class="k">舱内环境</span><span class="v">{{ nest.temperature }} / {{ nest.humidity }}</span></div>
        <div class="kv"><span class="k">机场模式</span><span class="v">{{ nest.mode }}</span></div>
      </div>
    </div>

    <!-- 底部 KPI -->
    <div class="kpi-bar kpi-dash">
      <div class="kpi-cell">
        <div class="k">今日飞行架次</div>
        <div class="v"><span v-count="kpi.sorties">0</span></div>
      </div>
      <div class="kpi-cell">
        <div class="k">累计飞行时长</div>
        <div class="v"><span v-count="kpi.durationHours" :decimals="1">0</span><span class="u">h</span></div>
      </div>
      <div class="kpi-cell">
        <div class="k">巡查里程</div>
        <div class="v"><span v-count="kpi.distanceKm" :decimals="1">0</span><span class="u">km</span></div>
      </div>
      <div class="kpi-cell" :class="{ danger: kpi.alerts > 0, 'alert-pulse': kpi.alerts > 0 }">
        <div class="k">待处理告警</div>
        <div class="v"><span v-count="kpi.alerts">0</span></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
// 只按需引入柱状图，避免把整个 echarts 打进 DashboardView（整包会让该 chunk 超过 1MB）
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, GraphicComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
echarts.use([BarChart, GridComponent, TooltipComponent, GraphicComponent, CanvasRenderer]);
import { useSessionStore } from '../stores/session';
import { waylineApi, taskApi, opsApi } from '../api/dji';
import { taskStatus } from '../utils/dict';
import BaseMap from '../components/BaseMap.vue';

const router = useRouter();
const store = useSessionStore();

const mapRef = ref(null);
/** 本月记录（当前月份），最近 7 天与柱状图都从这里面派生 */
const records = ref([]);
const recordLoading = ref(false);
/** 左上角面板折叠状态 */
const recordsCollapsed = ref(false);
/** 切换机场（'' = 全部机场） */
const selectedAirportSn = ref('');
const waylines = ref([]);
const overview = ref(null);
let timer = null;

const TASK_STATUS = {
  waiting: { text: '排队中', cls: 'warn', bar: 'var(--c-warn)', percent: 12 },
  executing: { text: '执行中', cls: 'ok', bar: 'var(--c-ok)', percent: 62 },
  success: { text: '已完成', cls: 'info', bar: 'var(--c-info)', percent: 100 },
  partially_done: { text: '部分完成', cls: 'info', bar: 'var(--c-info)', percent: 100 },
  paused: { text: '已暂停', cls: 'warn', bar: 'var(--c-warn)', percent: 45 },
  suspended: { text: '已挂起', cls: 'warn', bar: 'var(--c-warn)', percent: 30 },
  starting_failure: { text: '启动失败', cls: 'err', bar: 'var(--c-err)', percent: 100 },
  terminated: { text: '已终止', cls: 'err', bar: 'var(--c-err)', percent: 100 },
  timeout: { text: '超时', cls: 'err', bar: 'var(--c-err)', percent: 100 },
};

const waylineName = (uuid) => waylines.value.find((w) => w.id === uuid)?.name || '未命名航线';

/** 按选择机场筛选后的记录（'' = 全部机场） */
const filteredRecords = computed(() => {
  if (!selectedAirportSn.value) return records.value || [];
  return (records.value || []).filter((r) => r.sn === selectedAirportSn.value);
});

/** 最近作业记录：本月记录里取近 7 天，按时间倒序取前 5 条 */
const recentRecords = computed(() => {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  return [...(filteredRecords.value || [])]
    .filter((t) => (toDate(t.run_at || t.begin_at)?.getTime() || 0) >= cutoff)
    .sort((a, b) => (toDate(b.run_at || b.begin_at)?.getTime() || 0) - (toDate(a.run_at || a.begin_at)?.getTime() || 0))
    .slice(0, 5)
    .map((t) => {
      const st = taskStatus(t.status);
      const code = `R-${String(t.uuid || '').replace(/\D/g, '').slice(0, 3).padStart(3, '0') || '000'}`;
      const when = formatTime(t.run_at || t.begin_at);
      const dev = store.allDevices.find((d) => d.sn === t.sn);
      const devName = dev ? dev.callsign || dev.sn : t.sn ? `…${String(t.sn).slice(-6)}` : '--';
      return {
        uuid: t.uuid,
        code,
        name: t.name || waylineName(t.wayline_uuid) || '未命名任务',
        statusText: st.text,
        tagClass: st.key === 'success' ? 'ok' : st.key === 'failed' ? 'err' : st.key === 'running' ? 'ok' : 'info',
        meta: `${devName} · ${when}`,
      };
    });
});

/**
 * 本月航线执行次数：按航线聚合，横向柱状图数据
 * 没有 wayline_uuid 的自动动作记录直接用任务名当标签
 */
const monthChartData = computed(() => {
  const map = new Map();
  for (const r of filteredRecords.value || []) {
    const label = r.wayline_uuid ? waylineName(r.wayline_uuid) : r.name || '未命名任务';
    map.set(label, (map.get(label) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
});

const chartRef = ref(null);
let chartInst = null;

function renderChart() {
  if (!chartRef.value) return;
  if (recordsCollapsed.value) return;
  if (!chartInst) chartInst = echarts.init(chartRef.value);
  const data = monthChartData.value;
  if (!data.length) {
    chartInst.clear();
    chartInst.setOption({
      graphic: {
        type: 'text',
        left: 'center',
        top: 'middle',
        style: { text: '本月暂无航线执行记录', fill: '#8b93a7', fontSize: 12 },
      },
    });
    return;
  }
  const cats = data.map((d) => d.name).reverse();
  const vals = data.map((d) => d.value).reverse();
  chartInst.setOption(
    {
      grid: { left: 92, right: 28, top: 6, bottom: 6 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: '#8b93a7', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } },
      },
      yAxis: {
        type: 'category',
        data: cats,
        axisLabel: { color: '#c3c8d4', fontSize: 11, width: 88, overflow: 'truncate' },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          data: vals,
          barMaxWidth: 14,
          itemStyle: { color: '#4a8cff', borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', color: '#c3c8d4', fontSize: 10 },
        },
      ],
    },
    { notMerge: true }
  );
  chartInst.resize();
}

function toggleRecords() {
  recordsCollapsed.value = !recordsCollapsed.value;
}

/** 数据或折叠状态变化后重绘；折叠时 v-show 隐藏容器，展开后需要重新 resize */
watch([monthChartData, recordsCollapsed], async () => {
  await nextTick();
  renderChart();
});

/**
 * 机巢面板显示哪台机场：
 *  1. 用户点选（下拉 / 点击地图上的机场或无人机图标）优先
 *  2. 未点选时回退到第一个在线机场，再不行取第一个
 * 切换项目后设备列表会重新加载，selectedNestSn 不在列表里时自动回退，
 * 因此面板始终显示「当前项目」里的机巢。
 */
const selectedNestSn = ref('');
const nestDock = computed(() => {
  const list = store.airports;
  return (
    list.find((a) => a.sn === selectedNestSn.value) ||
    store.onlineAirports[0] ||
    list[0] ||
    null
  );
});

/** 点击地图图标切换机巢：点机场直接选，点飞行器选它所属的机巢 */
function onMarkerClick(m) {
  if (m.type === 'airport') {
    if (store.airports.some((a) => a.sn === m.sn)) selectedNestSn.value = m.sn;
  } else if (m.type === 'drone') {
    const d = store.drones.find((x) => x.sn === m.sn);
    if (d?.dockSn && store.airports.some((a) => a.sn === d.dockSn)) {
      selectedNestSn.value = d.dockSn;
    }
  }
}

// 项目切换 / 设备列表变化后：选中的机巢不在当前项目里 → 回退；未选过 → 默认选中（下拉能显示机巢名）
watch(
  () => store.airports,
  (list) => {
    if (!list.some((a) => a.sn === selectedNestSn.value)) {
      selectedNestSn.value = (store.onlineAirports[0] || list[0])?.sn || '';
    }
  },
  { deep: true }
);
const nestDrone = computed(() => {
  const d = nestDock.value;
  if (!d) return null;
  return store.drones.find((x) => x.sn === d.droneSn) || null;
});
const nestState = computed(() => {
  const sn = nestDock.value?.sn;
  return sn ? store.states[sn]?.device_state || {} : {};
});
const droneState = computed(() => {
  const sn = nestDrone.value?.sn;
  return sn ? store.states[sn]?.device_state || {} : {};
});

/** 机场状态码 → 中文（兼容数字码与字符串枚举） */
const AIRPORT_MODE = {
  0: '空闲中', 1: '现场调试', 2: '远程调试', 3: '固件升级中', 4: '作业中',
  idle: '空闲中', on_job: '作业中', working: '作业中', debug: '现场调试',
  remote_debug: '远程调试', upgrade: '固件升级中', preparing: '作业准备中',
  returning: '作业后关舱盖中', offline: '已离线', not_connected: '未连接',
};

const nest = computed(() => {
  const s = nestState.value;
  const ds = droneState.value;
  const num = (v, digits = 1, unit = '') =>
    v === undefined || v === null || v === '' ? '-' : `${Number(v).toFixed(digits)}${unit}`;
  const temp = s.environment_temperature ?? s.temperature;
  const humidity = s.environment_humidity ?? s.humidity;
  const mode = s.mode_code ?? nestDock.value?.modeCode;
  return {
    name: nestDock.value?.callsign || '-',
    online: !!nestDock.value?.online,
    droneModel: nestDrone.value?.model || '-',
    height: num(ds.height, 1, ' m'),
    battery: num(ds.battery?.capacity_percent ?? s.drone_charge_state?.capacity_percent, 0, '%'),
    rtk: ds.position_state?.is_fixed ? 'FIX' : ds.position_state?.rtk_number ? 'RTK' : '-',
    satellites: ds.position_state?.gps_number ?? '-',
    temperature: temp === undefined || temp === null ? '-' : `${Number(temp).toFixed(1)}°C`,
    humidity: humidity === undefined || humidity === null ? '-' : `${Number(humidity).toFixed(0)}%`,
    mode: AIRPORT_MODE[mode] ?? (mode === undefined ? '-' : String(mode)),
  };
});

const batteryColor = computed(() => {
  const v = parseInt(nest.value.battery, 10);
  if (Number.isNaN(v)) return 'var(--c-text-0)';
  if (v < 25) return 'var(--c-err)';
  if (v < 40) return 'var(--c-warn)';
  return 'var(--c-ok)';
});

const kpi = computed(() => {
  const o = overview.value || {};
  const flight = o.flight || {};
  const res = o.resources || {};
  const trend = o.trend || [];
  return {
    sorties: trend.length ? trend[trend.length - 1].count : flight.sorties || 0,
    // 返回数字而不是 toFixed 后的字符串：数字要交给 v-count 滚动，
    // 小数位由模板上的 :decimals 声明，指令内部会处理显示格式
    durationHours: Math.round(((flight.durationMin || 0) / 60) * 10) / 10,
    distanceKm: Math.round((flight.distanceKm || 0) * 10) / 10,
    alerts: res.alerts || 0,
  };
});

function posOf(sn) {
  const s = store.states[sn]?.device_state;
  if (!s) return null;
  const lat = s.latitude ?? s.home_latitude;
  const lng = s.longitude ?? s.home_longitude;
  if (lat === undefined || lng === undefined || (lat === 0 && lng === 0)) return null;
  // 过滤异常坐标，避免个别脏数据把地图视野拉到天边
  if (lat < 3 || lat > 54 || lng < 73 || lng > 136) return null;
  return { lat, lng };
}

const markers = computed(() =>
  [...store.airports, ...store.drones]
    .map((d) => {
      const p = posOf(d.sn);
      if (!p) return null;
      return {
        type: d.kind === 'drone' ? 'drone' : 'airport',
        sn: d.sn,
        name: d.callsign || d.sn,
        lat: p.lat,
        lng: p.lng,
        online: d.online,
        heading: store.states[d.sn]?.device_state?.attitude_heading || 0,
        extra: d.model,
      };
    })
    .filter(Boolean)
);

/**
 * 机巢作业半径圈
 *
 * 说明：这里**不画编造的飞线**。司空 2 的任务列表不返回航点坐标
 * （task/list 只有 total_waypoints，没有 points 数组），航线列表也不带航点，
 * 所以「机场 → 作业点」的飞线两端拿不到真实数据，画出来只会误导。
 *
 * 改为画**有真实数据支撑的覆盖范围圈**：用该机场真实累计飞行里程推算作业半径
 * （行业经验值 ~ 直线距离约为航程的 40%），悬停能看到具体公里数。
 * 数据来自 overview.flight.distanceKm，里程为 0 时不画（不给假圈）。
 */
const nestCircles = computed(() => {
  const flight = overview.value?.flight || {};
  // 累计里程为 0 说明这台机场还没飞过，画圈就是编数据了
  if (!flight.distanceKm) return [];
  const radiusM = Math.round((flight.distanceKm * 1000 * 0.4) / 500) * 500;
  if (!radiusM) return [];
  return (store.airports || [])
    .map((a) => {
      const p = posOf(a.sn);
      if (!p) return null;
      return { lat: p.lat, lng: p.lng, radius: radiusM, color: '#4a8cff', name: a.callsign || a.sn };
    })
    .filter(Boolean);
});

async function loadData() {  // 标记轮询状态，顶栏据此显示「刷新中 / Ns 前已刷新」
  store.polling = true;
  try {
    const [w, o] = await Promise.all([waylineApi.list(), opsApi.overview()]);
    if (w?.ok) waylines.value = w.data?.list || [];
    if (o?.ok) overview.value = o.data || null;
  } finally {
    store.polling = false;
    store.lastRefreshAt = Date.now();
  }
}

/** 统一时间格式化：接口时间可能是秒 / 毫秒 / ISO 字符串 */
function toDate(ts) {
  if (!ts) return null;
  if (typeof ts === 'string' && /[-:T]/.test(ts)) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000);
}

function formatTime(ts) {
  const d = toDate(ts);
  if (!d) return '--';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本月作业记录：多机场并发聚合后按时间倒序（最近 7 天与柱状图都由此派生） */
async function loadRecords() {
  const sns = (store.airports || []).map((a) => a.sn).filter(Boolean);
  if (!sns.length) {
    records.value = [];
    return;
  }
  recordLoading.value = true;
  const now = new Date();
  const end = Math.floor(now.getTime() / 1000);
  const begin = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const rs = await Promise.all(sns.map((sn) => taskApi.list({ sn, begin_at: begin, end_at: end })));
  recordLoading.value = false;

  const seen = new Set();
  const merged = [];
  for (const r of rs) {
    for (const row of r?.data?.list || []) {
      if (!row?.uuid || seen.has(row.uuid)) continue;
      seen.add(row.uuid);
      merged.push(row);
    }
  }
  records.value = merged;
}

function goToRecords() {
  router.push('/wayline');
}

// 设备坐标是异步分批到达的：到齐后主动重算一次视野，避免只定位到其中一台设备
watch(
  () => markers.value.length,
  async () => {
    await nextTick();
    setTimeout(() => mapRef.value?.fitAll(), 300);
  }
);

async function refresh() {
  await loadData();
  await loadRecords();
}

/** 窗口尺寸变化后重算柱状图尺寸 */
function onResize() {
  chartInst?.resize();
}
window.addEventListener('resize', onResize);

onMounted(async () => {
  if (store.deviceCount === 0) await store.loadDevices();
  await refresh();
  await nextTick();
  renderChart();
  timer = setInterval(refresh, 20000);
});
onUnmounted(() => {
  timer && clearInterval(timer);
  window.removeEventListener('resize', onResize);
  chartInst?.dispose();
  chartInst = null;
});
</script>

<style scoped>
.dash { position: relative; height: 100%; overflow: hidden; background: var(--c-bg-0); }
.dash-map { position: absolute; inset: 0; }

.panel-tasks { left: 12px; top: 12px; width: 320px; max-height: calc(100% - 130px); display: flex; flex-direction: column; }
.panel-tasks.collapsed { max-height: none; height: auto; }
.panel-tasks .panel-body { overflow-y: auto; }

/* 折叠按钮 */
.collapse-btn {
  width: 18px; height: 18px; line-height: 1; border: none; cursor: pointer;
  background: transparent; color: var(--c-text-2); font-size: 12px; padding: 0;
}
.collapse-btn:hover { color: var(--c-text-0); }

.chart-title { margin: 10px 0 4px; }
.rec-chart { width: 100%; height: 180px; }
.panel-nest { right: 12px; top: 12px; width: 250px; }

/* 底图切换按钮放右下：左上被作业记录面板占满（高 605px），左侧那条缝塞不下
   192px 高的工具栏，会以 z-index 999 压在面板的柱状图上。右下在机巢面板下方、
   KPI 条上方，是唯一不冲突的空位。折叠按钮在左、菜单在右。 */
.dash :deep(.map-toolbar) {
  left: auto; right: 12px; top: auto; bottom: 100px;
  align-items: flex-start;
}

.kpi-dash { position: absolute; left: 12px; right: 12px; bottom: 12px; }
.empty { padding: 8px 2px; text-align: center; }

/* ---------- 大屏质感增强 ---------- */

/* 面板科技感：左上角强调角标 + 顶部一道渐隐高光线。
   纯装饰，不改布局、不挡内容（pointer-events: none）。 */
.dash :deep(.panel)::before {
  content: '';
  position: absolute; left: 0; top: 0;
  width: 26px; height: 2px;
  background: linear-gradient(90deg, var(--c-brand), transparent);
  pointer-events: none;
}
.dash :deep(.panel)::after {
  content: '';
  position: absolute; left: 0; top: 0;
  width: 2px; height: 14px;
  background: linear-gradient(180deg, var(--c-brand), transparent);
  pointer-events: none;
}
/* 面板头加一条渐隐分隔，比纯 border 更有层次 */
.dash :deep(.panel-head) {
  position: relative;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent);
}
.dash :deep(.panel-head)::after {
  content: '';
  position: absolute; left: 12px; right: 12px; bottom: 0; height: 1px;
  background: linear-gradient(90deg, var(--c-brand), transparent 65%);
  opacity: 0.5;
}

/* 待处理告警 > 0：整格脉冲红光，视线自然被拉到风险上。
   只改 box-shadow/透明度，不动布局，避免大屏抖动。 */
.kpi-cell.alert-pulse {
  animation: kpi-alert 1.8s ease-in-out infinite;
}
@keyframes kpi-alert {
  0%, 100% { background: rgba(226, 75, 74, 0.06); }
  50%      { background: rgba(226, 75, 74, 0.16); }
}

/* KPI 数字：等宽数字，滚动时不左右跳动 */
.kpi-cell .v { font-variant-numeric: tabular-nums; }

/* ---------- 大屏自适应 ----------
   不用 autofit.js 那种整体缩放（会让 1920 屏上的字在 2560 屏上偏小、
   鼠标热区错位），改用 clamp() 按视口平滑缩放关键尺寸。
   基准 1920×1080；超过 2560 宽时封顶，避免元素过度膨胀。 */
.dash {
  --dash-gap: clamp(8px, 0.78vw, 16px);
  --dash-pad: clamp(10px, 0.73vw, 18px);
  --panel-w-task: clamp(280px, 17.2vw, 360px);
  --panel-w-nest: clamp(220px, 14vw, 300px);
  --kpi-font: clamp(20px, 1.35vw, 30px);
}
.dash .panel-tasks { left: var(--dash-gap); top: var(--dash-gap); width: var(--panel-w-task); }
.dash .panel-nest { right: var(--dash-gap); top: var(--dash-gap); width: var(--panel-w-nest); }
.dash .kpi-bar { left: var(--dash-gap); right: var(--dash-gap); bottom: var(--dash-gap); }
.dash :deep(.map-toolbar) { bottom: calc(var(--dash-gap) + 76px); }
.dash .kpi-cell .v { font-size: var(--kpi-font); }

/* 窄屏（笔记本 1366 及以下）收紧面板，给地图留出可视面积 */
@media (max-width: 1440px) {
  .dash { --panel-w-task: 268px; --panel-w-nest: 208px; }
}

/* 尊重系统的「减少动态效果」：关掉脉冲与呼吸，数字直接跳到终值 */
@media (prefers-reduced-motion: reduce) {
  .kpi-cell.alert-pulse { animation: none; }
}
</style>
