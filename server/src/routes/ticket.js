/**
 * 工单路由：创建 · 派发 · 状态流转 · 留痕 · 台账统计
 *
 * 派发（send）在本路由只负责「入队」，真正的 SMTP 发送由 notify 模块异步处理。
 * 邮件模块尚未接入时，派发会成功入队但 mail_status 保持 pending。
 */
import { Router } from 'express';
import { ticketRepo, dictRepo, TICKET_STATUS, canTransit } from '../db/repositories/index.js';
import { patchDetail } from '../modules/review/reviewService.js';
import { run, all, get } from '../db/index.js';
import { log } from '../logger.js';

const router = Router();

function fail(res, r, httpStatus = 400) {
  return res.status(httpStatus).json({
    code: r.code ?? 40000,
    message: r.message || '操作失败',
    data: { allowed: r.allowed },
  });
}

// ================================================================
// 工单
// ================================================================

/** GET /api/tickets —— 列表（多条件 + 分页）——运营视角，跨项目看全组织数据 */
router.get('/', (req, res) => {
  // 刻意不接收 projectUuid：工单独立于项目，避免切了项目就「凭空丢数据」
  const { status, issueType, overdue, beginAt, endAt, keyword, page = 1, pageSize = 20 } = req.query || {};
  const data = ticketRepo.list({
    status: status || undefined,
    issueType: issueType || undefined,
    overdue: overdue === 'true' || overdue === true ? true : undefined,
    beginAt: beginAt || undefined,
    endAt: endAt || undefined,
    keyword: keyword || undefined,
    page: Number(page) || 1,
    pageSize: Math.min(Number(pageSize) || 20, 200),
  });
  res.json({ code: 0, message: '', data });
});

/** POST /api/tickets —— 由图斑生成工单 */
router.post('/', (req, res) => {
  const { patchId, recipientId, assignedTo, contact, dockSn } = req.body || {};
  if (!patchId) return res.status(400).json({ code: 40002, message: '缺少 patchId' });
  const r = ticketRepo.createFromPatch({
    patchId: Number(patchId),
    recipientId: recipientId ? Number(recipientId) : null,
    assignedTo,
    contact,
    dockSn,
  });
  if (!r.ok) return res.status(400).json({ code: 40030, message: r.message });
  res.json({
    code: 0,
    message: '',
    data: {
      ticketId: r.id, ticketNo: r.ticketNo, deadline: r.deadline,
      typeName: r.typeName, defaultOrg: r.defaultOrg,
    },
  });
});

/** GET /api/tickets/:id —— 详情（图斑 + 影像 + 留痕 + 邮件记录） */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const t = ticketRepo.findById(id);
  if (!t) return res.status(404).json({ code: 40400, message: '工单不存在' });
  const patch = patchDetail(t.patchId);

  const logs = ticketRepo.logs(id).map((l) => ({
    id: l.id,
    fromStatus: l.from_status,
    toStatus: l.to_status,
    fromLabel: l.from_status ? TICKET_STATUS[l.from_status] || l.from_status : null,
    toLabel: l.to_status ? TICKET_STATUS[l.to_status] || l.to_status : null,
    operator: l.operator,
    remark: l.remark,
    createdAt: l.created_at,
  }));

  const emailRows = all(
    `SELECT id, recipient_email, subject, status, attempts, error, sent_at, created_at, attachments
     FROM email_log WHERE ticket_id = @id ORDER BY id DESC`,
    { id }
  );

  res.json({
    code: 0,
    message: '',
    data: {
      ticket: t,
      patch,
      images: patch?.images || [],
      logs,
      emails: emailRows.map((e) => ({
        id: e.id,
        recipientEmail: e.recipient_email,
        subject: e.subject,
        status: e.status,
        attempts: e.attempts,
        error: e.error,
        attachmentCount: e.attachments ? JSON.parse(e.attachments).length : 0,
        sentAt: e.sent_at,
        createdAt: e.created_at,
      })),
      allowedTransitions: t.allowedTransitions,
    },
  });
});

/** POST /api/tickets/:id/send —— 派发（入队） */
router.post('/:id/send', (req, res) => {
  const id = Number(req.params.id);
  const t = ticketRepo.findById(id);
  if (!t) return res.status(404).json({ code: 40400, message: '工单不存在' });

  if (!['draft', 'rejected', 'dispatched'].includes(t.status)) {
    const c = canTransit(t.status, 'dispatched');
    if (!c.ok) return fail(res, { code: 40001, message: c.message, allowed: c.allowed });
  }
  if (!t.recipientId) {
    return res.status(400).json({ code: 40031, message: '请先在工单详情中设置派发对象' });
  }
  const recipient = dictRepo.getRecipient(t.recipientId);
  if (!recipient || !recipient.email) {
    return res.status(400).json({ code: 40031, message: '派发对象未配置邮箱' });
  }

  const ts = new Date().toISOString();
  run(
    `INSERT INTO mail_queue (ticket_id, priority, status, attempts, created_at, updated_at)
     VALUES (@tid, 5, 'pending', 0, @ts, @ts)`,
    { tid: id, ts }
  );
  ticketRepo.updateMailStatus(id, { status: 'pending' });
  log.ok('工单', `工单 ${t.ticketNo} 已入发送队列，收件人 ${recipient.email}`);
  res.json({ code: 0, message: '', data: { queued: true, recipientEmail: recipient.email } });
});

/** PATCH /api/tickets/:id/status —— 状态流转 */
router.patch('/:id/status', (req, res) => {
  const { to, remark } = req.body || {};
  if (!to) return res.status(400).json({ code: 40002, message: '缺少目标状态 to' });
  // 工单不存在 → 404，不要混进状态机错误里
  if (!ticketRepo.findById(Number(req.params.id))) {
    return res.status(404).json({ code: 40400, message: '工单不存在' });
  }
  const r = ticketRepo.transition({ id: Number(req.params.id), to, remark });
  if (!r.ok) {
    return res.status(400).json({ code: r.code ?? 40001, message: r.message, data: { allowed: r.allowed } });
  }
  res.json({
    code: 0,
    message: '',
    data: {
      from: r.from, to: r.to,
      fromLabel: TICKET_STATUS[r.from], toLabel: TICKET_STATUS[r.to],
    },
  });
});

/** PUT /api/tickets/:id/recipient —— 设置派发对象 */
router.put('/:id/recipient', (req, res) => {
  const { recipientId, assignedTo, contact } = req.body || {};
  ticketRepo.setRecipient(Number(req.params.id), {
    recipientId: recipientId ? Number(recipientId) : null,
    assignedTo,
    contact,
  });
  res.json({ code: 0, message: '', data: { updated: true } });
});

/** POST /api/tickets/:id/remark —— 追加备注 */
router.post('/:id/remark', (req, res) => {
  const { remark } = req.body || {};
  if (!remark || !String(remark).trim()) {
    return res.status(400).json({ code: 40002, message: '请输入备注内容' });
  }
  const r = ticketRepo.addRemark(Number(req.params.id), String(remark).trim());
  if (!r.ok) return fail(res, r);
  res.json({ code: 0, message: '', data: { ok: true } });
});

/** GET /api/tickets/:id/logs */
router.get('/:id/logs', (req, res) => {
  const logs = ticketRepo.logs(Number(req.params.id)).map((l) => ({
    id: l.id,
    fromStatus: l.from_status,
    toStatus: l.to_status,
    toLabel: l.to_status ? TICKET_STATUS[l.to_status] || l.to_status : null,
    operator: l.operator,
    remark: l.remark,
    createdAt: l.created_at,
  }));
  res.json({ code: 0, message: '', data: { list: logs } });
});

// ================================================================
// 台账统计（挂在 /api/tickets/stats 之前，避免被 /:id 吞掉）
// ================================================================

/** GET /api/tickets/stats/summary —— 状态汇总 */
router.get('/stats/summary', (req, res) => {
  const { beginAt, endAt, issueType } = req.query || {};
  res.json({ code: 0, message: '', data: ticketRepo.summary({ beginAt, endAt, issueType }) });
});

/** GET /api/tickets/stats/by-region —— 行政区分布 */
router.get('/stats/by-region', (req, res) => {
  const rows = all(
    `SELECT COALESCE(NULLIF(p.admin_region, ''), '未填写') AS region, COUNT(*) AS count
     FROM ticket t JOIN patch p ON p.id = t.patch_id
     GROUP BY region ORDER BY count DESC LIMIT 20`
  );
  res.json({ code: 0, message: '', data: rows });
});

/** GET /api/tickets/stats/by-type —— 问题类型分布 */
router.get('/stats/by-type', (req, res) => {
  const rows = all(
    `SELECT t.issue_type AS code, COALESCE(d.name, t.issue_type) AS name, COUNT(*) AS count
     FROM ticket t LEFT JOIN issue_type d ON d.code = t.issue_type
     GROUP BY t.issue_type ORDER BY count DESC`
  );
  const total = rows.reduce((s, r) => s + r.count, 0) || 1;
  res.json({
    code: 0,
    message: '',
    data: rows.map((r) => ({ ...r, ratio: Number((r.count / total).toFixed(3)) })),
  });
});

export default router;
