<template>
  <div class="page">
    <PageHeader title="台账统计" subtitle="按行政区与类型" />

    <FilterBar @search="load" @reset="onReset">
      <el-select v-model="range" size="small" style="width: 140px">
        <el-option label="近 7 天" :value="7" />
        <el-option label="近 30 天" :value="30" />
        <el-option label="近 90 天" :value="90" />
        <el-option label="近一年" :value="365" />
      </el-select>
      <el-select v-model="issueType" placeholder="问题类型：全部" size="small" style="width: 160px" clearable>
        <el-option v-for="t in types" :key="t.code" :label="t.name" :value="t.code" />
      </el-select>
    </FilterBar>

    <!-- 四张统计卡（非互斥：已提交是已派发的子集） -->
    <div class="cards">
      <div v-for="c in CARDS" :key="c.label" class="sc">
        <span class="v" :class="c.tone">{{ c.value }}</span>
        <span class="l">{{ c.label }}</span>
        <span v-if="c.sub" class="s">{{ c.sub }}</span>
      </div>
    </div>

    <div class="charts">
      <div class="blk">
        <h4>按行政区分布</h4>
        <div ref="regionEl" class="chart" />
      </div>
      <div class="blk">
        <h4>按问题类型分布</h4>
        <div ref="typeEl" class="chart" />
      </div>
    </div>

    <div class="blk">
      <h4>工单明细</h4>
      <el-table :data="rows" size="small" @row-click="open">
        <el-table-column label="工单号" min-width="180">
          <template #default="{ row }">
            <span class="link mono">{{ row.ticketNo }}</span>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="130" prop="issueTypeName" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }"><StatusTag :status="row.status" /></template>
        </el-table-column>
        <el-table-column label="责任单位" min-width="160" prop="recipientName" />
        <el-table-column label="截止" width="120" prop="deadline" />
        <el-table-column label="图斑" width="70" align="right" prop="imageCount" />
      </el-table>
      <div class="pager">
        <span class="total">共 {{ total }} 条</span>
        <el-pagination
          v-model:current-page="page"
          :page-size="20"
          :total="total"
          layout="prev, pager, next"
          size="small"
          @current-change="load"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
/** P6 台账统计：四卡 + 双图表 + 明细表 */
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import { ticketApi, dictApi } from '../api/duav';
import PageHeader from '../components/common/PageHeader.vue';
import FilterBar from '../components/common/FilterBar.vue';
import StatusTag from '../components/common/StatusTag.vue';
import { useThemeTokens } from '../composables/useThemeTokens';

const router = useRouter();
const tokens = useThemeTokens();

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const summary = ref({});
const byRegion = ref([]);
const byType = ref([]);
const types = ref([]);
const range = ref(30);
const issueType = ref('');
const regionEl = ref(null);
const typeEl = ref(null);

let c1 = null;
let c2 = null;

const CARDS = computed(() => [
  { label: '工单总数', value: summary.value.total || 0, tone: '', sub: '表内统计' },
  { label: '已派发', value: summary.value.dispatched || 0, tone: 'info', sub: `本期新增 ${summary.value.dispatched || 0}` },
  { label: '已提交整改', value: summary.value.submitted || 0, tone: 'ok', sub: '已派发的子集' },
  { label: '逾期未反馈', value: summary.value.overdue || 0, tone: 'err', sub: '已超期未完成' },
]);

function rangeQuery() {
  const end = new Date();
  const start = new Date(Date.now() - range.value * 86400000);
  return [start.toISOString(), end.toISOString()];
}

async function load() {
  const [b, e] = rangeQuery();
  const [s, r, t, d] = await Promise.all([
    ticketApi.statsSummary({ beginAt: b, endAt: e, issueType: issueType.value || undefined }),
    ticketApi.statsByRegion(),
    ticketApi.statsByType(),
    // 不带 projectUuid：台账跨项目统计全组织数据
    ticketApi.list({ beginAt: b, endAt: e, page: page.value, pageSize: 20 }),
  ]);
  if (s.ok) summary.value = s.data || {};
  if (r.ok) byRegion.value = r.data || [];
  if (t.ok) byType.value = t.data || [];
  if (d.ok) {
    rows.value = d.data.list || [];
    total.value = d.data.total || 0;
  }
  await nextTick();
  drawCharts();
}

function onReset() {
  range.value = 30;
  issueType.value = '';
  page.value = 1;
  load();
}

function drawCharts() {
  if (!regionEl.value || !typeEl.value) return;
  c1 ||= echarts.init(regionEl.value);
  c2 ||= echarts.init(typeEl.value);
  const axis = tokens.axis();

  const reg = byRegion.value.slice(0, 10);
  c1.setOption({
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: tokens.line } }, axisLabel: axis },
    yAxis: {
      type: 'category',
      data: reg.map((x) => x.region).reverse(),
      axisLine: { lineStyle: { color: tokens.line } },
      axisTick: { show: false },
      axisLabel: axis,
    },
    series: [
      {
        type: 'bar',
        data: reg.map((x) => x.count).reverse(),
        barMaxWidth: 14,
        itemStyle: { color: tokens.brand, borderRadius: [0, 3, 3, 0] },
      },
    ],
  });

  c2.setOption({
    tooltip: { trigger: 'item' },
    legend: { orient: 'vertical', right: 0, top: 'center', textStyle: axis },
    series: [
      {
        type: 'pie',
        radius: ['45%', '70%'],
        center: ['38%', '50%'],
        data: byType.value.map((x) => ({ name: x.name, value: x.count })),
        label: { show: false },
        itemStyle: { borderColor: tokens.bg1, borderWidth: 2 },
        color: tokens.palette,
      },
    ],
  });
}

function onResize() {
  c1?.resize();
  c2?.resize();
}
function open(row) {
  router.push(`/tickets/${row.id}`);
}

onMounted(async () => {
  const t = await dictApi.issueTypes();
  if (t.ok) types.value = t.data || [];
  load();
  window.addEventListener('resize', onResize);
});
onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  c1?.dispose();
  c2?.dispose();
});
</script>

<style scoped>
.page {
  padding: var(--sp-3);
}
.cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.sc {
  padding: var(--sp-3);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.v {
  font-size: 26px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--c-text-0);
}
.v.info { color: var(--c-info); }
.v.ok { color: var(--c-ok); }
.v.err { color: var(--c-err); }
.l {
  font-size: var(--fs-sm);
  color: var(--c-text-1);
}
.s {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.charts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.blk {
  padding: var(--sp-3);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}
.blk h4 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--c-text-0);
}
.chart {
  height: 260px;
}
.link {
  color: var(--c-brand);
  cursor: pointer;
}
.mono {
  font-family: ui-monospace, monospace;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--sp-3);
}
.total {
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
</style>
