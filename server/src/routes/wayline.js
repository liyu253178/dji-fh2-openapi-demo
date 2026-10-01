/**
 * 航线路由：列表 / 详情 / 下载 / 上传 + 自研规划闭环
 *
 * 自研规划部分（司空 2 不开放航线规划，这部分是我们补的能力）：
 *   GET  /aircraft          本机队机型（闸 1 的数据来源）
 *   POST /plan              规划预览，不落库不上传
 *   POST /generate          生成 KMZ → 上传司空 2 → 回查比对机型 → 落本地表（闸 2）
 *   POST /dispatch-check    下发前机型再校验（闸 3）
 *   GET  /local             本地自研航线草稿
 *   POST /local/:id/verify  重新回查验证
 *
 * ⚠️ 路径顺序：带具体前缀的路由必须写在 /:id 之前，否则会被 /:id 吃掉。
 */
import { Router } from 'express';
import multer from 'multer';
import { request } from '../djiClient.js';
import { log } from '../logger.js';
import { Readable } from 'node:stream';
import { fleetModels, assertDispatchable, annotateLibrary, invalidate } from '../modules/wayline/aircraftService.js';
import { plan, build, LIMITS } from '../modules/wayline/planner.js';
import { submitAndVerify, reverify } from '../modules/wayline/verifyService.js';
import { uploadWayline } from '../modules/wayline/ossUpload.js';
import { listDrafts, getDraft, createDraft, updateDraft, draftStats } from '../modules/wayline/draftRepo.js';

const router = Router();

/* ---------------- 自研规划：机队机型 ---------------- */

/** 本机队机型（含从真实航线反演出的载荷枚举与间距系数） */
router.get('/aircraft', async (req, res) => {
  const force = String(req.query.force || '') === '1';
  if (force) invalidate();
  const r = await fleetModels({ force });
  res.json({
    ok: r.ok,
    message: r.message || '',
    data: { models: r.models || [], airports: r.airports || 0, limits: LIMITS },
  });
});

/* ---------------- 自研规划：本地草稿 ---------------- */

router.get('/local', async (req, res) => {
  const list = listDrafts({ status: req.query.status });
  res.json({ ok: true, data: { list, stats: draftStats() } });
});

router.post('/local/:id/verify', async (req, res) => {
  const draft = getDraft(Number(req.params.id));
  if (!draft) return res.json({ ok: false, message: '草稿不存在' });
  updateDraft(draft.id, { status: 'validating', verifyMessage: '' });
  const v = await reverify(draft);
  const updated = updateDraft(draft.id, {
    status: v.ok ? 'verified' : 'rejected',
    waylineId: v.waylineId || draft.wayline_id,
    modelKeyRemote: v.remoteModelKey ?? draft.model_key_remote,
    verifyMessage: v.message || '',
    verifiedAt: v.ok ? new Date().toISOString() : null,
  });
  res.json({ ok: v.ok, message: v.message, data: updated });
});

/* ---------------- 自研规划：预览与生成 ---------------- */

/** 规划预览：只算不存，用于地图上画航带 */
router.post('/plan', async (req, res) => {
  try {
    const { polygon, aircraftKey, params } = req.body || {};
    const r = await plan({ polygon, aircraftKey, params: params || {} });
    res.json(r.ok ? { ok: true, data: r } : r);
  } catch (e) {
    log.error('航线规划', `预览异常：${e.message}`);
    res.json({ ok: false, message: `规划失败：${e.message}` });
  }
});

/**
 * 生成并提交司空 2 验证
 * 只有回查到航线且 device_model_key 与目标机型一致，状态才会变成 verified。
 * verified 的航线才允许下发（对应「无报错才显示在航线库」）。
 */
router.post('/generate', async (req, res) => {
  try {
    const { name, polygon, aircraftKey, params = {}, submit = true } = req.body || {};
    if (!name) return res.json({ ok: false, message: '请填写航线名称' });

    const built = await build({ polygon, aircraftKey, params, name });
    if (!built.ok) return res.json(built);

    const preview = built.preview;
    const draft = createDraft({
      name,
      aircraftKey,
      aircraftName: preview.aircraft.name,
      payload: preview.aircraft.payload,
      templateType: 'mapping2d',
      polygon,
      params,
      stats: { ...preview.plan.stats, measure: preview.measure, spacingSource: preview.spacingSource },
    });

    if (!submit) {
      return res.json({
        ok: true,
        data: draft,
        verify: { ok: false, message: '已保存为草稿，未提交司空 2' },
      });
    }

    updateDraft(draft.id, { status: 'validating' });
    const v = await submitAndVerify({
      kmz: built.kmz,
      name,
      aircraft: { key: aircraftKey, name: preview.aircraft.name },
    });
    const updated = updateDraft(draft.id, {
      status: v.ok ? 'verified' : 'rejected',
      waylineId: v.waylineId || null,
      modelKeyRemote: v.remoteModelKey ?? null,
      verifyMessage: v.message || '',
      verifiedAt: v.ok ? new Date().toISOString() : null,
    });
    log[v.ok ? 'ok' : 'error']('航线规划', `${name} 验证${v.ok ? '通过' : '失败'}：${v.message}`);
    res.json({ ok: v.ok, message: v.message, data: updated, verify: v });
  } catch (e) {
    log.error('航线规划', `生成异常：${e.message}`);
    res.json({ ok: false, message: `生成失败：${e.message}` });
  }
});

/* ---------------- 闸 3：下发前机型再校验 ---------------- */

router.post('/dispatch-check', async (req, res) => {
  const { modelKey, waylineId } = req.body || {};
  const r = await assertDispatchable(modelKey);
  res.json({ ok: r.ok, code: r.code || '', message: r.message, data: { waylineId, model: r.model || null } });
});

/* ---------------- 航线库（带机型可飞性标注） ---------------- */

router.get('/library-match', async (req, res) => {
  const r = await request({ method: 'GET', path: '/wayline', query: req.query, tag: '航线管理' });
  if (!r.ok) return res.json(r);
  const list = await annotateLibrary(r.data?.list || []);
  const { models } = await fleetModels();
  const ok = list.filter((w) => w.flyable === 'ok').length;
  const sibling = list.filter((w) => w.flyable === 'sibling').length;
  const no = list.filter((w) => w.flyable === 'no').length;
  res.json({
    ok: true,
    data: {
      list,
      fleet: models,
      stats: { total: list.length, ok, sibling, no, unknown: list.length - ok - sibling - no },
    },
  });
});

/* ---------------- 原有能力 ---------------- */

/** 透传 DJI CDN 文件流，给前端一个同域下载入口（避免 window.open 被拦截 / 跨域无法 download） */
router.get('/:id/download', async (req, res) => {
  const { id } = req.params;
  const r = await request({
    method: 'GET',
    path: `/wayline/${encodeURIComponent(id)}`,
    tag: '航线管理',
  });
  if (!r.ok) return res.status(r.status || 500).json(r);
  const url = r.data?.download_url;
  if (!url) return res.json({ ok: false, message: '司空 2 未返回下载链接' });

  try {
    const upstream = await fetch(url, { redirect: 'follow' });
    if (!upstream.ok) {
      return res.status(502).json({ ok: false, message: `DJI CDN 返回 ${upstream.status}` });
    }
    // 文件名：DJI 返回的 name 不带后缀，统一补 .kmz
    const base = String(r.data?.name || id).replace(/\.(kmz|kml)$/i, '');
    const filename = `${base}.kmz`;
    // 必须同时给 ASCII 回退：只写 filename*=UTF-8'' 时，部分浏览器/下载器不识别，
    // 会退化成无后缀的名字（如 "download"），用户再上传就被 accept=".kmz" 挡住。
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    res.set(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    log.error('航线管理', `下载代理失败：${e.message}`, { id, url });
    res.status(502).json({ ok: false, message: `下载失败：${e.message}` });
  }
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

/** 航线列表 */
router.get('/', async (req, res) => {
  const r = await request({ method: 'GET', path: '/wayline', query: req.query, tag: '航线管理' });
  res.json(r);
});

/** 航线详情 → download_url */
router.get('/:id', async (req, res) => {
  const r = await request({
    method: 'GET',
    path: `/wayline/${encodeURIComponent(req.params.id)}`,
    tag: '航线管理',
  });
  res.json(r);
});

/**
 * 上传航线文件（.kmz/.kml）
 * 1. 获取 STS 凭证 2. 上传到司空 2 存储桶 3. 通知司空 2 上传完成
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const name =
      (req.body && req.body.name) || (file ? file.originalname.replace(/\.(kmz|kml)$/i, '') : '');
    if (!file) return res.json({ ok: false, message: '未选择航线文件' });

    const r = await uploadWayline({ buffer: file.buffer, filename: file.originalname, name });
    if (!r.ok) return res.json({ ok: false, message: r.message, code: r.code, objectKey: r.objectKey });
    res.json({ ok: true, data: { ...r.data, objectKey: r.objectKey } });
  } catch (err) {
    log.error('航线管理', `航线上传异常：${err.message}`);
    res.json({ ok: false, message: `航线上传异常：${err.message}` });
  }
});

export default router;
