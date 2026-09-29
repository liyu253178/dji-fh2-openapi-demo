<template>
  <div class="player-box">
    <!-- 火山 / 声网 SDK 会在此容器内自行创建 video 元素 -->
    <div v-show="engine !== 'srs'" ref="rtcBox" style="width: 100%; height: 100%"></div>
    <video
      v-show="engine === 'srs'"
      ref="videoEl"
      autoplay
      playsinline
      controls
      muted
      style="width: 100%; height: 100%"
    ></video>

    <div v-if="status === 'idle'" class="player-placeholder" style="position: absolute">
      <div style="font-size: 30px; margin-bottom: 8px">📡</div>
      <div>{{ placeholderText }}</div>
    </div>

    <div
      v-if="status === 'error'"
      class="player-placeholder"
      style="position: absolute; padding: 16px; max-width: 90%"
    >
      <div style="color: var(--err); margin-bottom: 6px">播放失败：{{ errorMsg }}</div>
      <div class="mono small" style="word-break: break-all; opacity: .8">{{ url }}</div>
    </div>

    <div
      v-if="status === 'connecting'"
      class="player-placeholder"
      style="position: absolute"
    >
      <div style="color: var(--c-brand-2)">正在接入 {{ engineLabel }}…</div>
      <div class="small muted" style="margin-top: 6px">首次出图可能需要 10~20 秒</div>
    </div>

    <div
      v-if="status === 'playing' && !noFrame && !black"
      style="position: absolute; left: 8px; top: 8px; background: rgba(0,0,0,.5); padding: 3px 8px; border-radius: 6px; font-size: 11px"
    >
      <span class="tag ok"><span class="dot"></span> {{ engineLabel }} 直播中</span>
    </div>
    <div
      v-if="status === 'playing' && black && !noFrame"
      style="position: absolute; left: 8px; top: 8px; background: rgba(0,0,0,.5); padding: 3px 8px; border-radius: 6px; font-size: 11px"
    >
      <span class="tag warn"><span class="dot"></span> {{ engineLabel }} 已接通 · 画面全黑</span>
    </div>

    <!-- 有帧但画面全黑：链路通、设备也在推流，只是相机拍不到任何光线。
         实测（职校机场）：videoWidth=1280、currentTime 正常推进，看起来"直播中"，
         实际 mean=0 / std=0 纯黑 —— 若不单独识别，用户只会看到一片黑的"正常画面"。 -->
    <div
      v-if="status === 'playing' && black && !noFrame"
      class="player-placeholder"
      style="position: absolute; padding: 16px; max-width: 92%"
    >
      <div style="color: var(--warn); margin-bottom: 6px">画面为纯黑（相机无光照）</div>
      <div class="small" style="line-height: 1.7">
        直播链路与推流都正常，但相机拍到的画面<b>没有任何光线</b>（亮度 {{ blackMean }}）。<br />
        机场舱内相机在「舱盖关闭 + 补光灯关闭 + 飞行器断电」时就是全黑；也可能是镜头被遮挡/保护膜未撕。
        <template v-if="blackHint"><br />{{ blackHint }}</template>
      </div>
      <div style="margin-top: 10px">
        <button class="mini-btn" @click="emit('switchPosition')">切换机位</button>
      </div>
    </div>

    <!-- 已加入房间但收不到帧：司空 2 允许开播不代表设备已经在推流 -->
    <div
      v-if="status === 'playing' && noFrame"
      class="player-placeholder"
      style="position: absolute; padding: 16px; max-width: 92%"
    >
      <div style="color: var(--warn); margin-bottom: 6px">{{ noFrameTitle }}</div>
      <div class="small" style="line-height: 1.7">
        开播成功只代表直播会话已建立，设备侧还没有向媒体服务器推流。<br />
        飞行器在舱内待机时图传会间歇停推，执行航线任务后画面才会持续输出。
        <template v-if="noFrameHint"><br />{{ noFrameHint }}</template>
      </div>
      <div style="margin-top: 10px">
        <button class="mini-btn" @click="emit('retry')">重新开启</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onBeforeUnmount, watch } from 'vue';

const props = defineProps({
  /** 司空 2 返回的拉流地址 */
  url: { type: String, default: '' },
  /** volc / agora / srs */
  urlType: { type: String, default: '' },
  /** 后端解析出的鉴权参数 */
  params: { type: Object, default: null },
  autoStart: { type: Boolean, default: true },
  placeholder: { type: String, default: '尚未开启直播' },
  /** 父组件按当前设备状态给出的补充说明（避免无帧提示给出误导性建议） */
  noFrameHint: { type: String, default: '' },
  /** 黑屏时父组件给出的可执行建议 */
  blackHint: { type: String, default: '' },
});

const emit = defineEmits(['status', 'error', 'stalled', 'retry', 'black']);

const rtcBox = ref(null);
const videoEl = ref(null);
const status = ref('idle'); // idle | connecting | playing | error
const errorMsg = ref('');
/** 已加入房间但迟迟没有视频帧（司空 2 上「显示已开启」≠「图传已上线」） */
const noFrame = ref(false);
/**
 * 有帧但画面全黑。
 * 判据不能只看 videoWidth —— 实测职校机场相机输出 1280×720 的纯黑流，
 * 靠「有尺寸 + currentTime 推进」会被当成正常播放，用户看到的就是"没画面"。
 */
const black = ref(false);
const blackMean = ref(0);
/** 黑屏阈值：平均亮度极低且几乎没有明暗差异（纯色/无内容画面） */
const BLACK_MEAN_MAX = 8;
const BLACK_STD_MAX = 4;
/** 连续多少次采样判定为黑屏（3 × 1.5s ≈ 4.5s，避开首帧与瞬时卡顿） */
const BLACK_TICKS = 3;
let blackN = 0;
/** no-frame：从头到尾没出过帧；stall：出过帧后停止推进 */
const noFrameReason = ref('');
/** 首帧宽限：实测首次出图 10~20s，早于这个时间判定会产生大量误报 */
const FIRST_FRAME_GRACE_MS = 25000;
const TICK_MS = 1500;
/** 连续多少次 tick 内 currentTime 不推进即判定中断（4 × 1.5s ≈ 6s） */
const STALL_TICKS = 4;
let playTimer = null;
let lastCur = -1;
let stallN = 0;

const noFrameTitle = computed(() =>
  noFrameReason.value === 'stall' ? '画面已停止更新' : '已加入房间，但未收到视频帧'
);

function clearWatchTimer() {
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
}

function stopFrameWatch() {
  clearWatchTimer();
  noFrame.value = false;
  noFrameReason.value = '';
  black.value = false;
  blackMean.value = 0;
  blackN = 0;
  lastCur = -1;
  stallN = 0;
}

function findVideo() {
  const list = Array.from(rtcBox.value?.querySelectorAll('video') || []);
  if (videoEl.value) list.push(videoEl.value);
  return list.find((x) => x.videoWidth > 0);
}

/**
 * 采样画面亮度（缩到 160×90 后统计灰度均值与标准差）
 * 返回 null 表示采样失败（此时不做黑屏判定，避免误报）
 * MediaStream 的 video 没有跨域污染问题，canvas 可直接读取。
 */
function sampleBrightness(v) {
  try {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let s = 0;
    let s2 = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      s += l;
      s2 += l * l;
    }
    const mean = s / n;
    return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
  } catch {
    return null;
  }
}

/**
 * 判定画面死亡：既给 UI 提示，也通知父组件重连。
 * 之前「始终无帧」这一支只置提示位、不发事件，座舱的自动重连永远不会触发，
 * 画面就一直卡在这句文案上，只能手动重开。
 */
function markDead(reason) {
  clearWatchTimer();
  noFrame.value = true;
  noFrameReason.value = reason;
  emit('stalled', { reason });
}

/**
 * 播放健康检测
 *  ① 未出帧：超过 25s 宽限仍无 videoWidth → no-frame，并触发父组件自动重连
 *  ② 已出帧：每 1.5s 比对 currentTime，连续 4 次（≈6s）不推进 → stall
 * 实测：飞行器在舱内待机时，司空 2 会建立直播会话并推几帧，随后停止推流，
 *       表现为「状态显示直播中但画面冻结」。
 */
function watchPlayback() {
  stopFrameWatch();
  const t0 = Date.now();
  playTimer = setInterval(() => {
    const v = findVideo();
    if (!v) {
      if (Date.now() - t0 > FIRST_FRAME_GRACE_MS) markDead('no-frame');
      return;
    }
    noFrame.value = false;
    noFrameReason.value = '';

    // 黑屏检测：链路正常但相机拍不到光（职校机场实测就是这种）
    const b = sampleBrightness(v);
    if (b && b.mean < BLACK_MEAN_MAX && b.std < BLACK_STD_MAX) {
      blackN += 1;
      blackMean.value = b.mean.toFixed(1);
      if (blackN >= BLACK_TICKS && !black.value) {
        black.value = true;
        // 黑屏不是拉流故障，重连解决不了，所以只上报状态、不触发 stalled
        emit('black', { mean: b.mean, std: b.std });
      }
    } else {
      blackN = 0;
      if (black.value) {
        black.value = false;
        blackMean.value = 0;
        emit('black', null);
      }
    }

    if (lastCur >= 0 && v.currentTime - lastCur < 0.2) {
      stallN += 1;
      if (stallN >= STALL_TICKS) markDead('stall');
    } else {
      stallN = 0;
    }
    lastCur = v.currentTime;
  }, TICK_MS);
}

let volcEngine = null;
let agoraClient = null;
let pc = null;
/** 已挂载的远端用户，避免重复 setRemoteVideoPlayer */
let attachedUserId = '';

const engine = computed(() => {
  const t = (props.urlType || '').toLowerCase();
  if (t === 'volc' || t === 'volcengine') return 'volc';
  if (t === 'agora') return 'agora';
  if (t === 'srs') return 'srs';
  // 无类型时按地址兜底判断
  if (/whep|rtc\/v1/i.test(props.url || '')) return 'srs';
  return '';
});

const engineLabel = computed(
  () => ({ volc: '火山引擎 RTC', agora: '声网 Agora', srs: 'SRS WebRTC' }[engine.value] || '直播')
);
const placeholderText = computed(() => props.placeholder);

function setStatus(s, msg = '') {
  status.value = s;
  errorMsg.value = msg;
  emit('status', { status: s, message: msg });
  if (s === 'error') emit('error', msg);
}

function pickParams() {
  const p = props.params || {};
  const q = p.all || {};
  return {
    appId: p.appId || q.appId || q.appid || '',
    roomId: p.roomId || q.roomId || q.roomid || q.channel || q.stream || '',
    token: p.token || q.token || '',
    userId: p.userId || q.userId || q.uid || '',
  };
}

async function startVolc() {
  const { appId, roomId, token, userId } = pickParams();
  if (!appId || !roomId) throw new Error('拉流地址缺少 appId/roomId，无法加入房间');
  const mod = await import('@volcengine/rtc');
  const VERTC = mod.default || mod;
  const { StreamIndex } = mod;
  volcEngine = VERTC.createEngine(appId);

  /** 把远端用户的画面挂到容器上（onUserJoined / onUserPublishStream 可能各来一次，做幂等） */
  const attach = async (uid) => {
    if (!uid || attachedUserId === uid) return;
    try {
      const box = rtcBox.value;
      if (!box) return;
      box.innerHTML = '';
      attachedUserId = uid;
      await volcEngine.setUserVisibility(false);
      volcEngine.setRemoteVideoPlayer(StreamIndex.STREAM_INDEX_MAIN, {
        userId: uid,
        renderDom: box,
        visible: true,
      });
      setStatus('playing');
      watchPlayback();
    } catch (err) {
      setStatus('error', err.message);
    }
  };

  // 已加入房间的远端用户 + 后续发布的远端用户，两条路径都尝试挂载
  volcEngine.on(VERTC.events.onUserJoined, (e) => attach(e?.userId));
  volcEngine.on(VERTC.events.onUserPublishStream, (e) => attach(e?.userId));
  // 真正收到首帧才算播起来
  volcEngine.on(VERTC.events.onRemoteVideoFirstFrame, () => setStatus('playing'));
  // 诊断：把远端流统计挂到 window，便于排查"显示直播中但无画面"
  volcEngine.on(VERTC.events.onRemoteStreamStats, (e) => {
    window.__volcStats = e;
  });
  volcEngine.on(VERTC.events.onAutoplayFailed, () =>
    setStatus('error', '浏览器拦截了自动播放，请在画面上点击一次')
  );
  volcEngine.on(VERTC.events.onError, (e) => setStatus('error', `${e?.errorCode || ''} ${e?.message || ''}`.trim()));

  // 不指定 roomProfileType，避免与司空 2 推流端的房间策略不匹配导致订阅不到媒体流
  // 无人机无音频，关掉音频订阅，减少协商失败的干扰
  await volcEngine.joinRoom(
    token,
    roomId,
    { userId: userId || String(Date.now() % 100000) },
    {
      isAutoPublish: false,
      isAutoSubscribeAudio: false,
      isAutoSubscribeVideo: true,
    }
  );
}

async function startAgora() {
  const { appId, roomId, token, userId } = pickParams();
  if (!appId || !roomId) throw new Error('拉流地址缺少 appId/channel，无法加入频道');
  const mod = await import('agora-rtc-sdk-ng');
  const AgoraRTC = mod.default || mod;
  agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  agoraClient.on('user-published', async (user, mediaType) => {
    await agoraClient.subscribe(user, mediaType);
    if (mediaType === 'video') {
      const box = rtcBox.value;
      box.innerHTML = '';
      const div = document.createElement('div');
      div.style.width = '100%';
      div.style.height = '100%';
      box.appendChild(div);
      user.videoTrack.play(div);
      setStatus('playing');
      watchPlayback();
    }
  });
  agoraClient.on('user-unpublished', () => setStatus('idle'));
  await agoraClient.join(appId, roomId, token || null, userId || null);
}

async function startSrs() {
  const url = props.url;
  if (!url) throw new Error('拉流地址为空');
  const el = videoEl.value;
  if (el) el.srcObject = null;
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.ontrack = (e) => {
    if (el && e.streams && e.streams[0]) {
      el.srcObject = e.streams[0];
      el.play().catch(() => {});
      setStatus('playing');
      watchPlayback();
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const res = await fetch(url, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer.sdp,
  });
  if (!res.ok) throw new Error(`WHEP 握手失败 HTTP ${res.status}`);
  const answer = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
}

async function start() {
  await stop(true);
  if (!props.url) {
    setStatus('idle');
    return;
  }
  if (!engine.value) {
    setStatus('error', `未知直播类型 ${props.urlType}，请在司空管理查看原始返回`);
    return;
  }
  setStatus('connecting');
  try {
    if (engine.value === 'volc') await startVolc();
    else if (engine.value === 'agora') await startAgora();
    else await startSrs();
  } catch (err) {
    setStatus('error', err.message || String(err));
  }
}

async function stop(silent = false) {
  attachedUserId = '';
  stopFrameWatch();
  try {
    if (volcEngine) {
      await volcEngine.leaveRoom();
      volcEngine = null;
    }
    if (agoraClient) {
      await agoraClient.leave();
      agoraClient = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    if (videoEl.value) videoEl.value.srcObject = null;
    if (rtcBox.value) rtcBox.value.innerHTML = '';
  } catch {
    /* ignore */
  }
  if (!silent) setStatus('idle');
}

onBeforeUnmount(() => stop(true));

watch(
  () => [props.url, props.urlType],
  () => {
    if (props.autoStart && props.url) start();
  },
  { immediate: true }
);

defineExpose({ start, stop, getEngine: () => volcEngine });
</script>

<style scoped>
.mini-btn {
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-1);
  border-radius: 6px;
  padding: 4px 14px;
  font-size: 12px;
  cursor: pointer;
}
.mini-btn:hover {
  border-color: var(--c-brand);
  color: var(--c-brand-2);
}
</style>
