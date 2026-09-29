<template>
  <div class="page">
    <PageHeader title="派发对象" subtitle="责任单位与收件人">
      <template #actions>
        <el-button size="small" type="primary" @click="openEdit()">+ 新增派发对象</el-button>
      </template>
    </PageHeader>

    <div class="blk">
      <LoadingBlock v-if="loading" type="skeleton" :rows="4" />
      <EmptyState v-else-if="!list.length" title="还没有派发对象" description="至少配置一个收件对象才能派发工单" action-text="新增派发对象" @action="openEdit()" />
      <el-table v-else :data="list" size="small">
        <el-table-column label="单位名称" min-width="180" prop="name" />
        <el-table-column label="联系人" width="100" prop="contact" />
        <el-table-column label="电话" width="130" prop="phone" />
        <el-table-column label="邮箱" min-width="200" prop="email" class-name="mono" />
        <el-table-column label="行政区" width="120" prop="adminRegion" />
        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="hint">被工单引用的派发对象不可删除；邮箱格式需正确，否则 SMTP 会被拒收</p>
    </div>

    <el-dialog v-model="visible" :title="form.id ? '编辑派发对象' : '新增派发对象'" width="480px">
      <el-form label-width="88px" label-position="left">
        <el-form-item label="单位名称" required>
          <el-input v-model="form.name" placeholder="XX街道办事处" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contact" />
        </el-form-item>
        <el-form-item label="电话">
          <el-input v-model="form.phone" />
        </el-form-item>
        <el-form-item label="邮箱" required>
          <el-input v-model="form.email" placeholder="li@xx.gov.cn" />
        </el-form-item>
        <el-form-item label="行政区">
          <el-input v-model="form.adminRegion" placeholder="宝安区" />
        </el-form-item>
        <el-form-item label="地址描述">
          <el-input v-model="form.addressDesc" placeholder="宝安区XX路1号" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.active" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
/** P8b 派发对象 */
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { dictApi } from '../../api/duav';
import PageHeader from '../../components/common/PageHeader.vue';
import EmptyState from '../../components/common/EmptyState.vue';
import LoadingBlock from '../../components/common/LoadingBlock.vue';

const list = ref([]);
const loading = ref(true);
const visible = ref(false);
const saving = ref(false);
const form = reactive({ id: 0, name: '', contact: '', phone: '', email: '', adminRegion: '', addressDesc: '', active: true });

async function load() {
  loading.value = true;
  const r = await dictApi.recipients();
  if (r.ok) list.value = r.data || [];
  loading.value = false;
}

function openEdit(row) {
  Object.assign(form, row || { id: 0, name: '', contact: '', phone: '', email: '', adminRegion: '', addressDesc: '', active: true });
  visible.value = true;
}

async function save() {
  if (!form.name || !form.email) {
    ElMessage.error('单位名称与邮箱必填');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
    ElMessage.error('邮箱格式不正确');
    return;
  }
  saving.value = true;
  const r = form.id ? await dictApi.updateRecipient(form.id, form) : await dictApi.createRecipient(form);
  saving.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '保存失败');
    return;
  }
  ElMessage.success('已保存');
  visible.value = false;
  load();
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除派发对象「${row.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  const r = await dictApi.removeRecipient(row.id);
  if (!r.ok) {
    ElMessage.warning(r.message || '删除失败');
    return;
  }
  ElMessage.success('已删除');
  load();
}

onMounted(load);
</script>

<style scoped>
.page { padding: var(--sp-3); }
.blk {
  padding: var(--sp-3);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
}
.mono { font-family: ui-monospace, monospace; }
.hint {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
</style>
