<template>
  <div class="page">
    <PageHeader title="问题字典" subtitle="问题类型管理">
      <template #actions>
        <el-button size="small" type="primary" @click="openEdit()">+ 新增问题类型</el-button>
      </template>
    </PageHeader>

    <div class="blk">
      <LoadingBlock v-if="loading" type="skeleton" :rows="6" />
      <el-table v-else :data="list" size="small">
        <el-table-column label="编码" width="200" prop="code" class-name="mono" />
        <el-table-column label="名称" width="160" prop="name" />
        <el-table-column label="默认责任层级" width="150" prop="defaultOrg" />
        <el-table-column label="时限" width="80" align="right">
          <template #default="{ row }">{{ row.defaultDays }} 天</template>
        </el-table-column>
        <el-table-column label="必填面积" width="90" align="center">
          <template #default="{ row }">
            <span :class="row.requireArea ? 'on' : 'off'">{{ row.requireArea ? '☑' : '☐' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="必填地类" width="90" align="center">
          <template #default="{ row }">
            <span :class="row.requireLandType ? 'on' : 'off'">{{ row.requireLandType ? '☑' : '☐' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }">
            <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" text type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="hint">被工单或图斑引用的类型不可删除；停用后不出现在审核表单的下拉中</p>
    </div>

    <el-dialog v-model="visible" :title="form.code ? '编辑问题类型' : '新增问题类型'" width="480px">
      <el-form label-width="96px" label-position="left">
        <el-form-item label="编码" required>
          <el-input v-model="form.code" :disabled="!!form.code" placeholder="大写字母 + 下划线" />
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="疑似违法建设" />
        </el-form-item>
        <el-form-item label="责任层级">
          <el-input v-model="form.defaultOrg" placeholder="乡镇 → 执法大队" />
        </el-form-item>
        <el-form-item label="时限（天）">
          <el-input-number v-model="form.defaultDays" :min="1" :max="365" />
        </el-form-item>
        <el-form-item label="">
          <el-checkbox v-model="form.requireArea">必填面积</el-checkbox>
          <el-checkbox v-model="form.requireLandType">必填地类</el-checkbox>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="form.sortOrder" :min="0" />
        </el-form-item>
        <el-form-item label="启用">
          <el-switch v-model="form.enabled" />
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
/** P8a 问题字典 */
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { dictApi } from '../../api/duav';
import PageHeader from '../../components/common/PageHeader.vue';
import LoadingBlock from '../../components/common/LoadingBlock.vue';

const list = ref([]);
const loading = ref(true);
const visible = ref(false);
const saving = ref(false);
const form = reactive({
  code: '', name: '', defaultOrg: '', defaultDays: 7,
  requireArea: false, requireLandType: false, sortOrder: 0, enabled: true,
});

async function load() {
  loading.value = true;
  const r = await dictApi.issueTypes({ includeDisabled: 1 });
  if (r.ok) list.value = r.data || [];
  loading.value = false;
}

function openEdit(row) {
  Object.assign(form, row
    ? { ...row }
    : { code: '', name: '', defaultOrg: '', defaultDays: 7, requireArea: false, requireLandType: false, sortOrder: list.value.length + 1, enabled: true });
  visible.value = true;
}

async function save() {
  if (!form.code || !form.name) {
    ElMessage.error('编码与名称必填');
    return;
  }
  saving.value = true;
  const r = form.code && list.value.some((x) => x.code === form.code)
    ? await dictApi.updateIssueType(form.code, form)
    : await dictApi.createIssueType(form);
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
    await ElMessageBox.confirm(`删除问题类型「${row.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  const r = await dictApi.removeIssueType(row.code);
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
.on { color: var(--c-ok); }
.off { color: var(--c-text-2); }
.hint {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
}
</style>
