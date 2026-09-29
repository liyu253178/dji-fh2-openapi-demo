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
        <el-form-item label="机场" required>
          <el-select v-model="form.dockSn" placeholder="选择机场" style="width: 100%" :disabled="!form.projectUuid">
            <el-option
              v-for="d in docks"
              :key="d.sn || d.dockSn"
              :label="`${d.callsign || d.model || d.sn}（${d.sn || d.dockSn}）`"
              :value="d.sn || d.dockSn"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="时间范围" required>
          <el-date-picker
            v-model="form.range"
            type="daterange"
            range-separator="→"
            start-placeholder="开始"
            end-placeholder="结束"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="">
          <el-checkbox v-model="form.downloadImages">下载原图到本地（推荐，签名约 24 小时过期）</el-checkbox>
        </el-form-item>
      </el-form>
      <p class="hint">ⓘ 预计耗时与磁盘占用较大，建议按机场与时段分批同步。</p>
    </template>

    <!-- 同步中 -->
    <template v-else-if="stage === 'running'">
      <p class="stage-t">正在同步…请勿关闭窗口</p>
      <el-progress
        :percentage="progress"
        :stroke-width="6"
        :status="progress >= 100 ? 'success' : undefined"
      />
      <ul class="run-list">
        <li>已处理架次<strong>{{ st.processedTasks }}</strong> / {{ st.totalTasks }}</li>
        <li>已入库影像<strong>{{ st.downloaded }}</strong> 张</li>
        <li v-if="st.failed">失败<strong class="err">{{ st.failed }}</strong></li>
        <li v-if="st.currentTask" class="cur">当前：{{ st.currentTask }}</li>
      </ul>
    </template>

    <!-- 完成 -->
    <template v-else>
      <el-result icon="success" title="同步完成">
        <template #sub-title>
          <p>成功处理 <strong>{{ result.processedTasks }}</strong> 个架次，新入库 {{ result.downloaded }} 张</p>
          <p v-if="result.failed">失败 {{ result.failed }} 个，详见同步日志</p>
        </template>
      </el-result>
    </template>

    <template #footer>
      <template v-if="stage === 'config'">
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :disabled="!canStart" :loading="starting" @click="start">开始同步</el-button>
      </template>
      <el-button v-else-if="stage === 'running'" disabled>同步中…</el-button>
      <el-button v-else type="primary" @click="closeAll">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
/** 同步影像对话框：配置 / 同步中 / 完成 三态 */
import { ref, reactive, computed, watch, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { assetApi } from '../../api/duav';
import { useSessionStore } from '../../stores/session';

const visible = defineModel('visible', { default: false });
const emit = defineEmits(['done']);
const store = useSessionStore();

const stage = ref('config');
const starting = ref(false);
const projects = computed(() => store.projects || []);
const docks = computed(() => store.airports || []);
const st = ref({ processedTasks: 0, totalTasks: 0, downloaded: 0, failed: 0, currentTask: '' });
const result = ref({ processedTasks: 0, downloaded: 0, failed: 0 });

const form = reactive({
  projectUuid: '',
  dockSn: '',
  range: defaultRange(),
  downloadImages: true,
});

function defaultRange() {
  const end = new Date();
  const start = new Date(Date.now() - 30 * 86400000);
  const f = (d) => d.toISOString().slice(0, 10);
  return [f(start), f(end)];
}

const canStart = computed(() => form.projectUuid && form.dockSn && form.range?.length === 2);
const progress = computed(() => {
  const t = st.value.totalTasks || 0;
  if (!t) return 0;
  return Math.min(100, Math.round((st.value.processedTasks / t) * 100));
});

async function onProjectChange() {
  form.dockSn = '';
  if (!form.projectUuid) return;
  // 切项目后由store 统一拉设备（沿用存量逻辑，不重复实现）
  try {
    await store.selectProject(form.projectUuid);
  } catch {
    /* store 内部已处理错误 */
  }
}

let timer = null;
watch(visible, (v) => {
  if (v) {
    stage.value = 'config';
    form.projectUuid = form.projectUuid || store.projectUuid || '';
    if (form.projectUuid) onProjectChange();
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
  starting.value = true;
  const [b, e] = form.range;
  const beginAt = Math.floor(new Date(b).getTime() / 1000);
  const endAt = Math.floor(new Date(e).getTime() / 1000) + 86399;
  const r = await assetApi.sync({
    projectUuid: form.projectUuid,
    dockSn: form.dockSn,
    beginAt,
    endAt,
    downloadImages: form.downloadImages,
  });
  starting.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '同步请求失败');
    return;
  }
  stage.value = 'running';
  stopTimer();
  timer = setInterval(async () => {
    const s = await assetApi.syncStatus();
    if (s.ok && s.data) st.value = s.data;
    if (s.data && s.data.running === false) {
      stopTimer();
      result.value = {
        processedTasks: s.data.processedTasks || 0,
        downloaded: s.data.downloaded || 0,
        failed: s.data.failed || 0,
      };
      stage.value = 'done';
      emit('done');
    }
  }, 1500);
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
.stage-t {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  color: var(--c-text-0);
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
.run-list .cur {
  color: var(--c-text-2);
  font-size: var(--fs-xs);
}
</style>
