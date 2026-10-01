/**
 * KMZ 打包
 *
 * KMZ 本质就是 zip，但有两个必须遵守的约定：
 *  1. 条目路径必须是 wpmz/template.kml 与 wpmz/waylines.wpml（大小写与目录名固定）
 *  2. 不能混入 __MACOSX / .DS_Store——macOS 上用系统压缩工具打包会产生这些，
 *     司空 2 侧解析会失败；这里由代码直接写条目，天然不会有杂项。
 */

import { zipSync, strToU8, unzipSync } from 'fflate';

/** @param {Record<string,string>} files 路径 → 文本内容 */
export function packKmz(files) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = strToU8(content);
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}

/** 解包（读取司空 2 现有航线做对比 / 反演机型参数时用） */
export function unpackKmz(buf) {
  const out = {};
  const unzipped = unzipSync(new Uint8Array(buf));
  for (const [name, data] of Object.entries(unzipped)) {
    if (/\/$/.test(name)) continue; // 目录条目
    out[name] = Buffer.from(data).toString('utf8');
  }
  return out;
}

export { zipSync, strToU8, unzipSync };
