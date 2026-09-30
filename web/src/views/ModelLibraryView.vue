<template>
  <div class="card" style="height: 100%; display: flex; flex-direction: column">
    <div class="card-head">
      <span>模型库</span>
      <span class="sub">跨项目 · 共 {{ list.length }} 个模型<template v-if="failedCount"> · {{ failedCount }} 个项目拉取失败</template></span>
      <div style="flex: 1"></div>
      <el-button size="small" :loading="loading" @click="load(true)">刷新</el-button>
    </div>
    <div class="card-body" style="flex: 1; padding: 0; overflow: auto">
      <el-table :data="list" size="small" v-loading="loading">
        <el-table-column prop="name" label="模型名称" min-width="180" show-overflow-tooltip />
        <el-table-column label="所属项目" width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.projectName || '—' }}</template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            <span class="tag" :class="row.file_type === 'model_3d' ? 'info' : 'ok'">
              {{ row.file_type === 'model_3d' ? '3D 模型' : '2D 模型' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="120">
          <template #default="{ row }">{{ sizeText(row.size) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ fmt(row.update_at) }}</template>
        </el-table-column>
        <el-table-column label="地图展示" width="100">
          <template #default="{ row }">
            <span class="small" :style="{ color: row.show_on_map ? 'var(--c-ok)' : 'var(--c-text-2)' }">
              {{ row.show_on_map ? '已展示' : '未展示' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="源文件" width="110">
          <template #default="{ row }">
            <span v-if="!checkState[row.id]" class="small muted">未检测</span>
            <span v-else-if="checkState[row.id].state === 'checking'" class="small muted">检测中…</span>
            <span v-else-if="checkState[row.id].state === 'bad'" class="tag err" :title="checkState[row.id].message">不可用</span>
            <span v-else-if="checkState[row.id].state === 'over'" class="tag warn" title="超过浏览器预览上限（300MB），只能下载后查看">过大</span>
            <span v-else class="tag ok">可用</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              link
              type="primary"
              :disabled="checkState[row.id]?.state === 'bad'"
              @click="openViewer(row)"
            >
              三维预览
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="muted small" style="padding: 24px">
            组织内暂无模型——可在司空 2 中建模（或把模型加入任一项目）后点「刷新」
          </div>
        </template>
      </el-table>
    </div>

    <el-drawer v-model="viewerVisible" :title="`模型预览 · ${current?.name || ''}`" size="62%">
      <div style="display: flex; flex-direction: column; gap: 12px">
        <!-- 源文件不可用：直接说清原因，别让用户对着空白窗口猜 -->
        <el-alert
          v-if="curCheck?.state === 'bad'"
          type="error"
          show-icon
          :closable="false"
          title="源文件不可用"
          :description="curCheck.message"
        />
        <el-alert
          v-else-if="curCheck?.state === 'over'"
          type="warning"
          show-icon
          :closable="false"
          title="模型包超过浏览器预览上限"
          description="该包大于 300 MB，已自动退回预览图；需要完整模型请点「下载模型包」后用专业软件打开。"
        />

        <!-- 三维窗口：能渲染就渲染真实模型，不能渲染时退回预览图 -->
        <div class="viewer-box">
          <ModelViewer
            v-if="viewerVisible && current?.id && curCheck?.state !== 'bad' && curCheck?.state !== 'over'"
            :model-id="current.id"
            :model-name="current.name"
          />
          <img v-else :src="previewSrc" alt="预览图" class="preview-fallback" />
        </div>

        <div class="kv"><span class="k">模型 ID</span><span class="v mono">{{ current?.id }}</span></div>
        <div class="kv"><span class="k">类型</span><span class="v">{{ current?.file_type === 'model_3d' ? '3D 模型' : '2D 模型' }}</span></div>
        <div class="kv"><span class="k">大小</span><span class="v">{{ sizeText(current?.size) }}</span></div>
        <div class="kv"><span class="k">创建时间</span><span class="v">{{ fmt(current?.create_at) }}</span></div>
        <div class="kv"><span class="k">更新时间</span><span class="v">{{ fmt(current?.update_at) }}</span></div>
        <div class="kv"><span class="k">地图展示</span><span class="v">{{ current?.show_on_map ? '是' : '否' }}</span></div>

        <div style="display: flex; gap: 10px; margin-top: 4px">
          <el-button
            size="small"
            type="primary"
            tag="a"
            :href="packageSrc"
            target="_blank"
            :disabled="curCheck?.state === 'bad'"
          >
            下载模型包
          </el-button>
          <el-button size="small" tag="a" :href="previewSrc" target="_blank">查看预览图</el-button>
        </div>
        <div class="muted small">
          三维窗口由模型包内的 b3dm / glb 直接渲染；若模型包过大或仍在压缩，会自动退回预览图。
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { modelApi, errMsg } from '../api/dji';
import ModelViewer from '../components/ModelViewer.vue';

const list = ref([]);
const loading = ref(false);
const viewerVisible = ref(false);
const current = ref(null);
/** 每个模型的源文件预检结果：{ state: 'checking'|'ok'|'bad'|'over', message, size } */
const checkState = ref({});
const curCheck = computed(() => (current.value ? checkState.value[current.value.id] : null));
/** 组织里拉取失败的项目数（单项目失败不影响其它项目展示） */
const failedCount = ref(0);

const packageSrc = computed(() =>
  current.value?.id ? modelApi.packageSrc(current.value.id, current.value.name) : ''
);
const previewSrc = computed(() =>
  current.value?.id ? modelApi.previewSrc(current.value.id) : ''
);

function fmt(ts) {
  if (!ts) return '--';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '--';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sizeText(n) {
  if (!n || n <= 0) return '--';
  if (n > 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

async function load(refresh = false) {
  loading.value = true;
  // 模型库跨项目聚合，与顶部选择的项目无关——切项目不重拉
  const r = await modelApi.list(refresh);
  loading.value = false;
  if (r?.ok) {
    list.value = r.data?.list || [];
    failedCount.value = (r.data?.errors || []).length;
  } else {
    list.value = [];
    failedCount.value = 0;
    ElMessage.error(errMsg(r, '模型列表获取失败'));
  }
}

/**
 * 预检：只取 1 字节，先确认源文件还在、且没超预览上限。
 * 不做这一步的话，用户点「三维预览」要等整个包下完才知道是 404。
 */
async function precheck(row) {
  if (!row?.id) return;
  checkState.value = { ...checkState.value, [row.id]: { state: 'checking' } };
  try {
    const r = await modelApi.check(row.id);
    const next = { ...checkState.value };
    if (r?.ok && r.available === false) {
      next[row.id] = { state: 'bad', message: r.message || '源文件不可用' };
    } else if (r?.ok && r.overLimit) {
      next[row.id] = { state: 'over', size: r.size };
    } else if (r?.ok) {
      next[row.id] = { state: 'ok', size: r.size };
    } else {
      next[row.id] = { state: 'bad', message: r?.message || '预检失败' };
    }
    checkState.value = next;
  } catch (e) {
    checkState.value = { ...checkState.value, [row.id]: { state: 'bad', message: e?.message || '预检失败' } };
  }
}

function openViewer(row) {
  current.value = row;
  viewerVisible.value = true;
  precheck(row);
}

onMounted(() => load());
</script>

<style scoped>
.card-head { display: flex; align-items: center; gap: 12px; }
.viewer-box {
  width: 100%; height: 420px; border-radius: 8px; overflow: hidden;
  border: 1px solid var(--c-line); background: var(--c-bg-2);
}
/* 源文件缺失 / 过大时的兜底：铺满不拉伸 */
.preview-fallback {
  width: 100%; height: 100%; object-fit: contain; background: var(--c-bg-2);
}
.kv { display: flex; justify-content: space-between; font-size: 13px; }
.kv .k { color: var(--c-text-2); }
.kv .v { color: var(--c-text-1); }
</style>
