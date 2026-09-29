/**
 * 任务管理路由
 */
import { Router } from 'express';
import { Readable } from 'node:stream';
import { request } from '../djiClient.js';
import { buildFlightTaskBody } from '../modules/drone/services/flightTaskBody.js';
import { log } from '../logger.js';

const router = Router();

/**
 * 飞行记录列表
 *
 * 关键实测：sn / begin_at / end_at 是这个接口的**必填**参数，
 * 但司空 2 在缺参数时**不报错，只返回 code=0 + 空 list**，
 * 极易被误判成「这个组织从没飞过」。所以这里必须主动校验并给出明确错误，
 * 同时允许不传时间范围时用默认窗口兜底（而不是静默返回空）。
 */
router.get('/list', async (req, res) => {
  const q = { ...(req.query || {}) };
  const missing = ['sn', 'begin_at', 'end_at'].filter((k) => !q[k]);
  if (missing.length) {
    return res.json({
      ok: false,
      code: -1,
      message: `缺少必填参数：${missing.join(' / ')}（司空 2 缺参不报错只返回空列表，容易被误判成没有数据）`,
      data: { list: [] },
    });
  }
  const r = await request({ method: 'GET', path: '/flight-task/list', query: q, tag: '任务管理' });
  res.json(r);
});

/**
 * 创建飞行任务
 * 统一经 buildFlightTaskBody 补齐必填字段（resumable_status / time_zone）并净化任务名，
 * 否则司空 2 会返回 200610 invalid param format。
 */
router.post('/', async (req, res) => {
  const body = buildFlightTaskBody(req.body || {});
  const r = await request({ method: 'POST', path: '/flight-task', body, tag: '任务管理' });
  if (!r.ok) log.error('任务管理', `创建飞行任务失败 code=${r.code} ${r.message}`, body);
  res.json(r);
});

/** 任务列表 */
router.get('/list', async (req, res) => {
  const r = await request({ method: 'GET', path: '/flight-task/list', query: req.query, tag: '任务管理' });
  res.json(r);
});

/** 任务详情 */
router.get('/:uuid', async (req, res) => {
  const r = await request({
    method: 'GET',
    path: `/flight-task/${encodeURIComponent(req.params.uuid)}`,
    tag: '任务管理',
  });
  res.json(r);
});

/** 更新任务状态 suspended / restored */
router.put('/:uuid/status', async (req, res) => {
  const r = await request({
    method: 'PUT',
    path: `/flight-task/${encodeURIComponent(req.params.uuid)}/status`,
    body: { status: req.body?.status },
    tag: '任务管理',
  });
  res.json(r);
});

/** 任务媒体资源 */
router.get('/:uuid/media', async (req, res) => {
  const r = await request({
    method: 'GET',
    path: `/flight-task/${encodeURIComponent(req.params.uuid)}/media`,
    tag: '任务管理',
  });
  res.json(r);
});

/**
 * 媒体列表短缓存
 * 媒体直链带 auth_key 签名且按需签发，不能长期缓存；
 * 但代理单张图片时没必要每次都重新拉一遍列表，所以缓存列表本身 5 分钟。
 */
const mediaListCache = new Map();
const MEDIA_LIST_TTL = 5 * 60 * 1000;

async function fetchMediaList(uuid, force = false) {
  const hit = mediaListCache.get(uuid);
  if (!force && hit && Date.now() - hit.ts < MEDIA_LIST_TTL) return hit.list;
  const r = await request({
    method: 'GET',
    path: `/flight-task/${encodeURIComponent(uuid)}/media`,
    tag: '任务管理',
  });
  const list = (r?.data?.list || []).slice();
  mediaListCache.set(uuid, { ts: Date.now(), list });
  return list;
}

/**
 * 单张媒体代理（preview / original）
 *
 * 为什么不把 preview_url / original_url 直接交给前端 <img>：
 *   ① 直链带 auth_key 签名，会过期，前端缓存后必然出现裂图
 *   ② 跨域直连在部分网络环境下会被拦
 * 走后端代理后前端只认 /api/task/.../media/... 这一个同域地址。
 */
router.get('/:uuid/media/:mediaUuid', async (req, res) => {
  const { uuid, mediaUuid } = req.params;
  const type = req.query?.type === 'original' ? 'original' : 'preview';
  try {
    const list = await fetchMediaList(uuid, req.query?.refresh === '1');
    const item = list.find((m) => m?.uuid === mediaUuid);
    if (!item) return res.status(404).json({ ok: false, message: '媒体不存在或已过期' });

    const url = type === 'original' ? item.original_url : item.preview_url;
    if (!url) return res.status(404).json({ ok: false, message: `该媒体无${type === 'original' ? '原图' : '预览'}链接` });

    const upstream = await fetch(url, { redirect: 'follow' });
    if (!upstream.ok) return res.status(502).json({ ok: false, message: `CDN 返回 ${upstream.status}` });

    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'private, max-age=300');
    const len = upstream.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    log.error('任务管理', `媒体代理失败：${e.message}`, { uuid, mediaUuid });
    res.status(502).json({ ok: false, message: `媒体代理失败：${e.message}` });
  }
});

/** 任务飞行轨迹（地图绘制） */
router.get('/:uuid/track', async (req, res) => {
  const r = await request({
    method: 'GET',
    path: `/flight-task/${encodeURIComponent(req.params.uuid)}/track`,
    tag: '任务管理',
  });
  res.json(r);
});

export default router;
