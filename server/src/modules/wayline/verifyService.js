/**
 * 上传验证服务 —— 三道闸里的「闸 2：入库后回查比对」
 *
 * 为什么必须有这一步：实测司空 2 **不做机型校验**（把 droneEnumValue 写成 91 照样入库），
 * 所以「上传返回 code=0」只能证明文件格式被接受，证明不了机型对。
 * 真正的验证是：上传后回查航线列表，确认这条航线在库里、且 device_model_key 与目标机型一致。
 *
 * 用户口径「上传后到司空 2 验证，无报错就显示在航线库里」= 这里的 matched === true。
 */

import { request } from '../../djiClient.js';
import { log } from '../../logger.js';
import { uploadWayline } from './ossUpload.js';

const POLL_TIMES = 6;
const POLL_INTERVAL = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在航线库里找刚上传的那条（优先按 uuid，其次按名字取最新一条） */
async function findInLibrary({ id, name }) {
  const r = await request({ method: 'GET', path: '/wayline', query: { page: 1, page_size: 100 }, tag: '航线规划' });
  if (!r.ok) return { ok: false, message: r.message || '回查航线列表失败' };
  const list = r.data?.list || [];
  let hit = id ? list.find((w) => w.id === id) : null;
  if (!hit && name) {
    const same = list.filter((w) => w.name === name);
    // 同名取 update_time 最大的：重复提交时能拿到的才是最新的那条
    hit = same.sort((a, b) => Number(b.update_time || 0) - Number(a.update_time || 0))[0] || null;
  }
  return { ok: true, hit, total: list.length };
}

/**
 * 回查并比对机型
 * @returns {{ok:boolean, matched:boolean, waylineId:string|null, remoteModelKey:string|null, message:string}}
 */
export async function verifyInLibrary({ id, name, expectedKey }) {
  let last = { ok: false, matched: false, message: '未回查到航线' };
  for (let i = 0; i < POLL_TIMES; i++) {
    await sleep(i === 0 ? 800 : POLL_INTERVAL);
    const found = await findInLibrary({ id, name });
    if (!found.ok) {
      last = { ok: false, matched: false, waylineId: id || null, remoteModelKey: null, message: found.message };
      continue;
    }
    if (!found.hit) {
      last = {
        ok: false,
        matched: false,
        waylineId: id || null,
        remoteModelKey: null,
        message: `司空 2 航线库中未找到该航线（已回查 ${i + 1} 次）`,
      };
      continue;
    }
    const remote = String(found.hit.device_model_key || '');
    const matched = remote === String(expectedKey);
    return {
      ok: true,
      matched,
      waylineId: found.hit.id,
      remoteModelKey: remote,
      expectedKey: String(expectedKey),
      name: found.hit.name,
      attempts: i + 1,
      message: matched
        ? `已入库且机型一致（${remote}）`
        : `已入库但机型不符：期望 ${expectedKey}，实际 ${remote || '空'}。司空 2 不做机型校验，这条航线不能被本队执行`,
    };
  }
  return { ...last, attempts: POLL_TIMES };
}

/**
 * 生成好的 KMZ → 上传 → 回查验证
 * @param {object} opts
 * @param {Buffer} opts.kmz
 * @param {string} opts.name
 * @param {object} opts.aircraft  { key, name, type, subType, payload }
 */
export async function submitAndVerify({ kmz, name, aircraft }) {
  const filename = `${name}.kmz`;
  const up = await uploadWayline({ buffer: kmz, filename, name, tag: '航线规划' });
  if (!up.ok) {
    return {
      ok: false,
      stage: 'upload',
      step: up.step,
      message: up.message,
      code: up.code,
      objectKey: up.objectKey,
    };
  }
  // finish-upload 的返回体不同版本字段不一，id / wayline_id / uuid 都试一遍
  const id = up.data?.id || up.data?.wayline_id || up.data?.uuid || null;
  log.ok('航线规划', `航线已提交司空 2，开始回查验证`, { name, id, objectKey: up.objectKey });

  const v = await verifyInLibrary({ id, name, expectedKey: aircraft.key });
  return {
    ok: v.matched,
    stage: v.matched ? 'verified' : 'verify',
    waylineId: v.waylineId,
    remoteModelKey: v.remoteModelKey ?? null,
    expectedKey: String(aircraft.key),
    attempts: v.attempts,
    message: v.message,
  };
}

/** 对已有草稿重新回查（重试入口） */
export async function reverify(draft) {
  if (!draft?.wayline_id && !draft?.name) {
    return { ok: false, message: '草稿缺少航线标识，无法回查' };
  }
  const v = await verifyInLibrary({
    id: draft.wayline_id,
    name: draft.name,
    expectedKey: draft.aircraft_key,
  });
  return {
    ok: v.matched,
    waylineId: v.waylineId,
    remoteModelKey: v.remoteModelKey ?? null,
    message: v.message,
  };
}
