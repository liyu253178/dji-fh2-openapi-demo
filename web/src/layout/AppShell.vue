<template>
  <div class="shell">
    <!-- 顶栏：logo + 页面标题 · 面包屑 + 环境状态 -->
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
            <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
            <path d="M12 9.6V5M12 14.4V19M9.6 12H5M14.4 12H19" stroke-linecap="round" />
            <circle cx="4.4" cy="4.4" r="2.1" /><circle cx="19.6" cy="4.4" r="2.1" />
            <circle cx="4.4" cy="19.6" r="2.1" /><circle cx="19.6" cy="19.6" r="2.1" />
            <path d="M5.9 5.9 9.9 9.9M18.1 5.9 14.1 9.9M5.9 18.1 9.9 14.1M18.1 18.1 14.1 14.1" stroke-linecap="round" />
          </svg>
        </div>
        <span class="brand-title">DUAV</span>
      </div>

      <div class="topbar-title">
        <span class="t">{{ pageTitle }}</span>
        <span v-if="pageSubtitle" class="s">· {{ pageSubtitle }}</span>
        <span v-if="store.connected" class="tag ok live"><span class="dot"></span>实时</span>
        <span v-if="store.mock" class="tag warn">演示数据</span>
      </div>

      <div class="topbar-right">
        <!-- 显式轮询状态：让「数据没更新」和「界面卡了」一眼可区分 -->
        <span class="tag poll" :class="pollState.cls" :title="pollState.title">
          <span class="dot"></span>{{ pollState.text }}
        </span>
        <span class="env">{{ clockText }}</span>
        <span class="env">{{ store.airports.length }} 机场 · {{ store.drones.length }} 飞行器</span>

        <el-select
          v-model="store.projectUuid"
          size="small"
          placeholder="选择项目"
          style="width: 150px"
          :disabled="!store.projects.length"
          @change="onProjectChange"
        >
          <el-option v-for="p in store.projects" :key="p.uuid" :label="p.name" :value="p.uuid" />
        </el-select>

        <el-dropdown trigger="click" @command="onTokenCommand">
          <button class="icon-btn" :title="store.masked || '未配置 TK'">
            <el-icon><Key /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="t in store.tokens" :key="t.id" :command="'use:' + t.id">
                {{ t.name }}<span v-if="t.active" style="color: var(--c-ok)"> ✔</span>
              </el-dropdown-item>
              <el-dropdown-item divided command="manage">组织与接入点管理…</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <button class="icon-btn" :disabled="store.loading" title="刷新" @click="refresh">
          <el-icon :class="{ spinning: store.loading }"><Refresh /></el-icon>
        </button>
      </div>
    </header>

    <div class="body">
      <!-- 侧栏导航 -->
      <aside class="sidebar">
        <nav>
          <template v-for="item in nav" :key="item.path || item.title">
            <!-- 可折叠分组：父项只负责展开/收起，不跳转 -->
            <div v-if="item.children" class="nav-item group" :class="{ open: isOpen(item), 'group-on': groupActive(item) }" @click="toggle(item)">
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.title }}</span>
              <span v-if="groupBadge(item)" class="nav-badge">{{ groupBadge(item) }}</span>
              <el-icon class="caret" :class="{ rot: isOpen(item) }"><ArrowRight /></el-icon>
            </div>
            <template v-if="item.children && isOpen(item)">
              <div
                v-for="c in item.children"
                :key="c.path"
                class="nav-item sub"
                :class="{ active: route.path === c.path }"
                @click="router.push(c.path)"
              >
                <span class="sub-dot"></span>
                <span class="sub-t">{{ c.title }}</span>
                <span v-if="c.badge && badgeValue(c.badge)" class="nav-badge">{{ badgeValue(c.badge) }}</span>
              </div>
            </template>

            <!-- 普通一级项 -->
            <div
              v-else-if="!item.children"
              class="nav-item"
              :class="{ active: route.path === item.path }"
              @click="router.push(item.path)"
            >
              <el-icon><component :is="item.icon" /></el-icon>
              <span>{{ item.title }}</span>
              <span v-if="item.badge && badgeValue(item.badge)" class="nav-badge">{{ badgeValue(item.badge) }}</span>
            </div>
          </template>
        </nav>
        <div class="sidebar-foot">
          <span class="dot" :style="{ background: store.connected ? 'var(--c-ok)' : 'var(--c-err)' }"></span>
          <span>{{ store.connected ? '系统运行正常' : '云端未连接' }}</span>
          <span class="ver">v2.7</span>
        </div>
      </aside>

      <!-- 内容 -->
      <main class="content" :class="{ 'content-full': isFullPage }">
        <el-alert
          v-if="store.lastError"
          :title="store.lastError"
          type="warning"
          show-icon
          closable
          style="margin-bottom: 12px"
          @close="store.lastError = ''"
        />
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '../stores/session';

const route = useRoute();
const router = useRouter();
const store = useSessionStore();

/**
 * 信息架构导航
 * ⚠️ 这里是**硬编码数组，不派生自 router/index.js**——
 *    新增页面时必须同时改 router/index.js 与本数组，只改一处菜单不会出现。
 *
 * children 表示可折叠分组：「发现—核查—派发—归档」这一整条业务链路平铺在侧栏时，
 * 一级项一度达到 14 个，主次不分、找入口全靠扫读，所以收敛成「工单管理」一个栏目。
 */
const nav = [
  { path: '/dashboard', title: '首页大屏', icon: 'Monitor', badge: 'online' },
  { path: '/screen', title: '省域态势', icon: 'Aim' },
  { path: '/cockpit', title: '虚拟座舱', icon: 'Coordinate' },
  {
    title: '航线规划',
    icon: 'MapLocation',
    children: [
      { path: '/wayline/plan', title: '规划工作台', icon: 'EditPen' },
      { path: '/wayline', title: '航线库', icon: 'MapLocation' },
      { path: '/wayline/tasks', title: '执行记录', icon: 'Timer' },
    ],
  },
  { path: '/devices', title: '设备管理', icon: 'Box' },
  {
    title: '模型管理',
    icon: 'Collection',
    children: [
      { path: '/models', title: '模型库', icon: 'Collection' },
      // 模型分析（原三维底座 POC，阶段 0 验证通过后转正为功能页）
      { path: '/models/geo-cesium', title: '模型分析', icon: 'DataLine' },
    ],
  },
  {
    title: '工单管理',
    icon: 'Tickets',
    children: [
      { path: '/assets', title: '巡检成果', icon: 'FolderOpened' },
      // 「影像审核」独立菜单已删除：入口统一收到巡检成果的「审核影像」，
      // 建出的图斑/工单分别在工作台右栏与工单列表看，不再需要单独的队列页。
      { path: '/tickets', title: '工单列表', icon: 'Tickets' },
      { path: '/stats', title: '台账统计', icon: 'DataAnalysis' },
      { path: '/admin/dict', title: '问题字典', icon: 'Notebook' },
      { path: '/admin/recipients', title: '派发对象', icon: 'User' },
      { path: '/admin/mail', title: '邮件配置', icon: 'Message' },
    ],
  },
  { path: '/admin', title: '其他设置', icon: 'Setting' },
  { path: '/admin/status', title: '系统状态', icon: 'Monitor' },
];

/** 分组展开态：默认收起，当前路由落在组内时自动展开 */
const openGroups = ref(new Set());
function groupActive(item) {
  return (item.children || []).some((c) => c.path && route.path.startsWith(c.path));
}
function hasOpened(item) {
  return openGroups.value.has(item.title);
}
function isOpen(item) {
  return hasOpened(item) || groupActive(item);
}
function toggle(item) {
  const s = new Set(openGroups.value);
  if (isOpen(item)) s.delete(item.title);
  else s.add(item.title);
  openGroups.value = s;
}
/** 分组上的角标：取子项角标之和（暂无数据的保持 0 不显示） */
function groupBadge(item) {
  const n = (item.children || []).reduce((acc, c) => acc + (c.badge ? Number(badgeValue(c.badge)) || 0 : 0), 0);
  return n > 0 ? n : 0;
}

const pageTitle = computed(() => route.meta?.title || 'DUAV · 无人机巡检监管平台');
const pageSubtitle = computed(() => route.meta?.subtitle || '');
/** 大屏 / 座舱需要满屏铺底，不加内边距 */
const isFullPage = computed(() => !!route.meta?.full);

const badgeValue = (k) => (k === 'online' ? store.onlineAirports.length + store.onlineDrones.length : 0);

/** 顶栏时钟（设计稿右上角的时间） */
const now = ref(new Date());
const clockText = computed(() => {
  const d = now.value;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
});
let timer = null;

/**
 * 轮询状态指示
 * 各页面自己的定时器负责刷新，并把 progress 写进 store（polling / lastRefreshAt），
 * 这里只做展示：正在刷 → 「刷新中」；最近 30s 内刷过 → 「Ns 前已刷新」；否则 → 「已停止」。
 * 之前界面上完全看不出在不在轮询，出问题时用户无法判断是数据没刷还是界面卡了。
 */
const pollState = computed(() => {
  if (store.polling) return { text: '刷新中…', cls: 'ok', title: '正在拉取设备物模型与 HMS' };
  if (!store.lastRefreshAt) return { text: '暂无轮询', cls: '', title: '当前页面没有启动物模型轮询' };
  const sec = Math.max(0, Math.floor((now.value.getTime() - store.lastRefreshAt) / 1000));
  if (sec <= 30) return { text: `${sec}s 前已刷新`, cls: 'ok', title: `最近一次刷新：${new Date(store.lastRefreshAt).toLocaleTimeString()}` };
  return { text: `轮询已停止（${sec}s）`, cls: 'warn', title: '超过 30 秒没有刷新，请检查网络或后端连接' };
});

async function onProjectChange(uuid) {
  await store.selectProject(uuid);
  ElMessage.success('已切换项目');
}

async function onTokenCommand(cmd) {
  if (cmd === 'manage') return router.push('/admin');
  if (cmd.startsWith('use:')) {
    await store.activateToken(cmd.slice(4));
    ElMessage.success('已切换组织');
  }
}

async function refresh() {
  await store.init();
  ElMessage.success('已刷新');
}

onMounted(() => {
  store.init();
  timer = setInterval(() => (now.value = new Date()), 1000);
});
onUnmounted(() => timer && clearInterval(timer));
</script>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; background: var(--c-bg-0); }

/* ---------- 顶栏 ---------- */
.topbar {
  height: var(--topbar-h); flex: 0 0 var(--topbar-h);
  display: flex; align-items: center; gap: 16px; padding: 0 14px;
  background: var(--c-bg-1); border-bottom: 1px solid var(--c-line-soft);
}
.brand { display: flex; align-items: center; gap: 9px; width: calc(var(--sidebar-w) - 14px); flex: 0 0 auto; }
.brand-mark {
  width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
  background: var(--c-brand); color: #fff;
}
.brand-title { font-size: var(--fs-lg); font-weight: 600; letter-spacing: .2px; white-space: nowrap; }

.topbar-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.topbar-title .t { font-size: var(--fs-lg); font-weight: 600; }
.topbar-title .s { font-size: var(--fs-md); color: var(--c-text-2); }
.tag.live { padding: 1px 7px; }

.topbar-right { display: flex; align-items: center; gap: 10px; }
.env { font-size: var(--fs-sm); color: var(--c-text-2); white-space: nowrap; }
.icon-btn {
  width: 28px; height: 28px; border-radius: var(--r-sm);
  background: var(--c-bg-2); border: 1px solid var(--c-line);
  color: var(--c-text-1); display: grid; place-items: center; cursor: pointer;
  transition: all .15s;
}
.icon-btn:hover { color: #fff; border-color: rgba(255, 255, 255, .22); background: var(--c-bg-3); }
.icon-btn:disabled { opacity: .5; cursor: default; }
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- 主体 ---------- */
.body { flex: 1; display: flex; min-height: 0; }

.sidebar {
  width: var(--sidebar-w); flex: 0 0 var(--sidebar-w);
  background: var(--c-bg-1); border-right: 1px solid var(--c-line-soft);
  display: flex; flex-direction: column; padding: 10px 8px 0;
}
.nav-item {
  position: relative;
  display: flex; align-items: center; gap: 10px; padding: 9px 11px; margin-bottom: 2px;
  border-radius: var(--r-sm); color: var(--c-text-1); cursor: pointer;
  font-size: var(--fs-md); transition: all .15s;
}
.nav-item:hover { background: var(--c-bg-2); color: var(--c-text-0); }
.nav-item.active { background: var(--c-brand-dim); color: var(--c-brand); font-weight: 600; }
.nav-item.active::before {
  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: 3px; height: 16px; border-radius: 0 2px 2px 0; background: var(--c-brand);
}
.nav-item .el-icon { font-size: 15px; }
/* ---------- 可折叠分组 ---------- */
.nav-item.group { color: var(--c-text-1); }
.nav-item.group .caret {
  margin-left: auto; font-size: 12px; opacity: .6; transition: transform .18s;
}
.nav-item.group .caret.rot { transform: rotate(90deg); }
/* 组内有选中子项时，父项标题也要亮起来（但不用选中态的深色底） */
.nav-item.group.group-on { color: var(--c-brand); }
.nav-item.group.group-on .el-icon { color: var(--c-brand); }
.nav-item.sub {
  padding-left: 30px; font-size: var(--fs-sm); color: var(--c-text-2);
  gap: 8px; margin-bottom: 1px;
}
.nav-item.sub:hover { color: var(--c-text-0); }
.nav-item.sub.active { color: var(--c-brand); background: var(--c-brand-dim); }
.nav-item.sub .sub-dot {
  width: 4px; height: 4px; border-radius: 50%; background: currentColor;
  opacity: .45; flex: 0 0 auto;
}
.nav-item.sub.active .sub-dot { opacity: 1; }
.nav-item.sub .sub-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-badge {
  margin-left: auto; font-size: var(--fs-xs); background: var(--c-brand);
  color: #fff; border-radius: 9px; padding: 0 6px; line-height: 16px;
}
.sidebar-foot {
  margin-top: auto; display: flex; align-items: center; gap: 6px;
  padding: 10px 11px; border-top: 1px solid var(--c-line-soft);
  font-size: var(--fs-xs); color: var(--c-text-2);
}
.sidebar-foot .dot { width: 6px; height: 6px; border-radius: 50%; }
.sidebar-foot .ver { margin-left: auto; }

.content { flex: 1; min-width: 0; overflow: auto; padding: 12px; }
.content-full { padding: 0; overflow: hidden; }
</style>
