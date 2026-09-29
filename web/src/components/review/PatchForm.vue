<template>
  <el-dialog
    :model-value="visible"
    :title="patchId ? '编辑图斑' : '新建图斑'"
    width="620px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <el-form ref="formRef" :model="form" :rules="rules" label-width="92px" label-position="left">
      <el-form-item label="问题类型" prop="issueType">
        <el-select v-model="form.issueType" placeholder="选择问题类型" style="width: 100%" @change="onTypeChange">
          <el-option v-for="t in types" :key="t.code" :label="t.name" :value="t.code" />
        </el-select>
        <p v-if="typeInfo" class="hint">
          ⓘ 默认责任层级 {{ typeInfo.defaultOrg }} · 限期 {{ typeInfo.defaultDays }} 天
        </p>
      </el-form-item>

      <el-form-item label="标题" prop="title">
        <el-input v-model="form.title" maxlength="50" show-word-limit placeholder="例：疑似新增钢结构厂房" />
      </el-form-item>

      <el-form-item label="描述">
        <el-input
          v-model="form.description"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="航拍可见的具体情况"
        />
      </el-form-item>

      <el-divider content-position="left">空间</el-divider>

      <el-form-item label="坐标">
        <div class="coord-row">
          <el-input v-model="form.latStr" :disabled="!manualCoord" placeholder="纬度" class="mono" />
          <el-input v-model="form.lonStr" :disabled="!manualCoord" placeholder="经度" class="mono" />
        </div>
        <el-checkbox v-model="manualCoord" class="mt6">手动微调（默认取影像 GPS）</el-checkbox>
        <p v-if="!form.latStr" class="hint err">该影像无 GPS 坐标，请手动填写</p>
      </el-form-item>

      <el-form-item label="问题范围">
        <div class="range-row">
          <span v-if="areaText" class="area">已框选 ▭ {{ areaText }}</span>
          <span v-else class="area muted">尚未框选</span>
          <el-button size="small" @click="$emit('redraw')">重新框选</el-button>
        </div>
      </el-form-item>

      <el-divider content-position="left">位置描述</el-divider>

      <el-form-item label="行政区" prop="adminRegion">
        <el-input v-model="form.adminRegion" placeholder="例：深圳市宝安区XX街道" />
      </el-form-item>
      <el-form-item label="村/社区">
        <el-input v-model="form.village" placeholder="例：XX社区" />
      </el-form-item>
      <el-form-item label="位置描述" prop="positionDesc">
        <el-input
          v-model="form.positionDesc"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="东至XX路，西至XX河，南至XX鱼塘"
        />
        <p class="hint">ⓘ 请写四至与参照物，让没去过现场的人能定位</p>
      </el-form-item>

      <el-divider content-position="left">土地属性</el-divider>

      <el-form-item label="当前地类" prop="landType">
        <el-select v-model="form.landType" placeholder="选择地类" style="width: 100%" clearable>
          <el-option v-for="l in LAND_TYPES" :key="l" :label="l" :value="l" />
        </el-select>
      </el-form-item>
      <el-form-item label="">
        <el-checkbox v-model="form.isPermanentFarmland">涉及永久基本农田</el-checkbox>
      </el-form-item>
      <el-form-item label="规划用途">
        <el-input v-model="form.planningUse" placeholder="选填" />
      </el-form-item>
      <el-form-item label="审批手续号">
        <el-input v-model="form.approvalNo" placeholder="选填" />
      </el-form-item>

      <el-form-item label="关联影像">
        <div class="imgs">
          <span v-for="i in form.imageIds" :key="i" class="chip">
            #{{ i }}
            <i v-if="i === form.primaryImageId" class="primary">主</i>
            <em @click="removeImage(i)">×</em>
          </span>
          <span v-if="!form.imageIds.length" class="muted">未关联</span>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="$emit('update:visible', false)">取消</el-button>
      <el-button @click="submit(false)">保存图斑</el-button>
      <el-button type="primary" :loading="saving" @click="submit(true)">保存并生成工单</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
/** 图斑表单：问题类型联动必填、范围、位置描述、土地属性 */
import { ref, reactive, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { reviewApi } from '../../api/duav';

const LAND_TYPES = ['耕地', '园地', '林地', '草地', '商服用地', '工矿仓储用地', '住宅用地', '公共管理与公共服务用地', '交通运输用地', '水域及水利设施用地', '其他土地'];

const props = defineProps({
  visible: { type: Boolean, default: false },
  patchId: { type: Number, default: 0 },
  types: { type: Array, default: () => [] },
  taskUuid: { type: String, default: '' },
  projectUuid: { type: String, default: '' },
  flightLineId: { type: String, default: '' },
  /** 框选结果：{ geometry, areaM2, lat, lon } */
  draw: { type: Object, default: null },
  initialImageIds: { type: Array, default: () => [] },
  primaryImageId: { type: Number, default: 0 },
});
const emit = defineEmits(['update:visible', 'saved', 'redraw']);

const formRef = ref(null);
const saving = ref(false);
const manualCoord = ref(false);

const form = reactive({
  issueType: '',
  title: '',
  description: '',
  latStr: '',
  lonStr: '',
  adminRegion: '',
  village: '',
  positionDesc: '',
  landType: '',
  isPermanentFarmland: false,
  planningUse: '',
  approvalNo: '',
  imageIds: [],
  primaryImageId: 0,
});

const typeInfo = computed(() => props.types.find((t) => t.code === form.issueType) || null);
const areaText = computed(() => {
  const a = props.draw?.areaM2;
  if (!a) return '';
  if (a < 10000) return `${Math.round(a)} ㎡`;
  return `${(a / 666.6667).toFixed(1)} 亩`;
});

const rules = computed(() => {
  const t = typeInfo.value;
  return {
    issueType: [{ required: true, message: '请选择问题类型', trigger: 'change' }],
    title: [{ required: true, message: '请填写标题', trigger: 'blur' }],
    adminRegion: [{ required: true, message: '请填写行政区', trigger: 'blur' }],
    positionDesc: [
      { required: true, message: '请填写位置描述', trigger: 'blur' },
      { min: 10, message: '位置描述至少 10 字，让收件人能定位', trigger: 'blur' },
    ],
    landType: t?.requireLandType ? [{ required: true, message: '该问题类型必须填写当前地类', trigger: 'change' }] : [],
  };
});

watch(
  () => props.visible,
  (v) => {
    if (v) reset();
  }
);
watch(
  () => props.draw,
  (d) => {
    if (!d) return;
    if (d.lat !== undefined) form.latStr = String(d.lat);
    if (d.lon !== undefined) form.lonStr = String(d.lon);
  }
);

function reset() {
  form.issueType = '';
  form.title = '';
  form.description = '';
  form.latStr = '';
  form.lonStr = '';
  form.adminRegion = '';
  form.village = '';
  form.positionDesc = '';
  form.landType = '';
  form.isPermanentFarmland = false;
  form.planningUse = '';
  form.approvalNo = '';
  form.imageIds = [...props.initialImageIds];
  form.primaryImageId = props.primaryImageId || props.initialImageIds[0] || 0;
  manualCoord.value = false;
  formRef.value?.clearValidate();
}

function onTypeChange() {
  // 类型变了，若新类型不要求地类则不强制
  formRef.value?.clearValidate('landType');
}

function removeImage(id) {
  form.imageIds = form.imageIds.filter((x) => x !== id);
  if (form.primaryImageId === id) form.primaryImageId = form.imageIds[0] || 0;
}

async function submit(withTicket) {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  if (!form.latStr || !form.lonStr) {
    ElMessage.error('请填写坐标（该影像无 GPS）');
    return;
  }
  saving.value = true;
  const body = {
    projectUuid: props.projectUuid,
    taskUuid: props.taskUuid || undefined,
    flightLineId: props.flightLineId || undefined,
    issueType: form.issueType,
    title: form.title,
    description: form.description,
    lat: Number(form.latStr),
    lon: Number(form.lonStr),
    geometry: props.draw?.geometry || null,
    areaM2: props.draw?.areaM2 ?? null,
    adminRegion: form.adminRegion,
    village: form.village,
    positionDesc: form.positionDesc,
    landType: form.landType,
    isPermanentFarmland: form.isPermanentFarmland,
    planningUse: form.planningUse,
    approvalNo: form.approvalNo,
    imageIds: form.imageIds,
    primaryImageId: form.primaryImageId,
  };
  const r = props.patchId ? await reviewApi.update(props.patchId, body) : await reviewApi.create(body);
  saving.value = false;
  if (!r.ok) {
    ElMessage.error(r.message || '保存失败');
    return;
  }
  ElMessage.success('图斑已保存');
  emit('update:visible', false);
  emit('saved', { patchId: r.data.patchId, withTicket });
}
</script>

<style scoped>
.coord-row {
  display: flex;
  gap: var(--sp-2);
  width: 100%;
}
.mono :deep(input) {
  font-family: ui-monospace, monospace;
}
.mt6 {
  margin-top: var(--sp-2);
}
.range-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
}
.area {
  flex: 1;
  font-size: var(--fs-md);
  color: var(--c-brand);
}
.area.muted {
  color: var(--c-text-2);
  font-size: var(--fs-sm);
}
.imgs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  align-items: center;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  color: var(--c-text-1);
  background: var(--c-bg-2);
}
.chip .primary {
  font-style: normal;
  color: var(--c-brand);
}
.chip em {
  cursor: pointer;
  color: var(--c-text-2);
}
.chip em:hover {
  color: var(--c-err);
}
.muted {
  font-size: var(--fs-sm);
  color: var(--c-text-2);
}
.hint {
  margin: 4px 0 0;
  font-size: var(--fs-xs);
  color: var(--c-text-2);
  line-height: 1.6;
}
.hint.err {
  color: var(--c-err);
}
</style>
