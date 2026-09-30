<template>
  <div class="cockpit">
    <div class="cockpit-body">
      <!-- 左列：实时地图 + 机场相机 + HMS -->
      <div class="col-left">
        <div class="card map-card">
          <div class="card-head">
            <span>实时地图</span>
            <span class="sub">{{ flightTaskLabel }}</span>
          </div>
          <div class="card-body" style="padding: 0; overflow: hidden">
            <BaseMap ref="mapRef" :markers="markers" :polylines="trackLine" :zoom="16" />
          </div>
        </div>

        <!-- 固定为机场相机：一个「机场直播」按钮切换开/停。
             不再提供舱外/舱内切换 —— 本场 Dock 只上报 indoor，舱外相机是可选配件，
             切过去 change-camera 假成功但设备不推流，是个必然失败的死选项。 -->
        <div class="card cam-card">
          <div class="card-head">
            <span>现场画面</span>
            <el-button
              size="small"
              :loading="dockLoading"
              :type="dockStreamOn ? 'danger' : 'primary'"
              :disabled="!airportCameraIndex"
              @click="dockStreamOn ? stopDockStream() : startSideStream()"
            >
              {{ dockStreamOn ? '停止机场直播' : '机场直播' }}
            </el-button>
          </div>
          <div class="cam-stage">
            <LivePlayer
              ref="dockPlayer"
              :url="dockLive.url"
              :url-type="dockLive.urlType"
              :params="dockLive.params"
              :no-frame-hint="sideNoFrameHint"
              :black-hint="sideBlackHint"
              :placeholder="airportCameraIndex ? '点击右上「机场直播」' : '该机场未上报相机'"
              @stalled="onSideStalled"
              @black="onSideBlack"
              @switch-position="switchSidePosition"
              @retry="() => startSideStream()"
            />
            <div v-if="dockLive.url" class="cam-live"><span class="dot"></span>LIVE</div>
            <div v-if="airportCameraLabel" class="cam-tag">{{ airportCameraLabel }}</div>
          </div>
        </div>

        <div class="card hms-panel">
          <div class="card-head">
            <span>HMS 状态码</span>
            <span class="sub" :style="hmsWorst ? `color: ${hmsWorst.color}` : ''">
              {{ hmsLoading ? '查询中…' : hms.length ? hmsSummary : '正常' }}
            </span>
          </div>
          <div class="card-body hms-body">
            <div v-if="!hms.length" class="small muted">无异常状态码</div>
            <div v-for="(h, i) in hmsSorted" :key="i" class="hms-item">
              <div class="hms-row">
                <span class="hms-lv" :style="{ color: hmsLv(h).color, borderColor: hmsLv(h).color }">
                  {{ hmsLv(h).text }}
                </span>
                <span class="mono small">{{ h.code || h.hms_code || '-' }}</span>
                <span v-if="h.imminent" class="hms-imminent">即将发生</span>
                <div style="flex: 1"></div>
                <button
                  v-if="hasSub(h)"
                  class="hms-toggle"
                  @click="toggleSub(i)"
                >{{ subOpen[i] ? '收起根因' : `根因 ${h.sub_hms_list.length}` }}</button>
              </div>
              <div class="small hms-src">{{ hmsSrc(h) }}</div>
              <div class="small hms-msg" :style="{ color: hmsLv(h).color }">
                {{ h.message || h.hms_message || h.description || '' }}
              </div>
              <div class="hms-time">{{ fmtTime(h.begin_time) }} → {{ h.end_time ? fmtTime(h.end_time) : '持续中' }}</div>
              <!-- 根因（sub_hms_list）：只有根因条目才值得下钻，展开后逐条列出子告警 -->
              <div v-if="hasSub(h) && subOpen[i]" class="hms-sub">
                <div v-for="(c, ci) in h.sub_hms_list" :key="ci" class="hms-sub-item">
                  <span class="hms-lv" :style="{ color: hmsLv(c).color, borderColor: hmsLv(c).color }">
                    {{ hmsLv(c).text }}
                  </span>
                  <span class="mono small">{{ c.code || '-' }}</span>
                  <div class="small" style="margin-top: 2px">{{ c.message || '' }}</div>
                  <div class="hms-time">{{ fmtTime(c.begin_time) }} → {{ c.end_time ? fmtTime(c.end_time) : '持续中' }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 中列：无人机主画面（最大）+ HUD 叠加 -->
      <div class="col-main">
        <div class="stage">
          <LivePlayer
            ref="player"
            :url="live.url"
            :url-type="live.urlType"
            :params="live.params"
            :no-frame-hint="liveNoFrameHint"
            :black-hint="liveBlackHint"
            :placeholder="'点击底部红色「直播」按钮开启无人机画面'"
            @error="onLiveError"
            @stalled="onLiveStalled"
            @retry="onLiveRetry"
          />

          <!-- HUD 叠加层（未出图时降透明度，仅作遥测参考） -->
          <div class="hud" :class="{ dim: !live.url }">
            <div class="hud-top">
              <span v-if="live.url" class="rec"><span class="dot"></span>REC {{ recTime }}</span>
              <span
                class="hud-chip"
                :style="drone?.online ? '' : 'color: var(--c-warn); border-color: rgba(255,176,32,.4)'"
              >
                <span class="dot"></span>{{ drone?.online ? droneModeText : '飞行器离线 · 遥测为最后一次上报' }}
              </span>
              <span class="hud-chip"><span class="k">高度</span>{{ hud.height }}</span>
              <span class="hud-chip"><span class="k">速度</span>{{ hud.speed }}</span>
              <span class="hud-chip"><span class="k">RTK</span>{{ hud.rtk }}</span>
              <span class="hud-chip"><span class="k">卫星</span>{{ hud.satellites }}</span>
              <span class="hud-chip"><span class="k">电量</span>{{ hud.battery }}</span>
            </div>

            <div class="hud-bottom">
              <span class="hud-chip"><span class="k">高度</span>{{ hud.height }}</span>
              <span class="hud-chip"><span class="k">速度</span>{{ hud.speed }}</span>
              <span class="hud-chip"><span class="k">航段</span>{{ hud.course }}</span>
              <span class="hud-chip"><span class="k">升降</span>{{ hud.vspeed }}</span>
              <span v-if="liveInfo" class="hud-chip">{{ liveInfo.cameraIndex }}</span>
            </div>

            <div class="compass">
              <div class="ticks">
                <i v-for="n in 9" :key="n" :class="{ hi: n === 5 }" :style="{ height: n === 5 ? '14px' : n % 2 ? '6px' : '10px' }"></i>
              </div>
              HOG {{ hud.heading }}°
            </div>
          </div>

          <div v-if="!live.url" class="stage-empty">
            <div class="t">无人机实时画面</div>
            <div class="s">{{ stageEmptyHint }}</div>
          </div>
        </div>

        <!-- 自动开机链路进度 -->
        <div v-if="liveSteps.length" class="live-steps">
          <div v-for="s in liveSteps" :key="s.key" class="takeoff-step">
            <span class="dot" :class="s.status === 'success' ? 'success' : s.status === 'fail' ? 'fail' : 'skip'"></span>
            <span style="font-weight: 600">{{ s.title }}</span>
            <span class="muted">{{ s.message }}</span>
          </div>
          <div v-if="powerWaiting" class="small muted">
            正在等待机场开舱上电（每 5 秒自动检查一次）…
            <el-button size="small" text type="danger" @click="stopPowerPolling">取消</el-button>
          </div>
        </div>

        <div v-if="logHint" class="stage-hint">{{ logHint }}</div>
      </div>

    </div>

    <!-- 底部操作条：设备与控制权 | 常用功能 | 直播 -->
    <div class="cockpit-bar">
      <div class="bar-left">
        <el-select v-model="dockSn" size="small" style="width: 160px" placeholder="选择机场">
          <el-option v-for="a in store.airports" :key="a.sn" :label="label(a)" :value="a.sn" />
        </el-select>
        <el-select v-model="droneSn" size="small" style="width: 175px" placeholder="选择飞行器">
          <el-option v-for="d in store.drones" :key="d.sn" :label="label(d)" :value="d.sn" />
        </el-select>
        <span class="tag" :class="control ? 'ok' : ''">
          <span class="dot"></span>{{ control ? '控制权已获取' : '控制权未获取' }}
        </span>
        <el-button
          size="small"
          :loading="ctrlLoading"
          :disabled="!droneSn"
          @click="control ? releaseControl() : takeControl()"
        >
          {{ control ? '释放控制权' : '获取控制权' }}
        </el-button>
      </div>

      <div class="bar-actions">
        <button class="bar-btn" :disabled="!dockSn" @click="openTakeoff">
          <el-icon><Top /></el-icon>快速起飞
        </button>
        <button class="bar-btn" @click="sendCommand('return_home')">
          <el-icon><RefreshLeft /></el-icon>一键返航
        </button>
        <button class="bar-btn" :disabled="!availableLens.includes('ir')" @click="onLensChange('ir')">
          <el-icon><Aim /></el-icon>切换红外
        </button>
        <button class="bar-btn" @click="cycleBasemap">
          <el-icon><MapLocation /></el-icon>切换星图
        </button>
      </div>

      <div class="bar-right">
        <button
          class="btn-live"
          :class="{ on: !!live.url }"
          :disabled="liveLoading"
          @click="live.url ? stopLive() : startLive()"
        >
          <el-icon><VideoCamera /></el-icon>{{ live.url ? '停止直播' : '直播' }}
        </button>
      </div>
    </div>

    <!-- 一键起飞弹窗 -->
    <el-dialog v-model="takeoffVisible" title="一键起飞" width="520px" destroy-on-close @close="closeTakeoff">
      <div style="display: flex; flex-direction: column; gap: 12px">
        <div class="small muted">
          一键起飞将自动执行：起飞前预检 → 获取控制权 → 创建立即航线任务 → 机场开舱上电起飞。
        </div>
        <div>
          <div class="small muted" style="margin-bottom: 4px">起飞机场</div>
          <el-input :model-value="dockSn" disabled size="small" />
        </div>
        <div>
          <div class="small muted" style="margin-bottom: 4px">
            航线 <span class="required">*</span>
            <span v-if="droneModelKey">（已按飞行器机型 {{ droneModelKey }} 过滤）</span>
          </div>
          <el-select v-model="takeoffWaylineId" size="small" placeholder="选择航线" style="width: 100%">
            <el-option v-for="w in takeoffWaylines" :key="w.id" :label="w.name" :value="w.id" />
          </el-select>
          <div v-if="!takeoffWaylines.length" class="small" style="color: var(--warn); margin-top: 4px">
            当前飞行器机型（{{ droneModelKey || '未知' }}）没有匹配的航线，请先在航线规划中上传对应机型航线
          </div>
        </div>
        <div style="display: flex; gap: 10px">
          <div style="flex: 1">
            <div class="small muted" style="margin-bottom: 4px">返航高度（m）</div>
            <el-input-number v-model="takeoffRth" :min="30" :max="800" size="small" style="width: 100%" />
          </div>
          <div style="flex: 1">
            <div class="small muted" style="margin-bottom: 4px">任务精度</div>
            <el-select v-model="takeoffPrecision" size="small" style="width: 100%">
              <el-option label="RTK 高精度" value="rtk" />
              <el-option label="GNSS 普通" value="gps" />
            </el-select>
          </div>
        </div>
        <div>
          <el-checkbox v-model="takeoffAcquireControl" size="small">起飞前获取控制权（用于远程开机）</el-checkbox>
        </div>

        <!-- 步骤与结果 -->
        <div v-if="takeoffSteps.length" class="card" style="margin-top: 4px">
          <div class="card-body small" style="display: flex; flex-direction: column; gap: 6px">
            <div v-for="step in takeoffSteps" :key="step.key" class="takeoff-step">
              <span class="dot" :class="step.status"></span>
              <span style="font-weight: 600">{{ step.title }}</span>
              <span class="muted">{{ step.message }}</span>
            </div>
          </div>
        </div>
        <div v-if="takeoffResult" class="card" style="margin-top: 4px">
          <div class="card-body small">
            <div v-if="takeoffResult.taskUuid">
              任务 UUID：<span class="mono">{{ takeoffResult.taskUuid }}</span>
            </div>
            <div style="margin-top: 4px">
              状态：
              <span class="tag" :class="takeoffResult.finished ? 'info' : 'ok'">
                {{ takeoffResult.finished ? '已完成' : '执行中' }}
              </span>
              <span v-if="takeoffResult.status" class="muted">（{{ takeoffResult.status }}）</span>
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button size="small" @click="closeTakeoff">取消</el-button>
        <el-button size="small" type="primary" :loading="takeoffLoading" @click="runTakeoff">确认起飞</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '../stores/session';
import { deviceApi, liveApi, waylineApi, taskApi, takeoffApi, errMsg } from '../api/dji';
import BaseMap from '../components/BaseMap.vue';
import LivePlayer from '../components/LivePlayer.vue';
import { taskName as buildTaskName, fmtTime } from '../utils/format';
import {
  CLASS,
  positionOrder,
  positionText,
  nextPosition,
  supportsBlackFallback,
} from '../utils/cameraProfile';
import {
  modeText,
  hmsLevel,
  HMS_MODULE_TEXT,
  HMS_SKY_TEXT,
  DOMAIN_TEXT_MAP,
} from '../utils/dict';

const store = useSessionStore();
const tab = ref('telemetry');
const dockSn = ref('');
const droneSn = ref('');
const control = ref(false);
const controlInfo = ref(null);
const ctrlLoading = ref(false);
const liveLoading = ref(false);

const dockCameraIndex = ref('');
const lensType = ref('wide');
const quality = ref('adaptive');
/** HMS 状态码（侧边小窗口） */
const hms = ref([]);
const hmsLoading = ref(false);

/** 等级权重：warning > reminder > notification，重的排前面；同级按「即将发生」→ 时间倒序 */
const HMS_ORDER = { warning: 0, reminder: 1, notification: 2 };
const hmsLv = (h) => hmsLevel(h.level);
const hmsSorted = computed(() =>
  [...hms.value].sort((a, b) => {
    const lv = (HMS_ORDER[hmsLv(a).key] ?? 9) - (HMS_ORDER[hmsLv(b).key] ?? 9);
    if (lv !== 0) return lv;
    const im = Number(!!b.imminent) - Number(!!a.imminent);
    if (im !== 0) return im;
    return Number(b.begin_time || 0) - Number(a.begin_time || 0);
  })
);
/** 最严重的一条（决定表头颜色） */
const hmsWorst = computed(() => (hmsSorted.value.length ? hmsLv(hmsSorted.value[0]) : null));
const hmsSummary = computed(() => {
  if (!hms.value.length) return '正常';
  const c = { warning: 0, reminder: 0, notification: 0 };
  hms.value.forEach((h) => { const k = hmsLv(h).key; if (k in c) c[k] += 1; });
  const parts = [];
  if (c.warning) parts.push(`告警 ${c.warning}`);
  if (c.reminder) parts.push(`注意 ${c.reminder}`);
  if (c.notification) parts.push(`通知 ${c.notification}`);
  return parts.length ? parts.join(' · ') : `${hms.value.length} 条`;
});
/** HMS 来源：模块 · 设备域 · 地面/空中 · 设备尾号 */
const hmsSrc = (h) =>
  [
    HMS_MODULE_TEXT[h.module],
    DOMAIN_TEXT_MAP[h.domain_type],
    HMS_SKY_TEXT[h.in_the_sky],
    h._sn ? `…${String(h._sn).slice(-6)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

/** 是否有根因（sub_hms_list）可展开 */
const hasSub = (h) => Array.isArray(h?.sub_hms_list) && h.sub_hms_list.length > 0;
/** 根因展开状态，key 用排序后的下标 */
const subOpen = ref({});
const toggleSub = (i) => {
  subOpen.value = { ...subOpen.value, [i]: !subOpen.value[i] };
};

const live = ref({ url: '', urlType: '', params: null, expire_ts: 0 });
const liveInfo = ref(null);
/** 当前主画面使用的相机索引 */
const liveCameraIndex = ref('');
/** 候选相机索引（后端按 lens_list 镜头能力排序），无帧时按顺序逐路回退 */
const liveCameraCandidates = ref([]);
/** 直播状态说明：错误码释义 / 切换提示，展示在画面下方 */
const logHint = ref('');
/** 无人机自动开机链路的步骤进度 */
const liveSteps = ref([]);
const powerWaiting = ref(false);
const powerTaskUuid = ref('');
let powerTimer = null;
const player = ref(null);
/** 左列小地图（用于「切换星图」） */
const mapRef = ref(null);
/** 左列现场画面播放器与独立直播会话 */
const dockPlayer = ref(null);
const dockLive = ref({ url: '', urlType: '', params: null, info: '' });
const dockStreamOn = ref(false);
const dockLoading = ref(false);
/** 录像计时（HUD 左上 REC） */
const recTime = ref('00:00:00');
let recTimer = null;
/** 遥测自动刷新（飞行器起飞后 HUD/地图需要持续更新） */
let stateTimer = null;

const waylines = ref([]);
const taskName = ref('');
const precision = ref('rtk');
const currentTask = ref(null);
const trackLine = ref([]);

// 一键起飞弹窗
const takeoffVisible = ref(false);
const takeoffWaylineId = ref('');
const takeoffRth = ref(100);
const takeoffPrecision = ref('rtk');
const takeoffAcquireControl = ref(true);
const takeoffLoading = ref(false);
const takeoffResult = ref(null);
const takeoffSteps = ref([]);
let takeoffTimer = null;

const dock = computed(() => store.airports.find((a) => a.sn === dockSn.value) || null);
const drone = computed(() => store.drones.find((d) => d.sn === droneSn.value) || null);
/** 飞行器飞行状态（mode_code → 中文），HUD 上替代原来含糊的「图传在线」 */
const droneModeText = computed(() => modeText('drone', drone.value?.modeCode));
/** 机场工作状态（mode_code → 中文） */
const dockModeText = computed(() => modeText('airport', store.airports.find((a) => a.sn === dockSn.value)?.modeCode));
const dockState = computed(() => (dockSn.value ? store.states[dockSn.value] : null));
const droneState = computed(() => (droneSn.value ? store.states[droneSn.value] : null));

/**
 * 无帧提示的补充说明：按「当前飞行器实际状态」给出可执行的建议。
 * 之前写死一句「请确认 camera_list 有值」，而实测 camera_list 明明有值，反而误导。
 */
/** 主画面黑屏提示：飞行器在舱内、镜头盖未摘、夜间无光都会是纯黑 */
const liveBlackHint = computed(() => {
  const inDock = droneState.value?.device_state?.drone_in_dock;
  if (inDock && inDock !== 'outside') {
    return '飞行器还在舱内：舱内无光照时云台拍到的就是纯黑，需先执行起飞任务出舱。';
  }
  return '请确认镜头盖已摘下、当前环境有光照；也可切换镜头（如红外 IR）确认相机工作正常。';
});

const liveNoFrameHint = computed(() => {
  const d = drone.value;
  if (!d?.online) {
    return '当前飞行器离线：司空 2 没有远程开机接口，需先下发起飞任务让机场开舱上电。';
  }
  if (!(d.cameraList || []).length) {
    return '当前飞行器 camera_list 为空，图传通道不存在，请先执行起飞任务让飞行器上电。';
  }
  return '飞行器已在线且 camera_list 正常，属于舱内待机未推流；执行航线任务后画面会持续输出。';
});

/** 飞行器机型 key：司空 2 要求航线 device_model_key 与飞行器机型一致，否则创建任务报 invalid param format */
const droneModelKey = computed(() => drone.value?.modelKey || '');
/** 一键起飞可选航线：只保留与当前飞行器机型匹配的航线 */
const takeoffWaylines = computed(() => {
  const key = droneModelKey.value;
  if (!key) return waylines.value;
  return waylines.value.filter((w) => !w.device_model_key || w.device_model_key === key);
});

/** 设备下拉文案：callsign 与型号/SN 重复时改用 SN 尾号，避免下拉被撑爆 */
function label(d) {
  const isDrone = d.kind === 'drone';
  const named = d.callsign && d.callsign !== d.model && d.callsign !== d.sn;
  const name = named ? d.callsign : isDrone ? `…${(d.sn || '').slice(-6)}` : d.sn;
  return `${name} · ${d.model}${d.online ? '' : ' (离线)'}`;
}

const dockCameras = computed(() => dock.value?.cameraList || []);
const droneCameras = computed(() => drone.value?.cameraList || []);
/** 镜头 / 清晰度 / 控制权作用在飞行器的主云台相机上（与中间大画面用同一路） */
const activeDroneCamera = computed(() => droneCameras.value[0]);
/** 飞行器主云台相机的 camera_index（控制权 payload_index / 镜头 / 清晰度都用它） */
const droneCameraIndex = computed(() => activeDroneCamera.value?.camera_index || '');
const availableLens = computed(() => activeDroneCamera.value?.lens_list?.[0]?.available_lens_types || []);
const lensName = (l) => ({ wide: '广角', zoom: '变焦', ir: '红外', normal: '默认' }[l] || l);


/** 机位覆盖值：画面全黑自动回退 / 用户手动切换时写入，换机场即清空（不按设备记忆） */
const positionOverride = ref('');

/**
 * 左列「现场画面」= 机场相机
 *
 * 机位选择按「设备类型范式」走（见 utils/cameraProfile.js）：
 *   - 范式顺序：舱外 → 舱内，对所有 Dock 3 一致，不针对某台机场写分支
 *   - 设备上报的 camera_position 只作参考：实测有机场只报 indoor 但 outdoor 才有画面，
 *     只信上报会让这类机场永远黑屏
 *   - 哪个机位真的有画面，由运行时实测决定：画面全黑就自动切下一机位（不是用户去猜）
 */
const airportCameraIndex = computed(() => dockCameras.value[0]?.camera_index || '');
/** 设备类型（用于取范式；机场=airport） */
const dockClass = computed(() => dock.value?.deviceClass || CLASS.AIRPORT);
/** 机位候选顺序（类型级范式 + 上报补充） */
const airportPositionOrder = computed(() =>
  positionOrder(dockClass.value, dockCameras.value.map((c) => c.camera_position).filter(Boolean))
);
/** 当前生效机位：范式首选项 + 黑屏回退后的覆盖值 */
const airportPosition = computed(
  () => positionOverride.value || airportPositionOrder.value[0] || 'indoor'
);
/** 画面角标文案：明确告诉用户这是哪一路、哪个机位 */
const airportCameraLabel = computed(() => {
  if (!airportCameraIndex.value) return '';
  return `机场${positionText(airportPosition.value)}（${airportCameraIndex.value}）`;
});

/** 机场画面黑屏时的说明：告诉用户系统会自动换机位，而不是让他干等 */
const sideBlackHint = computed(() => {
  const pos = positionText(airportPosition.value);
  const next = nextPosition(airportPositionOrder.value, airportPosition.value);
  const tail = next
    ? `已自动切换到${positionText(next)}机位重试；若仍全黑可点「切换机位」手动试。`
    : '所有机位都是纯黑，多为舱内无光照或镜头被遮挡。';
  return `当前${pos}机位画面全黑（相机未接收到光线）。${tail}`;
});

/** 机场画面无帧时的补充说明 */
const sideNoFrameHint = computed(() => {
  if (!dockCameras.value.length) {
    return '该机场未上报任何相机，请先确认机场在线状态与 HMS 告警。';
  }
  if (airportPosition.value === 'indoor') {
    return '该机场只装了舱内相机（舱外相机为可选配件）；若长时间无画面，请检查相机是否被其它会话占用。';
  }
  return '若长时间无画面，可点「机场直播」重新开播。';
});

/** 当前执行航线名（地图卡片副标题）：只由正在执行的任务决定 */
const flightTaskLabel = computed(() => currentTask.value?.name || '待命');

/**
 * 主画面空状态文案：按飞行器真实状态给出**可执行**的下一步。
 * 之前统一写「会自动获取控制权并下发起飞任务上电」——实测这条链路在没有航线时
 * 走不通（司空 2 没有远程开机接口，只有创建立即飞行任务才会让机场给飞行器上电），
 * 泛泛的说明会让用户一直等一个不会发生的动作。
 */
const stageEmptyHint = computed(() => {
  const d = drone.value;
  if (!d) return '请先在底部选择飞行器';
  if (!d.online) {
    return '飞行器当前离线：司空 2 没有远程开机接口，需现场给飞行器开机；或用「快速起飞」让机场开舱上电起飞后自动出图。';
  }
  if (!(d.cameraList || []).length) {
    return '飞行器已在线但未上报相机（camera_list 为空），请稍候重试或确认飞行器固件状态。';
  }
  return '飞行器已在线，点击底部红色「直播」接入图传。';
});

/** 视频 HUD 遥测（取自飞行器物模型） */
const hud = computed(() => {
  const s = droneState.value?.device_state || {};
  const ps = s.position_state || {};
  const num = (v, digits = 1) => (v === undefined || v === null || v === '' ? '-' : Number(v).toFixed(digits));
  const heading = Number(s.attitude_heading || 0);
  const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8];
  return {
    height: `${num(s.height)} m`,
    speed: `${num(s.horizontal_speed)} m/s`,
    vspeed: `${Number(s.vertical_speed ?? 0) >= 0 ? '+' : ''}${num(s.vertical_speed)} m/s`,
    course: `${Math.round(heading)}° ${dir}`,
    heading: String(Math.round(heading)),
    rtk: ps.is_fixed ? 'FIX' : ps.rtk_number ? 'RTK' : '-',
    satellites: ps.gps_number ?? '-',
    battery: s.battery?.capacity_percent !== undefined ? `${s.battery.capacity_percent}%` : '-',
  };
});

function startRecTimer() {
  recStart = Date.now();
  if (recTimer) clearInterval(recTimer);
  const tick = () => {
    const el = Math.floor((Date.now() - recStart) / 1000);
    const p = (n) => String(n).padStart(2, '0');
    recTime.value = `${p(Math.floor(el / 3600))}:${p(Math.floor((el % 3600) / 60))}:${p(el % 60)}`;
  };
  tick();
  recTimer = setInterval(tick, 1000);
}
let recStart = 0;
function stopRecTimer() {
  if (recTimer) clearInterval(recTimer);
  recTimer = null;
  recTime.value = '00:00:00';
}

/** 循环切换底图（座舱「切换星图」） */
function cycleBasemap() {
  mapRef.value?.nextBasemap();
  ElMessage.success('已切换底图');
}

/** 位置：机场取物模型经纬度；飞行器优先实时位置，其次 home 点 */
function posOf(state) {
  const s = state?.device_state;
  if (!s) return null;
  const lat = s.latitude;
  const lng = s.longitude;
  if (lat === undefined || lng === undefined || (lat === 0 && lng === 0)) {
    if (s.home_latitude !== undefined && s.home_longitude !== undefined && !(s.home_latitude === 0 && s.home_longitude === 0)) {
      return { lat: s.home_latitude, lng: s.home_longitude };
    }
    return null;
  }
  return { lat, lng };
}

const markers = computed(() => {
  const list = [];
  const dp = posOf(dockState.value);
  if (dp && dock.value) {
    list.push({
      type: 'airport',
      sn: dock.value.sn,
      name: `${dock.value.callsign}（机场）`,
      lat: dp.lat,
      lng: dp.lng,
      online: dock.value.online,
      extra: `高度 ${dockState.value?.device_state?.height ?? '-'} m`,
    });
  }
  const rp = posOf(droneState.value);
  if (rp && drone.value) {
    list.push({
      type: 'drone',
      sn: drone.value.sn,
      name: `${drone.value.callsign || drone.value.sn}（飞行器）`,
      lat: rp.lat,
      lng: rp.lng,
      heading: droneState.value?.device_state?.attitude_heading || 0,
      online: drone.value.online,
      extra: `高度 ${droneState.value?.device_state?.height ?? '-'} m · 电量 ${batteryText(droneState.value)}`,
    });
    // 返航点在飞行器所属机场内，坐标与机场重合；BaseMap 会自动省略这类重合标记，
    // 避免「H」盖住机场实拍图标
    if (droneState.value?.device_state?.home_latitude) {
      list.push({
        type: 'home',
        name: '返航点',
        lat: droneState.value.device_state.home_latitude,
        lng: droneState.value.device_state.home_longitude,
        extra: 'Home',
      });
    }
  }
  return list;
});

function batteryText(state) {
  const cap = state?.device_state?.battery?.capacity_percent ?? state?.device_state?.capacity_percent;
  return cap === undefined ? '-' : `${cap}%`;
}

const telemetry = computed(() => {
  const out = [];
  if (dock.value) {
    const s = dockState.value?.device_state || {};
    out.push({ k: '机场状态', v: dock.value.online ? '在线' : '离线' });
    if (s.mode_code !== undefined) out.push({ k: '机场模式', v: airportMode(s.mode_code) });
    if (s.drone_charge_state?.capacity_percent !== undefined)
      out.push({ k: '飞行器电量', v: `${s.drone_charge_state.capacity_percent}%` });
    // live_capacity 是对象：{available_video_number, coexist_video_number_max, device_list}
    if (s.live_capacity && typeof s.live_capacity === 'object') {
      const av = s.live_capacity.available_video_number;
      const max = s.live_capacity.coexist_video_number_max;
      if (av !== undefined) out.push({ k: '可用直播路数', v: `${av}/${max ?? '-'}` });
    } else if (s.live_capacity !== undefined && s.live_capacity !== null) {
      out.push({ k: '直播剩余', v: String(s.live_capacity) });
    }
    if (s.drone_in_dock !== undefined) out.push({ k: '飞行器在舱', v: s.drone_in_dock ? '是' : '否' });
  }
  if (drone.value) {
    const s = droneState.value?.device_state || {};
    out.push({ k: '飞行器状态', v: drone.value.online ? '在线' : '离线' });
    if (s.mode_code !== undefined) out.push({ k: '飞行模式', v: droneMode(s.mode_code) });
    if (s.height !== undefined) out.push({ k: '高度', v: `${s.height} m` });
    if (s.elevation !== undefined) out.push({ k: '海拔', v: `${s.elevation} m` });
    if (s.battery?.capacity_percent !== undefined) out.push({ k: '电量', v: `${s.battery.capacity_percent}%` });
  }
  return out;
});

const airportMode = (c) =>
  typeof c === 'string'
    ? ({ idle: '空闲中', on_job: '作业中', debug: '现场调试', remote_debug: '远程调试', upgrade: '固件升级中', working: '作业中' }[c] || c)
    : { 0: '空闲中', 1: '现场调试', 2: '远程调试', 3: '固件升级中', 4: '作业中' }[c] || `未知(${c})`;
const droneMode = (c) =>
  typeof c === 'string'
    ? ({ standby: '待机', not_connected: '未连接', takeoff_preparing: '起飞准备', takeoff_ready: '起飞准备完毕', flying: '飞行中', manual: '手动飞行', auto: '自动飞行', returning: '自动返航', landing: '自动降落', upgrading: '升级中', paused: '暂停' }[c] || c)
    : {
        0: '待机', 1: '起飞准备', 2: '起飞准备完毕', 3: '手动飞行', 4: '自动起飞', 5: '航线飞行',
        6: '全景拍照', 9: '自动返航', 10: '自动降落', 13: '升级中', 14: '未连接', 19: '机场选址中',
      }[c] || `其他(${c})`;

async function refreshStates() {
  // 显式标记轮询状态：顶栏据此显示「刷新中」，避免用户分不清「数据没更新」和「界面卡了」
  store.polling = true;
  try {
    if (dockSn.value) await store.loadState(dockSn.value);
    if (droneSn.value) await store.loadState(droneSn.value);
  } finally {
    store.polling = false;
    store.lastRefreshAt = Date.now();
  }
  loadHms();
}

async function takeControl() {
  if (!droneSn.value) return ElMessage.warning('请先选择飞行器');
  ctrlLoading.value = true;
  // payload_index 可留空：后端会自动解析（飞行器自身 → 所属机场 → 兜底）
  const idx = droneCameraIndex.value ? [droneCameraIndex.value] : [];
  const r = await deviceApi.takeControl(droneSn.value, idx);
  ctrlLoading.value = false;
  if (r?.ok) {
    control.value = true;
    controlInfo.value = r.controlInfo || null;
    const types = (r.data?.controls || []).map((c) => (c.type === 'flight' ? '飞行控制权' : '负载控制权')).join(' + ');
    ElMessage.success(`已获取 ${types || '控制权'}，可执行远程开机与负载操作`);
  } else {
    ElMessage.error(
      `${errMsg(r, '控制权获取失败')}｜drone_sn 必须为飞行器 SN；若飞行器未开机，后端会自动回退使用机场相机索引`
    );
  }
}

async function releaseControl() {
  ctrlLoading.value = true;
  const idx = droneCameraIndex.value ? [droneCameraIndex.value] : [];
  const r = await deviceApi.releaseControl(droneSn.value, idx);
  ctrlLoading.value = false;
  if (r?.ok) {
    control.value = false;
    controlInfo.value = null;
    ElMessage.success('控制权已释放');
  } else {
    control.value = false;
    ElMessage.error(`${errMsg(r, '释放失败')}｜该接口为 DELETE + Body，payload 需与获取时一致`);
  }
}

/** HMS 状态码（机场 + 飞行器），侧边小窗口展示 */
async function loadHms() {
  const sns = [dockSn.value, droneSn.value].filter(Boolean);
  if (!sns.length) return;
  hmsLoading.value = true;
  const r = await deviceApi.hms(sns);
  hmsLoading.value = false;
  if (r?.ok) {
    // 打平各设备的 HMS 列表，并把来源设备 SN 带上，便于判断是机场还是飞行器的问题
    hms.value = (r.data?.list || []).flatMap((x) =>
      (x.device_hms?.list || []).map((h) => ({ ...h, _sn: x.device_sn }))
    );
  } else {
    hms.value = [];
  }
}

/** 镜头切换：作用在中间大画面（飞行器主云台相机）上 */
async function onLensChange(v) {
  const idx = droneCameraIndex.value;
  if (!droneSn.value || !idx) return ElMessage.warning('请先选择飞行器');
  const r = await deviceApi.changeLens(droneSn.value, idx, v);
  if (r?.ok) ElMessage.success(`镜头已切换为${lensName(v)}`);
  else ElMessage.error(errMsg(r, '镜头切换失败') + '（需先获取控制权）');
}

/** 清晰度：中间大画面改飞行器相机，左列机场画面改机场相机 */
async function onQualityChange(v) {
  const sn = live.value.url ? droneSn.value : dockSn.value;
  const idx = live.value.url ? droneCameraIndex.value : dockCameraIndex.value;
  if (!sn || !idx) return;
  const r = await deviceApi.setQuality(sn, idx, v);
  if (!r?.ok) ElMessage.error(errMsg(r, '清晰度设置失败'));
}

/** 底部「直播」按钮：始终走无人机画面的自动开机链路（对齐设计稿的单一主画面） */
async function startLive() {
  // 用户手动重开：清空上一次的相机回退记录，从后端推荐的首选相机重新开始
  stallRetry = 0;
  cameraTried = [];
  liveCameraCandidates.value = [];
  liveCameraIndex.value = '';
  return startDroneLive();
}

async function legacyStartLive() {
  const src = liveSource.value;
  const sn = src?.sn || dockSn.value;
  const idx = src?.cameraIndex || dockCameraIndex.value;
  if (!sn) return ElMessage.warning('请先选择机场');
  if (!idx) {
    // 飞行器关机时这一路在图传层面不存在，直接说明原因，不要让用户干等一个必然失败的拉流
    return ElMessage.warning(
      '飞行器未开机，没有可用的 camera_index，无法拉起自身图传。可改用「机场舱内直播」查看机舱内的飞机，或先执行起飞任务让飞行器上电。'
    );
  }
  // 机场相机：先下发 change-camera（indoor/outdoor），确保取的确实是对应那一路
  if (src?.group === 'dock') {
    const pos = src.position || 'indoor';
    const cr = await deviceApi.changeCamera(sn, idx, pos);
    if (!cr?.ok) {
      // 部分机场不支持切换，不阻断，仍尝试用原索引开播
      logHint.value = `机场相机切换未完成（${cr?.message || '未知'}），将直接用 ${idx} 开播`;
    }
  }
  liveLoading.value = true;
  const r = await liveApi.start({
    sn,
    camera_index: idx,
    video_expire: 7200,
    quality_type: quality.value,
  });
  liveLoading.value = false;
  if (r?.ok) {
    live.value = {
      url: r.data?.url || '',
      urlType: r.data?.url_type || '',
      params: r.data?.params || null,
      expire_ts: r.data?.expire_ts || 0,
    };
    liveInfo.value = r.liveInfo || null;
    logHint.value = '';
    const source = r.liveInfo?.sourceText ? `（${r.liveInfo.sourceText}）` : '';
    ElMessage.success(`直播已开启（供应商 ${r.data?.url_type}${source}）`);
  } else {
    // 后端已把司空 2 错误码翻译成人话，优先展示释义
    logHint.value = r?.hint || '';
    ElMessage.error(`${r?.hint || errMsg(r, '开启直播失败')}（code ${r?.code ?? '-'}）`);
  }
}

/**
 * 无人机直播自动开机链路
 * 后端：获取控制权 → 已上电则直接开播 → 未上电则创建立即任务（机场自动开舱上电起飞）→ 返回等待态
 * 前端：拿到等待态后每 5s 复调一次（带回 task_uuid 避免重复建任务），直到出画面
 * @param {boolean} quiet 静默模式（自动重连/轮询时不弹提示）
 * @param {string} cameraIndex 指定相机索引；不传则由后端按 lens_list 能力挑主云台相机
 */
async function startDroneLive(quiet = false, cameraIndex = '') {
  if (!droneSn.value) return ElMessage.warning('请先选择飞行器');
  liveLoading.value = true;
  const r = await liveApi.drone({
    dock_sn: dockSn.value,
    drone_sn: droneSn.value,
    // 底部不再有「执行航线」选择器；若刚在「快速起飞」里选过航线则复用它，
    // 否则后端返回 need_wayline，提示用户走「快速起飞」——那里才是选航线 + 上电的正规入口
    wayline_uuid: takeoffWaylineId.value || '',
    task_uuid: powerTaskUuid.value || '',
    auto_takeoff: true,
    video_expire: 7200,
    quality_type: quality.value,
    camera_index: cameraIndex || '',
  });
  liveLoading.value = false;
  liveSteps.value = r?.steps || [];

  if (r?.ok && r.live) {
    stopPowerPolling();
    live.value = {
      url: r.live.url || '',
      urlType: r.live.url_type || '',
      params: r.live.params || null,
      expire_ts: r.live.expire_ts || 0,
    };
    liveInfo.value = r.liveInfo || null;
    // 记住后端给出的候选顺序，无帧时可逐路回退
    liveCameraCandidates.value = r.liveInfo?.candidates || [];
    liveCameraIndex.value = r.liveInfo?.cameraIndex || '';
    if (liveCameraIndex.value && !cameraTried.includes(liveCameraIndex.value)) {
      cameraTried.push(liveCameraIndex.value);
    }
    logHint.value = '';
    stallRetry = 0;
    startRecTimer();
    if (!quiet) ElMessage.success(`无人机图传已开启（相机 ${liveCameraIndex.value || '-'}）`);
    return;
  }

  if (r?.phase === 'waiting_power_on') {
    powerTaskUuid.value = r.taskUuid || powerTaskUuid.value;
    if (!quiet) ElMessage.info(r.message || '已下发起飞任务，等待机场开舱上电…');
    startPowerPolling();
    return;
  }

  if (r?.phase === 'need_wayline') {
    ElMessage.warning(`${r.message}（请点底部「快速起飞」选一条航线）`);
    openDockFallback();
    return;
  }

  logHint.value = r?.message || '';
  ElMessage.error(r?.message || '无人机直播开启失败');
  openDockFallback();
}

/**
 * 无人机画面起不来时的兜底：确保左列机场画面在播。
 * 飞行器未开机时它自己的图传物理上不存在，此时机场镜头是唯一能看到现场的画面。
 */
function openDockFallback() {
  if (!airportCameraIndex.value) return;
  if (!dockStreamOn.value) startSideStream(true);
}

function startPowerPolling() {
  if (powerTimer) return;
  powerWaiting.value = true;
  let n = 0;
  powerTimer = setInterval(async () => {
    n += 1;
    if (n > 72) {
      stopPowerPolling();
      ElMessage.warning('等待飞行器上电超时（6 分钟），请确认机场状态后重试');
      return;
    }
    await startDroneLive(true);
  }, 5000);
}

function stopPowerPolling() {
  if (powerTimer) clearInterval(powerTimer);
  powerTimer = null;
  powerWaiting.value = false;
  powerTaskUuid.value = '';
}

/**
 * 画面中断 / 始终无帧 → 自动重连
 * LivePlayer 两种死法都会发 stalled：
 *   - no-frame：加入房间后一帧都没有（多半是这一路相机推不出流）
 *   - stall：出过帧后 currentTime 长时间不推进（推流中断）
 *
 * 「无帧」优先换一路相机再试：实测 Matrice 4TD 的 176-0-0 订阅成功、设备也上报在推流，
 * 但浏览器侧永远收不到帧；99-0-0（广角/变焦/红外主云台）正常。候选顺序由后端按
 * lens_list 能力给出，这里逐路回退，全部试完才退回「同一路重试」策略。
 */
let stallRetry = 0;
/** 本次会话已试过的相机索引 */
let cameraTried = [];
async function onLiveStalled(e) {
  if (!live.value.url) return;
  const reason = e?.reason === 'stall' ? 'stall' : 'no-frame';

  if (reason === 'no-frame') {
    const next = liveCameraCandidates.value.find((c) => !cameraTried.includes(c));
    if (next) {
      cameraTried.push(next);
      const total = liveCameraCandidates.value.length;
      logHint.value = `相机 ${liveCameraIndex.value || '-'} 无画面，正在切换 ${next}（第 ${cameraTried.length}/${total} 路）…`;
      await startDroneLive(true, next);
      return;
    }
  }

  if (stallRetry >= 3) {
    logHint.value =
      reason === 'stall'
        ? '画面已冻结，自动重连 3 次仍未恢复。飞行器在舱内待机时图传会间歇停推，执行航线任务后画面才稳定。'
        : `已把 ${cameraTried.join(' / ') || '全部'} 相机都试过，仍未出图。请确认飞行器已执行航线任务，或改用左列「现场画面」。`;
    return;
  }
  stallRetry += 1;
  logHint.value =
    reason === 'stall'
      ? `画面已停止更新，正在自动重连（第 ${stallRetry}/3 次）…`
      : `已加入房间但未收到画面，正在重新开播（第 ${stallRetry}/3 次）…`;
  await startDroneLive(true, liveCameraIndex.value || '');
}

/** 画面上「重新开启」按钮：手动重置重试计数后重开 */
function onLiveRetry() {
  stallRetry = 0;
  cameraTried = [];
  liveCameraCandidates.value = [];
  startDroneLive(false, '');
}

function stopLive() {
  stopPowerPolling();
  stopRecTimer();
  live.value = { url: '', urlType: '', params: null, expire_ts: 0 };
  liveSteps.value = [];
  logHint.value = '';
  player.value?.stop();
  ElMessage.info('已停止拉流（5 分钟无观众司空 2 会自动停止推流）');
}

/* ---------- 左列：机场直播（独立于中间无人机主画面的一路直播） ---------- */
/** 机场画面的自动重连次数（与主画面分开计数） */
let sideRetry = 0;
async function onSideStalled() {
  if (!dockLive.value.url || sideRetry >= 2) return;
  sideRetry += 1;
  await startSideStream(true);
}

/**
 * 机场画面黑屏：链路是通的，同一机位重连没有意义。
 * 按「类型范式」走：切到候选顺序里的下一个机位再试。
 *
 * 为什么不按机场 SN 记住"这台该用舱外"：那是设备特化，换一台同型号机场就要改代码。
 * 范式顺序（舱外 → 舱内）+ 运行时实测（有没有画面）对所有同型号设备一致，
 * 谁有画面就用谁，同型号新机场接入零改动。
 */
let sideBlackHandled = false;
async function onSideBlack(e) {
  if (!e) {
    // 画面恢复正常：说明当前机位是对的，允许后续再次回退
    sideBlackHandled = false;
    return;
  }
  if (sideBlackHandled) return;
  if (!supportsBlackFallback(dockClass.value)) return;
  const next = nextPosition(airportPositionOrder.value, airportPosition.value);
  if (!next) return;
  sideBlackHandled = true;
  positionOverride.value = next;
  await startSideStream(true, `画面为纯黑，自动切换到${positionText(next)}机位重试`);
}

/** 用户在黑屏提示上手动切换机位 */
async function switchSidePosition() {
  const order = airportPositionOrder.value;
  const next = nextPosition(order, airportPosition.value) || order[0];
  if (!next) return;
  positionOverride.value = next;
  sideBlackHandled = true;
  await startSideStream(false, `已切换到${positionText(next)}机位`);
}

/**
 * 开播机场相机
 * 机位由「类型范式」给出（舱外 → 舱内），哪个有画面由运行时实测决定；
 * 不针对某台机场写死机位，也不按 SN 记忆。
 */
async function startSideStream(quiet = false, successMsg = '') {
  const sn = dockSn.value;
  const idx = airportCameraIndex.value;
  if (!sn || !idx) return ElMessage.warning('该机场未上报可用相机');
  const pos = airportPosition.value;
  dockLoading.value = true;
  // 先切到对应机位再拉流（change-camera 与 camera_index 是同一路相机的两个维度）
  await deviceApi.changeCamera(sn, idx, pos);
  const r = await liveApi.start({
    sn,
    camera_index: idx,
    video_expire: 7200,
    quality_type: quality.value,
  });
  dockLoading.value = false;
  if (r?.ok) {
    dockLive.value = {
      url: r.data?.url || '',
      urlType: r.data?.url_type || '',
      params: r.data?.params || null,
      info: airportCameraLabel.value,
    };
    dockStreamOn.value = true;
    sideRetry = 0;
    // 重新开播后允许再次黑屏回退（换机位/重开都是新的一路流）
    sideBlackHandled = false;
    if (!quiet) ElMessage.success(successMsg || `机场直播已开启（${airportCameraLabel.value}）`);
    else if (successMsg) ElMessage.info(successMsg);
  } else {
    ElMessage.error(`${r?.hint || errMsg(r, '直播开启失败')}（code ${r?.code ?? '-'}）`);
  }
}

function stopDockStream() {
  dockLive.value = { url: '', urlType: '', params: null, info: '' };
  dockStreamOn.value = false;
  dockPlayer.value?.stop();
}

function onLiveError(msg) {
  ElMessage.error(`播放器：${msg}`);
}

async function sendCommand(cmd) {
  const sn = droneSn.value || dockSn.value;
  if (!sn) return ElMessage.warning('请选择设备');
  const r = await deviceApi.command(sn, cmd);
  if (r?.ok) ElMessage.success('指令已下发');
  else ElMessage.error(errMsg(r, '指令下发失败'));
}

async function loadWaylines() {
  const r = await waylineApi.list();
  if (r?.ok) waylines.value = r.data?.list || [];
}

function openTakeoff() {
  if (!dockSn.value) return ElMessage.warning('请先选择机场');
  takeoffVisible.value = true;
  // 保留上次选择，避免每次打开都被清空
  takeoffRth.value = 100;
  takeoffPrecision.value = precision.value || 'rtk';
  takeoffAcquireControl.value = true;
  takeoffResult.value = null;
  takeoffSteps.value = [];
  if (takeoffTimer) {
    clearInterval(takeoffTimer);
    takeoffTimer = null;
  }
}

function closeTakeoff() {
  if (takeoffTimer) {
    clearInterval(takeoffTimer);
    takeoffTimer = null;
  }
  takeoffVisible.value = false;
}

async function runTakeoff() {
  if (!dockSn.value) return ElMessage.warning('请先选择机场');
  if (!takeoffWaylineId.value) return ElMessage.warning('请选择起飞航线');
  takeoffLoading.value = true;
  takeoffResult.value = null;
  takeoffSteps.value = [];
  const pre = await takeoffApi.precheck(dockSn.value, takeoffWaylineId.value, droneSn.value);
  if (!pre?.ok || !pre.data?.ok) {
    takeoffSteps.value = pre?.data?.checks || [];
    takeoffLoading.value = false;
    return ElMessage.error(`预检未通过：${(pre?.data?.blockers || []).join('；') || '未知错误'}`);
  }
  takeoffSteps.value = pre.data.checks || [];
  const r = await takeoffApi.takeoff(dockSn.value, takeoffWaylineId.value, {
    drone_sn: droneSn.value,
    name: buildTaskName('座舱一键起飞'),
    rth_altitude: Number(takeoffRth.value) || 100,
    precision: takeoffPrecision.value,
    acquire_control: takeoffAcquireControl.value,
  });
  takeoffLoading.value = false;
  if (r?.ok) {
    takeoffResult.value = r;
    takeoffSteps.value = r.steps || [];
    ElMessage.success(r.message || '一键起飞已触发');
    if (r.taskUuid) pollTakeoff(r.taskUuid);
  } else {
    takeoffSteps.value = r?.steps || [];
    ElMessage.error(errMsg(r, '一键起飞失败'));
  }
}

function pollTakeoff(uuid) {
  if (takeoffTimer) clearInterval(takeoffTimer);
  takeoffTimer = setInterval(async () => {
    const s = await takeoffApi.status(uuid);
    if (s?.ok && takeoffResult.value) {
      takeoffResult.value.status = s.data?.status || '-';
      takeoffResult.value.finished = s.data?.finished || false;
    }
    if (s?.ok && s.data?.finished) {
      clearInterval(takeoffTimer);
      takeoffTimer = null;
    }
  }, 5000);
}

let pollTimer = null;
function pollTask(uuid) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await taskApi.detail(uuid);
    if (r?.ok && currentTask.value) {
      currentTask.value = { ...currentTask.value, ...r.data };
      if (['success', 'terminated', 'starting_failure'].includes(r.data.status)) {
        clearInterval(pollTimer);
        const tk = await taskApi.track(uuid);
        if (tk?.ok && tk.data?.track?.points?.length) {
          trackLine.value = [
            {
              name: '飞行轨迹',
              points: tk.data.track.points.map((p) => [p.latitude, p.longitude]),
              color: '#00d3ff',
            },
          ];
        }
      }
    }
  }, 5000);
}

watch(
  () => store.airports,
  (list) => {
    if (!dockSn.value && list.length) {
      dockSn.value = list[0].sn;
      droneSn.value = list[0].droneSn || '';
    }
  },
  { immediate: true, deep: true }
);

/**
 * 换机场后的默认画面源。
 *
 * 与 onMounted 的取同一套逻辑：飞行器待机时它自己的图传会间歇停推，
 * 机场相机始终可用，所以先把左列「现场画面」顶上来，保证换机场后立刻有画面。
 * 机位覆盖值清空——不继承上一台机场的实测结果，重新按范式从首选开始。
 */
function pickDefaultSource() {
  positionOverride.value = '';
  if (!dockCameraIndex.value || !airportCameraIndex.value) return;
  if (!dockStreamOn.value) startSideStream(true);
}

watch(dockSn, (sn) => {
  const d = store.airports.find((a) => a.sn === sn);
  if (d?.droneSn) droneSn.value = d.droneSn;
  dockCameraIndex.value = d?.cameraList?.[0]?.camera_index || '';
  pickDefaultSource();
  refreshStates();
});

watch(droneSn, () => {
  refreshStates();
});

/**
 * 换机场时重挂机场画面。
 *
 * 踩坑：不能只监听 airportCameraIndex —— 本场两台 Dock 3 上报的 camera_index 完全一样
 * （都是 165-0-7），只监听索引的话换机场时 idx===prev，监听根本不触发，
 * 左侧会一直播着上一台机场的流，画面和标题对不上（表现为「换了机场还是那个黑屏」）。
 * 所以必须把 dockSn 一起纳入监听。
 */
watch([dockSn, airportCameraIndex], ([sn, idx], [prevSn, prevIdx]) => {
  // 换机场：机位覆盖值清空，重新从范式首选项开始实测（不继承上一台机场的结果）
  if (sn !== prevSn) positionOverride.value = '';
  if (!idx || !dockStreamOn.value) return;
  if (prevSn && (sn !== prevSn || idx !== prevIdx)) startSideStream(true);
});

onMounted(() => {
  loadWaylines();
  // 进座舱自动打开机场画面：飞行器待机时它自己的图传会间歇停推，
  // 机场镜头始终可用，保证一进来就能看到现场画面
  setTimeout(() => {
    if (!dockStreamOn.value && airportCameraIndex.value) startSideStream(true);
  }, 2500);
  // 遥测 10 秒自动刷新：飞行器起飞后高度/速度/位置才会持续更新
  stateTimer = setInterval(() => refreshStates(), 10000);
});

onUnmounted(() => {
  stopPowerPolling();
  stopRecTimer();
  if (stateTimer) clearInterval(stateTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (takeoffTimer) clearInterval(takeoffTimer);
});
</script>

<style scoped>
.cockpit { height: 100%; display: flex; flex-direction: column; overflow: hidden; }

/* 主体：左列（地图+机场镜头+HMS） | 中列（无人机主画面，最大） */
.cockpit-body {
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 10px; padding: 10px 10px 0;
}
.col-left { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.col-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; }

.map-card { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; }
.map-card .card-body { flex: 1; min-height: 0; }
.cam-card { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; }
.cam-stage { position: relative; flex: 1; min-height: 0; background: #000; }
.cam-stage :deep(.player-box) { height: 100%; border-radius: 0; }
.cam-live {
  position: absolute; left: 8px; top: 8px; z-index: 20;
  display: inline-flex; align-items: center; gap: 5px;
  background: rgba(0, 0, 0, .6); border-radius: 4px; padding: 2px 7px;
  font-size: var(--fs-xs); color: #fff; font-weight: 600; letter-spacing: .5px;
  backdrop-filter: blur(8px);
}
.cam-live .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c-err); animation: rec-blink 1.2s infinite; }
.cam-tag {
  position: absolute; left: 8px; bottom: 8px; z-index: 20;
  background: rgba(0, 0, 0, .6); border-radius: 4px; padding: 2px 7px;
  font-size: var(--fs-xs); color: rgba(255, 255, 255, .8); backdrop-filter: blur(8px);
}
.hms-panel { flex: 0 0 132px; display: flex; flex-direction: column; min-height: 0; }
.hms-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 12px; }
/* HMS 每条告警：等级徽标 + 状态码 + 来源 + 描述 + 时间 + 可展开根因 */
.hms-item { padding: 6px 0; border-bottom: 1px dashed var(--c-line-soft); }
.hms-item:last-child { border-bottom: 0; }
.hms-row { display: flex; align-items: center; gap: 6px; }
.hms-lv {
  display: inline-block; padding: 0 5px;
  border: 1px solid currentColor; border-radius: 4px;
  font-size: 11px; line-height: 16px;
}
.hms-imminent {
  font-size: 11px; padding: 0 5px; border-radius: 4px;
  background: rgba(255, 77, 79, .18); color: var(--c-err);
}
.hms-toggle {
  border: 0; background: transparent; padding: 0;
  color: var(--c-brand-2); font-size: 11px; font-family: inherit; cursor: pointer;
}
.hms-toggle:hover { text-decoration: underline; }
.hms-src { margin-top: 2px; color: var(--c-text-2); font-size: 11px; }
.hms-msg { margin-top: 3px; line-height: 1.55; }
.hms-time { margin-top: 2px; color: var(--c-text-2); font-size: 11px; }
.hms-sub {
  margin-top: 6px; padding: 6px 8px; border-radius: var(--r-sm);
  background: var(--c-bg-2); border-left: 2px solid var(--c-warn);
}
.hms-sub-item + .hms-sub-item { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--c-line-soft); }

/* 中列主画面 */
.stage {
  position: relative; flex: 1; min-height: 0;
  background: #000; border: 1px solid var(--c-line-soft);
  border-radius: var(--r-md); overflow: hidden;
}
.stage :deep(.player-box) { height: 100%; border-radius: 0; }
.hud.dim { opacity: .5; }
.stage-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; z-index: 10;
  background: linear-gradient(180deg, #0b0b0d, #131316);
  text-align: center; padding: 20px;
}
.stage-empty .t { font-size: var(--fs-xl); font-weight: 600; color: var(--c-text-1); }
.stage-empty .s { font-size: var(--fs-sm); color: var(--c-text-2); max-width: 460px; line-height: 1.7; }
.stage-hint {
  padding: 7px 10px; border-radius: var(--r-sm); font-size: var(--fs-sm);
  background: rgba(255, 176, 32, .1); border: 1px solid rgba(255, 176, 32, .35); color: var(--c-warn);
}
.live-steps {
  display: flex; flex-direction: column; gap: 4px; flex: 0 0 auto;
  padding: 8px 10px; border-radius: var(--r-sm); font-size: var(--fs-sm);
  background: var(--c-bg-1); border: 1px solid var(--c-line-soft);
}

/* 底部操作条 */
.cockpit-bar {
  flex: 0 0 52px; display: flex; align-items: center; gap: 10px;
  padding: 0 10px; background: var(--c-bg-1); border-top: 1px solid var(--c-line-soft);
}
.bar-left { display: flex; align-items: center; gap: 8px; }
.bar-actions { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; }
.bar-right { display: flex; align-items: center; }
.bar-btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 30px; padding: 0 12px; border-radius: var(--r-sm);
  background: var(--c-bg-2); border: 1px solid var(--c-line);
  color: var(--c-text-0); font-size: var(--fs-md); cursor: pointer;
  transition: all .15s; white-space: nowrap; font-family: inherit;
}
.bar-btn:hover:not(:disabled) { background: var(--c-bg-3); border-color: rgba(255, 255, 255, .22); }
.bar-btn:disabled { opacity: .4; cursor: not-allowed; }
.bar-btn .el-icon { font-size: 14px; }
.btn-live {
  display: inline-flex; align-items: center; gap: 6px;
  height: 34px; padding: 0 20px; border-radius: var(--r-sm);
  background: var(--c-err); border: 1px solid var(--c-err);
  color: #fff; font-size: var(--fs-lg); font-weight: 600; cursor: pointer;
  transition: all .15s; font-family: inherit;
}
.btn-live:hover:not(:disabled) { filter: brightness(1.12); }
.btn-live.on { background: var(--c-bg-2); border-color: rgba(255, 255, 255, .2); color: var(--c-text-0); }
.btn-live:disabled { opacity: .6; cursor: default; }

@media (max-width: 1400px) {
  .cockpit-body { grid-template-columns: 300px minmax(0, 1fr); }
}
.takeoff-step { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sm); }
.takeoff-step .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-text-2); flex: 0 0 auto; }
.takeoff-step .dot.success { background: var(--c-ok); }
.takeoff-step .dot.fail { background: var(--c-err); }
.takeoff-step .dot.skip { background: var(--c-warn); }
.required { color: var(--c-err); }
</style>
