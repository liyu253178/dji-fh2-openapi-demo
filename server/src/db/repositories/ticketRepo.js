/**
 * 仓储层：工单与图斑
 *
 * 服务层不写 SQL，全部经此层。好处：
 *   1. SQL 变更只改这一处
 *   2. 状态流转规则集中在这里，不散落到路由里
 *   3. 便于测试（可替换为内存实现）
 */

import { all, get, run, insert, patch, tx, scalar } from '../index.js';

const now = () => new Date().toISOString();

// ===================================================================
// 工单状态机（一期权威定义）
// 规则集中在此，接口层的 allowedTransitions 直接由 canTransit 派生，
// 前端不需要硬编码这张表。
// ===================================================================

export const TICKET_STATUS = {
  draft: '草稿',
  dispatched: '已派发',
  accepted: '已接收',
  processing: '整改中',
  submitted: '已提交整改',
  rejected: '已退回',
  cancelled: '已作废',
};

/** 一期终态：不可再流转 */
const TERMINAL = new Set(['submitted', 'cancelled']);

/** 允许的流转关系 */
const TRANSITIONS = {
  draft: ['dispatched', 'cancelled'],
  dispatched: ['accepted', 'rejected', 'cancelled'],
  accepted: ['processing', 'rejected'],
  processing: ['submitted'],
  submitted: [],
  rejected: ['dispatched', 'cancelled'],
  cancelled: [],
};

/** 某状态可流转到哪些状态 */
export function allowedTransitions(from) {
  return TRANSITIONS[from] || [];
}

/**
 * 校验流转是否合法
 * @returns {{ok:boolean, message?:string, allowed?:string[]}}
 */
export function canTransit(from, to) {
  if (!TICKET_STATUS[to]) {
    return { ok: false, message: `未知状态 ${to}`, allowed: allowedTransitions(from) };
  }
  if (from === to) {
    return { ok: false, message: `工单已处于 ${TICKET_STATUS[to]} 状态`, allowed: allowedTransitions(from) };
  }
  if (TERMINAL.has(from)) {
    return {
      ok: false,
      message: `工单当前状态为 ${TICKET_STATUS[from]}（终态），不允许再流转`,
      allowed: [],
    };
  }
  const allowed = allowedTransitions(from);
  if (!allowed.includes(to)) {
    const label = allowed.map((s) => TICKET_STATUS[s]).join('、');
    return {
      ok: false,
      message: `工单当前状态为 ${TICKET_STATUS[from]}，不允许流转到 ${TICKET_STATUS[to]}。可选目标状态：${label || '无'}`,
      allowed,
    };
  }
  return { ok: true, allowed };
}

// ===================================================================
// 图斑
// ===================================================================

export const patchRepo = {
  create(data) {
    const ts = now();
    return insert('patch', {
      project_uuid: data.projectUuid,
      task_uuid: data.taskUuid ?? null,
      flight_line_id: data.flightLineId ?? null,
      issue_type: data.issueType,
      title: data.title ?? '',
      description: data.description ?? '',
      lat: data.lat,
      lon: data.lon,
      crs: data.crs || 'EPSG:4326',
      geometry_type: data.geometryType || 'rect',
      geometry: data.geometry ? JSON.stringify(data.geometry) : null,
      area_m2: data.areaM2 ?? null,
      admin_region: data.adminRegion ?? '',
      village: data.village ?? '',
      position_desc: data.positionDesc ?? '',
      land_type: data.landType ?? '',
      is_permanent_farmland: data.isPermanentFarmland ? 1 : 0,
      planning_use: data.planningUse ?? '',
      approval_no: data.approvalNo ?? '',
      overlay_result: data.overlayResult ? JSON.stringify(data.overlayResult) : null,
      overlay_confidence: data.overlayConfidence ?? null,
      data_version: data.dataVersion ?? null,
      reviewed_by: data.reviewedBy || 'local_user',
      reviewed_at: ts,
      review_remark: data.reviewRemark ?? '',
      assignee: data.assignee ?? null,
      status: 'draft',
      created_at: ts,
      updated_at: ts,
    });
  },

  update(id, data) {
    const map = {
      title: 'title',
      description: 'description',
      lat: 'lat',
      lon: 'lon',
      issueType: 'issue_type',
      areaM2: 'area_m2',
      adminRegion: 'admin_region',
      village: 'village',
      positionDesc: 'position_desc',
      landType: 'land_type',
      isPermanentFarmland: 'is_permanent_farmland',
      planningUse: 'planning_use',
      approvalNo: 'approval_no',
      geometryType: 'geometry_type',
      reviewRemark: 'review_remark',
      assignee: 'assignee',
      overlayResult: 'overlay_result',
      overlayConfidence: 'overlay_confidence',
      dataVersion: 'data_version',
    };
    const payload = { updated_at: now() };
    for (const [k, col] of Object.entries(map)) {
      if (data[k] === undefined) continue;
      if (k === 'isPermanentFarmland') payload[col] = data[k] ? 1 : 0;
      else if (k === 'geometry') payload.geometry = data[k] ? JSON.stringify(data[k]) : null;
      else if (k === 'overlayResult') payload[col] = data[k] ? JSON.stringify(data[k]) : null;
      else payload[col] = data[k];
    }
    return patch('patch', id, payload);
  },

  /** 解析 JSON 字段（读出时用） */
  parse(p) {
    if (!p) return p;
    return {
      ...p,
      issueType: p.issue_type,
      geometry: p.geometry ? JSON.parse(p.geometry) : null,
      areaM2: p.area_m2,
      adminRegion: p.admin_region,
      village: p.village,
      positionDesc: p.position_desc,
      landType: p.land_type,
      isPermanentFarmland: !!p.is_permanent_farmland,
      planningUse: p.planning_use,
      approvalNo: p.approval_no,
      overlayResult: p.overlay_result ? JSON.parse(p.overlay_result) : null,
      overlayConfidence: p.overlay_confidence,
      dataVersion: p.data_version,
      geometryType: p.geometry_type,
      flightLineId: p.flight_line_id,
      projectUuid: p.project_uuid,
      taskUuid: p.task_uuid,
      reviewedAt: p.reviewed_at,
      reviewRemark: p.review_remark,
      projectUuid_: p.project_uuid, // 保留 snake_case 供调试
    };
  },

  findById(id) {
    const row = get('SELECT * FROM patch WHERE id = @id', { id });
    return row ? patchRepo.parse(row) : null;
  },

  /** 审核队列：按状态 + 条件分页 */
  list({ status, projectUuid, issueType, page = 1, pageSize = 20 } = {}) {
    const where = [];
    const params = { limit: pageSize, offset: (page - 1) * pageSize };
    if (status) {
      where.push('p.status = @status');
      params.status = status;
    }
    if (projectUuid) {
      where.push('p.project_uuid = @projectUuid');
      params.projectUuid = projectUuid;
    }
    if (issueType) {
      where.push('p.issue_type = @issueType');
      params.issueType = issueType;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = scalar(`SELECT COUNT(*) AS n FROM patch p ${w}`, params) || 0;
    const list = all(
      `SELECT p.*, (SELECT COUNT(*) FROM patch_image pi WHERE pi.patch_id = p.id) AS image_count
       FROM patch p ${w}
       ORDER BY p.created_at DESC
       LIMIT @limit OFFSET @offset`,
      params
    );
    return {
      total,
      list: list.map((row) => ({
        ...patchRepo.parse(row),
        imageCount: row.image_count,
        issueTypeName: scalar('SELECT name FROM issue_type WHERE code = @code', { code: row.issue_type }) || row.issue_type,
      })),
    };
  },

  markTicketed(id) {
    return patch('patch', id, { status: 'ticketed', updated_at: now() });
  },
};

// ===================================================================
// 图斑 ↔ 影像关联
// ===================================================================

export const patchImageRepo = {
  attach(patchId, imageIds, primaryImageId) {
    const ts = now();
    tx(() => {
      for (const imageId of imageIds) {
        run(
          `INSERT OR REPLACE INTO patch_image (patch_id, image_id, is_primary, created_at)
           VALUES (@patchId, @imageId, @isPrimary, @ts)`,
          { patchId, imageId, isPrimary: imageId === primaryImageId ? 1 : 0, ts }
        );
      }
      // 只允许一个主图
      if (primaryImageId) {
        run('UPDATE patch_image SET is_primary = 0 WHERE patch_id = @patchId AND image_id != @primary', {
          patchId,
          primary: primaryImageId,
        });
        run('UPDATE patch_image SET is_primary = 1 WHERE patch_id = @patchId AND image_id = @primary', {
          patchId,
          primary: primaryImageId,
        });
      }
      // 冗余更新影像的 review_state
      for (const imageId of imageIds) {
        const dispatched = scalar(
          `SELECT COUNT(*) AS n FROM patch_image pi
           JOIN patch p ON p.id = pi.patch_id
           JOIN ticket t ON t.patch_id = p.id
           WHERE pi.image_id = @imageId AND t.status != 'draft'`,
          { imageId }
        );
        run('UPDATE asset_image SET review_state = @state, updated_at = @ts WHERE id = @imageId', {
          imageId,
          state: dispatched > 0 ? 'dispatched' : 'patched',
          ts,
        });
      }
    });
  },

  detach(patchId, imageId) {
    tx(() => {
      run('DELETE FROM patch_image WHERE patch_id = @patchId AND image_id = @imageId', { patchId, imageId });
      const still = scalar('SELECT COUNT(*) AS n FROM patch_image WHERE image_id = @imageId', { imageId });
      run('UPDATE asset_image SET review_state = @state, updated_at = @ts WHERE id = @imageId', {
        imageId,
        state: still > 0 ? 'patched' : 'none',
        ts: now(),
      });
    });
  },

  listByPatch(patchId) {
    return all(
      `SELECT a.*, pi.is_primary
       FROM patch_image pi
       JOIN asset_image a ON a.id = pi.image_id
       WHERE pi.patch_id = @patchId
       ORDER BY pi.is_primary DESC, a.shot_at ASC`,
      { patchId }
    ).map((r) => ({ ...r, isPrimary: !!r.is_primary }));
  },

  countByPatch(patchId) {
    return scalar('SELECT COUNT(*) AS n FROM patch_image WHERE patch_id = @patchId', { patchId }) || 0;
  },
};

// ===================================================================
// 工单
// ===================================================================

/** 生成工单编号：日期-机场码-序号，如 20260929-D3-007 */
function buildTicketNo(dockSn = '') {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  // 从 SN 推断机场码：取末两段字母数字，无则用 DOCK
  const m = String(dockSn).match(/([A-Z]+\d*)$/);
  const code = m ? m[1] : 'DOCK';
  const prefix = `${ymd}-${code}-`;
  const last = get(
    `SELECT ticket_no FROM ticket WHERE ticket_no LIKE @like ORDER BY ticket_no DESC LIMIT 1`,
    { like: `${prefix}%` }
  );
  const seq = last ? Number(last.ticket_no.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

export const ticketRepo = {
  /**
   * 由图斑创建工单
   * 自动带出责任层级与时限（按问题类型字典）
   */
  createFromPatch({ patchId, recipientId, assignedTo, contact, dockSn }) {
    const p = patchRepo.findById(patchId);
    if (!p) return { ok: false, message: '图斑不存在' };
    if (p.status === 'ticketed') return { ok: false, message: '该图斑已生成工单' };

    const type = get('SELECT * FROM issue_type WHERE code = @code', { code: p.issueType });
    if (!type) return { ok: false, message: `问题类型 ${p.issueType} 不在字典中` };

    // 缺少必填的空间/属性时拒绝，避免派出无法核查的工单
    if (!p.adminRegion) return { ok: false, message: '请先填写行政区' };
    if (!p.positionDesc) return { ok: false, message: '请先填写位置描述' };
    if (type.require_area && !p.areaM2) return { ok: false, message: `「${type.name}」必须填写估算面积` };
    if (patchImageRepo.countByPatch(patchId) === 0) {
      return { ok: false, message: '该图斑未关联任何影像，不能派发（无证据不可派单）' };
    }
    if (recipientId) {
      const r = get('SELECT * FROM recipient WHERE id = @id AND active = 1', { id: recipientId });
      if (!r) return { ok: false, message: '派发对象不存在或已停用' };
      if (!r.email) return { ok: false, message: `派发对象「${r.name}」未配置邮箱` };
    }

    const ts = now();
    const deadline = new Date(Date.now() + (type.default_days || 7) * 86400000)
      .toISOString()
      .slice(0, 10);
    const ticketNo = buildTicketNo(dockSn || p.taskUuid?.slice(-2) || '');

    const { id } = insert('ticket', {
      ticket_no: ticketNo,
      patch_id: patchId,
      issue_type: p.issueType,
      project_uuid: p.project_uuid,
      status: 'draft',
      recipient_id: recipientId ?? null,
      assigned_to: assignedTo ?? null,
      contact: contact ?? null,
      discovered_at: p.reviewed_at || ts,
      deadline,
      mail_status: 'none',
      overdue: 0,
      created_at: ts,
      updated_at: ts,
    });
    patchRepo.markTicketed(patchId);
    run('INSERT INTO ticket_log (ticket_id, from_status, to_status, operator, remark, created_at) VALUES (@id, NULL, @to, @op, @remark, @ts)', {
      id,
      to: 'draft',
      op: 'local_user',
      remark: `由图斑 #${patchId} 生成（问题类型：${type.name}，限期 ${deadline}）`,
      ts,
    });
    return { ok: true, id, ticketNo, deadline, typeName: type.name, defaultOrg: type.default_org };
  },

  findById(id) {
    const t = get('SELECT * FROM ticket WHERE id = @id', { id });
    return t ? ticketRepo.parse(t) : null;
  },

  findByNo(ticketNo) {
    const t = get('SELECT * FROM ticket WHERE ticket_no = @no', { no: ticketNo });
    return t ? ticketRepo.parse(t) : null;
  },

  parse(t) {
    if (!t) return t;
    return {
      ...t,
      ticketNo: t.ticket_no,
      patchId: t.patch_id,
      issueType: t.issue_type,
      projectUuid: t.project_uuid,
      statusLabel: TICKET_STATUS[t.status] || t.status,
      recipientId: t.recipient_id,
      assignedTo: t.assigned_to,
      discoveredAt: t.discovered_at,
      dispatchedAt: t.dispatched_at,
      acceptedAt: t.accepted_at,
      submittedAt: t.submitted_at,
      closedAt: t.closed_at,
      mailStatus: t.mail_status,
      mailError: t.mail_error,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      issueTypeName: scalar('SELECT name FROM issue_type WHERE code = @c', { c: t.issue_type }) || t.issue_type,
      recipientName: t.recipient_id ? scalar('SELECT name FROM recipient WHERE id = @i', { i: t.recipient_id }) : null,
      daysLeft: t.deadline
        ? Math.ceil((new Date(t.deadline).getTime() - Date.now()) / 86400000)
        : null,
      allowedTransitions: allowedTransitions(t.status),
    };
  },

  /** 列表：多条件 + 分页 */
  list({ status, issueType, projectUuid, overdue, beginAt, endAt, keyword, page = 1, pageSize = 20 } = {}) {
    const where = [];
    const params = { limit: pageSize, offset: (page - 1) * pageSize };
    if (status) {
      where.push('t.status = @status');
      params.status = status;
    }
    if (issueType) {
      where.push('t.issue_type = @issueType');
      params.issueType = issueType;
    }
    if (projectUuid) {
      where.push('t.project_uuid = @projectUuid');
      params.projectUuid = projectUuid;
    }
    if (overdue) {
      where.push("t.overdue = 1 AND t.status NOT IN ('submitted','cancelled')");
    }
    if (beginAt) {
      where.push('t.created_at >= @beginAt');
      params.beginAt = beginAt;
    }
    if (endAt) {
      where.push('t.created_at <= @endAt');
      params.endAt = endAt;
    }
    if (keyword) {
      where.push('(t.ticket_no LIKE @kw OR p.title LIKE @kw)');
      params.kw = `%${keyword}%`;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      scalar(`SELECT COUNT(*) AS n FROM ticket t LEFT JOIN patch p ON p.id = t.patch_id ${w}`, params) || 0;
    const list = all(
      `SELECT t.*, p.title,
              (SELECT COUNT(*) FROM patch_image pi WHERE pi.patch_id = p.id) AS image_count
       FROM ticket t LEFT JOIN patch p ON p.id = t.patch_id
       ${w}
       ORDER BY t.created_at DESC
       LIMIT @limit OFFSET @offset`,
      params
    );
    return { total, list: list.map((r) => ({ ...ticketRepo.parse(r), imageCount: r.image_count })) };
  },

  /**
   * 状态流转（一期手动模拟属地反馈）
   * 非法流转直接拒绝并返回 allowed 列表，绝不静默忽略
   */
  transition({ id, to, remark, operator = 'local_user' }) {
    const t = get('SELECT * FROM ticket WHERE id = @id', { id });
    if (!t) return { ok: false, code: 40400, message: '工单不存在', allowed: [] };
    const check = canTransit(t.status, to);
    if (!check.ok) {
      return { ok: false, code: 40001, message: check.message, allowed: check.allowed };
    }
    const ts = now();
    const sets = { status: to, updated_at: ts };
    // 落状态时间戳（供统计与逾期计算）
    if (to === 'dispatched') sets.dispatched_at = t.dispatched_at || ts;
    if (to === 'accepted') sets.accepted_at = ts;
    if (to === 'submitted') sets.submitted_at = ts;
    if (to === 'cancelled') sets.closed_at = ts;
    // 进入终态时清逾期标记
    if (TERMINAL.has(to)) sets.overdue = 0;

    tx(() => {
      patch('ticket', id, sets);
      run(
        `INSERT INTO ticket_log (ticket_id, from_status, to_status, operator, remark, created_at)
         VALUES (@id, @from, @to, @op, @remark, @ts)`,
        { id, from: t.status, to, op: operator, remark: remark || '', ts }
      );
      if (t.status === 'dispatched' && to === 'accepted') {
        // 冗余更新影像状态为已派单
        for (const img of patchImageRepo.listByPatch(t.patch_id)) {
          run(`UPDATE asset_image SET review_state = 'dispatched', updated_at = @ts WHERE id = @id`, {
            id: img.id,
            ts,
          });
        }
      }
    });
    return { ok: true, from: t.status, to };
  },

  updateMailStatus(id, { status, error }) {
    return patch('ticket', id, {
      mail_status: status,
      mail_error: error ?? null,
      updated_at: now(),
    });
  },

  setRecipient(id, { recipientId, assignedTo, contact }) {
    return patch('ticket', id, {
      recipient_id: recipientId ?? null,
      assigned_to: assignedTo ?? null,
      contact: contact ?? null,
      updated_at: now(),
    });
  },

  addRemark(id, remark) {
    const t = get('SELECT * FROM ticket WHERE id = @id', { id });
    if (!t) return { ok: false, message: '工单不存在' };
    run('INSERT INTO ticket_log (ticket_id, from_status, to_status, operator, remark, created_at) VALUES (@id, @from, NULL, @op, @remark, @ts)', {
      id,
      from: t.status,
      op: 'local_user',
      remark: `【备注】${remark}`,
      ts: now(),
    });
    return { ok: true };
  },

  logs(id) {
    return all('SELECT * FROM ticket_log WHERE ticket_id = @id ORDER BY created_at ASC, id ASC', { id });
  },

  /** 刷新逾期标记（定时任务每小时调） */
  refreshOverdue() {
    const today = new Date().toISOString().slice(0, 10);
    return run(
      `UPDATE ticket SET overdue = 1, updated_at = @ts
       WHERE deadline IS NOT NULL AND deadline < @today
         AND overdue = 0 AND status NOT IN ('submitted','cancelled')`,
      { today, ts: now() }
    ).changes;
  },

  /** 统计汇总（台账页） */
  summary({ beginAt, endAt, issueType } = {}) {
    const where = [];
    const params = {};
    if (beginAt) {
      where.push('created_at >= @beginAt');
      params.beginAt = beginAt;
    }
    if (endAt) {
      where.push('created_at <= @endAt');
      params.endAt = endAt;
    }
    if (issueType) {
      where.push('issue_type = @issueType');
      params.issueType = issueType;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = all(`SELECT status, COUNT(*) AS n FROM ticket ${w} GROUP BY status`, params);
    const byStatus = Object.fromEntries(Object.keys(TICKET_STATUS).map((s) => [s, 0]));
    for (const r of rows) byStatus[r.status] = r.n;
    return {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      ...byStatus,
      overdue:
        scalar(
          `SELECT COUNT(*) AS n FROM ticket ${w ? w + ' AND' : 'WHERE'} overdue = 1 AND status NOT IN ('submitted','cancelled')`,
          params
        ) || 0,
    };
  },
};
