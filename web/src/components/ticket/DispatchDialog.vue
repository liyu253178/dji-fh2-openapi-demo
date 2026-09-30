<template>
  <el-dialog
    :model-value="visible"
    title="派发工单"
    width="520px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <template v-if="stage === 'config'">
      <p class="cnt">{{ ticket ? `工单 ${ticket.ticketNo}（草稿）` : `已选 ${patches.length} 个图斑` }}</p>
      <el-form label-width="80px" label-position="left">
        <el-form-item label="收件对象" required>
          <el-select v-model="recipientId" placeholder="选择派发对象" style="width: 100%">
            <el-option
              v-for="r in recipients"
              :key="r.id"
              :label="`${r.name}${r.contact ? ' · ' + r.contact : ''}`"
              :value="r.id"
            />
          </el-select>
          <p v-if="currentRecipient" class="hint">
            ⓘ 邮箱 {{ currentRecipient.email }}
            <template v-if="currentRecipient.adminRegion"> · {{ currentRecipient.adminRegion }}</template>
          </p>
        </el-form-item>
        <el-form-item label="责任人">
          <el-input v-model="assignedTo" placeholder="选填" />
        </el-form-item>
        <el-form-item label="联系电话">
          <el-input v-model="contact" placeholder="选填" />
        </el-form-item>
      </el-form>

      <div class="preview-box">
        <p class="lb">邮件主题预览</p>
        <p class="subj">{{ subjectPreview }}</p>
      </div>

      <p v-if="!recipients.length" class="warn-box">
        ⚠ 还没有派发对象，请先到「系统管理 → 派发对象」配置
      </p>
      <p v-if="!mailConfigured" class="warn-box">
        ⚠ 邮件服务未配置，工单可创建但邮件发不出去
      </p>
    </template>

    <template v-else-if="stage === 'preview'">
      <p class="lb">邮件预览（不发送）</p>
      <iframe class="mail-frame" :srcdoc="previewHtml" />
    </template>

    <template v-else>
      <el-result icon="success" title="已进入发送队列">
        <template #sub-title>
          <p>可在工单详情查看发送结果</p>
        </template>
      </el-result>
    </template>

    <template #footer>
      <template v-if="stage === 'config'">
        <el-button @click="$emit('update:visible', false)">取消</el-button>
        <el-button :disabled="!patchId" @click="doPreview">预览</el-button>
        <el-button
          type="primary"
          :loading="sending"
          :disabled="!canSend"
          @click="doSend"
        >
          确认发送
        </el-button>
      </template>
      <template v-else-if="stage === 'preview'">
        <el-button @click="stage = 'config'">返回</el-button>
        <el-button type="primary" :loading="sending" :disabled="!canSend" @click="doSend">确认发送</el-button>
      </template>
      <el-button v-else type="primary" @click="close">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
/** 派发对话框：两种入口 —— ① 图斑直接建单派发（patches）② 工单草稿补选派发对象后派发（ticket） */
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { ticketApi, notifyApi, dictApi } from '../../api/duav';

const props = defineProps({
  visible: { type: Boolean, default: false },
  patches: { type: Array, default: () => [] },
  /** 草稿工单模式：传入工单对象（含 id/ticketNo/patchId/issueTypeName/deadline） */
  ticket: { type: Object, default: null },
});
const emit = defineEmits(['update:visible', 'sent']);

const stage = ref('config');
const recipientId = ref(null);
const assignedTo = ref('');
const contact = ref('');
const recipients = ref([]);
const mailConfigured = ref(true);
const sending = ref(false);
const previewHtml = ref('');
const ticketId = ref(0);

const patchId = computed(() => props.ticket?.patchId || props.patches[0]?.patchId || 0);
const currentRecipient = computed(() => recipients.value.find((r) => r.id === recipientId.value) || null);
const canSend = computed(() => !!recipientId.value && !!patchId.value);

const subjectPreview = computed(() => {
  if (props.ticket) {
    return `【低空巡查问题线索】${props.ticket.issueTypeName || ''}（限期 ${String(props.ticket.deadline || '').slice(0, 10) || '7 天'}）`;
  }
  const p = props.patches[0];
  if (!p) return '—';
  return `【低空巡查问题线索】${p.adminRegion || ''}${p.issueTypeName || ''}（限期 7 天）`;
});

watch(
  () => props.visible,
  async (v) => {
    if (!v) return;
    stage.value = 'config';
    ticketId.value = 0;
    previewHtml.value = '';
    // 每次打开都从空白开始；草稿工单若已带对象则回填
    recipientId.value = props.ticket?.recipientId || null;
    assignedTo.value = props.ticket?.assignedTo || '';
    contact.value = props.ticket?.contact || '';
    const [r, m] = await Promise.all([dictApi.recipients(), notifyApi.config()]);
    if (r.ok) recipients.value = r.data || [];
    if (m.ok) mailConfigured.value = !!m.data.configured;
  }
);

/** 草稿工单模式：先把派发对象落到工单上，再走入队 */
async function ensureTicket() {
  if (props.ticket) {
    const r = await ticketApi.setRecipient(props.ticket.id, {
      recipientId: recipientId.value,
      assignedTo: assignedTo.value || null,
      contact: contact.value || null,
    });
    if (!r.ok) {
      ElMessage.error(r.message || '派发对象设置失败');
      return 0;
    }
    return props.ticket.id;
  }
  if (ticketId.value) return ticketId.value;
  const t = await ticketApi.create({
    patchId: patchId.value,
    recipientId: recipientId.value,
    assignedTo: assignedTo.value,
    contact: contact.value,
  });
  if (!t.ok) {
    ElMessage.error(t.message || '工单创建失败');
    return 0;
  }
  ticketId.value = t.data.ticketId;
  return ticketId.value;
}

async function doPreview() {
  const id = await ensureTicket();
  if (!id) return;
  const r = await notifyApi.preview(id);
  if (!r.ok) {
    ElMessage.error(r.message || '预览失败');
    return;
  }
  previewHtml.value = r.data.html;
  stage.value = 'preview';
}

async function doSend() {
  const id = await ensureTicket();
  if (!id) return;
  sending.value = true;
  const r = await ticketApi.send(id);
  sending.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '入队失败');
    return;
  }
  stage.value = 'done';
  emit('sent');
}

function close() {
  emit('update:visible', false);
}
</script>

<style scoped>
.cnt {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-md);
  color: var(--c-text-1);
}
.hint {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.preview-box {
  padding: var(--sp-2) var(--sp-3);
  background: var(--c-bg-0);
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
}
.lb {
  margin: 0 0 4px;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
.subj {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--c-text-0);
}
.warn-box {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--c-warn);
  background: rgba(255, 176, 32, 0.1);
}
.mail-frame {
  width: 100%;
  height: 420px;
  border: 1px solid var(--c-line);
  border-radius: var(--r-sm);
  background: #fff;
}
</style>
