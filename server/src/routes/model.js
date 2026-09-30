/**
 * 模型库路由
 * 对接司空 2 OpenAPI /openapi/v0.1/model
 *
 * 三维预览链路：
 *   /model            → 组织模型列表（跨项目聚合）
 *   /model/:id        → 模型详情（含 preview_url / url）
 *   /model/:id/preview→ 预览图代理（直链带签名会过期，浏览器直连经常裂图）
 *   /model/:id/files  → 下载并解压模型包，返回包内文件清单（前端据此挑 b3dm/glb 渲染）
 *   /model/:id/asset  → 按路径读取解压出来的单个文件
 */
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { request } from '../djiClient.js';
import { log } from '../logger.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.resolve(__dirname, '../../data/models');
/** 单个模型包下载上限（超过就没必要在浏览器里预览了） */
const MAX_ZIP_BYTES = 300 * 1024 * 1024;
/** 详情短缓存：详情里带签名链接，重复取没有意义 */
const detailCache = new Map();
const DETAIL_TTL = 5 * 60 * 1000;

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.b3dm': 'application/octet-stream',
  '.pnts': 'application/octet-stream',
  '.i3dm': 'application/octet-stream',
  '.cmpt': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.ply': 'application/octet-stream',
  '.las': 'application/octet-stream',
  '.laz': 'application/octet-stream',
  '.osgb': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bin': 'application/octet-stream',
};

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

/**
 * 模型详情（带短缓存）
 * 注意：详情里的 url / preview_url 是带签名的直链，签名有效期通常远长于本缓存，
 * 但对象可能已被清理，所以取链失败时必须 force=true 重取一次再判定。
 */
async function fetchDetail(id, force = false) {
  const key = String(id);
  if (force) detailCache.delete(key);
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.ts < DETAIL_TTL) return hit.data;
  const r = await request({
    method: 'GET',
    path: `/model/${encodeURIComponent(id)}`,
    tag: '模型库',
  });
  if (r?.ok) detailCache.set(key, { ts: Date.now(), data: r.data });
  return r?.data || null;
}

/** OSS / CDN 常见错误码 → 人话 */
const CDN_ERRORS = {
  NoSuchKey: '源文件在对象存储里已不存在（司空 2 里记录还在，文件已被清理或当初就没生成成功），需要在司空 2 重新生成 / 重新上传该模型',
  AccessDenied: '签名链接无访问权限或已过期',
  SignatureDoesNotMatch: '签名校验失败（链接被改写或已过期）',
  RequestTimeTooSkewed: '本机时间与对象存储服务器相差过大，请校准系统时间',
  NoSuchBucket: '存储桶不存在（可能接入点/区域不匹配）',
};

/** 读取 CDN 错误体，翻译成可读原因 */
async function readCdnError(res) {
  const text = (await res.text().catch(() => '')) || '';
  const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || '';
  const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1] || '';
  const reason = CDN_ERRORS[code] || msg || '';
  return { code, msg, reason, raw: text.replace(/\s+/g, ' ').slice(0, 200) };
}

/**
 * 拉取模型包（或预览图）直链。
 * 遇到 403/404 先强刷一次详情重签再试一次——排除"签名过期 / 对象同步延迟"这类可恢复原因，
 * 仍然失败才认定是源文件缺失。
 */
async function fetchSigned(url, id, label) {
  let res = await fetch(url, { redirect: 'follow' });
  if (res.status === 403 || res.status === 404) {
    const first = await readCdnError(res);
    const fresh = await fetchDetail(id, true);
    const newUrl = fresh?.url || fresh?.preview_url;
    if (newUrl && newUrl !== url) {
      const retry = await fetch(newUrl, { redirect: 'follow' });
      if (retry.ok) {
        log.info('模型库', `${label}：重签后重试成功（首次 ${res.status} ${first.code}）`);
        return { res: retry, url: newUrl, recovered: true };
      }
      const second = await readCdnError(retry);
      return { res: retry, url: newUrl, err: second, firstErr: first };
    }
    return { res, url, err: first };
  }
  return { res, url };
}

function cdnFailMessage(label, status, err) {
  const base = `${label}失败：CDN 返回 ${status}`;
  if (!err) return base;
  return `${base}（${err.code || '未知'}${err.reason ? ' · ' + err.reason : ''}）`;
}

/**
 * 获取组织全量模型列表（跨项目聚合）
 *
 * ⚠️ 司空 2 的 /model 接口按 X-Project-Uuid 返回**当前项目**的模型。
 *    但模型库是运营视角：当前项目没有设备 / 没建模，不代表组织里没有模型。
 *    这里遍历组织全部项目逐个拉取后合并，并在每个模型上标注所属项目。
 *    单个项目拉取失败不拖垮整体（比如某项目无模型权限），失败明细放在 data.errors。
 *    结果缓存 60s；「刷新」按钮带 ?refresh=1 强制重拉。
 */
let listCache = { ts: 0, data: null };
const LIST_TTL = 60 * 1000;

router.get('/', async (req, res) => {
  if (listCache.data && !req.query.refresh && Date.now() - listCache.ts < LIST_TTL) {
    return res.json(listCache.data);
  }
  const prj = await request({
    method: 'GET',
    path: '/project',
    query: { page: 1, page_size: 100 },
    tag: '模型库',
  });
  const projects = (prj.ok && prj.data?.list) || [];
  if (!prj.ok && !projects.length) {
    // 项目列表都拿不到（TK 失效 / 网络）→ 退回旧行为：按当前项目拉一次，错误原样透出
    const r = await request({ method: 'GET', path: '/model', tag: '模型库' });
    return res.json({ ...r, message: r.ok ? r.message : r.message || prj.message || '项目列表获取失败' });
  }
  const merged = [];
  const seen = new Set();
  const errors = [];
  for (const p of projects) {
    const r = await request({ method: 'GET', path: '/model', projectUuid: p.uuid, tag: '模型库' });
    if (r.ok) {
      for (const m of r.data?.list || []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        merged.push({ ...m, projectUuid: p.uuid, projectName: p.name });
      }
    } else {
      errors.push({ projectUuid: p.uuid, projectName: p.name, message: r.message || `code ${r.code}` });
    }
  }
  const data = {
    ok: true,
    code: 0,
    message: errors.length ? `部分项目拉取失败：${errors.map((e) => `${e.projectName}（${e.message}）`).join('、')}` : '',
    data: { list: merged, total: merged.length, errors },
  };
  listCache = { ts: Date.now(), data };
  res.json(data);
});

/** 模型详情 */
router.get('/:id', async (req, res) => {
  const r = await request({
    method: 'GET',
    path: `/model/${encodeURIComponent(req.params.id)}`,
    tag: '模型库',
  });
  res.json(r);
});

/** 预览图代理：解决直链签名过期 / 跨域导致的裂图 */
router.get('/:id/preview', async (req, res) => {
  try {
    const d = await fetchDetail(req.params.id);
    const url = d?.preview_url;
    if (!url) return res.status(404).json({ ok: false, message: '该模型没有预览图' });
    const got = await fetchSigned(url, req.params.id, '预览图代理');
    if (!got.res.ok) {
      const err = got.err || (await readCdnError(got.res));
      return res.status(502).json({
        ok: false,
        message: cdnFailMessage('预览图代理', got.res.status, err),
        code: err.code || 'CDN_ERROR',
        hint: err.reason || '',
      });
    }
    const upstream = got.res;
    const ct = upstream.headers.get('content-type') || 'image/png';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'private, max-age=600');
    const len = upstream.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    log.error('模型库', `预览图代理失败：${e.message}`);
    res.status(502).json({ ok: false, message: `预览图代理失败：${e.message}` });
  }
});

/** 归一化包内路径（zip 里统一用 / 分隔） */
function normRel(p) {
  return path.posix.normalize(String(p || '').replace(/\\/g, '/'));
}

/**
 * 3D Tiles 允许「外部瓦片集」：某个瓦片的 content.uri 指向另一个 tileset.json。
 * 这里把所有 tileset 读一遍，记录谁被别人引用，从而找出真正的根。
 */
function collectExternalRefs(node, baseDir, out) {
  if (!node || typeof node !== 'object') return;
  const uri = node?.content?.uri;
  if (uri && /\.json$/i.test(uri)) {
    out.add(normRel(baseDir ? `${baseDir}/${uri}` : uri));
  }
  (node.children || []).forEach((c) => collectExternalRefs(c, baseDir, out));
}

/** 在文件清单里挑出根 tileset（未被任何 tileset 引用的那个） */
async function resolveTilesets(dir, files) {
  const all = files.filter((f) => /tileset[^/]*\.json$/i.test(f.path));
  const referenced = new Set();
  for (const t of all) {
    try {
      const raw = await fsp.readFile(path.join(dir, t.path), 'utf8');
      const j = JSON.parse(raw);
      collectExternalRefs(j?.root, path.posix.dirname(t.path), referenced);
    } catch {
      /* 单个 tileset 读不动就跳过 */
    }
  }
  const roots = all.filter((t) => !referenced.has(t.path)).map((t) => t.path);
  return {
    tilesets: all.map((t) => t.path),
    tilesetRoots: roots,
    // 兼容旧字段：优先返回唯一的根；多个根时取路径最短的那个（通常是总根）
    tileset: roots.length
      ? roots.slice().sort((a, b) => a.split('/').length - b.split('/').length)[0]
      : (all[0]?.path || ''),
  };
}

/** 模型包下载 + 解压，返回文件清单 */
router.get('/:id/files', async (req, res) => {
  const id = String(req.params.id);
  const dir = path.join(CACHE_ROOT, id);
  const manifestPath = path.join(dir, '_manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      // 老版本清单没有 tilesets / tilesetRoots，就地补算（文件已在磁盘，不用重新下包）
      if (!m.tilesets) {
        const ts = await resolveTilesets(dir, m.files || []);
        m.tileset = ts.tileset;
        m.tilesets = ts.tilesets;
        m.tilesetRoots = ts.tilesetRoots;
        await fsp.writeFile(manifestPath, JSON.stringify(m));
      }
      return res.json({ ok: true, data: m });
    }
    const d = await fetchDetail(id);
    const url = d?.url;
    if (!url) {
      return res.json({
        ok: false,
        message: '司空 2 暂未提供该模型的下载链接（可能仍在压缩中，请稍后重试）',
        data: { files: [] },
      });
    }
    const got = await fetchSigned(url, id, '模型包下载');
    if (!got.res.ok) {
      const err = got.err || (await readCdnError(got.res));
      const msg = cdnFailMessage('模型包下载', got.res.status, err);
      log.error('模型库', `id=${id} ${msg}`, { cdnCode: err.code, raw: err.raw });
      return res.json({
        ok: false,
        message: msg,
        code: err.code || 'CDN_ERROR',
        hint: err.reason || '',
        data: { files: [] },
      });
    }
    const upstream = got.res;
    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared && declared > MAX_ZIP_BYTES) {
      return res.json({
        ok: false,
        message: `模型包 ${(declared / 1024 / 1024).toFixed(0)} MB，超过浏览器预览上限（300 MB），请下载后用专业软件查看`,
        data: { files: [] },
      });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_ZIP_BYTES) {
      return res.json({ ok: false, message: '模型包过大，无法在浏览器预览', data: { files: [] } });
    }

    let entries = null;
    try {
      entries = unzipSync(new Uint8Array(buf));
    } catch (e) {
      return res.json({ ok: false, message: `模型包解压失败：${e.message}`, data: { files: [] } });
    }

    await ensureDir(dir);
    const files = [];
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      const safe = name.replace(/\.\./g, '_');
      const target = path.join(dir, safe);
      await ensureDir(path.dirname(target));
      await fsp.writeFile(target, Buffer.from(data));
      files.push({ path: safe, size: data.length });
    }
    const ts = await resolveTilesets(dir, files);
    const b3dm = files.filter((f) => /\.b3dm$/i.test(f.path));
    const gltf = files.filter((f) => /\.(glb|gltf)$/i.test(f.path));
    const manifest = {
      files,
      tileset: ts.tileset,
      tilesets: ts.tilesets,
      tilesetRoots: ts.tilesetRoots,
      b3dm: b3dm.map((f) => f.path),
      gltf: gltf.map((f) => f.path),
    };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));
    log.ok(
      '模型库',
      `模型包已解压 id=${id} 文件 ${files.length} 个（b3dm ${b3dm.length} / tileset ${ts.tilesets.length}，根 ${ts.tilesetRoots.length}）`
    );
    res.json({ ok: true, data: manifest });
  } catch (e) {
    log.error('模型库', `模型包准备失败：${e.message}`);
    res.json({ ok: false, message: `模型包准备失败：${e.message}`, data: { files: [] } });
  }
});

/** 模型包下载代理（带正确文件名，避免浏览器存成无名文件） */
router.get('/:id/package', async (req, res) => {
  try {
    const d = await fetchDetail(req.params.id);
    const url = d?.url;
    if (!url) return res.status(404).json({ ok: false, message: '该模型暂无下载链接' });
    const got = await fetchSigned(url, req.params.id, '模型包下载');
    if (!got.res.ok) {
      const err = got.err || (await readCdnError(got.res));
      return res.status(502).json({
        ok: false,
        message: cdnFailMessage('模型包下载', got.res.status, err),
        code: err.code || 'CDN_ERROR',
        hint: err.reason || '',
      });
    }
    const upstream = got.res;
    const name = String(req.query?.name || d?.name || req.params.id).replace(/\.(zip|las|laz)$/i, '');
    const filename = `${name}.zip`;
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/zip');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    log.error('模型库', `模型包下载失败：${e.message}`);
    res.status(502).json({ ok: false, message: `模型包下载失败：${e.message}` });
  }
});

/**
 * 可用性预检：用 Range 只取 1 字节，不下载整包就能判断源文件还在不在。
 * 前端可在点「三维预览 / 下载」前先打一次，避免等半天才弹 404。
 */
router.get('/:id/check', async (req, res) => {
  const id = String(req.params.id);
  try {
    const d = await fetchDetail(id, true);
    const url = d?.url;
    if (!url) {
      return res.json({ ok: true, available: false, message: '司空 2 暂未提供该模型的下载链接（可能仍在压缩中）' });
    }
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    if (r.ok || r.status === 206) {
      const total = Number((r.headers.get('content-range') || '').split('/')[1] || r.headers.get('content-length') || 0);
      return res.json({ ok: true, available: true, size: total, overLimit: total > MAX_ZIP_BYTES });
    }
    const err = await readCdnError(r);
    return res.json({
      ok: true,
      available: false,
      status: r.status,
      code: err.code || 'CDN_ERROR',
      message: `源文件不可用（${err.code || r.status}）：${err.reason || err.msg || '未知原因'}`,
    });
  } catch (e) {
    res.json({ ok: false, available: false, message: `预检失败：${e.message}` });
  }
});

/** 读取解压出来的单个文件（供前端三维渲染） */
router.get('/:id/asset', async (req, res) => {
  const id = String(req.params.id);
  const rel = String(req.query?.path || '');
  if (!rel) return res.status(400).json({ ok: false, message: '缺少 path' });
  const dir = path.join(CACHE_ROOT, id);
  const target = path.resolve(dir, rel);
  if (!target.startsWith(dir)) return res.status(400).json({ ok: false, message: '非法路径' });
  if (!fs.existsSync(target)) return res.status(404).json({ ok: false, message: '文件不存在' });
  const ext = path.extname(target).toLowerCase();
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(target).pipe(res);
});

export default router;
