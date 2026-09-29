/**
 * 缩略图与邮件压缩图生成
 *
 * 同步时一次性生成三种尺寸，避免审核/派发时临时处理：
 *   原图   —— 归档与复核证据（不改动，保留 EXIF）
 *   邮件图 —— 1600px / q80，约 500KB/张（邮件附件用，避免 4.5MB 原图超邮箱限制）
 *   缩略图 —— 200px，审核网格用
 *
 * ⚠️ 缩略图会剥离 EXIF（含 GPS），只有原图能拿到定位信息。
 *    因此坐标一律在同步阶段从原图解析后入库，不依赖缩略图。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { THUMB_DIR, MAIL_IMAGE_DIR, THUMB_SIZE, MAIL_IMAGE_SIZE, MAIL_IMAGE_QUALITY, toRelative, toAbsolute } from '../../db/config.js';
import { log } from '../../logger.js';

/**
 * 红外影像在网格里需要人眼可辨，做轻微提亮
 *
 * ⚠️ 必须返回 { pipeline } 而不是 sharp 实例本身：
 *    若把已链式的实例再传给 resize()，sharp 会把后续方法误当成 autoOrient 的布尔参数，
 *    报 "Expected boolean for autoOrient but received function"。
 */
function enhanceForInfrared(pipeline) {
  return pipeline.linear(1.25, -12).modulate({ saturation: 0.85 });
}

/**
 * 生成缩略图（200px）与邮件压缩图（1600px）
 * @param {Buffer} buf 原图字节
 * @param {object} opts
 * @param {string} opts.baseName 文件名主干（不含扩展名），用于命名
 * @param {boolean} [opts.infrared] 是否红外（做可视化增强）
 * @returns {Promise<{thumbPath:string|null, mailPath:string|null, width:number, height:number, error?:string}>}
 */
export async function generateDerivatives(buf, { baseName, infrared = false }) {
  let width = 0;
  let height = 0;
  let thumbPath = null;
  let mailPath = null;
  try {
    const meta = await sharp(buf).metadata();
    width = meta.width || 0;
    height = meta.height || 0;

    // 缩略图：200px inside（保持比例，不裁切）
    // 注意：红外增强链必须一次链到底，不能中途再调 resize
    const thumbBuf = await (infrared
      ? enhanceForInfrared(sharp(buf)).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      : sharp(buf).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    )
      .jpeg({ quality: 78 })
      .toBuffer();
    const thumbAbs = path.join(THUMB_DIR, `${baseName}.jpg`);
    await fs.writeFile(thumbAbs, thumbBuf);
    thumbPath = toRelative(thumbAbs);

    // 邮件图：1600px inside，控制体积
    const mailBuf = await (infrared
      ? enhanceForInfrared(sharp(buf)).resize(MAIL_IMAGE_SIZE, MAIL_IMAGE_SIZE, { fit: 'inside', withoutEnlargement: true })
      : sharp(buf).resize(MAIL_IMAGE_SIZE, MAIL_IMAGE_SIZE, { fit: 'inside', withoutEnlargement: true })
    )
      .jpeg({ quality: MAIL_IMAGE_QUALITY, mozjpeg: true })
      .toBuffer();
    const mailAbs = path.join(MAIL_IMAGE_DIR, `${baseName}.jpg`);
    await fs.writeFile(mailAbs, mailBuf);
    mailPath = toRelative(mailAbs);
  } catch (e) {
    // 红外 tlif/未支持格式等异常不应中断整批同步
    return { thumbPath, mailPath, width, height, error: e.message };
  }
  return { thumbPath, mailPath, width, height };
}

/**
 * 生成位置示意图（发邮件时用）
 * 纯 canvas 绘制，不依赖外部瓦片服务，避免一期引入网络依赖。
 *
 * @param {object} opts
 * @param {number} opts.lat @param {number} opts.lon
 * @param {object} [opts.bbox] 图斑范围 {minLat,maxLat,minLon,maxLon}
 * @param {string} [opts.label] 角标文字（如工单号）
 * @param {string} [opts.adminRegion]
 * @returns {Promise<Buffer>} PNG
 */
export async function renderLocatorPng({ lat, lon, bbox, label, adminRegion }) {
  const W = 640;
  const H = 420;
  const pad = 40;
  // 计算范围：优先用图斑 bbox，否则以中心点为圆心展开约 200m
  let minLat;
  let maxLat;
  let minLon;
  let maxLon;
  if (bbox && bbox.minLat != null) {
    minLat = bbox.minLat; maxLat = bbox.maxLat; minLon = bbox.minLon; maxLon = bbox.maxLon;
  } else {
    const dLat = 0.0018; // ≈200m
    const dLon = 0.0018 / Math.cos((lat * Math.PI) / 180 || 1);
    minLat = lat - dLat; maxLat = lat + dLat; minLon = lon - dLon; maxLon = lon + dLon;
  }
  const toX = (lo) => pad + ((lo - minLon) / (maxLon - minLon || 1e-9)) * (W - pad * 2);
  const toY = (la) => H - pad - ((la - minLat) / (maxLat - minLat || 1e-9)) * (H - pad * 2);

  // 生成 SVG 再转 PNG（sharp 支持 svg 输入）
  const x1 = toX(minLon); const y1 = toY(maxLat);
  const x2 = toX(maxLon); const y2 = toY(minLat);
  const cx = toX(lon); const cy = toY(lat);
  const text = adminRegion || '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#F2F5F8"/>
  <g stroke="#D9E1E8" stroke-width="1">
    ${Array.from({ length: 9 }, (_, i) => `<line x1="${pad + i * 70}" y1="${pad}" x2="${pad + i * 70}" y2="${H - pad}"/>`).join('')}
    ${Array.from({ length: 5 }, (_, i) => `<line x1="${pad}" y1="${pad + i * 60}" x2="${W - pad}" y2="${pad + i * 60}"/>`).join('')}
  </g>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="#B7C3CE"/>
  <rect x="${x1}" y="${y1}" width="${Math.max(6, x2 - x1)}" height="${Math.max(6, y2 - y1)}"
        fill="rgba(230,120,0,0.22)" stroke="#E67800" stroke-width="2"/>
  <circle cx="${cx}" cy="${cy}" r="6" fill="#E67800" stroke="#fff" stroke-width="2"/>
  <text x="${cx + 12}" y="${cy - 10}" font-family="sans-serif" font-size="14" fill="#333">${lat.toFixed(7)}, ${lon.toFixed(7)}</text>
  ${text ? `<text x="${pad}" y="${pad - 14}" font-family="sans-serif" font-size="15" fill="#333">${text}</text>` : ''}
  ${label ? `<text x="${W - pad}" y="${H - pad + 20}" font-family="sans-serif" font-size="13" fill="#6B7A88" text-anchor="end">${label}</text>` : ''}
  <g transform="translate(${W - pad - 18},${pad + 8})">
    <line x1="0" y1="14" x2="0" y2="-14" stroke="#5A6874" stroke-width="2"/>
    <path d="M0,-16 L-5,-6 L5,-6 Z" fill="#5A6874"/>
    <text x="0" y="28" font-family="sans-serif" font-size="12" fill="#5A6874" text-anchor="middle">N</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 删除派生图（删除架次时用） */
export async function removeDerivatives(relativePaths) {
  for (const rel of relativePaths) {
    if (!rel) continue;
    try {
      await fs.unlink(toAbsolute(rel));
    } catch {
      /* 文件不存在时忽略 */
    }
  }
}
