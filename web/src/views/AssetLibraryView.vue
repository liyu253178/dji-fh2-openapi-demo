<template>
  <div class="page">
    <PageHeader title="巡检成果" subtitle="航拍影像与架次">
      <template #actions>
        <el-button size="small" type="primary" @click="syncVisible = true">⟳ 同步影像</el-button>
      </template>
    </PageHeader>

    <FilterBar @search="load(1)" @reset="onReset">
      <el-select v-model="q.dockSn" placeholder="机场：全部" size="small" style="width: 150px" clearable>
        <el-option v-for="d in store.airports" :key="d.sn" :label="d.callsign || d.model" :value="d.sn" />
      </el-select>
      <el-date-picker
        v-model="q.range"
        type="daterange"
        size="small"
        range-separator="→"
        start-placeholder="开始"
        end-placeholder="结束"
        style="width: 240px"
      />
      <el-select v-model="q.reviewState" placeholder="审核状态：全部" size="small" style="width: 140px" clearable>
        <el-option label="未审核" value="none" />
        <el-option label="部分审核" value="partial" />
        <el-option label="已完成" value="done" />
      </el-select>
    </FilterBar>

    <!-- 表格 -->
    <div class="card">
      <LoadingBlock v-if="firstLoading" type="skeleton" :rows="6" />

      <ErrorState
        v-else-if="error"
        title="加载失败"
        :detail="error"
        @retry="load(1)"
      />

      <EmptyState
        v-else-if="!rows.length"
        title="还没有同步过航拍影像"
        description="同步后可在成果库按架次浏览，供人工审核与派单"
        action-text="同步影像"
        @action="syncVisible = true"
      />

      <template v-else>
        <el-table :data="rows" v-loading="refreshing" size="small" @row-click="openTask">
          <el-table-column label="架次" min-width="180">
            <template #default="{ row }">
              <span class="link">{{ row.name || row.taskUuid.slice(0, 8) }}</span>
              <div class="sub">{{ fmtTime(row.beginAt) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="设备" width="140">
            <template #default="{ row }">
              <span>{{ row.dockSn || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="影像" width="80" align="right">
            <template #default="{ row }">{{ row.imageCount }}</template>
          </el-table-column>
          <el-table-column label="类型构成" width="200">
            <template #default="{ row }">
              <span class="tag visible">{{ row.imageStats.visible }} 可</span>
              <span class="tag infrared">{{ row.imageStats.infrared }} 红</span>
              <span v-if="row.imageStats.ppk" class="tag ppk">{{ row.imageStats.ppk }} PPK</span>
            </template>
          </el-table-column>
          <el-table-column label="任务状态" width="110">
            <template #default="{ row }">
              <StatusTag :status="row.status" />
            </template>
          </el-table-column>
          <el-table-column label="审核进度" width="170">
            <template #default="{ row }">
              <el-progress
                :percentage="pct(row)"
                :stroke-width="5"
                :show-text="false"
                style="width: 100px"
              />
              <span class="sub">{{ row.review.patched }} / {{ row.review.total }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" align="right">
            <template #default="{ row }">
              <el-button size="small" text type="primary" @click.stop="openTask(row)">查看影像</el-button>
              <el-button size="small" text type="danger" @click.stop="removeTask(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pager">
          <span class="total">共 {{ total }} 个架次 · {{ totalImages }} 张影像</span>
          <el-pagination
            v-model:current-page="page"
            :page-size="pageSize"
            :total="total"
            layout="prev, pager, next"
            size="small"
            @current-change="load()"
          />
        </div>
      </template>
    </div>

    <SyncDialog v-model:visible="syncVisible" @done="load(1)" />
  </div>
</template>

<script setup>
/** P1 巡检成果：架次列表 + 同步入口 */
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { assetApi } from '../api/duav';
import { useSessionStore } from '../stores/session';
import PageHeader from '../components/common/PageHeader.vue';
import FilterBar from '../components/common/FilterBar.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import LoadingBlock from '../components/common/LoadingBlock.vue';
import SyncDialog from '../components/asset/SyncDialog.vue';

const router = useRouter();
const store = useSessionStore();

const rows = ref([]);
const total = ref(0);
const totalImages = ref(0);
const page = ref(1);
const pageSize = 20;
const firstLoading = ref(true);
const refreshing = ref(false);
const error = ref('');
const syncVisible = ref(false);

const q = reactive({ dockSn: '', range: null, reviewState: '' });

const pct = (row) => {
  if (!row.review.total) return 0;
  return Math.round((row.review.patched / row.review.total) * 100);
};

function fmtTime(t) {
  return t ? String(t).slice(0, 16).replace('T', ' ') : '—';
}

async function load(toPage) {
  if (toPage) page.value = toPage;
  if (rows.value.length) refreshing.value = true;
  else firstLoading.value = true;
  error.value = '';
  try {
    const query = {
      projectUuid: store.projectUuid || undefined,
      dockSn: q.dockSn || undefined,
      beginAt: q.range?.[0] ? new Date(q.range[0]).toISOString() : undefined,
      endAt: q.range?.[1] ? new Date(q.range[1]).toISOString() : undefined,
      page: page.value,
      pageSize,
    };
    const r = await assetApi.tasks(query);
    if (!r.ok) {
      error.value = r.message || '加载失败';
      return;
    }
    rows.value = r.data.list || [];
    total.value = r.data.total || 0;
    totalImages.value = rows.value.reduce((s, x) => s + (x.imageCount || 0), 0);
  } catch (e) {
    error.value = e.message;
  } finally {
    firstLoading.value = false;
    refreshing.value = false;
  }
}

function onReset() {
  q.dockSn = '';
  q.range = null;
  q.reviewState = '';
  load(1);
}

function openTask(row) {
  if (!row.imageCount) {
    ElMessage.info('该架次暂无航拍成果（可能是 FlyToTask 定点飞行任务）');
    return;
  }
  router.push(`/review/task/${row.taskUuid}`);
}

async function removeTask(row) {
  try {
    await ElMessageBox.confirm(
      `确认删除架次「${row.name || row.taskUuid.slice(0, 8)}」及其 ${row.imageCount} 个影像文件？该操作不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  const r = await assetApi.removeTask(row.taskUuid);
  if (!r.ok) {
    ElMessage.error(r.message || '删除失败');
    return;
  }
  ElMessage.success(`已删除 ${r.data.removed} 个影像`);
  load();
}

onMounted(() => load(1));
</script>

<style scoped>
.page {
  padding: var(--sp-3);
}
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
.sub {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.tag {
  display: inline-block;
  padding: 1px 6px;
  margin-right: 4px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
}
.tag.visible {
  color: var(--c-info);
  background: rgba(59, 130, 246, 0.14);
}
.tag.infrared {
  color: var(--c-warn);
  background: rgba(255, 176, 32, 0.14);
}
.tag.ppk {
  color: var(--c-text-1);
  background: rgba(255, 255, 255, 0.06);
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
