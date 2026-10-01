/**
 * 航线文件上传（STS 三步）：取凭证 → 传司空 2 存储桶 → 通知上传完成
 *
 * 三步里任何一步失败都要说清卡在哪一段，否则用户只看到「上传失败」无法定位。
 * 原先这段逻辑写在 routes/wayline.js 里，自研规划也要用，抽出来共用。
 */

import OSS from 'ali-oss';
import { request } from '../../djiClient.js';
import { log } from '../../logger.js';

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

export function normalizeRegion(region = '') {
  if (!region) return 'oss-cn-hangzhou';
  if (region.startsWith('oss-')) return region;
  return REGION_MAP[region.toLowerCase()] || `oss-cn-${region}`;
}

/**
 * @param {object} opts
 * @param {Buffer} opts.buffer    KMZ 内容
 * @param {string} opts.filename  存储桶里的对象名（需带 .kmz）
 * @param {string} opts.name      航线名称（司空 2 里显示的名字）
 * @param {string} [opts.tag]
 */
export async function uploadWayline({ buffer, filename, name, tag = '航线管理' }) {
  const sts = await request({ method: 'GET', path: '/project/sts-token', tag });
  if (!sts.ok) {
    return { ok: false, step: 'sts', message: `获取上传凭证失败：${sts.message}`, code: sts.code };
  }
  const { endpoint, bucket, region, credentials, object_key_prefix } = sts.data || {};
  const c = credentials || {};

  const prefix = (object_key_prefix || '').replace(/\/+$/, '');
  const objectKey = `${prefix}/${filename}`;

  let client;
  try {
    client = new OSS({
      accessKeyId: c.access_key_id,
      accessKeySecret: c.access_key_secret,
      stsToken: c.security_token,
      bucket,
      region: normalizeRegion(region),
      ...(endpoint ? { endpoint: endpoint.startsWith('http') ? endpoint : `https://${endpoint}` } : {}),
      secure: true,
    });
    await client.put(objectKey, buffer);
  } catch (e) {
    log.error(tag, `航线文件上传存储桶失败：${e.message}`, { objectKey });
    return { ok: false, step: 'oss', message: `上传到存储桶失败：${e.message}`, objectKey };
  }

  const finish = await request({
    method: 'POST',
    path: '/wayline/finish-upload',
    body: { object_key: objectKey, name: name || filename },
    tag,
  });
  if (!finish.ok) {
    return {
      ok: false,
      step: 'finish',
      message: `通知司空 2 失败：${finish.message}`,
      code: finish.code,
      objectKey,
    };
  }
  return { ok: true, data: finish.data || {}, objectKey };
}
