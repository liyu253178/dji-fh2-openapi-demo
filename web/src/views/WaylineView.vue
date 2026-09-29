<template>
  <div style="display: flex; flex-direction: column; gap: 14px">
    <!-- 上传区 -->
    <div class="card">
      <div class="card-head">
        <span>航线上传</span>
        <span class="sub">STS 凭证 → 司空 2 存储桶 → 上传完成通知</span>
      </div>
      <div class="card-body" style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap">
        <el-input v-model="uploadName" size="small" placeholder="航线别名（可选）" style="width: 220px" />
        <!-- KMZ 本质是 zip 压缩包，部分系统/浏览器会把下载的文件存成 .zip，
             若只收 .kmz 会导致「刚下载的文件选不中」，看起来像上传不了 -->
        <input ref="fileEl" type="file" accept=".kmz,.kml,.zip" style="display: none" @change="onFile" />
        <el-button size="small" type="primary" @click="fileEl?.click()">选择 .kmz 文件</el-button>
        <el-button size="small" type="success" :loading="uploading" :disabled="!file" @click="upload">
          上传到司空 2
        </el-button>
        <span v-if="file" class="small">{{ file.name }}（{{ (file.size / 1024).toFixed(1) }} KB）</span>
        <div style="flex: 1"></div>
        <el-button size="small" @click="load">刷新列表</el-button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="card" style="flex: 1">
      <div class="card-head">
        <span>项目航线列表</span>
        <div style="display: flex; gap: 8px; align-items: center">
          <span class="sub">共 {{ list.length }} 条 · 项目：{{ store.projectName || '未选择' }}</span>
          <el-button size="small" @click="openRecords">执行记录</el-button>
        </div>
      </div>
      <div class="card-body" style="padding: 0">
        <el-table :data="list" size="small" v-loading="loading" height="440">
          <el-table-column prop="name" label="航线名称" min-width="200" show-overflow-tooltip />
          <el-table-column label="类型" width="160">
            <template #default="{ row }">
              <span v-for="t in row.template_types || []" :key="t" class="tag info" style="margin-right: 4px">
                {{ typeName(t) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="更新时间" width="170">
            <template #default="{ row }">{{ fmt(row.update_time) }}</template>
          </el-table-column>
          <el-table-column prop="id" label="wayline_id" min-width="200" show-overflow-tooltip>
            <template #default="{ row }"><span class="mono small">{{ row.id }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="220" fixed="right">
            <template #default="{ row }">
              <el-button size="small" link @click="download(row)">下载</el-button>
              <el-button size="small" link type="primary" @click="openTaskDialog(row)">执行</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <div class="muted small" style="padding: 24px">
              暂无航线{{ store.projectUuid ? '' : '，请先在项目下拉中选择项目' }}
            </div>
          </template>
        </el-table>
      </div>
    </div>

    <!-- 执行任务弹窗 -->
    <el-dialog v-model="taskVisible" title="创建飞行任务" width="460px">
      <el-form label-width="100px" size="small">
        <el-form-item label="航线">{{ current?.name }}</el-form-item>
        <el-form-item label="任务名称">
          <el-input v-model="taskForm.name" placeholder="留空自动生成" />
        </el-form-item>
        <el-form-item label="执行机场">
          <el-select v-model="taskForm.sn" style="width: 100%">
            <el-option v-for="a in store.airports" :key="a.sn" :label="a.callsign || a.sn" :value="a.sn" />
          </el-select>
        </el-form-item>
        <el-form-item label="任务精度">
          <el-radio-group v-model="taskForm.wayline_precision_type">
            <el-radio value="rtk">RTK 高精度</el-radio>
            <el-radio value="gps">GNSS 普通</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="返航模式">
          <el-radio-group v-model="taskForm.rth_mode">
            <el-radio value="optimal">智能高度</el-radio>
            <el-radio value="preset">设定高度</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="taskForm.rth_mode === 'preset'" label="返航高度(m)">
          <el-input-number v-model="taskForm.rth_altitude" :min="20" :max="500" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="taskVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="creating" @click="createTask">创建并执行</el-button>
      </template>
    </el-dialog>

    <!-- 执行记录：任务状态 / 航点进度 / 媒体上传进度，按日期分组 -->
    <el-drawer v-model="recordVisible" title="执行记录" size="76%" @open="loadRecords">
      <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px">
        <el-radio-group v-model="recordTab" size="small" @change="loadRecords">
          <el-radio-button :value="'unfinished'">未完成</el-radio-button>
          <el-radio-button :value="'finished'">已结束</el-radio-button>
          <el-radio-button :value="'all'">全部</el-radio-button>
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

      <div v-if="!recordGroups.length && !recordLoading" class="muted small" style="padding: 24px">
        暂无执行记录{{ store.projectUuid ? '' : '，请先在顶部选择项目' }}
      </div>

      <div v-for="g in recordGroups" :key="g.date" style="margin-bottom: 16px">
        <div class="rec-date">{{ g.date }}<span class="muted small" style="margin-left: 8px">{{ g.rows.length }} 条</span></div>
        <el-table :data="g.rows" size="small" v-loading="recordLoading">
          <el-table-column label="计划 / 实际时间" min-width="180">
            <template #default="{ row }">
              <div class="small">{{ fmt(row.begin_at || row.begin_time) }}</div>
              <div class="small muted">实际 {{ fmt(row.run_at || row.completed_at || row.end_time) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="执行状态" width="110">
            <template #default="{ row }">
              <span :style="{ color: statusOf(row).color, fontWeight: 500 }">
                {{ statusOf(row).text }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="90">
            <template #default="{ row }">{{ taskType(row.task_type) }}</template>
          </el-table-column>
          <el-table-column prop="name" label="计划名称" min-width="160" show-overflow-tooltip />
          <el-table-column label="航线" min-width="150" show-overflow-tooltip>
            <template #default="{ row }">{{ waylineName(row.wayline_uuid) }}</template>
          </el-table-column>
          <el-table-column label="设备" width="130" show-overflow-tooltip>
            <template #default="{ row }">{{ deviceName(row.sn) }}</template>
          </el-table-column>
          <el-table-column label="航点进度" width="100">
            <template #default="{ row }">{{ waypointProgress(row) }}</template>
          </el-table-column>
          <el-table-column label="媒体上传" width="120">
            <template #default="{ row }">
              <span class="small">{{ mediaText(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="航拍照片" width="120">
            <template #default="{ row }">
              <el-button
                size="small"
                link
                :disabled="!isUploaded(row)"
                @click="openMedia(row)"
              >
                {{ photoBtnText(row) }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="创建人" width="110" show-overflow-tooltip>
            <template #default="{ row }">{{ row.operations?.operator_account || '--' }}</template>
          </el-table-column>
          <el-table-column label="异常" width="90">
            <template #default="{ row }">
              <span v-if="row.exceptions?.message" class="small" style="color: var(--c-err)">
                {{ row.exceptions.code }}
              </span>
              <span v-else class="small muted">--</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-drawer>

    <!-- 航拍照片墙：点执行记录里的「查看照片」打开 -->
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
        <el-button size="small" @click="loadMoreMedia">
          加载更多（还有 {{ mediaImages.length - mediaShown }} 张）
        </el-button>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '../stores/session';
import { waylineApi, taskApi, errMsg } from '../api/dji';
import { taskName } from '../utils/format';
import { taskStatus, mediaUploadText, TASK_DONE_KEYS } from '../utils/dict';

const store = useSessionStore();
const list = ref([]);
const loading = ref(false);
const uploading = ref(false);
const file = ref(null);
const fileEl = ref(null);
const uploadName = ref('');

const taskVisible = ref(false);
const creating = ref(false);
const current = ref(null);
const taskForm = ref({
  name: '',
  sn: '',
  wayline_precision_type: 'rtk',
  rth_mode: 'optimal',
  rth_altitude: 100,
});

const typeName = (t) =>
  ({
    waypoint: '航点航线',
    mapping_2d: '正射采集',
    maping_2d: '正射采集',
    mapping_3d: '倾斜摄影',
    mapping_strip: '带状航线',
    facade: '斜面航线',
    solid: '几何体航线',
    mapping_gobject: '贴近摄影',
  }[t] || t);

function fmt(ts) {
  return formatTime(ts);
}

async function load() {
  loading.value = true;
  const r = await waylineApi.list();
  loading.value = false;
  if (r?.ok) list.value = r.data?.list || [];
  else ElMessage.error(errMsg(r, '航线列表获取失败'));
}

function onFile(e) {
  const f = e.target.files?.[0] || null;
  if (f && !/\.(kmz|kml|zip)$/i.test(f.name)) {
    file.value = null;
    e.target.value = '';
    ElMessage.warning(`不支持的文件类型「${f.name}」，请选择 .kmz / .kml 航线文件`);
    return;
  }
  file.value = f;
}

async function upload() {
  if (!file.value) return ElMessage.warning('请先选择文件');
  if (!store.projectUuid) return ElMessage.warning('请先选择项目');
  uploading.value = true;
  const r = await waylineApi.upload(file.value, uploadName.value);
  uploading.value = false;
  if (r?.ok) {
    ElMessage.success(`上传成功：${r.data?.name}`);
    file.value = null;
    uploadName.value = '';
    load();
  } else {
    // 上传链路有三段（STS → 存储桶 → 通知司空 2），失败时要说清卡在哪一段
    ElMessage.error(errMsg(r, '上传失败'));
  }
}

async function download(row) {
  const r = await waylineApi.detail(row.id);
  if (!r?.ok || !r.data?.download_url) {
    ElMessage.error(errMsg(r, '获取下载链接失败'));
    return;
  }
  // 走后端代理下载：浏览器真正触发下载框，且能拿到正确文件名，避免 window.open 被拦截 / 跨域 download 失效
  const filename = `${r.data?.name || row.name || row.id}.kmz`;
  const link = document.createElement('a');
  link.href = `/api/wayline/${encodeURIComponent(row.id)}/download`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function openTaskDialog(row) {
  if (!store.airports.length) return ElMessage.warning('当前项目没有可用机场');
  current.value = row;
  taskForm.value.sn = store.airports[0].sn;
  taskForm.value.name = '';
  taskVisible.value = true;
}

async function createTask() {
  creating.value = true;
  const r = await taskApi.create({
    name: taskForm.value.name || taskName(`${current.value.name}`),
    wayline_uuid: current.value.id,
    sn: taskForm.value.sn,
    task_type: 'immediate',
    rth_mode: taskForm.value.rth_mode,
    rth_altitude: Number(taskForm.value.rth_altitude) || 100,
    wayline_precision_type: taskForm.value.wayline_precision_type,
  });
  creating.value = false;
  if (r?.ok) {
    ElMessage.success('任务已创建，可在任务管理查看');
    taskVisible.value = false;
  } else ElMessage.error(errMsg(r, '任务创建失败'));
}

watch(() => store.projectUuid, () => load());
onMounted(load);

/* ---------- 执行记录 ---------- */
const recordVisible = ref(false);
const recordLoading = ref(false);
const recordTab = ref('unfinished');
const recordSns = ref([]);
const recordList = ref([]);
const recordTotal = ref(0);

/** 可筛选设备（机型合并 + 去重） */
const filterableDevices = computed(() => store.allDevices || []);

const statusOf = (row) => taskStatus(row.status);

/** 航线名：列表接口只给 wayline_uuid，用已加载的航线库反查 */
function waylineName(uuid) {
  if (!uuid) return '--';
  return list.value.find((w) => w.id === uuid)?.name || `…${String(uuid).slice(-8)}`;
}

function deviceName(sn) {
  if (!sn) return '--';
  const d = filterableDevices.value.find((x) => x.sn === sn);
  return d ? d.callsign || d.sn : `…${String(sn).slice(-6)}`;
}

/** 航点进度 current_waypoint_index / total_waypoints */
function waypointProgress(row) {
  const cur = row.current_waypoint_index;
  const total = row.total_waypoints;
  if (cur === undefined && total === undefined) return '--';
  return `${cur ?? '-'} / ${total ?? '-'}`;
}

/** 媒体是否已上传完：未上传的任务点了也拿不到照片，按钮直接置灰。
 * 机场自动产生的 FlyTo 动作记录（task_type === 'others'）没有航拍照片，
 * 司空 2 的媒体接口会返回 219021，直接把按钮禁掉避免误导。 */
function isUploaded(row) {
  if (String(row?.task_type || '') === 'others') return false;
  return String(row?.media_upload_status || '') === 'upload_finished';
}

function photoBtnText(row) {
  if (String(row?.task_type || '') === 'others') return '无照片';
  return isUploaded(row) ? '查看照片' : '未上传';
}

/** 媒体上传：优先 media_upload_status，其次用已上传数 / 总数（接口存在时） */
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

/** 按状态归类分组：未完成 / 已结束 / 全部 */
function matchTab(row) {
  if (recordTab.value === 'all') return true;
  const done = TASK_DONE_KEYS.includes(statusOf(row).key);
  return recordTab.value === 'finished' ? done : !done;
}

/** 按日期分组（兼容 run_at / begin_at / completed_at / begin_time） */
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
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function openRecords() {
  recordVisible.value = true;
}

/** 时间范围选项：飞行记录接口 begin_at / end_at 是必填，不给默认窗口会查不到任何数据 */
const RANGE_OPTIONS = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
  { label: '近 1 年', value: 365 },
];
const recordRange = ref(90);

/**
 * 查询用的 SN 列表
 *
 * 实测：这个接口传**飞行器 SN 返回 0 条**，只有机场 SN 才有数据。
 * 所以选了飞行器时要换成它所属机场的 SN，否则用户会以为"这台设备没飞过"。
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

/* ---------- 航拍照片墙 ---------- */
const mediaVisible = ref(false);
const mediaLoading = ref(false);
const mediaTask = ref(null);
const mediaList = ref([]);
const mediaError = ref('');
/** 懒加载：当前已渲染到第几张（媒体多的任务一次全渲染会卡死） */
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
    // 219021 是司空 2 内部异常，常见于机场自动产生的飞行动作记录，
    // 这类任务 media_upload_status 也可能显示 upload_finished，但实际没有可读取的媒体。
    if (r?.code === 219021) {
      mediaError.value = '司空 2 无法读取该任务媒体（多为机场自动产生的飞行动作记录，无航拍照片）。';
    } else {
      mediaError.value = errMsg(r, '媒体资源获取失败');
    }
    return;
  }
  mediaList.value = r.data?.list || [];
  mediaShown.value = MEDIA_PAGE;
}

function loadMoreMedia() {
  mediaShown.value += MEDIA_PAGE;
}

/** 原图可能几 MB，单独开窗口看，不占用照片墙 */
function viewOriginal(m) {
  window.open(srcOf(m, 'original'), '_blank');
}

function sizeText(n) {
  if (!n) return '--';
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
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
</script>

<style scoped>
/* 执行记录按日期分组的小标题 */
.rec-date {
  font-size: 12px; font-weight: 500; color: var(--c-text-1);
  padding: 4px 0 8px; border-bottom: 1px dashed var(--c-line-soft); margin-bottom: 8px;
}

/* 航拍照片墙：固定网格 + 缩略图懒加载，媒体多的任务分批渲染 */
.media-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}
.media-cell {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--c-bg-2);
  cursor: pointer;
}
.media-cell:hover { border-color: var(--c-brand); }
.media-cell img {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  display: block;
  background: #000;
}
.media-meta {
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.media-name {
  font-size: 12px;
  color: var(--c-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.media-size { font-size: 11px; color: var(--c-text-3); }
</style>
