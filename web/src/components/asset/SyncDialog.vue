<template>
  <el-dialog v-model="visible" title="同步影像" width="520px" :close-on-click-modal="false">
    <!-- 配置态 -->
    <template v-if="stage === 'config'">
      <el-form label-width="88px" label-position="left">
        <el-form-item label="项目" required>
          <el-select v-model="form.projectUuid" placeholder="选择项目" style="width: 100%" @change="onProjectChange">
            <el-option v-for="p in projects" :key="p.uuid" :label="p.name" :value="p.uuid" />
          </el-select>
        </el-form-item>
        <!--
          机场改为「非必选 + 多选」。
          ① 不必选：留空 = 同步该项目全部机场（在线机场 ∪ 历史同步过的机场），
             后端拉不到在线设备时也能靠历史记录推断，不会因为设备离线就卡住；
          ② 数据源不再是「当前在线机场」，在线设备可能与历史拍摄时的归属不一致，
             所以并入该项目历史同步出过的机场。
        -->
        <el-form-item label="机场">
          <el-select
            v-model="form.dockSns"
            multiple
            clearable
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="2"
            placeholder="不选 = 全部机场"
            style="width: 100%"
            :disabled="!form.projectUuid"
            :loading="dockLoading"
          >
            <el-option-group v-if="onlineDocks.length" label="当前在线">
              <el-option
                v-for="d in onlineDocks"
                :key="d.sn"
                :label="`${d.callsign || d.model || d.sn}（${d.sn}）`"
                :value="d.sn"
              />
            </el-option-group>
            <el-option-group v-if="historyDocks.length" label="历史同步过（可能已离线）">
              <el-option
                v-for="d in historyDocks"
                :key="d.sn"
                :label="`${d.callsign || d.sn}（${d.sn}）`"
                :value="d.sn"
              />
            </el-option-group>
            <template #empty>
              <p class="sel-empty">
                {{
                  dockLoading
                    ? '正在获取机场…'
                    : '该项目下暂无可用机场。留空仍可同步 —— 未选机场时会按本项目历史记录自动推断。'
                }}
              </p>
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="时间范围" required>
          <el-date-picker
            v-model="form.range"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="→"
            start-placeholder="开始"
            end-placeholder="结束"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="">
          <el-checkbox v-model="form.downloadImages">下载原图到本地（推荐，签名约 24 小时过期）</el-checkbox>
        </el-form-item>
        <el-form-item label="">
          <el-checkbox v-model="form.skipEmptyTasks" class="skip-cb">
            自动剔除无图片的航线
            <span class="sub">FlyToTask 定点飞行、仅 PPK 辅助下载等没有成果影像的航线不再入库</span>
          </el-checkbox>
        </el-form-item>
      </el-form>
      <p class="hint">ⓘ 预计耗时与磁盘占用较大，建议按机场与时段分批同步。</p>
      <div class="prune">
        <span class="prune-t">历史同步入库的空壳航线（无任何影像）可一键清理：</span>
        <el-button size="small" text type="primary" :loading="pruning" @click="prune">清理无影像架次</el-button>
      </div>
    </template>

    <!-- 同步中（含暂停态） -->
    <template v-else-if="stage === 'running'">
      <p class="stage-t">
        <template v-if="st.paused">已暂停 —— 当前这张影像下完就停，可继续或终止</template>
        <template v-else>正在同步…请勿关闭窗口</template>
      </p>
      <el-progress
        :percentage="progress"
        :stroke-width="6"
        :status="st.paused ? 'warning' : progress >= 100 ? 'success' : undefined"
      />
      <ul class="run-list">
        <li>已处理架次<strong>{{ st.processedTasks }}</strong> / {{ st.totalTasks }}</li>
        <li>已入库影像<strong>{{ st.downloaded }}</strong> 张</li>
        <li v-if="st.emptyTasks">剔除无影像航线<strong class="dim">{{ st.emptyTasks }}</strong></li>
        <li v-if="st.failed">失败<strong class="err">{{ st.failed }}</strong></li>
        <li v-if="st.currentTask" class="cur">当前：{{ st.currentTask }}</li>
      </ul>
      <p class="pause-hint">已入库的影像会保留，下次同步自动跳过，不会重复下载。</p>
    </template>

    <!-- 完成 -->
    <template v-else>
      <el-result :icon="result.stopped ? 'warning' : 'success'" :title="result.stopped ? '同步已终止' : '同步完成'">
        <template #sub-title>
          <p v-if="result.stopped" class="dim">未处理的架次留给下次，已入库的不会重复下载</p>
          <p>成功处理 <strong>{{ result.processedTasks }}</strong> 个架次，新入库 {{ result.downloaded }} 张</p>
          <p v-if="result.emptyTasks">自动剔除无影像航线 <strong>{{ result.emptyTasks }}</strong> 条</p>
          <p v-if="result.failed">失败 {{ result.failed }} 个，详见同步日志</p>
        </template>
      </el-result>
    </template>

    <template #footer>
      <template v-if="stage === 'config'">
        <el-button @click="visible = false">取消</el-button>
        <!-- disabled 的按钮不派发鼠标事件，外层包一层 span 才能弹出提示 -->
        <el-tooltip :content="`还需选择：${missing.join('、')}`" :disabled="!missing.length" placement="top">
          <span class="btn-wrap">
            <el-button type="primary" :disabled="!canStart" :loading="starting" @click="start">开始同步</el-button>
          </span>
        </el-tooltip>
      </template>
      <!--
        运行态控制：暂停 / 继续 / 终止。
        暂停只是把循环挂在安全点（当前影像下完），已入库的保留，下次同步自动跳过。
      -->
      <template v-else-if="stage === 'running'">
        <el-button v-if="!st.paused" :loading="ctrlBusy" @click="control('pause')">暂停</el-button>
        <el-button v-else type="primary" :loading="ctrlBusy" @click="control('resume')">继续</el-button>
        <el-button type="danger" plain :loading="ctrlBusy" @click="control('stop')">终止</el-button>
      </template>
      <el-button v-else type="primary" @click="closeAll">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
/** 同步影像对话框：配置 / 同步中 / 完成 三态 */
import { ref, reactive, computed, watch, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { assetApi } from '../../api/duav';
import { localDay, dayBounds } from '../../utils/format';
import { useSessionStore } from '../../stores/session';

const visible = defineModel('visible', { default: false });
const emit = defineEmits(['done']);
const store = useSessionStore();

const stage = ref('config');
const starting = ref(false);
/** 机场列表加载中：切项目后要重新拉设备树 + 物模型，慢的时候有好几秒 */
const dockLoading = ref(false);
const projects = computed(() => store.projects || []);
/** 当前在线机场（设备树） */
const onlineDocks = computed(() =>
  (store.airports || []).map((d) => ({
    sn: d.sn || d.dockSn,
    callsign: d.callsign || '',
    model: d.model || '',
  })).filter((d) => !!d.sn)
);
/** 该项目历史同步出过架次的机场（可能已离线/已移出本项目，但历史数据还在） */
const rawHistory = ref([]);
const historyDocks = computed(() => {
  const known = new Set(onlineDocks.value.map((d) => d.sn));
  return rawHistory.value.filter((d) => !known.has(d.dockSn)).map((d) => ({
    sn: d.dockSn,
    callsign: d.callsign || '',
    tasks: d.tasks,
  }));
});
const st = ref({ processedTasks: 0, totalTasks: 0, downloaded: 0, failed: 0, emptyTasks: 0, currentTask: '', paused: false });
const result = ref({ processedTasks: 0, downloaded: 0, failed: 0, emptyTasks: 0, stopped: false });

const form = reactive({
  projectUuid: '',
  dockSns: [],
  range: defaultRange(),
  downloadImages: true,
  skipEmptyTasks: true,
});

function defaultRange() {
  const end = new Date();
  const start = new Date(Date.now() - 30 * 86400000);
  return [localDay(start), localDay(end)];
}

/** 机场不再是必选：留空即「全部机场」 */
const canStart = computed(() => !!form.projectUuid && form.range?.length === 2);

/** 还差哪几项才能开始：禁用按钮上挂 tooltip 用 */
const missing = computed(() => {
  const m = [];
  if (!form.projectUuid) m.push('项目');
  if (form.range?.length !== 2) m.push('时间范围');
  return m;
});
const progress = computed(() => {
  const t = st.value.totalTasks || 0;
  if (!t) return 0;
  return Math.min(100, Math.round((st.value.processedTasks / t) * 100));
});

/**
 * 载入机场候选：在线设备 + 历史同步过的机场
 *
 * ⚠️ 实测缺陷：历史方案只取「当前在线设备」，项目里曾经同步过数据、
 *    但机场现已离线或已被移出本项目的场景下拉直接为空，且机场还是必选，用户被完全卡死。
 */
async function loadDocks() {
  if (!form.projectUuid) {
    rawHistory.value = [];
    return;
  }
  const r = await assetApi.knownDocks(form.projectUuid);
  rawHistory.value = r.ok ? (r.data?.list || []) : [];
}

async function onProjectChange() {
  form.dockSns = [];
  if (!form.projectUuid) return;
  loadDocks();
  // 项目没变且设备已缓存时直接复用现有列表。
  // 之前这里无条件调 selectProject：它会先把 airports 清空再重拉（含 4 个物模型请求，
  // 实测被浏览器同源连接数卡住要 3~5 秒），于是每次打开弹窗，机场下拉都会真·空上几秒。
  if (form.projectUuid === store.projectUuid && store.airports.length) return;
  dockLoading.value = true;
  try {
    // 切项目后由 store 统一拉设备（沿用存量逻辑，不重复实现）
    await store.selectProject(form.projectUuid);
  } catch {
    /* store 内部已处理错误 */
  } finally {
    dockLoading.value = false;
  }
}

/** 暂停 / 继续 / 终止。暂停后 running 仍为 true，弹窗停在 running 态 */
const ctrlBusy = ref(false);
const CTRL = {
  pause: { fn: () => assetApi.pauseSync(), ok: '已暂停，可在当前影像下完后继续' },
  resume: { fn: () => assetApi.resumeSync(), ok: '已继续' },
  stop: { fn: () => assetApi.stopSync(), ok: '已终止，已入库的影像保留' },
};
async function control(action) {
  if (ctrlBusy.value) return;
  ctrlBusy.value = true;
  try {
    const r = await CTRL[action].fn();
    if (!r.ok) {
      ElMessage.warning(r.message || '操作失败');
      return;
    }
    if (r.data) st.value = { ...st.value, ...r.data };
    ElMessage.success(CTRL[action].ok);
    // 终止后直接跳到完成态，让用户看到这轮跑了多少
    if (action === 'stop') {
      stopTimer(); // 先停轮询，否则它下一拍就会把「已终止」覆盖成「同步完成」
      result.value = {
        processedTasks: st.value.processedTasks,
        downloaded: st.value.downloaded,
        failed: st.value.failed,
        emptyTasks: st.value.emptyTasks,
        stopped: true,
      };
      stage.value = 'done';
    }
  } finally {
    ctrlBusy.value = false;
  }
}

/** 清理存量「无任何影像」的空壳架次（同步选项只管新数据，历史脏数据靠这里） */
const pruning = ref(false);
async function prune() {
  if (!form.projectUuid) {
    ElMessage.warning('请先选择项目');
    return;
  }
  pruning.value = true;
  const r = await assetApi.pruneEmptyTasks(form.projectUuid);
  pruning.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '清理失败');
    return;
  }
  const n = r.data?.removed ?? 0;
  if (n > 0) {
    ElMessage.success(`已清理 ${n} 条无影像架次`);
    emit('done');
  } else {
    ElMessage.info('没有需要清理的空壳架次');
  }
}

let timer = null;

/** 轮询同步状态：跑到结束为止 */
function pollStatus() {
  stopTimer();
  timer = setInterval(async () => {
    // 已经进完成态（含用户点「终止」主动结束）就不要再覆盖结果，
    // 否则轮询会把「已终止」冲成「同步完成」
    if (stage.value === 'done') {
      stopTimer();
      return;
    }
    const s = await assetApi.syncStatus();
    if (s.ok && s.data) st.value = s.data;
    if (s.data && s.data.running === false) {
      stopTimer();
      result.value = {
        processedTasks: s.data.processedTasks || 0,
        downloaded: s.data.downloaded || 0,
        failed: s.data.failed || 0,
        emptyTasks: s.data.emptyTasks || 0,
      };
      stage.value = 'done';
      emit('done');
    }
  }, 1500);
}

watch(visible, async (v) => {
  if (v) {
    stage.value = 'config';
    form.projectUuid = form.projectUuid || store.projectUuid || '';
    if (form.projectUuid) onProjectChange();
    /**
     * ⚠️ 加了「暂停/终止」之后暴露的缺口：同步在后台跑着（或被暂停了）时
     *    重新打开弹窗，会直接回到配置态 —— 用户既看不到进度也按不到暂停。
     *    打开时先探一次状态，运行中就直接进运行态接着轮询。
     */
    const s = await assetApi.syncStatus().catch(() => null);
    if (s?.ok && s.data?.running) {
      st.value = s.data;
      stage.value = 'running';
      pollStatus();
    }
  } else {
    stopTimer();
  }
});
onUnmounted(stopTimer);

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function start() {
  if (!canStart.value) return;
  // 本地日边界 → 秒级时间戳；传字符串会被按 UTC 解析，整体偏移 8 小时
  const bound = dayBounds(form.range, 'sec');
  if (!bound) return;
  starting.value = true;
  const r = await assetApi.sync({
    projectUuid: form.projectUuid,
    dockSns: form.dockSns,
    beginAt: bound.beginAt,
    endAt: bound.endAt,
    downloadImages: form.downloadImages,
    skipEmptyTasks: form.skipEmptyTasks,
  });
  starting.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '同步请求失败');
    return;
  }
  stage.value = 'running';
  pollStatus();
}

function closeAll() {
  visible.value = false;
}
</script>

<style scoped>
.hint {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-2);
  line-height: 1.7;
}
.btn-wrap {
  display: inline-block;
}
.sel-empty {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-sm);
  color: var(--c-text-2);
  line-height: 1.6;
}
.stage-t {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  color: var(--c-text-0);
}
.pause-hint {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  line-height: 1.6;
}
.run-list {
  list-style: none;
  margin: var(--sp-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--fs-sm);
  color: var(--c-text-1);
}
.run-list strong {
  color: var(--c-text-0);
  font-weight: 600;
  margin: 0 2px;
}
.run-list .err {
  color: var(--c-err);
}
.run-list .dim {
  color: var(--c-text-2);
}
/* 「自动剔除」的说明文字较长：EP 的 .el-checkbox 默认 nowrap，会横向溢出对话框 */
.skip-cb {
  white-space: normal;
  align-items: flex-start;
  height: auto;
}
.skip-cb :deep(.el-checkbox__label) {
  line-height: 1.55;
}
.sub {
  display: block;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  line-height: 1.55;
}
.prune {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--c-line);
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-wrap: wrap;
}
.prune-t {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.run-list .cur {
  color: var(--c-text-2);
  font-size: var(--fs-xs);
}
</style>
