/**
 * 审核服务：图斑业务规则
 *
 * 图斑 = 审核员在影像上框选出的问题范围，是工单的空间载体。
 * 本服务只管业务规则与数据组装，SQL 都在 db/repositories 里。
 */

import { patchRepo, patchImageRepo, assetRepo, dictRepo } from '../../db/repositories/index.js';
import { get, run } from '../../db/index.js';
import { estimateArea, isValidLatLon, bboxOf, patchOverlapsImage } from './geo.js';
import { log } from '../../logger.js';

/** 审核员标识（一期不做鉴权，恒为本地用户） */
const REVIEWER = 'local_user';

/** 业务错误码（前端按 code 分支处理） */
export const REVIEW_ERR = {
  INVALID_COORD: 40010,
  INVALID_GEOMETRY: 40011,
  UNKNOWN_ISSUE_TYPE: 40012,
  AREA_REQUIRED: 40013,
  LAND_TYPE_REQUIRED: 40014,
  IMAGE_NOT_FOUND: 40015,
  IMAGE_NOT_IN_TASK: 40019,
  ALREADY_TICKETED: 40020,
  TITLE_INVALID: 40018,
};

/**
 * 校验并归一化图斑入参
 * @returns {{ok:boolean, code?:number, message?:string, data?:object, issueTypeInfo?:object}}
 */
export function validatePatchInput(input, { issueType } = {}) {
  if (!input.issueType) {
    return { ok: false, code: REVIEW_ERR.UNKNOWN_ISSUE_TYPE, message: '请选择问题类型' };
  }
  const type = issueType || dictRepo.getIssueType(input.issueType);
  if (!type) {
    return { ok: false, code: REVIEW_ERR.UNKNOWN_ISSUE_TYPE, message: `问题类型 ${input.issueType} 不在字典中` };
  }
  if (!type.enabled) {
    return { ok: false, code: REVIEW_ERR.UNKNOWN_ISSUE_TYPE, message: `问题类型「${type.name}」已停用` };
  }

  const title = String(input.title ?? '').trim();
  if (!title) return { ok: false, code: REVIEW_ERR.TITLE_INVALID, message: '请填写标题' };
  if (title.length > 50) return { ok: false, code: REVIEW_ERR.TITLE_INVALID, message: '标题不超过 50 字' };

  if (!isValidLatLon(input.lat, input.lon)) {
    return {
      ok: false,
      code: REVIEW_ERR.INVALID_COORD,
      message: '坐标无效，请确认经纬度填写正确（或勾选手动微调后重新输入）',
    };
  }

  // 范围几何 → 面积以实算为准，避免前端传错
  let geometry = input.geometry ?? null;
  let areaM2 = input.areaM2 ?? null;
  let dataVersion = input.dataVersion ?? null;
  if (geometry) {
    const est = estimateArea(geometry);
    if (!est.ok) return { ok: false, code: REVIEW_ERR.INVALID_GEOMETRY, message: est.message };
    areaM2 = est.areaM2;
    dataVersion = dataVersion || est.dataVersion;
    if (!input.lat || !input.lon) {
      input = { ...input, lat: est.centroid.lat, lon: est.centroid.lon };
    }
  }

  if (type.requireArea && !areaM2) {
    return { ok: false, code: REVIEW_ERR.AREA_REQUIRED, message: `「${type.name}」必须框选范围或填写估算面积` };
  }
  if (type.requireLandType && !String(input.landType ?? '').trim()) {
    return { ok: false, code: REVIEW_ERR.LAND_TYPE_REQUIRED, message: `「${type.name}」必须填写当前地类` };
  }

  return {
    ok: true,
    data: {
      ...input,
      title,
      geometry,
      areaM2,
      dataVersion,
      geometryType: geometry ? input.geometryType || 'rect' : 'rect',
    },
    issueTypeInfo: type,
  };
}

/** 创建图斑 */
export function createPatch(input) {
  const v = validatePatchInput(input);
  if (!v.ok) return v;
  const d = v.data;

  const imageIds = Array.isArray(input.imageIds) ? input.imageIds.filter(Boolean) : [];
  for (const id of imageIds) {
    const img = assetRepo.findById(id);
    if (!img) return { ok: false, code: REVIEW_ERR.IMAGE_NOT_FOUND, message: `影像 #${id} 不存在` };
    if (input.taskUuid && img.taskUuid !== input.taskUuid) {
      return {
        ok: false,
        code: REVIEW_ERR.IMAGE_NOT_IN_TASK,
        message: '只能关联同一架次内的影像（跨架次合并需先在成果库切换架次）',
      };
    }
  }

  const { id } = patchRepo.create({
    projectUuid: input.projectUuid,
    taskUuid: input.taskUuid ?? null,
    flightLineId: input.flightLineId ?? null,
    issueType: d.issueType,
    title: d.title,
    description: d.description,
    lat: d.lat,
    lon: d.lon,
    geometryType: d.geometryType,
    geometry: d.geometry,
    areaM2: d.areaM2,
    adminRegion: d.adminRegion,
    village: d.village,
    positionDesc: d.positionDesc,
    landType: d.landType,
    isPermanentFarmland: !!d.isPermanentFarmland,
    planningUse: d.planningUse,
    approvalNo: d.approvalNo,
    reviewedBy: REVIEWER,
    reviewRemark: d.reviewRemark,
  });

  if (imageIds.length) {
    patchImageRepo.attach(id, imageIds, input.primaryImageId ?? imageIds[0]);
  }
  log.ok('审核', `创建图斑 #${id}「${d.title}」面积 ${d.areaM2 ?? '—'} ㎡，关联 ${imageIds.length} 张影像`);
  return { ok: true, patchId: id, issueTypeName: v.issueTypeInfo.name };
}

/** 修改图斑 */
export function updatePatch(id, input) {
  const existing = patchRepo.findById(id);
  if (!existing) return { ok: false, code: 40400, message: '图斑不存在' };
  if (existing.status === 'ticketed') {
    return { ok: false, code: REVIEW_ERR.ALREADY_TICKETED, message: '该图斑已生成工单，修改需先作废工单' };
  }
  const merged = {
    issueType: input.issueType ?? existing.issueType,
    title: input.title ?? existing.title,
    description: input.description ?? existing.description,
    lat: input.lat ?? existing.lat,
    lon: input.lon ?? existing.lon,
    geometryType: input.geometryType ?? existing.geometryType,
    geometry: input.geometry ?? existing.geometry,
    areaM2: input.areaM2 ?? existing.areaM2,
    adminRegion: input.adminRegion ?? existing.adminRegion,
    village: input.village ?? existing.village,
    positionDesc: input.positionDesc ?? existing.positionDesc,
    landType: input.landType ?? existing.landType,
    isPermanentFarmland: input.isPermanentFarmland ?? existing.isPermanentFarmland,
    planningUse: input.planningUse ?? existing.planningUse,
    approvalNo: input.approvalNo ?? existing.approvalNo,
    reviewRemark: input.reviewRemark ?? existing.reviewRemark,
  };
  const v = validatePatchInput(merged);
  if (!v.ok) return v;
  patchRepo.update(id, merged);
  return { ok: true, patchId: id };
}

/** 追加关联影像（多图合并核心） */
export function attachImages(patchId, imageIds, primaryImageId) {
  const p = patchRepo.findById(patchId);
  if (!p) return { ok: false, code: 40400, message: '图斑不存在' };
  if (p.status === 'ticketed') {
    return { ok: false, code: REVIEW_ERR.ALREADY_TICKETED, message: '该图斑已生成工单，不能追加影像' };
  }
  const ids = Array.isArray(imageIds) ? imageIds.filter(Boolean) : [];
  if (!ids.length) return { ok: false, code: 40021, message: '请选择要关联的影像' };
  for (const id of ids) {
    const img = assetRepo.findById(id);
    if (!img) return { ok: false, code: REVIEW_ERR.IMAGE_NOT_FOUND, message: `影像 #${id} 不存在` };
    if (p.taskUuid && img.taskUuid !== p.taskUuid) {
      return { ok: false, code: REVIEW_ERR.IMAGE_NOT_IN_TASK, message: '只能关联同一架次内的影像' };
    }
  }
  patchImageRepo.attach(patchId, ids, primaryImageId);
  const total = patchImageRepo.countByPatch(patchId);
  log.ok('审核', `图斑 #${patchId} 追加 ${ids.length} 张影像，现共 ${total} 张`);
  return { ok: true, imageCount: total };
}

/** 解除影像关联 */
export function detachImage(patchId, imageId) {
  const p = patchRepo.findById(patchId);
  if (!p) return { ok: false, code: 40400, message: '图斑不存在' };
  if (p.status === 'ticketed') {
    return { ok: false, code: REVIEW_ERR.ALREADY_TICKETED, message: '该图斑已生成工单，不能解除关联' };
  }
  patchImageRepo.detach(patchId, imageId);
  return { ok: true, imageCount: patchImageRepo.countByPatch(patchId) };
}

/** 设置主图（邮件附件第一张） */
export function setPrimaryImage(patchId, imageId) {
  const linked = patchImageRepo.listByPatch(patchId);
  if (!linked.some((x) => x.id === imageId)) {
    return { ok: false, code: 40022, message: '该影像未关联到此图斑' };
  }
  patchImageRepo.attach(patchId, [imageId], imageId);
  return { ok: true, primaryImageId: imageId };
}

/** 删除图斑（仅未生成工单的） */
export function deletePatch(patchId) {
  const p = patchRepo.findById(patchId);
  if (!p) return { ok: false, code: 40400, message: '图斑不存在' };
  if (p.status === 'ticketed') {
    return { ok: false, code: REVIEW_ERR.ALREADY_TICKETED, message: '该图斑已生成工单，不能删除' };
  }
  run('DELETE FROM patch_image WHERE patch_id = @id', { id: patchId });
  run('DELETE FROM patch WHERE id = @id', { id: patchId });
  return { ok: true };
}

/**
 * 推荐影像：框选后找出「哪些影像拍到了这里」
 * 先用 footprint bbox 粗筛，无 footprint 时按最近距离兜底（300m 内）
 */
export function suggestImages({ lat, lon, projectUuid, taskUuid, limit = 20 }) {
  if (!isValidLatLon(lat, lon)) {
    return { ok: false, code: REVIEW_ERR.INVALID_COORD, message: '坐标无效' };
  }
  const box = {
    minLat: lat - 0.001, maxLat: lat + 0.001,
    minLon: lon - 0.001, maxLon: lon + 0.001,
  };
  const near = assetRepo.search({
    projectUuid, taskUuid,
    minLat: box.minLat, maxLat: box.maxLat,
    minLon: box.minLon, maxLon: box.maxLon,
    pageSize: 200,
  });
  const dist = (x) =>
    Math.round(
      Math.hypot((x.lat - lat) * 111320, (x.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180))
    );
  if (near.list.length) {
    return {
      ok: true,
      source: 'footprint',
      list: near.list.slice(0, limit).map((x) => ({
        id: x.id, fileName: x.fileName, lensType: x.lensType,
        lat: x.lat, lon: x.lon, gpsStatus: x.gpsStatus, reviewState: x.reviewState,
        distanceM: dist(x),
        covered: x.footprint?.bbox ? patchOverlapsImage(box, x.footprint.bbox) : false,
      })),
    };
  }
  const fallback = assetRepo.search({ projectUuid, taskUuid, pageSize: 500 }).list
    .filter((x) => x.lat !== null)
    .map((x) => ({ ...x, _d: dist(x) }))
    .filter((x) => x._d < 300)
    .sort((a, b) => a._d - b._d)
    .slice(0, limit)
    .map(({ _d, ...rest }) => ({ ...rest, distanceM: _d, covered: false }));
  return { ok: true, source: 'nearest', list: fallback };
}

/** 审核队列 */
export function reviewQueue({ status, projectUuid, issueType, page = 1, pageSize = 20 } = {}) {
  const data = patchRepo.list({ status, projectUuid, issueType, page, pageSize });
  const list = data.list.map((p) => {
    const images = patchImageRepo.listByPatch(p.id);
    const primary = images.find((i) => i.is_primary) || images[0] || null;
    return {
      patchId: p.id,
      title: p.title,
      issueType: p.issueType,
      issueTypeName: p.issueTypeName,
      lat: p.lat,
      lon: p.lon,
      areaM2: p.areaM2,
      adminRegion: p.adminRegion,
      village: p.village,
      gpsStatus: primary?.gps_status || null,
      imageCount: p.imageCount,
      status: p.status,
      statusLabel: p.status === 'ticketed' ? '已生成工单' : '待派单',
      thumbnailUrl: primary ? `/api/asset/images/${primary.id}/file?size=thumb` : '',
      sourceTaskUuid: p.taskUuid,
      sourceTaskName: p.taskUuid
        ? get('SELECT name FROM flight_task WHERE uuid = @u', { u: p.taskUuid })?.name || ''
        : '',
      reviewedAt: p.reviewedAt,
      reviewedBy: p.reviewedBy,
      taskUuid: p.taskUuid,
    };
  });
  return { total: data.total, list };
}

/** 图斑详情 */
export function patchDetail(patchId) {
  const p = patchRepo.findById(patchId);
  if (!p) return null;
  const images = patchImageRepo.listByPatch(patchId).map((i) => ({
    id: i.id,
    fileName: i.file_name,
    lensType: i.lens_type,
    gpsStatus: i.gps_status,
    lat: i.lat,
    lon: i.lon,
    isPrimary: !!i.is_primary,
    shotAt: i.shot_at,
    thumbUrl: `/api/asset/images/${i.id}/file?size=thumb`,
    mailUrl: `/api/asset/images/${i.id}/file?size=mail`,
    originalUrl: `/api/asset/images/${i.id}/file?size=original`,
  }));
  const ticket = get(
    'SELECT id, ticket_no, status FROM ticket WHERE patch_id = @id ORDER BY id DESC LIMIT 1',
    { id: patchId }
  );
  return {
    patchId: p.id,
    projectUuid: p.projectUuid,
    taskUuid: p.taskUuid,
    taskName: p.taskUuid ? get('SELECT name FROM flight_task WHERE uuid = @u', { u: p.taskUuid })?.name || '' : '',
    flightLineId: p.flightLineId,
    issueType: p.issueType,
    issueTypeName: p.issueTypeName,
    title: p.title,
    description: p.description,
    lat: p.lat,
    lon: p.lon,
    crs: p.crs,
    geometry: p.geometry,
    bbox: p.geometry ? bboxOf(p.geometry) : null,
    areaM2: p.areaM2,
    adminRegion: p.adminRegion,
    village: p.village,
    positionDesc: p.positionDesc,
    landType: p.landType,
    isPermanentFarmland: p.isPermanentFarmland,
    planningUse: p.planningUse,
    approvalNo: p.approvalNo,
    overlayResult: p.overlayResult,
    overlayConfidence: p.overlayConfidence,
    dataVersion: p.dataVersion,
    status: p.status,
    reviewedBy: p.reviewedBy,
    reviewedAt: p.reviewedAt,
    reviewRemark: p.reviewRemark,
    images,
    imageCount: images.length,
    ticket: ticket || null,
  };
}
