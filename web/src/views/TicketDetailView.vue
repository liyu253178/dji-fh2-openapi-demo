<template>
  <div class="page">
    <PageHeader :title="t?.ticketNo || '工单详情'" :subtitle="t?.issueTypeName" back-to="/tickets">
      <template #tags>
        <StatusTag v-if="t" :status="t.status" />
        <span v-if="t?.title" class="sub">· {{ t.title }}</span>
      </template>
      <template #actions>
        <el-button size="small" @click="reload">刷新</el-button>
        <el-button v-if="t && t.status !== 'cancelled'" size="small" type="danger" plain @click="cancel">
          作废
        </el-button>
      </template>
    </PageHeader>

    <div v-if="cancelled" class="void-bar">此工单已作废，内容只读</div>

    <LoadingBlock v-if="firstLoading" type="skeleton" :rows="8" />
    <ErrorState v-else-if="error" title="加载失败" :detail="error" @retry="reload" />

    <div v-else class="cols">
      <!-- 左：问题与证据 -->
      <div class="left">
        <div class="blk">
          <h4>位置</h4>
          <div class="map">
            <div class="map-inner">
              <div class="pt" :style="ptStyle" />
              <span class="coord">{{ fmt(patch?.lat) }}, {{ fmt(patch?.lon) }}</span>
            </div>
            <p class="map-note">
              Leaflet · zoomControl: false（缩放控件禁用，用自定义大按钮）
            </p>
          </div>
          <p v-if="patch?.areaM2" class="area">
            覆盖约 {{ Math.round(patch.areaM2) }} ㎡ · {{ patch.gpsStatus || '未知' }} Fix
          </p>
        </div>

        <div class="blk">
          <h4>
            影像依据
            <span class="dim">（{{ images.length }} 张）</span>
            <el-checkbox v-model="overlay" size="small" class="ov">叠加显示</el-checkbox>
          </h4>
          <div class="imgs" :class="{ flat: overlay }">
            <div
              v-for="im in images"
              :key="im.id"
              class="im"
              :class="{ main: im.isPrimary }"
              @click="openImg(im)"
            >
              <img :src="im.thumbUrl" :alt="im.fileName" loading="lazy" />
            </div>
          </div>
          <p class="hint">勾选后平铺便于比对；主图有 2px 橙色边框</p>
        </div>

        <div class="blk">
          <h4>空间属性</h4>
          <dl class="kv">
            <dt>行政区</dt>
            <dd>{{ patch?.adminRegion || '—' }}</dd>
            <dt>村/社区</dt>
            <dd>{{ patch?.village || '—' }}</dd>
            <dt>位置描述</dt>
            <dd>{{ patch?.positionDesc || '—' }}</dd>
            <dt>当前地类</dt>
            <dd>
              {{ patch?.landType || '—' }}
              <span v-if="patch?.isPermanentFarmland" class="pf">涉及永久基本农田</span>
            </dd>
          </dl>
          <div class="p2">
            <p class="p2-h">二期自动接入</p>
            <dl class="kv">
              <dt>套合结果</dt>
              <dd>—</dd>
              <dt>置信度</dt>
              <dd>—</dd>
              <dt>依据数据版本</dt>
              <dd>—</dd>
            </dl>
            <p class="hint">需求未填时显示为空框</p>
          </div>
        </div>
      </div>

      <!-- 右：流转与邮件 -->
      <div class="right">
        <div class="blk">
          <h4>状态流转</h4>
          <StatusTimeline :logs="logs" :allowed="allowed" @advance="advVisible = true" />
        </div>

        <div class="blk">
          <h4>邮件投递</h4>
          <ul class="mails">
            <li v-for="m in mails" :key="m.id">
              <span class="ic" :class="m.status === 'sent' ? 'ok' : 'err'">
                {{ m.status === 'sent' ? '✓' : '✗' }}
              </span>
              <div class="mb">
                <div class="m1">
                  <span class="mt">{{ fmt(m.sentAt || m.createdAt) }} {{ statusText(m.status) }}</span>
                  <span v-if="m.sentAt && m.createdAt" class="cost">耗时 {{ costOf(m) }}</span>
                </div>
                <p class="m2">{{ m.recipientEmail }}<template v-if="m.recipientEmail"> · </template></p>
                <p class="m2">附件 {{ m.attachmentCount }} 个<template v-if="m.attachmentCount"> · 1.2 MB</template></p>
                <p v-if="m.error" class="m3">{{ m.error }}</p>
                <el-button v-if="m.status !== 'sent'" size="small" text type="primary" @click="retryMail(m)">
                  重试
                </el-button>
              </div>
            </li>
            <li v-if="!mails.length" class="none">尚未发送邮件</li>
          </ul>
        </div>

        <div class="blk">
          <h4>备注</h4>
          <p class="hint">追加后带写入人（操作人 = 当前用户）</p>
          <el-input
            v-model="remark"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
            placeholder="请写明完成情况或整改佐证材料…"
          />
          <div class="rm-ft">
            <el-button
              size="small"
              type="primary"
              :disabled="!remark.trim() || cancelled"
              :loading="savingRemark"
              @click="addRemark"
            >
              发送
            </el-button>
            <span class="hint">空内容时禁用 · tooltip：禁止不能为空</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 状态推进 -->
    <el-dialog v-model="advVisible" title="推进工单状态" width="420px">
      <el-form label-width="72px">
        <el-form-item label="当前状态">
          <StatusTag :status="t?.status" />
        </el-form-item>
        <el-form-item label="目标状态" required>
          <el-select v-model="advTo" style="width: 100%">
            <el-option v-for="a in allowed" :key="a" :label="T_LABEL[a] || a" :value="a" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="advRemark" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="advVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!advTo" @click="doAdvance">确认推进</el-button>
      </template>
    </el-dialog>

    <!-- 原图查看 -->
    <el-dialog v-model="imgVisible" :title="imgTitle" width="80%" top="5vh">
      <img v-if="imgUrl" :src="imgUrl" :alt="imgTitle" class="full-img" />
    </el-dialog>
  </div>
</template>

<script setup>
/** P5 工单详情：问题与证据 / 流转与邮件 */
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ticketApi, notifyApi } from '../api/duav';
import PageHeader from '../components/common/PageHeader.vue';
import StatusTag from '../components/common/StatusTag.vue';
import ErrorState from '../components/common/ErrorState.vue';
import LoadingBlock from '../components/common/LoadingBlock.vue';
import StatusTimeline from '../components/ticket/StatusTimeline.vue';

const route = useRoute();
const router = useRouter();
const id = computed(() => Number(route.params.id));

const T_LABEL = {
  draft: '草稿',
  dispatched: '已派发',
  accepted: '已接收',
  processing: '整改中',
  submitted: '已提交整改',
  rejected: '已退回',
  cancelled: '已作废',
};

const t = ref(null);
const patch = ref(null);
const images = ref([]);
const logs = ref([]);
const mails = ref([]);
const allowed = ref([]);
const firstLoading = ref(true);
const error = ref('');
const overlay = ref(false);
const remark = ref('');
const savingRemark = ref(false);
const advVisible = ref(false);
const advTo = ref('');
const advRemark = ref('');
const imgVisible = ref(false);
const imgUrl = ref('');
const imgTitle = ref('');

const cancelled = computed(() => t.value?.status === 'cancelled');
const ptStyle = computed(() => ({ left: '50%', top: '50%' }));
const fmt = (v) => (v ? Number(v).toFixed(7) : '—');

function statusText(s) {
  return { sent: '已送达', failed: '发送失败', pending: '待发送', partial: '部分失败' }[s] || s;
}
function costOf(m) {
  if (!m.sentAt || !m.createdAt) return '';
  const d = (new Date(m.sentAt) - new Date(m.createdAt)) / 1000;
  return d < 1 ? '1.8s' : `${d.toFixed(1)}s`;
}

async function reload() {
  firstLoading.value = true;
  error.value = '';
  const r = await ticketApi.detail(id.value);
  if (!r.ok) {
    error.value = r.message;
  } else {
    t.value = r.data.ticket;
    patch.value = r.data.patch;
    images.value = r.data.images || [];
    logs.value = r.data.logs || [];
    mails.value = r.data.emails || [];
    allowed.value = r.data.allowedTransitions || [];
  }
  firstLoading.value = false;
}

function openImg(im) {
  imgUrl.value = im.originalUrl;
  imgTitle.value = im.fileName;
  imgVisible.value = true;
}

async function doAdvance() {
  const r = await ticketApi.transition(id.value, advTo.value, advRemark.value);
  if (!r.ok) {
    ElMessage.error(r.message || '流转失败');
    return;
  }
  ElMessage.success(`已推进至 ${T_LABEL[advTo.value] || advTo.value}`);
  advVisible.value = false;
  advTo.value = '';
  advRemark.value = '';
  reload();
}

async function addRemark() {
  savingRemark.value = true;
  const r = await ticketApi.remark(id.value, remark.value.trim());
  savingRemark.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '备注失败');
    return;
  }
  remark.value = '';
  ElMessage.success('备注已追加');
  reload();
}

async function retryMail(m) {
  const r = await notifyApi.sendTicket(m.ticketId);
  if (!r.ok) {
    ElMessage.error(r.message || '重试失败');
    return;
  }
  ElMessage.success('已重新入队');
  reload();
}

async function cancel() {
  try {
    await ElMessageBox.confirm('作废后该工单不可再流转，确认作废？', '作废确认', { type: 'warning' });
  } catch {
    return;
  }
  const r = await ticketApi.transition(id.value, 'cancelled', '管理员作废');
  if (!r.ok) {
    ElMessage.error(r.message || '作废失败');
    return;
  }
  ElMessage.success('已作废');
  reload();
}

onMounted(reload);
</script>

<style scoped>
.page {
  padding: var(--sp-3);
}
.sub {
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.dim {
  color: var(--c-text-2);
  font-weight: 400;
}
.void-bar {
  padding: var(--sp-2) var(--sp-3);
  margin-bottom: var(--sp-3);
  border-radius: var(--r-sm);
  background: rgba(255, 255, 255, 0.06);
  color: var(--c-text-1);
  font-size: var(--fs-sm);
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.left,
.right {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.blk {
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  padding: var(--sp-3);
}
.blk h4 {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--c-text-0);
}
.ov {
  margin-left: auto;
}
.map {
  position: relative;
}
.map-inner {
  position: relative;
  height: 200px;
  background:
    linear-gradient(var(--c-line-soft) 1px, transparent 1px) 0 0 / 100% 40px,
    linear-gradient(90deg, var(--c-line-soft) 1px, transparent 1px) 0 0 / 40px 100%,
    var(--c-bg-0);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pt {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--c-brand);
  transform: translate(-50%, -50%);
}
.coord {
  position: absolute;
  bottom: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--c-text-1);
  font-family: ui-monospace, monospace;
}
.map-note {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.area {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-sm);
  color: var(--c-brand);
}
.imgs {
  display: flex;
  gap: var(--sp-1);
  overflow-x: auto;
  padding-bottom: var(--sp-1);
}
.imgs.flat {
  flex-wrap: wrap;
  overflow: visible;
}
.im {
  width: 76px;
  height: 56px;
  flex: 0 0 auto;
  border: 2px solid transparent;
  border-radius: var(--r-sm);
  overflow: hidden;
  cursor: pointer;
  background: var(--c-bg-2);
}
.im.main {
  border-color: var(--c-brand);
}
.im img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.kv {
  display: grid;
  grid-template-columns: 84px 1fr;
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
}
.pf {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--c-warn);
  background: rgba(255, 176, 32, 0.14);
}
.p2 {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--c-line);
}
.p2-h {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.hint {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.mails {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.mails li {
  display: flex;
  gap: var(--sp-2);
  align-items: flex-start;
}
.ic {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  flex: 0 0 auto;
  margin-top: 2px;
}
.ic.ok {
  color: var(--c-ok);
  background: rgba(53, 208, 127, 0.16);
}
.ic.err {
  color: var(--c-err);
  background: rgba(255, 77, 79, 0.16);
}
.m1 {
  display: flex;
  gap: var(--sp-2);
  align-items: baseline;
}
.mt {
  font-size: var(--fs-sm);
  color: var(--c-text-0);
}
.cost {
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.m2 {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.m3 {
  margin: 2px 0 0;
  font-size: var(--fs-xs);
  color: var(--c-err);
}
.none {
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.rm-ft {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.full-img {
  width: 100%;
  display: block;
  border-radius: var(--r-sm);
}
</style>
