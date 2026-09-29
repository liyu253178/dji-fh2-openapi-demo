/**
 * 字典与派发对象路由
 *
 * 问题类型字典供审核表单联动（默认责任层级 / 时限 / 必填项），
 * 派发对象即工单的收件单位与邮箱。
 */
import { Router } from 'express';
import { dictRepo } from '../db/repositories/index.js';
import { log } from '../logger.js';

const router = Router();

function fail(res, r, httpStatus = 400) {
  return res.status(httpStatus).json({ code: r.code ?? 40000, message: r.message || '操作失败' });
}

// ---------- 问题类型字典 ----------

/** GET /api/dict/issue-types?includeDisabled=1 */
router.get('/issue-types', (req, res) => {
  const includeDisabled = req.query?.includeDisabled === '1' || req.query?.includeDisabled === true;
  res.json({ code: 0, message: '', data: dictRepo.listIssueTypes({ enabledOnly: !includeDisabled }) });
});

/** POST /api/dict/issue-types */
router.post('/issue-types', (req, res) => {
  const b = req.body || {};
  if (!b.code) return fail(res, { message: '请填写编码' });
  if (!b.name) return fail(res, { message: '请填写名称' });
  if (!/^[A-Z][A-Z0-9_]*$/.test(b.code)) {
    return fail(res, { message: '编码只能是大写字母、数字和下划线，且以字母开头' });
  }
  const r = dictRepo.upsertIssueType(b);
  log.ok('字典', `${r.created ? '新增' : '更新'}问题类型 ${b.code}`);
  res.json({ code: 0, message: '', data: { code: b.code, created: r.created } });
});

/** PUT /api/dict/issue-types/:code */
router.put('/issue-types/:code', (req, res) => {
  const code = req.params.code;
  if (!dictRepo.getIssueType(code)) return res.status(404).json({ code: 40400, message: '问题类型不存在' });
  const r = dictRepo.upsertIssueType({ ...req.body, code });
  log.ok('字典', `更新问题类型 ${code}`);
  res.json({ code: 0, message: '', data: r });
});

/** DELETE /api/dict/issue-types/:code —— 被工单/图斑引用时拒绝 */
router.delete('/issue-types/:code', (req, res) => {
  const r = dictRepo.deleteIssueType(req.params.code);
  if (!r.ok) return fail(res, r);
  log.ok('字典', `删除问题类型 ${req.params.code}`);
  res.json({ code: 0, message: '', data: { deleted: true } });
});

// ---------- 派发对象 ----------

/** GET /api/recipients?includeDisabled=1 */
router.get('/recipients', (req, res) => {
  const includeDisabled = req.query?.includeDisabled === '1' || req.query?.includeDisabled === true;
  res.json({ code: 0, message: '', data: dictRepo.listRecipients({ activeOnly: !includeDisabled }) });
});

/** POST /api/recipients */
router.post('/recipients', (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, { message: '请填写单位名称' });
  if (!b.email) return fail(res, { message: '请填写邮箱' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return fail(res, { message: '邮箱格式不正确' });
  const id = dictRepo.createRecipient(b);
  log.ok('派发对象', `新增 ${b.name}（${b.email}）`);
  res.json({ code: 0, message: '', data: { id } });
});

/** PUT /api/recipients/:id */
router.put('/recipients/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) {
    return fail(res, { message: '邮箱格式不正确' });
  }
  dictRepo.updateRecipient(id, b);
  res.json({ code: 0, message: '', data: { updated: true } });
});

/** DELETE /api/recipients/:id —— 被工单引用时拒绝 */
router.delete('/recipients/:id', (req, res) => {
  const r = dictRepo.deleteRecipient(Number(req.params.id));
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: { deleted: true } });
});

export default router;

/**
 * 派发对象的根路径路由（挂载点/api/recipients）
 *
 * 与上面的 dictRouter 共用实现，区别只是路径不带 /recipients 前缀。
 * 直接挂 dictRouter 会让实际路径变成 /api/recipients/recipients。
 */
export const recipientRoutes = Router();

recipientRoutes.get('/', (req, res) => {
  const includeDisabled = req.query?.includeDisabled === '1' || req.query?.includeDisabled === true;
  res.json({ code: 0, message: '', data: dictRepo.listRecipients({ activeOnly: !includeDisabled }) });
});

recipientRoutes.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, { message: '请填写单位名称' });
  if (!b.email) return fail(res, { message: '请填写邮箱' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return fail(res, { message: '邮箱格式不正确' });
  const id = dictRepo.createRecipient(b);
  log.ok('派发对象', `新增 ${b.name}（${b.email}）`);
  res.json({ code: 0, message: '', data: { id } });
});

recipientRoutes.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) {
    return fail(res, { message: '邮箱格式不正确' });
  }
  dictRepo.updateRecipient(id, b);
  res.json({ code: 0, message: '', data: { updated: true } });
});

recipientRoutes.delete('/:id', (req, res) => {
  const r = dictRepo.deleteRecipient(Number(req.params.id));
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: { deleted: true } });
});
