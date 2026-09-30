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
        <el-input
          v-model="form.title"
          maxlength="50"
          show-word-limit
          placeholder="留空自动按「街道 + 问题类型」生成"
          @input="titleTouched = true"
        />
        <p v-if="autoTitleHint" class="hint">ⓘ 已按「街道 + 问题类型」自动生成标题，可直接修改</p>
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
        <p v-if="!hasCoord" class="hint err">影像与框选都没有 GPS 坐标，请手动填写</p>
      </el-form-item>

      <!--
        原来这里有「问题范围 ≈ 1822 ㎡」的面积估算与「重新框选」按钮，已按需求删除：
        无人机照片的 GSD/相对高度本来就不准，估算面积会误导，删掉显示与其计算。
        框选本身仍保留（用于确定图斑位置与关联影像），只是不再换算成面积展示。
        需要重画时关掉表单、在图上重新拖拽即可。
      -->

      <el-divider content-position="left">位置描述</el-divider>

      <!--
        具体地址：按影像 GPS 逆地理编码自动带出，可直接改。
        ⚠️ 改成手填后不再被自动结果覆盖（addrTouched），否则会出现"改完又被冲掉"。
      -->
      <el-form-item label="具体地址">
        <div class="addr-row">
          <el-input
            v-model="form.address"
            :loading="addrLoading"
            placeholder="按影像坐标自动匹配，也可手填"
            @input="onAddressInput"
          />
          <el-button size="default" :loading="addrLoading" :disabled="!hasCoord" @click="matchAddress(true)">
            重新匹配
          </el-button>
        </div>
        <p v-if="addrLoading" class="hint">正在按影像坐标匹配地址…</p>
        <p v-else-if="addrMsg" class="hint" :class="{ err: addrErr }">{{ addrMsg }}</p>
        <p v-else class="hint">
          ⓘ 来源：{{ sourceText }}<template v-if="form.addressSource === 'nearby'">（邻近图斑地址，请核对）</template>
        </p>
      </el-form-item>

      <el-form-item label="行政区" prop="adminRegion">
        <el-input v-model="form.adminRegion" placeholder="例：深圳市宝安区XX街道" @input="regionTouched = true" />
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
          placeholder="选填：东至XX路，西至XX河，南至XX鱼塘"
        />
        <p class="hint">ⓘ 选填：有四至与参照物时填写，能让没去过现场的人定位</p>
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
      <el-button type="primary" :loading="saving" @click="submit(true)">保存并生成工单草稿</el-button>
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
  /** 框选结果：{ geometry, lat, lon }（不再含面积——航拍估算面积不准，已停用） */
  draw: { type: Object, default: null },
  initialImageIds: { type: Array, default: () => [] },
  primaryImageId: { type: Number, default: 0 },
  /** 主图 GPS 兜底：未框选时（draw 为 null）用它做地址匹配与入库坐标 */
  imageCoord: { type: Object, default: null },
});
const emit = defineEmits(['update:visible', 'saved']);

const formRef = ref(null);
const saving = ref(false);
const manualCoord = ref(false);
const addrLoading = ref(false);
const addrMsg = ref('');
const addrErr = ref(false);
/** 用户手改过地址/行政区后，自动匹配不再覆盖（避免"改完又被冲掉"） */
const addrTouched = ref(false);
const regionTouched = ref(false);
/** 标题自动生成：街道（来自逆地理）+ 问题类型；用户手改后不再覆盖 */
const titleTouched = ref(false);
const streetName = ref('');
const lastAutoTitle = ref('');

const form = reactive({
  issueType: '',
  title: '',
  description: '',
  latStr: '',
  lonStr: '',
  address: '',
  addressSource: '',
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
const autoTitleHint = computed(() => !!form.title && form.title === lastAutoTitle.value);

/**
 * 自动生成标题：「XX街道 XX问题」
 * - 街道取逆地理的 township（与行政区/具体地址同源，高德 regeo）
 * - 问题类型取所选类型名
 * - 用户手改过标题（titleTouched）或已填了非自动内容时不覆盖
 * - 没匹配到街道时只用类型名，宁缺勿编
 */
function autoTitle() {
  if (titleTouched.value) return;
  const label = typeInfo.value?.name || '';
  if (!label) return;
  const gen = streetName.value ? `${streetName.value} ${label}` : label;
  if (form.title && form.title !== lastAutoTitle.value) return; // 已有用户内容
  form.title = gen;
  lastAutoTitle.value = gen;
}
const hasCoord = computed(() => Number.isFinite(Number(form.latStr)) && Number.isFinite(Number(form.lonStr)) && !!form.latStr && !!form.lonStr);
const sourceText = computed(
  () => ({ auto: '按影像坐标自动匹配', manual: '人工填写', nearby: '邻近图斑复用', coords: '未匹配' })[form.addressSource] || '未匹配'
);
const rules = computed(() => {
  const t = typeInfo.value;
  return {
    issueType: [{ required: true, message: '请选择问题类型', trigger: 'change' }],
    title: [{ required: true, message: '请填写标题', trigger: 'blur' }],
    adminRegion: [{ required: true, message: '请填写行政区', trigger: 'blur' }],
    // 位置描述改为选填：具体地址已按 GPS 自动带出，四至仅作补充
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
    // 框选坐标变了就重新匹配（用户手动改过地址则不覆盖）
    if (props.visible) matchAddress(false);
  }
);

/**
 * 按影像坐标匹配具体地址
 * @param {boolean} force true=用户点「重新匹配」，即使手改过也覆盖
 */
async function matchAddress(force = false) {
  if (!hasCoord.value) {
    addrMsg.value = '影像与框选都没有 GPS 坐标，请手动填写地址';
    addrErr.value = true;
    return;
  }
  if (!force && addrTouched.value) return;
  addrLoading.value = true;
  addrMsg.value = '';
  addrErr.value = false;
  const r = await reviewApi.reverseGeocode({
    lat: Number(form.latStr),
    lon: Number(form.lonStr),
    projectUuid: props.projectUuid || undefined,
  });
  addrLoading.value = false;
  const d = r.ok ? r.data : null;
  if (!d || !d.ok) {
    addrMsg.value = (d && d.message) || r.message || '地址匹配失败，请手动填写';
    addrErr.value = true;
    return;
  }
  if (d.address) {
    form.address = d.address;
    form.addressSource = d.source === 'nearby' ? 'nearby' : 'auto';
    addrTouched.value = false;
  }
  // 行政区空着就顺手带上（省/市/区/街道），不覆盖用户已填的内容
  if (!form.adminRegion) {
    const region = [d.city, d.district, d.township].filter(Boolean).join('');
    if (region) {
      form.adminRegion = region;
      regionTouched.value = false;
    }
  }
  // 记录街道（用于标题自动生成），街道变化会触发标题重算
  const st = d.township || '';
  if (st && st !== streetName.value) {
    streetName.value = st;
    autoTitle();
  }
  if (d.needKey) {
    addrMsg.value = d.message || '未配置高德 Key，无法自动匹配地址，请手动填写';
    addrErr.value = true;
    if (!form.address) form.addressSource = 'coords';
  } else if (d.message) {
    addrMsg.value = d.message;
  }
}

function onAddressInput() {
  addrTouched.value = true;
  if (form.address.trim()) form.addressSource = 'manual';
}

function reset() {
  form.issueType = '';
  form.title = '';
  form.description = '';
  form.latStr = '';
  form.lonStr = '';
  form.address = '';
  form.addressSource = '';
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
  addrTouched.value = false;
  regionTouched.value = false;
  titleTouched.value = !!props.patchId; // 编辑模式不覆盖已有标题
  streetName.value = '';
  lastAutoTitle.value = '';
  addrMsg.value = '';
  addrErr.value = false;
  // 坐标优先级：框选结果 > 主图 GPS（传来的 imageCoord）
  const c = props.draw || props.imageCoord;
  if (c && c.lat !== undefined && c.lon !== undefined) {
    form.latStr = String(c.lat);
    form.lonStr = String(c.lon);
  }
  formRef.value?.clearValidate();
  // 打开即自动带出地址（用户选的是"打开表单自动带出 + 可改 + 可重新匹配"）
  if (hasCoord.value) matchAddress(false);
}

function onTypeChange() {
  // 类型变了，若新类型不要求地类则不强制
  formRef.value?.clearValidate('landType');
  autoTitle(); // 标题跟着问题类型重算（手改过则不覆盖）
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
    address: form.address,
    addressSource: form.addressSource || (form.address ? 'manual' : ''),
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
.addr-row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  width: 100%;
}
.addr-row :deep(.el-input) {
  flex: 1;
  min-width: 0;
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
