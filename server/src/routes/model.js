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
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Unzip, UnzipInflate } from 'fflate';
import { request } from '../djiClient.js';
import { log } from '../logger.js';

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.resolve(__dirname, '../../data/models');
/**
 * 单个模型包的下载上限。
 *
 * 之前是 300 MB，超了直接拒绝预览——但司空 2 的贴近摄影成果动辄 800MB+
 * （实测「T3贴近摄影建模」862MB），门槛一设就等于大半模型看不了。
 * 现在下载/解压已改成流式，内存不再是瓶颈，门槛只用来兜住
 * 「异常包 / 磁盘不足」，放到 2 GB。
 */
const MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
/** 解压前预留的磁盘余量：zip 本身 + 解压产物至少要装得下 */
const MIN_FREE_DISK = 4 * 1024 * 1024 * 1024;
/** 详情短缓存：详情里带签名链接，重复取没有意义 */
const detailCache = new Map();
const DETAIL_TTL = 5 * 60 * 1000;

const fmtMB = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/**
 * 安静删除临时文件：失败不抛，最多重试 3 次（应对 EBUSY / 句柄未释放）。
 * 删不掉的大不了下次启动清 tmp，只是不该因此把请求搞崩。
 */
async function removeQuietly(p, tries = 3) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await fsp.rm(p, { force: true });
      return true;
    } catch (e) {
      if (i === tries - 1) {
        log.warn('模型库', `临时文件删除失败 ${p}：${e.code || e.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  return false;
}

/** 取缓存目录所在磁盘的可用字节数（失败返回 Infinity，不阻断流程） */
function freeDiskBytes(target) {
  try {
    const st = fs.statfsSync(path.dirname(target));
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Infinity;
  }
}

/**
 * 流式解压 zip 到目录，逐文件写盘。
 *
 * 不用 unzipSync：它是同步全量解，包和解压产物会同时驻留内存，
 * 大包直接 OOM。Unzip 可以边喂数据边出文件，峰值内存只有一个块。
 * 返回 [{ path, size }]。
 */
function unzipToDisk(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    const files = [];
    const writes = [];
    let failed = null;

    // fflate 的 Unzip 不是 EventEmitter：文件回调是 onfile 属性，
    // 压缩方式通过 register() 注册解压器（这里只处理 deflate）。
    unzip.onfile = (file) => {
      if (!file.name || file.name.endsWith('/')) return;
      // 防目录穿越：zip 里可能带 ../ 或绝对路径
      const rel = path.posix.normalize(file.name.replace(/\\/g, '/'));
      const safe = rel.replace(/^(\.\.(\/|$))+/, '');
      if (!safe || safe === '.' || safe.startsWith('/')) return;
      const target = path.join(outDir, safe);
      if (!path.resolve(target).startsWith(path.resolve(outDir))) return;
      const chunks = [];
      file.ondata = (err, chunk, final) => {
        if (err || failed) {
          failed = failed || err || new Error('解压数据出错');
          return;
        }
        chunks.push(chunk);
        if (final) {
          const data = Buffer.concat(chunks);
          chunks.length = 0;
          files.push({ path: safe, size: data.length });
          writes.push(
            fsp
              .mkdir(path.dirname(target), { recursive: true })
              .then(() => fsp.writeFile(target, data))
          );
        }
      };
      // ⚠️ 必须显式 start()：fflate 不会自动开始解压，
      // 不调用的话这个文件会被静默跳过（onfile 触发了但一个字节都不吐）。
      file.start();
    };
    unzip.onerror = (e) => {
      failed = failed || new Error(e.message || '解压失败');
    };

    const rs = fs.createReadStream(zipPath);
    rs.on('error', reject);
    rs.on('data', (chunk) => {
      if (failed) return;
      try {
        unzip.push(chunk, false);
      } catch (e) {
        failed = e;
        rs.destroy();
      }
    });
    rs.on('error', reject);
    rs.on('end', () => {
      // 句柄必须先关掉，否则调用方删除 zip 时会撞上 EBUSY
      rs.close(() => {
        if (!failed) {
          // 第二个参数 true = 最后一个数据块，触发 onfile 的 final 回调
          try {
            unzip.push(new Uint8Array(0), true);
          } catch (e) {
            failed = e;
          }
        }
        if (failed) {
          reject(failed);
          return;
        }
        Promise.all(writes)
          .then(() => resolve(files))
          .catch(reject);
      });
    });
  });
}

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
  // ---- 以下为 Cesium 三维底座 POC 补充（3D Tiles 1.1 / glTF 2.0 扩展）----
  '.ktx2': 'image/ktx2',
  '.basis': 'application/octet-stream',
  '.webp2': 'image/webp',
  '.wasm': 'application/wasm',
  '.kml': 'application/vnd.google-earth.kml+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
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

/**
 * 本地已缓存模型清单（**不依赖司空 2**）
 *
 * 为什么要单独一条：
 * 三维底座的离线可跑性（Cesium POC 的 G4）要求「断外网仍能打开一个模型」。
 * 而列表接口 /model 是实时向司空 2 拉的，没有 TK / 没网就无数据可渲染，
 * 于是「离线能不能跑」这件事永远测不了。这里直接读磁盘上的模型缓存目录，
 * 只依赖 _manifest.json（下载解压时已落盘），因此断网也可用。
 *
 * ⚠️ 必须注册在 /:id 之前，否则 '/local' 会被当成一个模型 id。
 */
router.get('/local', async (req, res) => {
  try {
    if (!fs.existsSync(CACHE_ROOT)) return res.json({ ok: true, data: { list: [], total: 0 } });
    const dirs = (await fsp.readdir(CACHE_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory());
    // 先把清单都读出来；老版本下载时没把模型名写进清单，name 会缺
    const entries = [];
    for (const d of dirs) {
      const dir = path.join(CACHE_ROOT, d.name);
      const manifestPath = path.join(dir, '_manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        entries.push({ id: d.name, manifestPath, m: JSON.parse(await fsp.readFile(manifestPath, 'utf8')) });
      } catch {
        /* 清单坏了就跳过这一个，不影响整表 */
      }
    }
    // 补名：只对 name 缺失的发生（新下载的包在落盘时已带 name），并行拉、短超时，
    // 拉到就写回清单——下次（包括断网时）直接用，不再依赖在线接口。
    // 失败（离线/无 TK/超时）就让列表用目录 id 兜底并标 nameKnown:false，
    // 不能因为补名把 /local「只依赖磁盘、断网可用」的初衷破坏掉。
    const needName = entries.filter((e) => !e.m.name);
    if (needName.length) {
      await Promise.allSettled(
        needName.map(async (e) => {
          try {
            const r = await request({
              method: 'GET',
              path: `/model/${encodeURIComponent(e.id)}`,
              tag: '模型库',
              timeout: 8000,
            });
            if (!r?.ok || !r.data?.name) return;
            e.m.name = r.data.name;
            e.m.userName = r.data.user_name || e.m.userName || null;
            await fsp.writeFile(e.manifestPath, JSON.stringify(e.m));
          } catch {
            /* 离线或超时：跳过，列表回退用 id */
          }
        })
      );
    }
    const list = entries.map((e) => {
      const m = e.m;
      const roots = (m.tilesetRoots || []).filter(Boolean);
      const entry = roots[0] || m.tileset || null;
      return {
        id: e.id,
        name: m.name || e.id,
        // name 是目录 id 兜底的（清单里没存名且这次也没拉到）→ 前端提示「未知名」
        nameKnown: !!m.name,
        file_type: entry ? 'model_3d' : m.raster2d ? 'model_2d' : 'unknown',
        entry,
        fileCount: (m.files || []).length,
        // 体积按清单累加，不用递归 stat（几千个文件 stat 一次要好几秒）
        bytes: (m.files || []).reduce((n, f) => n + (Number(f.size) || 0), 0),
        hasRaster2d: !!m.raster2d,
        assetVersion: m.assetVersion || null,
        cachedAt: m.ts || null,
      };
    });
    // 体积大的排前面：POC 优先拿大包压性能
    list.sort((a, b) => b.bytes - a.bytes);
    res.json({ ok: true, data: { list, total: list.length } });
  } catch (e) {
    log.error('模型库', `本地缓存清单读取失败：${e.message}`);
    res.status(500).json({ ok: false, message: `本地缓存清单读取失败：${e.message}` });
  }
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

/**
 * 识别「二维模型」= 正射影像瓦片金字塔（大疆测绘建图产物）
 *
 * 典型包结构（实测）：model/download/{z}/{x}/{y}.png，256px 瓦片，
 * 层级 z=12…23，x/y 就是标准 Web Mercator XYZ 行列号
 * （按 gps corner 反算的 x/y 范围与实际文件名逐一吻合），
 * 配套 report/map_report.json 里带 "GCJ tiles":false 表示瓦片是 WGS84。
 *
 * 这类模型没有 tileset.json / b3dm / glb，三维渲染器完全用不上，
 * 必须单独识别出来按二维瓦片金字塔渲染，否则只能退回预览图。
 */
function resolveRaster2d(dir, files) {
  const raster = files.filter((f) => /\.png$/i.test(f.path) && /\/(\d+)\/(\d+)\/(\d+)\.png$/.test(f.path));
  if (raster.length < 4) return null;
  /** z -> { min, max, n } */
  const levels = new Map();
  let samplePath = '';
  for (const f of raster) {
    const m = f.path.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!m) continue;
    const z = Number(m[1]);
    if (!levels.has(z)) levels.set(z, { z, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, n: 0 });
    const lv = levels.get(z);
    const x = Number(m[2]);
    const y = Number(m[3]);
    lv.minX = Math.min(lv.minX, x);
    lv.maxX = Math.max(lv.maxX, x);
    lv.minY = Math.min(lv.minY, y);
    lv.maxY = Math.max(lv.maxY, y);
    lv.n += 1;
    if (!samplePath) samplePath = f.path;
  }
  if (!levels.size) return null;
  const zs = [...levels.keys()].sort((a, b) => a - b);
  const deepest = levels.get(zs[zs.length - 1]);
  // 瓦片根目录：从样例路径剥掉尾部 {z}/{x}/{y}.png（样例本身就在这一层里）
  const base = samplePath.replace(/\d+\/\d+\/\d+\.png$/, '').replace(/\/$/, '');
  return {
    kind: 'raster2d',
    // 瓦片根目录（前端按 base/{z}/{x}/{y}.png 拼路径）
    base,
    minLevel: zs[0],
    maxLevel: zs[zs.length - 1],
    tileCount: raster.length,
    // 覆盖范围（用最深层的行列号反推经纬度矩形）
    minX: deepest.minX,
    maxX: deepest.maxX,
    minY: deepest.minY,
    maxY: deepest.maxY,
    gcjTiles: null, // 由 report 补齐
  };
}

/**
 * 读建图报告 map_report.json，补齐坐标系 / 层级 / 四角经纬度。
 * 报告不一定在包根（实测在 model/download/report/ 下），按清单里的实际路径找。
 */
async function readMapReport(dir, files) {
  const cand = (files || [])
    .map((f) => f.path)
    .filter((p) => /(^|\/)map_report\.json$/i.test(p));
  for (const c of cand) {
    try {
      const raw = await fsp.readFile(path.join(dir, c), 'utf8');
      const j = JSON.parse(raw);
      const g = j['gps corner'] || j.gpsCorner || j.gps_corner;
      const pick = (a, b) => {
        const v = g?.[a] ?? g?.[b];
        return typeof v === 'number' ? v : null;
      };
      return {
        gcjTiles: j['GCJ tiles'] === true || j.gcj_tiles === true,
        gsd: j['TDOM GSD'] ?? null,
        reportMinLevel: j['map tile']?.['minimum level'] ?? null,
        reportMaxLevel: j['map tile']?.['maximum level'] ?? null,
        topLeft: { lat: pick('top left lat', 'topLeftLat'), lon: pick('top left lon', 'topLeftLon') },
        bottomRight: { lat: pick('bottom right lat', 'bottomRightLat'), lon: pick('bottom right lon', 'bottomRightLon') },
      };
    } catch {
      /* 报告读不动就只用行列号推算范围 */
    }
  }
  return null;
}

/** 模型包下载 + 解压，返回文件清单 */
router.get('/:id/files', async (req, res) => {
  const id = String(req.params.id);
  const dir = path.join(CACHE_ROOT, id);
  const manifestPath = path.join(dir, '_manifest.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const m = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      // 老版本清单没有 tilesets / tilesetRoots / raster2d，就地补算（文件已在磁盘，不用重新下包）
      if (!m.tilesets) {
        const ts = await resolveTilesets(dir, m.files || []);
        m.tileset = ts.tileset;
        m.tilesets = ts.tilesets;
        m.tilesetRoots = ts.tilesetRoots;
      }
      if (m.raster2d === undefined) {
        const r2 = resolveRaster2d(dir, m.files || []);
        m.raster2d = r2 ? { ...r2, ...(await readMapReport(dir, m.files) || {}) } : null;
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
        message: `模型包 ${fmtMB(declared)}，超过预览上限 ${fmtMB(MAX_ZIP_BYTES)}，请下载后用专业软件查看`,
        data: { files: [] },
      });
    }

    // ⚠️ 必须流式落盘，不能 arrayBuffer() 整体读进内存：
    // 800MB+ 的包一次读进堆内存，再叠加解压副本，Node 进程会被直接 OOM 掉
    // （浏览器端同理）。这里边下边写盘、边下边解压，峰值内存只有一个数据块。
    await ensureDir(dir);
    if (declared && declared * 2 + MIN_FREE_DISK > freeDiskBytes(dir)) {
      return res.json({
        ok: false,
        message: `磁盘余量不足：解压该模型（${fmtMB(declared)}）至少需要 ${fmtMB(declared * 2)} 可用空间，请清理磁盘后重试`,
        data: { files: [] },
      });
    }
    // 临时 zip 放系统临时目录，而不是模型缓存目录：
    // 缓存目录下的文件正被 createReadStream 占用时，Windows/macOS 上
    // 删除会延后甚至失败（EBUSY），表现为「每次解压都残留一份几十上百 MB 的 zip」。
    const zipPath = path.join(os.tmpdir(), `duav-model-${id}-${Date.now()}.zip`);
    let received = 0;
    try {
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          // 有些包 CDN 不给 content-length，靠累计体积中途兜底
          if (received > MAX_ZIP_BYTES) {
            cb(new Error(`模型包超过预览上限 ${fmtMB(MAX_ZIP_BYTES)}`));
            return;
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(upstream.body), counter, fs.createWriteStream(zipPath));
    } catch (e) {
      await fsp.rm(zipPath, { force: true });
      const over = /超过预览上限/.test(e.message);
      return res.json({
        ok: false,
        message: over ? e.message : `模型包下载中断：${e.message}`,
        data: { files: [] },
      });
    }

    let files = [];
    try {
      files = await unzipToDisk(zipPath, dir);
    } catch (e) {
      log.error('模型库', `模型包解压失败 id=${id}：${e.message}`, { stack: e.stack });
      return res.json({ ok: false, message: `模型包解压失败：${e.message}`, data: { files: [] } });
    } finally {
      // 原始 zip 用完即删，避免磁盘双份占用。
      // 两个坑：①rm 抛错会穿到外层 catch，而此时响应已发出 →
      // ERR_HTTP_HEADERS_SENT 直接把进程带崩；②读流句柄未释放时删除会
      // EBUSY 失败，所以先 destroy 再删，失败重试几次。
      await removeQuietly(zipPath);
    }
    if (!files.length) {
      return res.json({ ok: false, message: '模型包为空或已损坏', data: { files: [] } });
    }
    const ts = await resolveTilesets(dir, files);
    const b3dm = files.filter((f) => /\.b3dm$/i.test(f.path));
    const gltf = files.filter((f) => /\.(glb|gltf)$/i.test(f.path));
    // 点云：LAS 上传到司空 2 后会转成 pnts，此前前端直接丢弃这类瓦片
    const pnts = files.filter((f) => /\.pnts$/i.test(f.path));
    const r2 = resolveRaster2d(dir, files);
    const manifest = {
      files,
      // 模型名：下载时 detail 接口是在线的，顺手存下来，离线列表才有名字可显
      name: d?.name || null,
      userName: d?.user_name || null,
      tileset: ts.tileset,
      tilesets: ts.tilesets,
      tilesetRoots: ts.tilesetRoots,
      b3dm: b3dm.map((f) => f.path),
      gltf: gltf.map((f) => f.path),
      pnts: pnts.map((f) => f.path),
      // 二维模型（正射影像金字塔）：没有 tileset，靠这个字段走瓦片渲染
      raster2d: r2 ? { ...r2, ...(await readMapReport(dir, files) || {}) } : null,
    };
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));
    log.ok(
      '模型库',
      `模型包已解压 id=${id} 文件 ${files.length} 个（b3dm ${b3dm.length} / tileset ${ts.tilesets.length}，根 ${ts.tilesetRoots.length}${
        r2 ? ` / 二维瓦片 ${r2.tileCount} 张 z${r2.minLevel}-${r2.maxLevel}` : ''
      }）`
    );
    res.json({ ok: true, data: manifest });
  } catch (e) {
    log.error('模型库', `模型包准备失败：${e.message}`, { stack: e.stack });
    // 响应可能已经发出（例如解压失败后 finally 又出错），再发一次会直接把进程带崩
    if (res.headersSent) return;
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
  if (!target.startsWith(dir + path.sep)) return res.status(400).json({ ok: false, message: '非法路径' });
  if (!fs.existsSync(target)) return res.status(404).json({ ok: false, message: '文件不存在' });
  const ext = path.extname(target).toLowerCase();
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(target).pipe(res);
});

/**
 * 路径式瓦片读取：GET /api/model/:id/tiles/<包内相对路径>
 *
 * 为什么要有它（不是重复造 /:id/asset）：
 * 三维瓦片链路里，tileset.json 内部写的是**相对 uri**，例如
 *   "content": { "uri": "BlockAYXY_L16_1.json" }
 *   "content": { "uri": "../BlockA/tileset.json" }
 * 引用方（Cesium / 任何三维引擎）会以「当前 tileset.json 的 URL」为基准去解析这些相对地址。
 *
 * 而 /:id/asset?path=xxx 是查询串形式：基准 URL 的路径部分是固定的 `/api/model/:id/asset`，
 * 相对地址会被解析到 `/api/model/xxx/BlockAYXY_L16_1.json` 这类**不存在**的位置。
 * 本项目真实数据里还有 `Project1 2/B3DM/Model_0/tileset.json` 这种带空格、多级子目录的路径，
 * 以及外部 tileset 引用，命令行与浏览器对空格的编码处理还不一致——查询串形式在这里必翻车。
 *
 * 路径式路由让相对 uri「自然成立」：base 变成 /api/model/:id/tiles/<入口目录>/，
 * 引擎拼出来的地址正好又落回本路由。这是 R4 的解法。
 *
 * 安全：仍然只允许读 CACHE_ROOT/:id 之内的文件，做 realpath 边界校验，
 * 防 ../ 穿越与符号链接逃逸。
 */
router.get('/:id/tiles/*', async (req, res) => {
  const id = String(req.params.id);
  // Express 4 把通配部分放在 params[0]；Express 5 为 params.splat，这里兼容两种
  const raw = String(req.params[0] ?? req.params.splat ?? '');
  if (!raw) return res.status(400).type('text/plain').send('缺少瓦片路径');

  const dir = path.join(CACHE_ROOT, id);
  let target;
  try {
    // 通配段可能是多段组成，逐段解码，避免文件名里本来就含 % 时被二次解码搞坏
    const rel = raw
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      })
      .join('/');
    target = path.resolve(dir, rel);
  } catch {
    return res.status(400).type('text/plain').send('非法瓦片路径');
  }
  if (target !== dir && !target.startsWith(dir + path.sep)) {
    log.warn('模型库', `瓦片路径越界被拒 id=${id} raw=${raw}`);
    return res.status(400).type('text/plain').send('非法瓦片路径');
  }

  let st;
  try {
    st = await fsp.stat(target);
    // 目录不放行（避免 Cesium 拿不到内容却一直重试）
    if (!st.isFile()) return res.status(404).type('text/plain').send('不是文件');
  } catch {
    return res.status(404).type('text/plain').send('瓦片不存在');
  }

  const ext = path.extname(target).toLowerCase();
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Content-Length', String(st.size));
  // 瓦片内容按 hash 命名/内容不变，可缓存；但它是私有项目数据，不加 public
  res.set('Cache-Control', 'private, max-age=3600');
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', (e) => {
    log.error('模型库', `瓦片读流失败 id=${id} path=${raw}：${e.message}`);
    if (!res.headersSent) res.status(500).type('text/plain').send('读取失败');
    else res.destroy();
  }).pipe(res);
});

export default router;
