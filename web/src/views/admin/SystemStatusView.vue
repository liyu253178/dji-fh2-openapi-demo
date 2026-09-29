<template>
  <div class="page">
    <PageHeader title="系统状态" subtitle="同步与告警">
      <template #actions>
        <el-button size="small" @click="load">刷新</el-button>
      </template>
    </PageHeader>

    <div class="blk">
      <h4>
        告警
        <span class="badge" :class="{ zero: !unack }">{{ unack }}</span>
        <el-button v-if="unack" size="small" text class="ml6" @click="ackAll">全部确认</el-button>
      </h4>
      <LoadingBlock v-if="loading" type="skeleton" :rows="3" />
      <EmptyState v-else-if="!alerts.length" title="暂无告警" description="系统运行正常" />
      <ul v-else class="alerts">
        <li v-for="a in alerts" :key="a.id" :class="[a.level, { ack: a.acknowledged }]">
          <span class="lv">
            {{ { fatal: '●', error: '●', warn: '●', info: '●' }[a.level] }}
            {{ { fatal: '致命', error: '错误', warn: '警告', info: '信息' }[a.level] }}
          </span>
          <div class="ab">
            <p class="t">{{ a.title }}</p>
            <p class="d">{{ a.detail }}</p>
          </div>
          <span class="tm">{{ ago(a.createdAt) }}</span>
          <el-button v-if="!a.acknowledged" size="small" text type="primary" @click="ack(a.id)">确认</el-button>
        </li>
      </ul>
    </div>

    <div class="cols">
      <div class="blk">
        <h4>数据库</h4>
        <dl class="kv">
          <dt>完整性</dt>
          <dd :class="db?.health?.ok ? 'ok' : 'err'">{{ db?.health?.integrity || '—' }}</dd>
          <dt>日志模式</dt>
          <dd>{{ db?.health?.journalMode || '—' }}</dd>
          <dt>文件大小</dt>
          <dd>{{ ((db?.health?.sizeKb || 0) / 1024).toFixed(2) }} MB</dd>
        </dl>
      </div>
      <div class="blk">
        <h4>邮件队列</h4>
        <dl class="kv">
          <dt>待发送</dt>
          <dd>{{ queue.pending || 0 }}</dd>
          <dt>处理中</dt>
          <dd>{{ queue.processing || 0 }}</dd>
          <dt>已完成</dt>
          <dd class="ok">{{ queue.done || 0 }}</dd>
          <dt>失败</dt>
          <dd :class="queue.failed ? 'err' : ''">{{ queue.failed || 0 }}</dd>
        </dl>
      </div>
      <div class="blk">
        <h4>影像同步</h4>
        <dl class="kv">
          <dt>运行中</dt>
          <dd>{{ sync.running ? '是' : '否' }}</dd>
          <dt>当前架次</dt>
          <dd>{{ sync.currentTask || '—' }}</dd>
          <dt>已处理</dt>
          <dd>{{ sync.processedTasks || 0 }} / {{ sync.totalTasks || 0 }}</dd>
          <dt>失败</dt>
          <dd :class="sync.failed ? 'err' : ''">{{ sync.failed || 0 }}</dd>
        </dl>
      </div>
    </div>
  </div>
</template>

<script setup>
/** P9 系统状态：告警 + 数据库 + 邮件队列 + 同步 */
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { notifyApi, systemApi, assetApi } from '../../api/duav';
import PageHeader from '../../components/common/PageHeader.vue';
import EmptyState from '../../components/common/EmptyState.vue';
import LoadingBlock from '../../components/common/LoadingBlock.vue';

const alerts = ref([]);
const unack = ref(0);
const loading = ref(true);
const db = ref(null);
const queue = reactive({});
const sync = reactive({});
let timer = null;

function ago(t) {
  if (!t) return '';
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

async function load() {
  const [a, d, q, s] = await Promise.all([
    notifyApi.alerts({ limit: 50 }),
    systemApi.dbStatus(),
    notifyApi.queue(),
    assetApi.syncStatus(),
  ]);
  if (a.ok) {
    alerts.value = a.data.list || [];
    unack.value = a.data.unacknowledged || 0;
  }
  if (d.ok) db.value = d.data;
  if (q.ok) Object.assign(queue, q.data || {});
  if (s.ok) Object.assign(sync, s.data || {});
  loading.value = false;
}

async function ack(id) {
  const r = await notifyApi.ackAlert(id);
  if (r.ok) load();
}
async function ackAll() {
  for (const a of alerts.value.filter((x) => !x.acknowledged)) {
    await notifyApi.ackAlert(a.id);
  }
  load();
}

onMounted(() => {
  load();
  timer = setInterval(load, 10000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.page { padding: var(--sp-3); }
.blk {
  padding: var(--sp-3);
  background: var(--c-bg-1);
  border: 1px solid var(--c-line);
  border-radius: var(--r-md);
  margin-bottom: var(--sp-3);
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
.badge {
  padding: 1px 7px;
  border-radius: 10px;
  font-size: var(--fs-xs);
  color: var(--c-err);
  background: rgba(255, 77, 79, 0.16);
}
.badge.zero {
  color: var(--c-text-2);
  background: rgba(255, 255, 255, 0.06);
}
.alerts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.alerts li {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--c-bg-0);
  border-left: 2px solid var(--c-line);
}
.alerts li.error { border-left-color: var(--c-err); }
.alerts li.warn { border-left-color: var(--c-warn); }
.alerts li.fatal { border-left-color: var(--c-err); }
.alerts li.info { border-left-color: var(--c-info); }
.alerts li.ack { opacity: 0.6; }
.lv {
  font-size: var(--fs-xs);
  color: var(--c-text-1);
  min-width: 52px;
}
.t { margin: 0; font-size: var(--fs-sm); color: var(--c-text-0); }
.d { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--c-text-2); }
.tm { font-size: var(--fs-xs); color: var(--c-text-2); margin-left: auto; }
.cols {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-3);
}
.cols .blk { margin-bottom: 0; }
.kv {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 4px var(--sp-2);
  margin: 0;
  font-size: var(--fs-sm);
}
.kv dt { color: var(--c-text-2); }
.kv dd { margin: 0; color: var(--c-text-0); }
.ok { color: var(--c-ok); }
.err { color: var(--c-err); }
.ml6 { margin-left: var(--sp-2); }
</style>
