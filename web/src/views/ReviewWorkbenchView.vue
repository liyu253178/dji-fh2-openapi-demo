<template>
  <div class="wb">
    <!-- 顶栏 -->
    <div class="bar">
      <el-button size="small" text class="back" @click="router.push('/assets')">‹ 返回</el-button>
      <div class="meta">
        <span class="name">{{ task?.name || taskUuid.slice(0, 8) }}</span>
        <span v-if="task?.dockSn" class="dim">· {{ task.dockSn }}</span>
        <span v-if="task?.beginAt" class="dim">· {{ fmtTime(task.beginAt) }}</span>
        <span v-if="images.length" class="dim">· {{ images.length }} 张</span>
      </div>
      <div class="spacer" />
      <el-select v-model="lensFilter" size="small" style="width: 108px">
        <el-option label="全部镜头" value="" />
        <el-option label="仅红外" value="infrared" />
        <el-option label="仅可见光" value="visible" />
      </el-select>
      <el-checkbox v-model="pairMode" size="small">成对比对</el-checkbox>
      <div class="prog">
        已标注 <strong>{{ patchedCount }}</strong> / {{ images.length }}
      </div>
    </div>

    <LoadingBlock v-if="firstLoading" type="spin" height="calc(100vh - 150px)" />

    <ErrorState
      v-else-if="error"
      title="加载失败"
      :detail="error"
      @retry="load"
    />

    <EmptyState
      v-else-if="!images.length"
      title="该架次暂无航拍影像"
      description="可能是 FlyToTask 定点飞行任务，本身不产生照片"
      action-text="返回成果库"
      @action="router.push('/assets')"
    />

    <div v-else class="cols">
      <!-- 左：缩略图 -->
      <aside class="left">
        <div class="left-hd">影像 {{ images.length }}<span class="dim"> / 已标 {{ patchedCount }}</span></div>
        <div class="thumbs">
          <ImageThumb
            v-for="(im, i) in visibleImages"
            :key="im.id"
            :image="im"
            :index="originalIndex(im)"
            :selected="selected.includes(im.id)"
            @click="select(im)"
            @toggle="toggleSelect"
          />
        </div>
        <div class="left-ft">
          <span class="sel">☑ 已选 {{ selected.length }}</span>
          <el-button size="small" type="primary" :disabled="selected.length < 2" @click="mergeSelected">
            合并图斑
          </el-button>
        </div>
      </aside>

      <!-- 中：单图 -->
      <section class="mid">
        <div v-if="pairMode && pairImage" class="pair">
          <div class="cell">
            <span class="tag">可见光 · 主图</span>
            <ImageViewer
              :url="assetApi.imageUrl(current.id, 'mail')"
              :alt="current.fileName"
              :loading="imgLoading"
              @drawn="onDrawn"
            />
          </div>
          <div class="cell">
            <span class="tag ir">红外 · 配对</span>
            <ImageViewer :url="assetApi.imageUrl(pairImage.id, 'mail')" :alt="pairImage.fileName" />
          </div>
        </div>
        <div v-else class="single">
          <ImageViewer
            :url="assetApi.imageUrl(current.id, 'mail')"
            :alt="current.fileName"
            :pair="pairImage ? '红外配对' : ''"
            :loading="imgLoading"
            @drawn="onDrawn"
            @reload="imgLoading = false"
          />
        </div>

        <div class="mid-ft">
          <div class="nav">
            <el-button size="small" text :disabled="idx <= 0" @click="step(-1)">‹</el-button>
            <span class="pg">{{ idx + 1 }} / {{ visibleImages.length }}</span>
            <el-button size="small" text :disabled="idx >= visibleImages.length - 1" @click="step(1)">›</el-button>
            <el-tooltip content="下载原图">
              <el-button size="small" text @click="download">⤓</el-button>
            </el-tooltip>
          </div>
          <div class="cover" v-if="cover">
            覆盖约 {{ cover.w }} × {{ cover.h }} m
          </div>
          <el-button size="small" type="primary" :disabled="!draw" @click="openForm">
            框选中
          </el-button>
        </div>
      </section>

      <!-- 右：属性 + 图斑 -->
      <aside class="right">
        <div class="blk">
          <h4>影像信息</h4>
          <dl class="kv">
            <dt>坐标</dt>
            <dd class="mono">
              {{ current.lat ? current.lat.toFixed(7) : '—' }}<br />
              {{ current.lon ? current.lon.toFixed(7) : '—' }}
            </dd>
            <dt>定位</dt>
            <dd>
              {{ current.gpsStatus || '未知' }}
              <span v-if="current.isRtk" class="ok">✓</span>
              <span v-else class="warn">⚠</span>
            </dd>
            <dt>绝对高</dt>
            <dd>{{ current.altitudeAbs ?? '—' }} m</dd>
            <dt>相对高</dt>
            <dd>{{ current.altitudeRel ?? '—' }} m</dd>
            <dt>云台姿态</dt>
            <dd class="mono small">
              R{{ fmtNum(current.gimbal?.roll) }} Y{{ fmtNum(current.gimbal?.yaw) }} P{{ fmtNum(current.gimbal?.pitch) }}
            </dd>
            <dt>机身姿态</dt>
            <dd class="mono small">
              R{{ fmtNum(current.flight?.roll) }} Y{{ fmtNum(current.flight?.yaw) }} P{{ fmtNum(current.flight?.pitch) }}
            </dd>
            <dt>机型</dt>
            <dd>{{ current.droneModel || '—' }}</dd>
            <dt>相机 SN</dt>
            <dd class="mono small">{{ current.cameraSn ? '…' + current.cameraSn.slice(-6) : '—' }}</dd>
            <dt>拍摄时间</dt>
            <dd class="small">{{ fmtTime(current.shotAt) }}</dd>
          </dl>
        </div>

        <div class="blk">
          <h4>已有图斑 ({{ patches.length }})</h4>
          <ul v-if="patches.length" class="pl">
            <li v-for="p in patches" :key="p.patchId">
              <span class="sq" />
              <span class="pt">#{{ p.patchId }} · {{ p.issueTypeName }}</span>
              <span class="pc">{{ p.imageCount }} 张</span>
              <StatusTag :status="p.status" />
            </li>
          </ul>
          <p v-else class="none">尚未标注</p>
        </div>

        <el-button type="primary" class="save" @click="openForm">保存为图斑</el-button>
      </aside>
    </div>

    <PatchForm
      v-model:visible="formVisible"
      :types="types"
      :task-uuid="taskUuid"
      :project-uuid="projectUuid"
      :flight-line-id="flightLineId"
      :draw="draw"
      :initial-image-ids="selected.length ? selected : [current.id]"
      :primary-image-id="selected[0] || current.id"
      @saved="onSaved"
      @redraw="needRedraw = true"
    />
  </div>
</template>

<script setup>
/** P2 影像审核工作台：三栏（左缩略图 / 中单图 + 框选 / 右属性与图斑） */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { assetApi, reviewApi, ticketApi, dictApi } from '../api/duav';
import { useSessionStore } from '../stores/session';
import ImageThumb from '../components/asset/ImageThumb.vue';
import ImageViewer from '../components/asset/ImageViewer.vue';
import PatchForm from '../components/review/PatchForm.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import LoadingBlock from '../components/common/LoadingBlock.vue';

const route = useRoute();
const router = useRouter();
const store = useSessionStore();

const taskUuid = computed(() => route.params.taskUuid);
const images = ref([]);
const task = ref(null);
const types = ref([]);
const patches = ref([]);
const curId = ref(0);
const selected = ref([]);
const lensFilter = ref('');
const pairMode = ref(false);
const imgLoading = ref(true);
const firstLoading = ref(true);
const error = ref('');
const draw = ref(null);
const formVisible = ref(false);
const needRedraw = ref(false);

const projectUuid = computed(() => store.projectUuid || '');
const flightLineId = computed(() => task.value?.flightLineId || '');

const visibleImages = computed(() =>
  lensFilter.value ? images.value.filter((x) => x.lensType === lensFilter.value) : images.value
);
const current = computed(() => visibleImages.value.find((x) => x.id === curId.value) || visibleImages.value[0] || {});
const idx = computed(() => Math.max(0, visibleImages.value.findIndex((x) => x.id === curId.value)));
const patchedCount = computed(() => images.value.filter((x) => x.reviewState !== 'none').length);
const pairImage = computed(() =>
  current.value.pairImageId ? images.value.find((x) => x.id === current.value.pairImageId) : null
);
const cover = computed(() => {
  const f = current.value.footprint;
  return f ? { w: Math.round(f.widthM), h: Math.round(f.heightM) } : null;
});

function originalIndex(im) {
  return images.value.findIndex((x) => x.id === im.id);
}
function fmtNum(v) {
  return v === null || v === undefined ? '—' : Number(v).toFixed(1);
}
function fmtTime(t) {
  return t ? String(t).slice(0, 16).replace('T', ' ') : '—';
}

async function load() {
  firstLoading.value = true;
  error.value = '';
  try {
    const [r, t] = await Promise.all([
      assetApi.taskImages(taskUuid.value),
      reviewApi.issueTypes(),
    ]);
    if (!r.ok) {
      error.value = r.message;
      return;
    }
    images.value = r.data.list || [];
    curId.value = images.value[0]?.id || 0;
    if (t.ok) types.value = t.data || [];
    // 架次元信息（用于顶栏展示）
    const list = await assetApi.tasks({ projectUuid: projectUuid.value, pageSize: 200 });
    if (list.ok) task.value = (list.data.list || []).find((x) => x.taskUuid === taskUuid.value) || null;
    await loadPatches();
  } catch (e) {
    error.value = e.message;
  } finally {
    firstLoading.value = false;
    imgLoading.value = false;
  }
}

async function loadPatches() {
  const r = await reviewApi.queue({ status: 'draft', pageSize: 200 });
  if (r.ok) patches.value = (r.data.list || []).filter((p) => p.taskUuid === taskUuid.value);
}

function select(im) {
  curId.value = im.id;
  imgLoading.value = true;
  setTimeout(() => (imgLoading.value = false), 120);
  if (!selected.value.includes(im.id)) selected.value.push(im.id);
}

function toggleSelect(id) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}

function step(d) {
  const list = visibleImages.value;
  const i = idx.value + d;
  if (i < 0 || i >= list.length) return;
  curId.value = list[i].id;
  imgLoading.value = true;
  setTimeout(() => (imgLoading.value = false), 120);
}

function onDrawn({ x, y, w, h, naturalW, naturalH }) {
  // 像素框 → 归一化 GeoJSON（外接框四至）
  const lon1 = current.value.lon + ((x / naturalW - 0.5) * (current.value.footprint?.widthM || 0)) / 111320 / Math.cos((current.value.lat * Math.PI) / 180);
  const lat1 = current.value.lat - ((y / naturalH - 0.5) * (current.value.footprint?.heightM || 0)) / 111320;
  const lon2 = current.value.lon + ((x + w) / naturalW - 0.5) / 111320 / Math.cos((current.value.lat * Math.PI) / 180) * (current.value.footprint?.widthM || 0);
  const lat2 = current.value.lat - ((y + h) / naturalH - 0.5) / 111320 * (current.value.footprint?.heightM || 0);
  const geometry = {
    type: 'Polygon',
    coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]],
  };
  reviewApi.areaEstimate(geometry).then((r) => {
    if (r.ok) {
      draw.value = { geometry, areaM2: r.data.areaM2, lat: r.data.centroid?.lat, lon: r.data.centroid?.lon };
      formVisible.value = true;
    } else {
      ElMessage.error(r.message || '面积估算失败');
    }
  });
}

function openForm() {
  if (!draw.value) {
    needRedraw.value = true;
    ElMessage.info('请先在图上拖拽框选问题范围');
    return;
  }
  formVisible.value = true;
}

function mergeSelected() {
  if (selected.value.length < 2) return;
  // 多图合并：以第一张为主图，框选沿用当前
  if (!draw.value) {
    ElMessage.info('请先框选问题范围，再合并多张影像');
    return;
  }
  formVisible.value = true;
}

async function onSaved({ withTicket }) {
  selected.value = [];
  draw.value = null;
  await loadPatches();
  if (withTicket) {
    // 生成工单：取刚建的图斑
    const r = await reviewApi.queue({ status: 'draft', pageSize: 1 });
    const p = r.ok ? r.data.list?.[0] : null;
    if (p) {
      const t = await ticketApi.create({ patchId: p.patchId });
      if (t.ok) ElMessage.success(`工单 ${t.data.ticketNo} 已创建，可在工单管理中派发`);
      else ElMessage.warning(`图斑已保存，但工单创建失败：${t.message}`);
    }
  }
}

function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
}
function download() {
  window.open(assetApi.imageUrl(current.value.id, 'original'), '_blank');
}

onMounted(() => {
  load();
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.wb {
  padding: var(--sp-3);
  height: calc(100vh - var(--topbar-h));
  display: flex;
  flex-direction: column;
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  flex-wrap: wrap;
}
.back {
  color: var(--c-text-1);
}
.meta {
  display: flex;
  gap: 6px;
  align-items: baseline;
  font-size: var(--fs-md);
}
.name {
  font-weight: 600;
  color: var(--c-text-0);
}
.dim {
  color: var(--c-text-2);
  font-size: var(--fs-sm);
}
.spacer {
  flex: 1;
}
.prog {
  font-size: var(--fs-sm);
  color: var(--c-text-1);
}
.prog strong {
  color: var(--c-brand);
}
.cols {
  flex: 1;
  display: grid;
  grid-template-columns: 200px 1fr 320px;
  gap: var(--sp-2);
  min-height: 0;
}
.left,
.right {
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.left-hd {
  padding: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--c-text-1);
  border-bottom: 1px solid var(--c-line);
}
.thumbs {
  flex: 1;
  overflow: auto;
  padding: var(--sp-2);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-1);
  align-content: start;
}
.left-ft {
  padding: var(--sp-2);
  border-top: 1px solid var(--c-line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.sel {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.mid {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-height: 0;
}
.single,
.pair {
  flex: 1;
  min-height: 0;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
}
.cell {
  position: relative;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.tag {
  position: absolute;
  top: var(--sp-2);
  left: var(--sp-2);
  z-index: 4;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--c-text-0);
  background: rgba(0, 0, 0, 0.6);
}
.tag.ir {
  color: #1a1a1e;
  background: var(--c-warn);
}
.mid-ft {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}
.nav {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.pg {
  font-size: var(--fs-sm);
  color: var(--c-text-1);
  min-width: 52px;
  text-align: center;
}
.cover {
  flex: 1;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.blk {
  padding: var(--sp-3);
  border-bottom: 1px solid var(--c-line);
}
.blk h4 {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--c-text-0);
}
.kv {
  display: grid;
  grid-template-columns: 62px 1fr;
  gap: 4px var(--sp-2);
  margin: 0;
  font-size: var(--fs-sm);
}
.kv dt {
  color: var(--c-text-2);
}
.kv dd {
  margin: 0;
  color: var(--c-text-0);
  word-break: break-all;
}
.mono {
  font-family: ui-monospace, monospace;
}
.small {
  font-size: var(--fs-xs);
}
.ok {
  color: var(--c-ok);
}
.warn {
  color: var(--c-warn);
}
.pl {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pl li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
}
.sq {
  width: 8px;
  height: 8px;
  background: var(--c-brand);
  border-radius: 2px;
}
.pt {
  flex: 1;
  color: var(--c-text-0);
}
.pc {
  color: var(--c-text-2);
}
.none {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.save {
  margin: var(--sp-3);
}
</style>
