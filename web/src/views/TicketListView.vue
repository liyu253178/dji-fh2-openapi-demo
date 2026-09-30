<template>
  <div class="page">
    <PageHeader title="工单管理" subtitle="派发与跟踪">
      <template #actions>
        <el-button size="small" @click="load()">刷新</el-button>
      </template>
    </PageHeader>

    <FilterBar @search="load(1)" @reset="onReset">
      <el-select v-model="q.status" placeholder="状态：全部" size="small" style="width: 140px" clearable>
        <el-option v-for="(v, k) in STATUS" :key="k" :label="v" :value="k" />
      </el-select>
      <el-select v-model="q.issueType" placeholder="问题类型：全部" size="small" style="width: 150px" clearable>
        <el-option v-for="t in types" :key="t.code" :label="t.name" :value="t.code" />
      </el-select>
      <el-select v-model="q.adminRegion" placeholder="行政区：全部" size="small" style="width: 140px" clearable>
        <el-option v-for="r in regions" :key="r" :label="r" :value="r" />
      </el-select>
      <el-select v-model="q.range" placeholder="时间范围：近30天" size="small" style="width: 140px">
        <el-option label="近 30 天" :value="30" />
        <el-option label="近 90 天" :value="90" />
        <el-option label="近一年" :value="365" />
      </el-select>
      <el-checkbox v-model="q.overdue" size="small">仅逾期</el-checkbox>
    </FilterBar>

    <!-- 统计条：点击任一数字即入筛选条件（与左侧六态一致，非互斥分类） -->
    <div class="stats">
      <div
        v-for="s in STAT_ITEMS"
        :key="s.key"
        class="stat"
        :class="[s.tone, { on: q.status === s.key }]"
        @click="toggleStatus(s.key)"
      >
        <span class="v">{{ s.value }}</span>
        <span class="l">{{ s.label }}</span>
      </div>
    </div>

    <div class="card">
      <LoadingBlock v-if="firstLoading" type="skeleton" :rows="6" />
      <ErrorState v-else-if="error" title="加载失败" :detail="error" @retry="load(1)" />
      <EmptyState
        v-else-if="!rows.length"
        title="暂无工单"
        description="从影像审核可以生成工单"
        action-text="去审核影像"
        @action="router.push('/assets')"
      />

      <template v-else>
        <el-table :data="rows" v-loading="refreshing" size="small" @row-click="open">
          <el-table-column width="40">
            <template #default="{ row }">
              <el-checkbox
                :model-value="selected.includes(row.id)"
                @change="toggleSel(row.id)"
                @click.stop
              />
            </template>
          </el-table-column>
          <el-table-column label="工单号" min-width="190">
            <template #default="{ row }">
              <span class="link mono">{{ row.ticketNo }}</span>
              <div class="sub">{{ row.issueTypeName }} · {{ row.title || '未填活动态' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="问题类型" width="130">
            <template #default="{ row }">
              <span class="tag">{{ row.issueTypeName }}</span>
            </template>
          </el-table-column>
          <el-table-column label="图斑" width="70" align="right">
            <template #default="{ row }">{{ row.imageCount }}</template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><StatusTag :status="row.status" /></template>
          </el-table-column>
          <el-table-column label="责任单位 / 联系人" min-width="180">
            <template #default="{ row }">
              <div>{{ row.recipientName || '未选择派发对象' }}</div>
              <div class="sub">{{ row.assignedTo || '—' }}<template v-if="row.recipientName"> · {{ row.recipientName }}</template></div>
            </template>
          </el-table-column>
          <el-table-column label="截止" width="130">
            <template #default="{ row }">
              <div :class="{ over: row.overdue }">{{ row.deadline || '—' }}</div>
              <div class="sub" :class="row.overdue ? 'over' : row.daysLeft <= 3 ? 'warn' : 'ok'">
                <template v-if="row.overdue">已逾期 {{ -row.daysLeft }} 天</template>
                <template v-else-if="row.daysLeft !== null">剩 {{ row.daysLeft }} 天</template>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" align="right">
            <template #default="{ row }">
              <el-button size="small" @click.stop="open(row)">详情</el-button>
              <el-button
                v-if="row.status === 'draft'"
                size="small"
                type="primary"
                @click.stop="send(row)"
              >
                发送
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pager">
          <span class="total">共 {{ total }} 条</span>
          <el-pagination
            v-model:current-page="page"
            :page-size="pageSize"
            :total="total"
            layout="sizes, prev, pager, next"
            :page-sizes="[20, 50, 100]"
            size="small"
            @current-change="load()"
            @size-change="load(1)"
          />
        </div>
      </template>
    </div>

    <DispatchDialog
      v-model:visible="dispatchVisible"
      :patches="dispatchPatches"
      @sent="load(1)"
    />
  </div>
</template>

<script setup>
/** P4 工单列表：筛选 + 六态统计条（可点击）+ 表格 */
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ticketApi, reviewApi, dictApi } from '../api/duav';
import PageHeader from '../components/common/PageHeader.vue';
import FilterBar from '../components/common/FilterBar.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import LoadingBlock from '../components/common/LoadingBlock.vue';
import DispatchDialog from '../components/ticket/DispatchDialog.vue';

const STATUS = {
  draft: '草稿',
  dispatched: '已派发',
  accepted: '已接收',
  processing: '整改中',
  submitted: '已提交整改',
  rejected: '已退回',
  cancelled: '已作废',
};

const router = useRouter();

const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const types = ref([]);
const regions = ref([]);
const summary = ref({});
const selected = ref([]);
const firstLoading = ref(true);
const refreshing = ref(false);
const error = ref('');
const dispatchVisible = ref(false);
const dispatchPatches = ref([]);

const q = reactive({ status: '', issueType: '', adminRegion: '', range: '30', overdue: false });

/** 统计条：与左列六态一致；已提交是已派发的子集，逾期只算未完成 */
const STAT_ITEMS = computed(() => [
  { key: 'draft', label: '草稿', value: summary.value.draft || 0, tone: 'muted' },
  { key: 'dispatched', label: '已派发', value: summary.value.dispatched || 0, tone: 'info' },
  { key: 'accepted', label: '已接收', value: summary.value.accepted || 0, tone: 'ok' },
  { key: 'processing', label: '整改中', value: summary.value.processing || 0, tone: 'warn' },
  { key: 'submitted', label: '已提交', value: summary.value.submitted || 0, tone: 'ok' },
  { key: '', label: '逾期', value: summary.value.overdue || 0, tone: 'err' },
]);

function rangeQuery() {
  const days = Number(q.range) || 30;
  const end = new Date();
  const start = new Date(Date.now() - days * 86400000);
  return [start.toISOString(), end.toISOString()];
}

async function load(toPage) {
  if (toPage) page.value = toPage;
  if (rows.value.length) refreshing.value = true;
  else firstLoading.value = true;
  error.value = '';
  const [b, e] = rangeQuery();
  const r = await ticketApi.list({
    status: q.status || undefined,
    issueType: q.issueType || undefined,
    // 不带 projectUuid：工单跨项目展示全组织数据，不随顶部项目切换而清空
    overdue: q.overdue || undefined,
    beginAt: b,
    endAt: e,
    page: page.value,
    pageSize,
  });
  if (!r.ok) {
    error.value = r.message;
  } else {
    rows.value = r.data.list || [];
    total.value = r.data.total || 0;
  }
  // 统计与筛选项并行拉
  const [s, t, reg] = await Promise.all([
    ticketApi.statsSummary({ beginAt: b, endAt: e }),
    dictApi.issueTypes(),
    ticketApi.statsByRegion(),
  ]);
  if (s.ok) summary.value = s.data || {};
  if (t.ok) types.value = t.data || [];
  if (reg.ok) regions.value = (reg.data || []).map((x) => x.region);
  firstLoading.value = false;
  refreshing.value = false;
}

function toggleStatus(key) {
  q.status = q.status === key ? '' : key;
  load(1);
}
function toggleSel(id) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}
function onReset() {
  q.status = '';
  q.issueType = '';
  q.adminRegion = '';
  q.range = '30';
  q.overdue = false;
  load(1);
}
function open(row) {
  router.push(`/tickets/${row.id}`);
}
async function send(row) {
  try {
    await ElMessageBox.confirm(`确认派发工单 ${row.ticketNo}？邮件将发送至 ${row.recipientName || '收件对象'}`, '派发确认', {
      type: 'info',
    });
  } catch {
    return;
  }
  const r = await ticketApi.send(row.id);
  if (!r.ok) {
    ElMessage.error(r.message || '派发失败');
    return;
  }
  ElMessage.success('已进入发送队列');
  load();
}

onMounted(() => load(1));
</script>

<style scoped>
.page {
  padding: var(--sp-3);
}
.stats {
  display: flex;
  gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  margin-bottom: var(--sp-3);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  align-items: center;
  flex-wrap: wrap;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--r-sm);
  min-width: 56px;
}
.stat:hover {
  background: var(--c-bg-2);
}
.stat.on {
  background: var(--c-brand-dim);
}
.v {
  font-size: var(--fs-xl);
  font-weight: 600;
  line-height: 1.2;
}
.l {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.s-muted .v { color: var(--c-text-1); }
.s-info .v { color: var(--c-info); }
.s-ok .v { color: var(--c-ok); }
.s-warn .v { color: var(--c-warn); }
.s-err .v { color: var(--c-err); }
.card {
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  padding: var(--sp-3);
}
.link {
  color: var(--c-brand);
  cursor: pointer;
}
.mono {
  font-family: ui-monospace, monospace;
}
.sub {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.sub.ok { color: var(--c-ok); }
.sub.warn { color: var(--c-warn); }
.over {
  color: var(--c-err);
  font-weight: 600;
}
.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--c-brand);
  background: var(--c-brand-dim);
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
