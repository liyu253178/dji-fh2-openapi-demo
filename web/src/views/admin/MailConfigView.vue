<template>
  <div class="page">
    <PageHeader title="邮件配置" subtitle="SMTP 服务">
      <template #actions>
        <el-button size="small" @click="load">刷新</el-button>
      </template>
    </PageHeader>

    <div v-if="!cfg.configured" class="alert">
      ⚠ 邮件服务未配置，工单派发功能不可用。<span class="mono">授权码请通过环境变量 SMTP_PASS 注入</span>
    </div>

    <div class="cols">
      <div class="blk">
        <h4>SMTP 配置</h4>
        <el-form label-width="76px" label-position="left">
          <el-form-item label="主机">
            <el-input v-model="host" disabled />
            <p class="hint">按邮箱后缀自动推断</p>
          </el-form-item>
          <el-form-item label="端口">
            <el-input v-model="portStr" disabled />
            <el-tag size="small" class="ml6">{{ cfg.secure ? 'SSL' : 'STARTTLS' }}</el-tag>
          </el-form-item>
          <el-form-item label="账号">
            <el-input v-model="cfg.user" disabled />
          </el-form-item>
          <el-form-item label="授权码">
            <el-input :model-value="cfg.hasPass ? '••••••••••••' : '未配置'" disabled />
            <p class="hint">ⓘ 须用「应用专用密码」，非邮箱登录密码；仅环境变量注入，不落盘</p>
          </el-form-item>
          <el-form-item label="发件人">
            <el-input v-model="cfg.from" disabled />
          </el-form-item>
          <el-form-item label="平台地址">
            <el-input v-model="form.platformUrl" placeholder="http://localhost:8787" />
            <p class="hint">⚠️ 路由为 History 模式，深链接不要带 #/</p>
          </el-form-item>
          <el-form-item label="落款单位">
            <el-input v-model="form.orgName" />
          </el-form-item>
          <el-form-item label="咨询电话">
            <el-input v-model="form.orgContact" />
          </el-form-item>
          <el-form-item>
            <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
            <el-button size="small" :loading="verifying" @click="verify">验证连接</el-button>
            <el-button size="small" :loading="testing" @click="sendTest">发送测试邮件</el-button>
          </el-form-item>
        </el-form>
      </div>

      <div class="blk">
        <h4>
          发送记录
          <el-select v-model="logStatus" size="small" class="ml6" style="width: 110px" @change="loadLogs">
            <el-option label="全部" value="" />
            <el-option label="已送达" value="sent" />
            <el-option label="发送失败" value="failed" />
          </el-select>
        </h4>
        <LoadingBlock v-if="logsLoading" type="skeleton" :rows="4" />
        <EmptyState v-else-if="!logs.length" title="暂无发送记录" description="派发工单后这里会显示记录" />
        <el-table v-else :data="logs" size="small">
          <el-table-column label="时间" width="140">
            <template #default="{ row }">{{ fmt(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="工单号" min-width="150" prop="ticketNo" />
          <el-table-column label="收件人" min-width="170" prop="recipientEmail" />
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><StatusTag :status="row.status" /></template>
          </el-table-column>
          <el-table-column label="尝试" width="60" align="right" prop="attempts" />
          <el-table-column label="错误" min-width="200">
            <template #default="{ row }">
              <span class="err">{{ row.error || '—' }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <div class="blk">
      <h4>错误码对照</h4>
      <el-table :data="ERR_CODES" size="small">
        <el-table-column label="SMTP 错误" width="230" prop="code" class-name="mono" />
        <el-table-column label="含义" width="110" prop="kind" />
        <el-table-column label="平台处理" prop="action" />
      </el-table>
    </div>
  </div>
</template>

<script setup>
/** P7 邮件配置：SMTP 状态 + 发送记录 + 错误码对照 */
import { ref, reactive, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { notifyApi } from '../../api/duav';
import PageHeader from '../../components/common/PageHeader.vue';
import StatusTag from '../../components/common/StatusTag.vue';
import EmptyState from '../../components/common/EmptyState.vue';
import LoadingBlock from '../../components/common/LoadingBlock.vue';

const ERR_CODES = [
  { code: '535 Authentication failed', kind: '认证', action: '不重试，告警提示改用应用专用密码（避免锁账号）' },
  { code: '550 mailbox unavailable', kind: '地址非法', action: '不重试，提示修正派发对象邮箱' },
  { code: '552 Message too large', kind: '附件过大', action: '不重试，自动降级为仅发送链接后重发一次' },
  { code: '421 / 450', kind: '限流', action: '退避重试 10s / 30s / 60s' },
  { code: '550 Rejected', kind: '内容被拒', action: '不重试，告警并记录' },
  { code: 'ETIMEDOUT / ECONNRESET', kind: '网络', action: '退避重试 1s / 3s / 7s' },
];

const cfg = ref({});
const form = reactive({ platformUrl: '', orgName: '', orgContact: '' });
const logs = ref([]);
const logStatus = ref('');
const logsLoading = ref(false);
const saving = ref(false);
const verifying = ref(false);
const testing = ref(false);

const fmt = (t) => (t ? String(t).slice(5, 16).replace('T', ' ') : '—');
const host = ref('');
const portStr = ref('');

async function load() {
  const r = await notifyApi.config();
  if (r.ok) {
    cfg.value = r.data || {};
    host.value = cfg.value.host || '';
    portStr.value = String(cfg.value.port || '');
    form.platformUrl = cfg.value.platformUrl || '';
    form.orgName = cfg.value.orgName || '';
    form.orgContact = cfg.value.orgContact || '';
  }
  await loadLogs();
}

async function loadLogs() {
  logsLoading.value = true;
  const r = await notifyApi.mailLogs({ status: logStatus.value || undefined, limit: 50 });
  if (r.ok) logs.value = r.data || [];
  logsLoading.value = false;
}

async function save() {
  saving.value = true;
  const r = await notifyApi.saveConfig(form);
  saving.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '保存失败');
    return;
  }
  ElMessage.success('已保存');
  load();
}

async function verify() {
  verifying.value = true;
  const r = await notifyApi.verify();
  verifying.value = false;
  if (r.ok) ElMessage.success(r.message);
  else ElMessage.error(r.message);
}

async function sendTest() {
  testing.value = true;
  const r = await notifyApi.sendTest();
  testing.value = false;
  if (r.ok) ElMessage.success(r.message);
  else ElMessage.error(r.message);
}

onMounted(load);
</script>

<style scoped>
.page {
  padding: var(--sp-3);
}
.alert {
  padding: var(--sp-2) var(--sp-3);
  margin-bottom: var(--sp-3);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--c-warn);
  background: rgba(255, 176, 32, 0.1);
}
.mono {
  font-family: ui-monospace, monospace;
  color: var(--c-text-1);
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.blk {
  padding: var(--sp-3);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}
.blk h4 {
  display: flex;
  align-items: center;
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--c-text-0);
}
.hint {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  line-height: 1.6;
}
.ml6 {
  margin-left: var(--sp-2);
}
.err {
  color: var(--c-err);
  font-size: var(--fs-xs);
}
</style>
