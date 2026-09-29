/**
 * 航线管理路由：列表 / 详情（下载链接） / 上传（STS → 存储桶 → 上传完成通知）
 */
import { Router } from 'express';
import multer from 'multer';
import OSS from 'ali-oss';
import { request } from '../djiClient.js';
import { log } from '../logger.js';
import { Readable } from 'node:stream';

const router = Router();

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

/** region 简写 → 阿里云标准 region */
const REGION_MAP = {
  hz: 'oss-cn-hangzhou',
  bj: 'oss-cn-beijing',
  sh: 'oss-cn-shanghai',
  sz: 'oss-cn-shenzhen',
  gz: 'oss-cn-guangzhou',
  cd: 'oss-cn-chengdu',
  hk: 'oss-cn-hongkong',
  qd: 'oss-cn-qingdao',
};

function normalizeRegion(region = '') {
  if (!region) return 'oss-cn-hangzhou';
  if (region.startsWith('oss-')) return region;
  return REGION_MAP[region.toLowerCase()] || `oss-cn-${region}`;
}

/**
 * 上传航线文件（.kmz/.kml）
 * 1. 获取 STS 凭证 2. 上传到司空 2 存储桶 3. 通知司空 2 上传完成
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const name = (req.body && req.body.name) || (file ? file.originalname.replace(/\.(kmz|kml)$/i, '') : '');
    if (!file) return res.json({ ok: false, message: '未选择航线文件' });

    const sts = await request({ method: 'GET', path: '/project/sts-token', tag: '组织项目' });
    if (!sts.ok) return res.json({ ok: false, message: `获取上传凭证失败：${sts.message}`, code: sts.code });

    const { endpoint, bucket, region, credentials, object_key_prefix } = sts.data || {};
    const c = credentials || {};
    log.info('航线管理', `获取上传凭证成功 bucket=${bucket} region=${region}`);

    const prefix = (object_key_prefix || '').replace(/\/+$/, '');
    const objectKey = `${prefix}/${file.originalname}`;

    const client = new OSS({
      accessKeyId: c.access_key_id,
      accessKeySecret: c.access_key_secret,
      stsToken: c.security_token,
      bucket,
      region: normalizeRegion(region),
      ...(endpoint ? { endpoint: endpoint.startsWith('http') ? endpoint : `https://${endpoint}` } : {}),
      secure: true,
    });

    await client.put(objectKey, file.buffer);
    log.ok('航线管理', `航线文件已上传到存储桶 object_key=${objectKey}`);

    const finish = await request({
      method: 'POST',
      path: '/wayline/finish-upload',
      body: { object_key: objectKey, name: name || file.originalname },
      tag: '航线管理',
    });
    if (!finish.ok) {
      return res.json({ ok: false, message: `通知司空 2 失败：${finish.message}`, code: finish.code, objectKey });
    }
    res.json({ ok: true, data: { ...finish.data, objectKey } });
  } catch (err) {
    log.error('航线管理', `航线上传异常：${err.message}`);
    res.json({ ok: false, message: `航线上传异常：${err.message}` });
  }
});

export default router;
