/**
 * 通知与告警路由：SMTP 配置 · 测试发送 · 队列状态 · 发送记录 · 告警
 */
import { Router } from 'express';
import { verifySmtp, sendMail, runQueueOnce, queueStats } from '../modules/notify/mailer.js';
import { getPublicConfig, savePublicConfig } from '../modules/notify/mailConfig.js';
import { composeTicketMail } from '../modules/notify/mailer.js';
import { alertRepo } from '../db/repositories/index.js';
import { all } from '../db/index.js';
import { log } from '../logger.js';

const router = Router();

/** GET /api/notify/config —— SMTP 配置（授权码脱敏） */
router.get('/config', (req, res) => {
  res.json({ code: 0, message: '', data: getPublicConfig() });
});

/** PUT /api/notify/config —— 保存非敏感配置（授权码走环境变量，不落盘） */
router.put('/config', (req, res) => {
  const data = savePublicConfig(req.body || {});
  res.json({ code: 0, message: '', data });
});

/** POST /api/notify/verify —— 验证 SMTP 连通与认证 */
router.post('/verify', async (req, res) => {
  const r = await verifySmtp();
  res.status(r.ok ? 200 : 400).json({ code: r.ok ? 0 : 40040, message: r.message, data: { ok: r.ok } });
});

/** POST /api/notify/test —— 发测试邮件 */
router.post('/test', async (req, res) => {
  const { to } = req.body || {};
  const cfg = getPublicConfig();
  if (!cfg.configured) {
    return res.status(400).json({ code: 40040, message: 'SMTP 未配置（缺少 SMTP_USER / SMTP_PASS）' });
  }
  const target = to || cfg.user;
  const nodemailer = (await import('nodemailer')).default;
  const { getConfig } = await import('../modules/notify/mailConfig.js');
  const c = getConfig();
  const tp = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
  });
  try {
    const info = await tp.sendMail({
      from: c.from || c.user,
      to: target,
      subject: '【低空智能监管平台】邮件服务测试',
      text: `这是一封测试邮件，用于验证 SMTP 配置是否正确。\n发送时间：${new Date().toLocaleString('zh-CN')}`,
      html: `<div style="font-family:sans-serif;padding:20px">
        <h3>邮件服务配置正常</h3>
        <p>这是一封测试邮件，用于验证 SMTP 配置是否正确。</p>
        <p style="color:#888;font-size:12px">发送时间：${new Date().toLocaleString('zh-CN')}</p>
      </div>`,
    });
    log.ok('邮件', `测试邮件已发送至 ${target}`);
    res.json({ code: 0, message: `测试邮件已发送至 ${target}`, data: { messageId: info.messageId, to: target } });
  } catch (e) {
    const { describeError } = await import('../modules/notify/mailer.js');
    const msg = describeError(e);
    log.error('邮件', `测试邮件发送失败: ${msg}`);
    res.status(400).json({ code: 40041, message: msg });
  }
});

/** POST /api/notify/send-ticket/:id —— 立即发送某工单（不走队列，便于调试） */
router.post('/send-ticket/:id', async (req, res) => {
  const r = await sendMail(Number(req.params.id), { maxAttempts: Number(req.body?.maxAttempts) || 3 });
  if (!r.ok) {
    return res.status(400).json({ code: 40042, message: r.error, data: { attempts: r.attempts, kind: r.kind } });
  }
  res.json({ code: 0, message: '发送成功', data: { attempts: r.attempts, degraded: r.degraded } });
});

/** GET /api/notify/preview/:id —— 预览邮件（不发送），返回渲染后的 HTML */
router.get('/preview/:id', async (req, res) => {
  try {
    const m = await composeTicketMail(Number(req.params.id), { degrade: req.query.degrade === '1' });
    res.json({
      code: 0,
      message: '',
      data: {
        subject: m.subject,
        html: m.html,
        attachments: m.attachments.map((a) => ({ name: a.filename })),
        degradedCount: m.degradedCount,
        context: m.ctx,
      },
    });
  } catch (e) {
    res.status(400).json({ code: 40043, message: `预览失败：${e.message}` });
  }
});

/** GET /api/notify/queue —— 队列状态 */
router.get('/queue', (req, res) => {
  res.json({ code: 0, message: '', data: queueStats() });
});

/** POST /api/notify/queue/run —— 手动触发一次队列扫描 */
router.post('/queue/run', async (req, res) => {
  const r = await runQueueOnce();
  res.json({ code: 0, message: '', data: r });
});

/** GET /api/notify/mail-logs —— 邮件发送记录 */
router.get('/mail-logs', (req, res) => {
  const { ticketId, status, limit = 50 } = req.query || {};
  const where = [];
  const params = { limit: Math.min(Number(limit) || 50, 200) };
  if (ticketId) {
    where.push('e.ticket_id = @ticketId');
    params.ticketId = Number(ticketId);
  }
  if (status) {
    where.push('e.status = @status');
    params.status = status;
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT e.*, t.ticket_no FROM email_log e
     LEFT JOIN ticket t ON t.id = e.ticket_id
     ${w} ORDER BY e.id DESC LIMIT @limit`,
    params
  );
  res.json({
    code: 0,
    message: '',
    data: rows.map((r) => ({
      id: r.id,
      ticketId: r.ticket_id,
      ticketNo: r.ticket_no || '',
      recipientEmail: r.recipient_email,
      subject: r.subject,
      status: r.status,
      attempts: r.attempts,
      error: r.error,
      attachmentCount: r.attachments ? JSON.parse(r.attachments).length : 0,
      sentAt: r.sent_at,
      createdAt: r.created_at,
    })),
  });
});

// ---------- 告警 ----------

/** GET /api/notify/alerts —— 告警列表 */
router.get('/alerts', (req, res) => {
  const { level, acknowledged, limit = 100 } = req.query || {};
  const list = alertRepo.list({
    level: level || undefined,
    acknowledged: acknowledged === undefined ? undefined : acknowledged === 'true' || acknowledged === true,
    limit: Math.min(Number(limit) || 100, 500),
  });
  res.json({ code: 0, message: '', data: { list, unacknowledged: alertRepo.unacknowledgedCount() } });
});

/** POST /api/notify/alerts/:id/ack —— 确认告警 */
router.post('/alerts/:id/ack', (req, res) => {
  alertRepo.acknowledge(Number(req.params.id));
  res.json({ code: 0, message: '', data: { acknowledged: true, unacknowledged: alertRepo.unacknowledgedCount() } });
});

export default router;
