<template>
  <div style="display: flex; flex-direction: column; gap: 14px">
    <!-- 机型可飞性统计：这一栏回答「库里这么多航线，哪些真能飞」 -->
    <div class="card">
      <div class="card-head">
        <span>机队匹配概览</span>
        <span class="sub">司空 2 不做机型校验，这里是我们自己卡的</span>
      </div>
      <div class="card-body">
        <div class="stat-row">
          <div class="stat"><b>{{ stats.total }}</b><span>航线总数</span></div>
          <div class="stat ok"><b>{{ stats.ok }}</b><span>本队可飞</span></div>
          <div class="stat warn"><b>{{ stats.sibling }}</b><span>同系列不同子型号</span></div>
          <div class="stat bad"><b>{{ stats.no }}</b><span>机型不在本队</span></div>
          <div style="flex: 1"></div>
          <el-checkbox v-model="onlyFlyable" size="small">只看可飞</el-checkbox>
          <el-button size="small" @click="$router.push('/wayline/tasks')">执行记录</el-button>
          <el-button size="small" @click="load">刷新</el-button>
        </div>
        <div class="fleet-tip">
          本机队机型：<span v-for="m in fleet" :key="m.key" class="mono">{{ m.name }}（{{ m.key }}）</span>
          <span v-if="!fleet.length" class="muted">未获取到机队机型</span>
        </div>
      </div>
    </div>

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
      </div>
    </div>

    <!-- 列表 -->
    <div class="card" style="flex: 1">
      <div class="card-head">
        <span>项目航线列表</span>
        <span class="sub">共 {{ rows.length }} 条 · 项目：{{ store.projectName || '未选择' }}</span>
      </div>
      <div class="card-body" style="padding: 0">
        <el-table :data="rows" size="small" v-loading="loading" height="440">
          <el-table-column prop="name" label="航线名称" min-width="180" show-overflow-tooltip />
          <el-table-column label="机型" width="150">
            <template #default="{ row }">
              <span v-if="row.aircraftName" class="small">{{ row.aircraftName }}</span>
              <span v-else class="mono small muted">{{ row.device_model_key || '--' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="可飞性" width="150">
            <template #default="{ row }">
              <span :class="['fly', row.flyable]">
                <span class="dot"></span>{{ flyText(row) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="150">
            <template #default="{ row }">
              <span v-for="t in row.template_types || []" :key="t" class="tag info" style="margin-right: 4px">
                {{ typeName(t) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="更新时间" width="160">
            <template #default="{ row }">{{ fmt(row.update_time) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button size="small" link @click="download(row)">下载</el-button>
              <el-button
                size="small"
                link
                type="primary"
                :disabled="row.flyable !== 'ok'"
                :title="row.flyable === 'ok' ? '' : row.flyableText"
                @click="openTaskDialog(row)"
              >
                执行
              </el-button>
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
        <el-form-item label="机型">
          <span class="small">{{ current?.aircraftName || current?.device_model_key }}</span>
        </el-form-item>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '../stores/session';
import { waylineApi, taskApi, errMsg } from '../api/dji';
import { taskName } from '../utils/format';

const router = useRouter();
const store = useSessionStore();
const list = ref([]);
const fleet = ref([]);
const stats = ref({ total: 0, ok: 0, sibling: 0, no: 0 });
const loading = ref(false);
const uploading = ref(false);
const file = ref(null);
const fileEl = ref(null);
const uploadName = ref('');
const onlyFlyable = ref(false);

const rows = computed(() => (onlyFlyable.value ? list.value.filter((r) => r.flyable === 'ok') : list.value));

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

const FLY_TEXT = { ok: '可飞', sibling: '待确认', no: '不可飞', unknown: '机型未知' };
const flyText = (row) => FLY_TEXT[row.flyable] || '机型未知';

async function load() {
  loading.value = true;
  const r = await waylineApi.libraryMatch();
  loading.value = false;
  if (r?.ok) {
    list.value = r.data?.list || [];
    fleet.value = r.data?.fleet || [];
    stats.value = r.data?.stats || { total: 0, ok: 0, sibling: 0, no: 0 };
  } else ElMessage.error(errMsg(r, '航线列表获取失败'));
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
  // 走后端代理下载：浏览器真正触发下载框，且能拿到正确文件名
  const filename = `${r.data?.name || row.name || row.id}.kmz`;
  const link = document.createElement('a');
  link.href = `/api/wayline/${encodeURIComponent(row.id)}/download`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function openTaskDialog(row) {
  if (!store.airports.length) return ElMessage.warning('当前项目没有可用机场');
  // 闸 3：下发前再校验一次机型。司空 2 自己不校验，所以必须在这里拦。
  const chk = await waylineApi.dispatchCheck(row.device_model_key, row.id);
  if (!chk?.ok) {
    ElMessage.error(chk?.message || '机型校验未通过，禁止下发');
    return;
  }
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
    ElMessage.success('任务已创建，可在执行记录查看');
    taskVisible.value = false;
    router.push('/wayline/tasks');
  } else ElMessage.error(errMsg(r, '任务创建失败'));
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

function fmt(ts) {
  const d = toDate(ts);
  if (!d) return '--';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

watch(() => store.projectUuid, () => load());
onMounted(load);
</script>

<style scoped>
.stat-row { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.stat { display: flex; flex-direction: column; }
.stat b { font-size: 20px; color: var(--c-text-1); line-height: 1.2; }
.stat span { font-size: 11px; color: var(--c-text-3); }
.stat.ok b { color: var(--c-ok); }
.stat.warn b { color: var(--c-warn); }
.stat.bad b { color: var(--c-err); }
.fleet-tip { font-size: 11px; color: var(--c-text-3); margin-top: 10px; line-height: 1.6; }
.fleet-tip .mono { margin-right: 10px; }

.fly { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
.fly .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-text-3); }
.fly.ok { color: var(--c-ok); }
.fly.ok .dot { background: var(--c-ok); }
.fly.sibling { color: var(--c-warn); }
.fly.sibling .dot { background: var(--c-warn); }
.fly.no { color: var(--c-err); }
.fly.no .dot { background: var(--c-err); }
.fly.unknown { color: var(--c-text-3); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: var(--c-text-3); }
.small { font-size: 11px; }
</style>
