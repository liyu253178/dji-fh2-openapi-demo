/**
 * 自研航线草稿仓储层
 * 只做 SQL 与 JSON 编解码，业务判定在 verifyService / 路由里。
 */

import { all, get, insert, patch } from '../../db/index.js';

const nowIso = () => new Date().toISOString();
const parse = (v, fallback) => {
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

/** DB 行 → 前端对象（JSON 字段展开） */
function mapRow(r) {
  if (!r) return null;
  return {
    ...r,
    polygon: parse(r.polygon, []),
    params: parse(r.params, {}),
    stats: parse(r.stats, {}),
  };
}

export function listDrafts({ status, limit = 100 } = {}) {
  const where = status ? 'WHERE status = @status' : '';
  const rows = all(`SELECT * FROM wayline_draft ${where} ORDER BY id DESC LIMIT @limit`, {
    ...(status ? { status } : {}),
    limit,
  });
  return rows.map(mapRow);
}

export function getDraft(id) {
  return mapRow(get('SELECT * FROM wayline_draft WHERE id = @id', { id }));
}

export function getDraftByWaylineId(waylineId) {
  return mapRow(get('SELECT * FROM wayline_draft WHERE wayline_id = @waylineId', { waylineId }));
}

export function createDraft(data) {
  const ts = nowIso();
  const row = {
    name: data.name,
    aircraft_key: data.aircraftKey,
    aircraft_name: data.aircraftName || '',
    payload_enum: data.payload ?? null,
    template_type: data.templateType || 'mapping2d',
    status: 'draft',
    polygon: JSON.stringify(data.polygon || []),
    params: JSON.stringify(data.params || {}),
    stats: JSON.stringify(data.stats || {}),
    wayline_id: data.waylineId || null,
    model_key_remote: data.modelKeyRemote || null,
    verify_message: data.verifyMessage || '',
    created_at: ts,
    updated_at: ts,
  };
  const { id } = insert('wayline_draft', row);
  return getDraft(id);
}

export function updateDraft(id, data) {
  const allowed = {};
  if (data.status !== undefined) allowed.status = data.status;
  if (data.waylineId !== undefined) allowed.wayline_id = data.waylineId;
  if (data.modelKeyRemote !== undefined) allowed.model_key_remote = data.modelKeyRemote;
  if (data.verifyMessage !== undefined) allowed.verify_message = data.verifyMessage;
  if (data.verifiedAt !== undefined) allowed.verified_at = data.verifiedAt;
  if (data.stats !== undefined) allowed.stats = JSON.stringify(data.stats);
  if (data.params !== undefined) allowed.params = JSON.stringify(data.params);
  if (!Object.keys(allowed).length) return getDraft(id);
  allowed.updated_at = nowIso();
  patch('wayline_draft', id, allowed);
  return getDraft(id);
}

/** 状态统计（航线库顶部统计条用） */
export function draftStats() {
  const rows = all('SELECT status AS s, COUNT(*) AS n FROM wayline_draft GROUP BY status');
  const out = { draft: 0, validating: 0, verified: 0, rejected: 0 };
  for (const r of rows) out[r.s] = r.n;
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
