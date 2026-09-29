/**
 * 直播领域服务：供应商自适应策略
 * 司空 2 动态选择直播供应商（volc / agora / srs），url 可能是 http 地址，
 * 也可能是 `app_id=..&room_id=..&token=..&user_id=..` 形式的鉴权参数串
 */
import { request } from '../../../djiClient.js';
import { log } from '../../../logger.js';
import {
  resolveCameraIndex,
  positionOrder,
  sourceText,
  CLASS,
} from './cameraProfile.js';

// 相机选择 / 机位顺序 / 兜底索引全部收敛到 cameraProfile（按设备类型定义，不按设备写死）
export { pickBestCamera, cameraCandidates } from './cameraProfile.js';

/**
 * 司空 2 直播错误码释义
 * 实测：飞行器关机时开播会返回 213003，前端若只显示英文原文用户完全无法判断原因
 */
const LIVE_ERRORS = {
  213003: '飞行器未开机，图传通道不存在（司空 2 无远程开机接口，需先执行起飞任务或现场开机；此时可用机场舱内相机查看机舱内的飞机）',
  213002: '直播路数已达上限，请先停止其他直播',
  213001: '当前设备不支持该 camera_index',
  219014: '设备不属于当前项目，请切换到该设备所属项目后重试',
  200610: '请求参数不合规（多为 camera_index 无效或飞行器未上报该路相机）',
  2006101: '参数为空或不合法',
  200101: '参数无效',
  200401: 'TK 失效或无权限',
};

function explain(code, message) {
  return LIVE_ERRORS[Number(code)] || message || '未知错误';
}

export function decodeSafe(v) {
  try {
    return decodeURIComponent(String(v).replace(/\+/g, ' '));
  } catch {
    return v;
  }
}

/** 解析拉流鉴权参数，输出统一结构 */
export function parseStreamParams(url) {
  if (!url || typeof url !== 'string') return null;
  const raw = String(url).trim();
  const q = {};
  try {
    if (raw.includes('://')) {
      const u = new URL(raw);
      u.searchParams.forEach((v, k) => (q[k] = v));
    } else {
      for (const pair of raw.replace(/^[?&]+/, '').split('&')) {
        if (!pair) continue;
        const i = pair.indexOf('=');
        const k = i > -1 ? pair.slice(0, i) : pair;
        const v = i > -1 ? pair.slice(i + 1) : '';
        q[k] = decodeSafe(v);
      }
    }
  } catch {
    return null;
  }
  const pick = (...keys) => {
    for (const k of keys) if (q[k]) return q[k];
    return '';
  };
  return {
    appId: pick('app_id', 'appId', 'appid'),
    roomId: pick('room_id', 'roomId', 'roomid', 'channel', 'stream', 'channelName'),
    token: pick('token'),
    userId: pick('user_id', 'userId', 'userid', 'uid'),
    all: q,
  };
}

/** 归一化播放引擎 */
export function engineOf(urlType, url = '') {
  const t = (urlType || '').toLowerCase();
  if (t === 'volc' || t === 'volcengine') return 'volc';
  if (t === 'agora') return 'agora';
  if (t === 'srs') return 'srs';
  if (t === 'demo') return 'demo';
  if (/whep|rtc\/v1/i.test(url)) return 'srs';
  return '';
}

export async function startLive({
  sn,
  camera_index,
  video_expire = 7200,
  quality_type = 'adaptive',
  projectUuid,
}) {
  if (!sn) return { ok: false, message: '缺少 sn（机场或飞行器 SN）' };

  // camera_index 缺失时自动解析，避免前端因飞行器未开机而无法开播
  const resolved = await resolveCameraIndex(sn, camera_index);
  if (!camera_index) {
    log.info('LIVE', `自动解析 camera_index → ${resolved.index}（${sourceText(resolved.source)}）`);
  }

  const r = await request({
    method: 'POST',
    path: '/live-stream/start',
    body: { sn, camera_index: resolved.index, video_expire: Number(video_expire) || 7200, quality_type },
    projectUuid: projectUuid || undefined,
    tag: '直播管理',
  });
  if (!r.ok) {
    const hint = explain(r.code, r.message);
    log.error('直播管理', `开启直播失败 code=${r.code} ${r.message} → ${hint}`, {
      sn,
      camera_index: resolved.index,
    });
    return {
      ...r,
      hint,
      liveInfo: {
        sn,
        cameraIndex: resolved.index,
        candidates: resolved.candidates || [],
        // 机位尝试顺序由「设备类型范式」给出，前端按此顺序实测回退（不对单台设备做特化）
        positions: positionOrder(resolved.deviceClass, resolved.reportedPositions),
        deviceClass: resolved.deviceClass,
        source: resolved.source,
        sourceText: sourceText(resolved.source),
      },
    };
  }

  const data = r.data || {};
  return {
    ...r,
    data: {
      ...data,
      engine: engineOf(data.url_type, data.url),
      params: parseStreamParams(data.url),
    },
    liveInfo: {
      sn,
      cameraIndex: resolved.index,
      candidates: resolved.candidates || [],
      // 机位尝试顺序由「设备类型范式」给出，前端按此顺序实测回退（不对单台设备做特化）
      positions: positionOrder(resolved.deviceClass, resolved.reportedPositions),
      deviceClass: resolved.deviceClass,
      source: resolved.source,
      sourceText: sourceText(resolved.source),
    },
  };
}
