<template>
  <div class="page">
    <PageHeader title="影像审核" subtitle="人工标注与工单生成" />

    <el-tabs v-model="tab" class="tabs" @tab-change="load(1)">
      <el-tab-pane :label="`待派单 (${counts.draft})`" name="draft" />
      <el-tab-pane :label="`已生成工单 (${counts.ticketed})`" name="ticketed" />
    </el-tabs>

    <LoadingBlock v-if="firstLoading" type="skeleton" :rows="6" />
    <ErrorState v-else-if="error" title="加载失败" :detail="error" @retry="load(1)" />

    <EmptyState
      v-else-if="!list.length"
      :title="tab === 'draft' ? '待派单已清空' : '该状态下暂无图斑'"
      :description="tab === 'draft' ? '所有架次都已审核完毕' : ''"
      :action-text="tab === 'draft' ? '去审核影像' : ''"
      @action="router.push('/assets')"
    />

    <div v-else class="grid">
      <div v-for="p in list" :key="p.patchId" class="card">
        <div class="thumb" @click="openDetail(p)">
          <img v-if="p.thumbnailUrl" :src="p.thumbnailUrl" :alt="p.title" loading="lazy" />
          <span class="cnt" v-if="p.imageCount > 1">{{ p.imageCount }} 张</span>
        </div>
        <div class="body">
          <div class="r1">
            <span class="no">图斑 #{{ p.patchId }}</span>
            <StatusTag :status="p.status" />
          </div>
          <div class="r2">
            <span class="type">{{ p.issueTypeName }}</span>
          </div>
          <p class="r3">{{ p.adminRegion || '未填写行政区' }}</p>
          <p class="r4 mono">{{ fmtCoord(p.lat) }}, {{ fmtCoord(p.lon) }}</p>
          <p class="r5">
            {{ p.sourceTaskName || '—' }} · {{ fmtTime(p.shotAt || p.reviewedAt) }}
          </p>
          <p class="r6">
            <span v-if="p.areaM2">{{ areaText(p.areaM2) }}</span>
            <span v-if="p.gpsStatus === 'RTK'" class="ok"> · RTK ✓</span>
            <span v-else-if="!p.gpsStatus" class="warn"> · ⚠ 无定位</span>
          </p>
        </div>
        <div class="acts">
          <el-button size="small" @click="openDetail(p)">查看</el-button>
          <el-button
            v-if="p.status === 'draft'"
            size="small"
            type="primary"
            @click="openDispatch(p)"
          >
            派发
          </el-button>
        </div>
      </div>
    </div>

    <div v-if="list.length" class="pager">
      <span class="total">共 {{ total }} 个图斑</span>
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        size="small"
        @current-change="load()"
      />
    </div>

    <DispatchDialog v-model:visible="dispatchVisible" :patches="dispatchTargets" @sent="load(1)" />
  </div>
</template>

<script setup>
/** P3 审核队列：图斑卡片网格 + 派发入口 */
import { ref, reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { reviewApi } from '../api/duav';
import { useSessionStore } from '../stores/session';
import PageHeader from '../components/common/PageHeader.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import LoadingBlock from '../components/common/LoadingBlock.vue';
import DispatchDialog from '../components/ticket/DispatchDialog.vue';

const router = useRouter();
const store = useSessionStore();

const tab = ref('draft');
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 12;
const firstLoading = ref(true);
const error = ref('');
const counts = reactive({ draft: 0, ticketed: 0 });
const dispatchVisible = ref(false);
const dispatchTargets = ref([]);

function fmtCoord(v) {
  return v ? Number(v).toFixed(7) : '—';
}
function fmtTime(t) {
  return t ? String(t).slice(0, 16).replace('T', ' ') : '—';
}
function areaText(a) {
  return a < 10000 ? `${Math.round(a)} ㎡` : `${(a / 666.6667).toFixed(1)} 亩`;
}

async function load(toPage) {
  if (toPage) page.value = toPage;
  if (list.value.length) return;
  firstLoading.value = true;
  error.value = '';
  const r = await reviewApi.queue({
    status: tab.value,
    projectUuid: store.projectUuid || undefined,
    page: page.value,
    pageSize,
  });
  if (!r.ok) {
    error.value = r.message;
  } else {
    list.value = r.data.list || [];
    total.value = r.data.total || 0;
    // 统计另一状态的数量
    const other = tab.value === 'draft' ? 'ticketed' : 'draft';
    const r2 = await reviewApi.queue({ status: other, pageSize: 1 });
    counts[other] = r2.ok ? r2.data.total || 0 : 0;
    counts[tab.value] = total.value;
  }
  firstLoading.value = false;
}

function openDetail(p) {
  router.push(`/review/task/${p.taskUuid}`);
}
function openDispatch(p) {
  dispatchTargets.value = [p];
  dispatchVisible.value = true;
}

onMounted(() => load(1));
</script>

<style scoped>
.page {
  padding: var(--sp-3);
}
.tabs {
  margin-bottom: var(--sp-2);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: var(--sp-3);
}
.card {
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  overflow: hidden;
  transition: box-shadow 0.15s, transform 0.15s;
}
.card:hover {
  box-shadow: var(--shadow-1);
  transform: translateY(-2px);
}
.thumb {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--c-bg-2);
  cursor: pointer;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cnt {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--c-text-0);
  background: rgba(0, 0, 0, 0.6);
}
.body {
  padding: var(--sp-2) var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.r1 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.no {
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.type {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--c-text-0);
}
.r3,
.r4,
.r5,
.r6 {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono {
  font-family: ui-monospace, monospace;
}
.ok {
  color: var(--c-ok);
}
.warn {
  color: var(--c-warn);
}
.acts {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-3);
}
.acts .el-button {
  flex: 1;
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
