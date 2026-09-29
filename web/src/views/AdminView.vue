<template>
  <div style="height: calc(100vh - 92px); display: flex; flex-direction: column">
    <el-tabs v-model="tab" style="flex: 1; min-height: 0; display: flex; flex-direction: column">
      <!-- 连接与组织 -->
      <el-tab-pane label="连接 · TK · 项目" name="conn">
        <div class="row" style="align-items: flex-start">
          <div class="card col">
            <div class="card-head"><span>接入点</span><span class="sub">{{ store.base }}</span></div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: 10px">
              <el-radio-group v-model="endpoint" @change="onEndpointChange">
                <el-radio label="cn">公有云·国内</el-radio>
                <el-radio label="us">公有云·海外</el-radio>
                <el-radio label="custom">私有云·自定义</el-radio>
              </el-radio-group>
              <el-input v-model="customBase" size="small" placeholder="https://your-fh2-domain.com" :disabled="endpoint !== 'custom'" />
              <el-button size="small" type="primary" @click="applyEndpoint">应用接入点</el-button>
              <el-button size="small" @click="runHealth">连通性体检</el-button>
              <el-divider style="margin: 4px 0" />
              <div class="row" style="align-items: center; gap: 8px">
                <el-switch v-model="mock" size="small" @change="onMockChange" />
                <span class="small">演示数据模式</span>
                <span class="small muted">（TK 未打通时用内置演示数据验收界面）</span>
              </div>
              <div v-if="health" class="card">
                <div class="card-body small">
                  <div>
                    鉴权：
                    <span class="tag" :class="health.tokenOk ? 'ok' : 'err'">
                      {{ health.tokenOk ? '通过' : `失败 ${health.code || ''}` }}
                    </span>
                  </div>
                  <div class="muted">项目数：{{ health.projectCount }} · 耗时 {{ health.latency }}ms</div>
                  <div v-if="health.message" class="muted" style="color: var(--err)">{{ health.message }}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="card col">
            <div class="card-head"><span>OpenAPI TK（组织密钥）</span><span class="sub">支持多组织快速切换</span></div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: 10px">
              <div v-for="t in store.tokens" :key="t.id" class="row" style="align-items: center; gap: 8px">
                <span class="tag" :class="t.active ? 'ok' : ''"><span class="dot"></span> {{ t.active ? '当前' : '备用' }}</span>
                <span>{{ t.name }}</span>
                <span class="mono small muted">{{ t.masked }}</span>
                <div style="flex: 1"></div>
                <el-button size="small" link @click="useToken(t.id)">切换</el-button>
                <el-button size="small" link type="danger" @click="delToken(t.id)">删除</el-button>
              </div>
              <el-divider style="margin: 4px 0" />
              <el-input v-model="tkName" size="small" placeholder="备注名，如：广州测试组织" />
              <el-input v-model="tkValue" type="textarea" :rows="3" size="small" placeholder="粘贴 X-User-Token（JWT）" />
              <div style="display: flex; gap: 8px">
                <el-button size="small" type="primary" @click="addToken">添加并切换</el-button>
                <el-button size="small" @click="decode">解析 TK</el-button>
              </div>
              <pre v-if="decoded" class="mono small" style="background: var(--bg-2); padding: 10px; border-radius: 6px; margin: 0">{{ decoded }}</pre>
            </div>
          </div>

          <div class="card col">
            <div class="card-head"><span>项目</span><span class="sub">进入组织后选择</span></div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: 8px">
              <el-select v-model="store.projectUuid" size="small" style="width: 100%" placeholder="选择项目" @change="onProjectChange">
                <el-option v-for="p in store.projects" :key="p.uuid" :label="p.name" :value="p.uuid" />
              </el-select>
              <div class="small muted">共 {{ store.projects.length }} 个项目</div>
              <el-button size="small" @click="loadProjects">刷新项目</el-button>
              <div v-if="store.projectUuid" class="mono small muted" style="word-break: break-all">
                {{ store.projectUuid }}
              </div>
              <el-divider style="margin: 4px 0" />
              <div class="small muted">当前组织：{{ store.decoded?.organization_uuid || '-' }}</div>
              <div class="small muted">账号：{{ store.decoded?.account || '-' }}</div>
              <div class="small muted">
                TK 有效期：{{ store.decoded?.exp ? new Date(store.decoded.exp * 1000).toLocaleString() : '-' }}
              </div>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- API 测试 -->
      <el-tab-pane label="API 测试" name="api">
        <div class="row" style="align-items: stretch; height: calc(100vh - 190px)">
          <div class="card" style="flex: 0 0 420px; display: flex; flex-direction: column">
            <div class="card-head"><span>请求构造</span></div>
            <div class="card-body" style="display: flex; flex-direction: column; gap: 8px; flex: 1; overflow: auto">
              <el-select v-model="picked" size="small" filterable placeholder="选择预置接口" @change="onPick">
                <el-option v-for="(c, i) in catalog" :key="i" :label="`${c.group} · ${c.name}`" :value="i" />
              </el-select>
              <div class="row" style="gap: 8px">
                <el-select v-model="method" size="small" style="width: 110px">
                  <el-option v-for="m in ['GET', 'POST', 'PUT', 'DELETE']" :key="m" :label="m" :value="m" />
                </el-select>
                <el-input v-model="path" size="small" placeholder="/openapi/v0.1/project" />
              </div>
              <el-input v-model="query" size="small" placeholder="query，如 usage=simple&page=1" />
              <el-input v-model="body" type="textarea" :rows="10" size="small" placeholder="JSON Body（DELETE 也支持）" />
              <el-checkbox v-model="useProject" size="small">携带 X-Project-Uuid</el-checkbox>
              <el-button size="small" type="primary" :loading="sending" @click="send">发送请求</el-button>
              <div class="small muted">
                路径中的 {device_sn} / {task_uuid} / {wayline_id} 需手动替换为真实值
              </div>
            </div>
          </div>

          <div class="card" style="flex: 1; display: flex; flex-direction: column; min-width: 0">
            <div class="card-head">
              <span>响应</span>
              <span class="sub">
                <span v-if="resp">HTTP {{ resp.status }} · {{ resp.duration }}ms</span>
              </span>
            </div>
            <div class="card-body" style="flex: 1; overflow: auto; min-height: 0">
              <pre v-if="resp" class="mono small" style="margin: 0; white-space: pre-wrap; word-break: break-all">{{ formatResp(resp) }}</pre>
              <div v-else class="muted small">点击「发送请求」查看原始响应（不做任何加工，便于排查）</div>
            </div>
          </div>
        </div>
      </el-tab-pane>

      <!-- 日志 -->
      <el-tab-pane label="日志输出" name="logs">
        <div class="card" style="height: calc(100vh - 190px)">
          <div class="card-body" style="height: 100%">
            <LogConsole />
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '../stores/session';
import { adminApi, sessionApi } from '../api/dji';
import LogConsole from '../components/LogConsole.vue';

const store = useSessionStore();
const tab = ref('conn');

const endpoint = ref(store.endpoint || 'cn');
const customBase = ref(store.customBase || '');
const health = ref(null);
const mock = ref(false);

async function onMockChange(v) {
  await store.toggleMock(v);
  ElMessage.success(v ? '已开启演示数据模式' : '已关闭演示模式，请求真实司空 2');
}

const tkName = ref('');
const tkValue = ref('');
const decoded = ref('');

const catalog = ref([]);
const picked = ref('');
const method = ref('GET');
const path = ref('/openapi/v0.1/project');
const query = ref('usage=simple');
const body = ref('');
const useProject = ref(true);
const sending = ref(false);
const resp = ref(null);

async function applyEndpoint() {
  const r = await store.setEndpoint(endpoint.value, customBase.value);
  if (r?.ok) ElMessage.success(`接入点已切换：${r.data.base}`);
  else ElMessage.error(r?.message || '切换失败');
  runHealth();
}

function onEndpointChange(v) {
  if (v !== 'custom') {
    store.setEndpoint(v).then(runHealth);
  }
}

async function runHealth() {
  const r = await sessionApi.health();
  if (r?.ok) health.value = r.data;
}

async function addToken() {
  if (!tkValue.value.trim()) return ElMessage.warning('请粘贴 TK');
  const r = await store.setToken(tkName.value || '新组织', tkValue.value.trim());
  if (r?.ok) {
    ElMessage.success('TK 已添加并切换');
    tkValue.value = '';
    tkName.value = '';
    runHealth();
  } else ElMessage.error(r?.message || '添加失败');
}

function useToken(id) {
  store.activateToken(id).then(() => {
    ElMessage.success('已切换 TK');
    runHealth();
  });
}

function delToken(id) {
  store.removeToken(id);
}

function decode() {
  try {
    const p = tkValue.value.trim().split('.')[1];
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    decoded.value = JSON.stringify(JSON.parse(decodeURIComponent(escape(atob(b64)))), null, 2);
  } catch {
    decoded.value = '无法解析，请确认 TK 完整';
  }
}

async function loadProjects() {
  await store.loadProjects();
}
async function onProjectChange(uuid) {
  await store.selectProject(uuid);
  ElMessage.success('已切换项目');
}

function onPick(i) {
  const c = catalog.value[i];
  if (!c) return;
  method.value = c.method;
  path.value = c.path;
  body.value = c.body || '';
  query.value = '';
  useProject.value = !/^\/openapi\/v0\.1\/project$|system_status/.test(c.path);
}

function formatResp(r) {
  const head = `${r.request.method} ${r.request.url}\nX-User-Token: ${r.request.token}\nX-Project-Uuid: ${r.request.projectUuid || '(未携带)'}\n\n`;
  if (r.json) return head + JSON.stringify(r.json, null, 2);
  return head + (r.text || '(空响应体)');
}

async function send() {
  sending.value = true;
  const q = {};
  (query.value || '').split('&').forEach((kv) => {
    if (!kv.includes('=')) return;
    const [k, v] = kv.split('=');
    q[k.trim()] = decodeURIComponent(v.trim());
  });
  let parsedBody = undefined;
  if (body.value && body.value.trim()) {
    try {
      parsedBody = JSON.parse(body.value);
    } catch {
      ElMessage.error('Body 不是合法 JSON');
      sending.value = false;
      return;
    }
  }
  resp.value = await adminApi.proxy({
    method: method.value,
    path: path.value,
    query: q,
    body: parsedBody,
    useProject: useProject.value,
  });
  sending.value = false;
}

onMounted(async () => {
  const r = await adminApi.catalog();
  if (r?.ok) catalog.value = r.data || [];
  endpoint.value = store.endpoint || 'cn';
  mock.value = !!store.mock;
  runHealth();
});
</script>
