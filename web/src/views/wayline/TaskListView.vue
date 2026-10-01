<template>
  <div style="display: flex; flex-direction: column; gap: 12px">
    <div class="card">
      <div class="card-head">
        <span>执行记录</span>
        <span class="sub">下发历史与任务状态（按机场查询，飞行器记录归到所属机场）</span>
      </div>
      <div class="card-body" style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
        <el-radio-group v-model="recordTab" size="small" @change="loadRecords">
          <el-radio-button value="unfinished">未完成</el-radio-button>
          <el-radio-button value="finished">已结束</el-radio-button>
          <el-radio-button value="all">全部</el-radio-button>
        </el-radio-group>
        <el-select
          v-model="recordSns"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          size="small"
          placeholder="按设备筛选（默认全部）"
          style="width: 260px"
          @change="loadRecords"
        >
          <el-option
            v-for="d in filterableDevices"
            :key="d.sn"
            :label="`${d.callsign || d.sn}${d.online ? '' : ' (离线)'}`"
            :value="d.sn"
          />
        </el-select>
        <el-button size="small" @click="selectOnlineDevices">全选在线</el-button>
        <el-select v-model="recordRange" size="small" style="width: 110px" @change="loadRecords">
          <el-option v-for="o in RANGE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <el-button size="small" :loading="recordLoading" @click="loadRecords">刷新</el-button>
        <div style="flex: 1"></div>
        <span class="small muted">共 {{ recordTotal }} 条</span>
      </div>
    </div>

    <div v-if="!recordGroups.length && !recordLoading" class="card">
      <div class="card-body muted small" style="padding: 24px">
        暂无执行记录{{ store.projectUuid ? '' : '，请先在顶部选择项目' }}
      </div>
    </div>

    <div v-for="g in recordGroups" :key="g.date" class="card">
      <div class="card-head">
        <span>{{ g.date }}</span>
        <span class="sub">{{ g.rows.length }} 条</span>
      </div>
      <div class="card-body" style="padding: 0">
        <el-table :data="g.rows" size="small" v-loading="recordLoading">
          <el-table-column label="计划 / 实际时间" min-width="180">
            <template #default="{ row }">
              <div class="small">{{ fmt(row.begin_at || row.begin_time) }}</div>
              <div class="small muted">实际 {{ fmt(row.run_at || row.completed_at || row.end_time) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="执行状态" width="110">
            <template #default="{ row }">
              <span :style="{ color: statusOf(row).color, fontWeight: 500 }">{{ statusOf(row).text }}</span>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="90">
            <template #default="{ row }">{{ taskType(row.task_type) }}</template>
          </el-table-column>
          <el-table-column prop="name" label="计划名称" min-width="150" show-overflow-tooltip />
          <el-table-column label="航线" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ waylineName(row.wayline_uuid) }}</template>
          </el-table-column>
          <el-table-column label="设备" width="120" show-overflow-tooltip>
            <template #default="{ row }">{{ deviceName(row.sn) }}</template>
          </el-table-column>
          <el-table-column label="航点进度" width="100">
            <template #default="{ row }">{{ waypointProgress(row) }}</template>
          </el-table-column>
          <el-table-column label="媒体上传" width="110">
            <template #default="{ row }"><span class="small">{{ mediaText(row) }}</span></template>
          </el-table-column>
          <el-table-column label="航拍照片" width="110">
            <template #default="{ row }">
              <el-button size="small" link :disabled="!isUploaded(row)" @click="openMedia(row)">
                {{ photoBtnText(row) }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="创建人" width="100" show-overflow-tooltip>
            <template #default="{ row }">{{ row.operations?.operator_account || '--' }}</template>
          </el-table-column>
          <el-table-column label="异常" width="80">
            <template #default="{ row }">
              <span v-if="row.exceptions?.message" class="small" style="color: var(--c-err)">
                {{ row.exceptions.code }}
              </span>
              <span v-else class="small muted">--</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 航拍照片墙 -->
    <el-drawer v-model="mediaVisible" :title="`航拍照片 · ${mediaTask?.name || ''}`" size="72%">
      <div class="small muted" style="margin-bottom: 10px">
        共 {{ mediaImages.length }} 张照片<template v-if="mediaList.length !== mediaImages.length">
          （另有 {{ mediaList.length - mediaImages.length }} 个非图片文件）
        </template>
        <template v-if="mediaImages.length"> · 点击图片查看原图</template>
      </div>

      <div v-if="mediaError" class="small" style="padding: 16px; background: var(--c-bg-2); border-radius: 8px; color: var(--c-err); margin-bottom: 10px">
        {{ mediaError }}
      </div>

      <div v-else-if="!mediaImages.length && !mediaLoading" class="muted small" style="padding: 24px">
        该任务没有已上传的照片{{ mediaTask ? `（媒体状态：${mediaText(mediaTask)}）` : '' }}
      </div>

      <div class="media-grid">
        <div v-for="m in visibleMedia" :key="m.uuid" class="media-cell" @click="viewOriginal(m)">
          <img :src="srcOf(m)" :alt="m.name" loading="lazy" />
          <div class="media-meta">
            <span class="media-name">{{ m.name }}</span>
            <span class="media-size">{{ sizeText(m.size) }}</span>
          </div>
        </div>
      </div>

      <div v-if="hasMoreMedia" style="text-align: center; margin: 16px 0">
        <el-button size="small" @click="loadMoreMedia">加载更多（还有 {{ mediaImages.length - mediaShown }} 张）</el-button>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '../../stores/session';
import { waylineApi, taskApi, errMsg } from '../../api/dji';
import { taskStatus, mediaUploadText, TASK_DONE_KEYS, taskType } from '../../utils/dict';

const store = useSessionStore();

const recordLoading = ref(false);
const recordTab = ref('unfinished');
const recordSns = ref([]);
const recordList = ref([]);
const recordTotal = ref(0);
const recordRange = ref(90);

const filterableDevices = computed(() => store.allDevices || []);
const statusOf = (row) => taskStatus(row.status);

const waylineNames = ref({});

async function loadWaylineNames() {
  const r = await waylineApi.list();
  if (!r?.ok) return;
  const map = {};
  for (const w of r.data?.list || []) map[w.id] = w.name;
  waylineNames.value = map;
}

function waylineName(uuid) {
  if (!uuid) return '--';
  return waylineNames.value[uuid] || `…${String(uuid).slice(-8)}`;
}

function deviceName(sn) {
  if (!sn) return '--';
  const d = filterableDevices.value.find((x) => x.sn === sn);
  return d ? d.callsign || d.sn : `…${String(sn).slice(-6)}`;
}

function waypointProgress(row) {
  const cur = row.current_waypoint_index;
  const total = row.total_waypoints;
  if (cur === undefined && total === undefined) return '--';
  return `${cur ?? '-'} / ${total ?? '-'}`;
}

/** 机场自动产生的 FlyTo 动作记录没有航拍照片，司空 2 媒体接口会返回 219021 */
function isUploaded(row) {
  if (String(row?.task_type || '') === 'others') return false;
  return String(row?.media_upload_status || '') === 'upload_finished';
}

function photoBtnText(row) {
  if (String(row?.task_type || '') === 'others') return '无照片';
  return isUploaded(row) ? '查看照片' : '未上传';
}

function mediaText(row) {
  if (row.media_upload_status) return mediaUploadText(row.media_upload_status);
  if (row.media_count !== undefined || row.media_uploaded_count !== undefined) {
    return `${row.media_uploaded_count ?? 0} / ${row.media_count ?? 0}`;
  }
  return '--';
}

function selectOnlineDevices() {
  recordSns.value = filterableDevices.value.filter((d) => d.online).map((d) => d.sn);
  loadRecords();
}

function matchTab(row) {
  if (recordTab.value === 'all') return true;
  const done = TASK_DONE_KEYS.includes(statusOf(row).key);
  return recordTab.value === 'finished' ? done : !done;
}

const recordGroups = computed(() => {
  const map = new Map();
  for (const row of recordList.value) {
    const ts = row.run_at || row.begin_at || row.completed_at || row.begin_time || row.end_time;
    const date = ts ? fmtDate(ts) : '未知时间';
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(row);
  }
  return [...map.entries()].map(([date, rows]) => ({ date, rows }));
});

function fmtDate(ts) {
  const d = toDate(ts);
  if (!d) return '未知时间';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

function fmt(ts) {
  const d = toDate(ts);
  if (!d) return '--';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 时间范围：飞行记录接口 begin_at / end_at 必填，不给默认窗口查不到数据 */
const RANGE_OPTIONS = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '近 1 年', value: 365 },
];

/**
 * 实测：该接口传飞行器 SN 返回 0 条，只有机场 SN 有数据。
 * 选了飞行器时要换成它所属机场的 SN，否则用户会以为「这台设备没飞过」。
 */
function querySns() {
  const picked = recordSns.value || [];
  if (!picked.length) return (store.airports || []).map((d) => d.sn).filter(Boolean);
  const out = new Set();
  for (const sn of picked) {
    const dev = filterableDevices.value.find((d) => d.sn === sn);
    if (dev?.deviceClass === 'drone' && dev.dockSn) out.add(dev.dockSn);
    else out.add(sn);
  }
  return [...out];
}

async function loadRecords() {
  const sns = querySns();
  if (!sns.length) {
    recordList.value = [];
    recordTotal.value = 0;
    return ElMessage.warning('当前项目没有可用机场');
  }
  const end = Math.floor(Date.now() / 1000);
  const begin = end - Number(recordRange.value) * 86400;

  recordLoading.value = true;
  // 接口一次只能查一个 sn，多个机场并发查再合并
  const rs = await Promise.all(sns.map((sn) => taskApi.list({ sn, begin_at: begin, end_at: end })));
  recordLoading.value = false;

  const failed = rs.find((r) => !r?.ok);
  if (failed) {
    recordList.value = [];
    recordTotal.value = 0;
    return ElMessage.error(errMsg(failed, '执行记录获取失败'));
  }

  const seen = new Set();
  const merged = [];
  for (const r of rs) {
    for (const row of r?.data?.list || []) {
      if (!row?.uuid || seen.has(row.uuid)) continue;
      seen.add(row.uuid);
      merged.push(row);
    }
  }
  merged.sort((a, b) => (toDate(b.run_at || b.begin_at)?.getTime() || 0) - (toDate(a.run_at || a.begin_at)?.getTime() || 0));
  recordTotal.value = merged.length;
  recordList.value = merged.filter(matchTab);
}

/* ---------- 航拍照片墙 ---------- */
const mediaVisible = ref(false);
const mediaLoading = ref(false);
const mediaTask = ref(null);
const mediaList = ref([]);
const mediaError = ref('');
const mediaShown = ref(0);
const MEDIA_PAGE = 24;

const mediaImages = computed(() => mediaList.value.filter((m) => m?.file_type === 'image'));
const visibleMedia = computed(() => mediaImages.value.slice(0, mediaShown.value));
const hasMoreMedia = computed(() => mediaShown.value < mediaImages.value.length);

const srcOf = (m, type = 'preview') => taskApi.mediaSrc(mediaTask.value?.uuid, m.uuid, type);

async function openMedia(row) {
  mediaTask.value = row;
  mediaList.value = [];
  mediaShown.value = 0;
  mediaError.value = '';
  mediaVisible.value = true;
  mediaLoading.value = true;
  const r = await taskApi.media(row.uuid);
  mediaLoading.value = false;
  if (!r?.ok) {
    // 219021 常见于机场自动产生的飞行动作记录，这类任务没有可读取的媒体
    mediaError.value =
      r?.code === 219021
        ? '司空 2 无法读取该任务媒体（多为机场自动产生的飞行动作记录，无航拍照片）。'
        : errMsg(r, '媒体资源获取失败');
    return;
  }
  mediaList.value = r.data?.list || [];
  mediaShown.value = MEDIA_PAGE;
}

function loadMoreMedia() {
  mediaShown.value += MEDIA_PAGE;
}

function viewOriginal(m) {
  window.open(srcOf(m, 'original'), '_blank');
}

function sizeText(n) {
  if (!n) return '--';
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

watch(() => store.projectUuid, () => {
  loadWaylineNames();
  loadRecords();
});
onMounted(() => {
  loadWaylineNames();
  loadRecords();
});
</script>

<style scoped>
.media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.media-cell { border: 1px solid var(--c-line); border-radius: 8px; overflow: hidden; background: var(--c-bg-2); cursor: pointer; }
.media-cell:hover { border-color: var(--c-brand); }
.media-cell img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; background: #000; }
.media-meta { padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.media-name { font-size: 12px; color: var(--c-text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.media-size { font-size: 11px; color: var(--c-text-3); }
.muted { color: var(--c-text-3); }
.small { font-size: 11px; }
</style>
