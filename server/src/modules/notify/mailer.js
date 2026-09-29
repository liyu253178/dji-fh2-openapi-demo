/**
 * SMTP 发送 + 队列 worker + 差异化重试
 *
 * 重试策略（按错误性质区分，避免无谓重试与账号被锁）：
 *   网络类（timeout/ECONNRESET）→ 退避重试 1s/3s/7s
 *   认证类（535）             → 不重试，立即告警（继续重试会锁账号）
 *   地址非法（550 mailbox）   → 不重试，标记待修正
 *   附件过大（552）           → 不重试，降级为「仅发链接」重发一次
 *   限流（421/450）           → 退避重试 10s/30s/60s
 *   内容被拒（550 Rejected）  → 不重试，告警并记录
 */

import nodemailer from 'nodemailer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './mailConfig.js';
import { buildContext, renderDispatch } from './templates.js';
import { renderLocatorPng } from '../asset/thumbnail.js';
import { toAbsolute, MAIL_TMP_DIR } from '../../db/config.js';
import { ticketRepo, dictRepo, patchRepo, patchImageRepo, alertRepo } from '../../db/repositories/index.js';
import { all, get, run, insert } from '../../db/index.js';
import { log } from '../../logger.js';
import { emit } from '../../events.js';

let transporter = null;

function getTransporter() {
  const cfg = getConfig();
  if (!cfg.user || !cfg.pass) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 3,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });
  return transporter;
}

/** 验证 SMTP 连通与认证 */
export async function verifySmtp() {
  const t = getTransporter();
  if (!t) return { ok: false, message: 'SMTP 未配置（缺少 SMTP_USER 或 SMTP_PASS）' };
  try {
    await t.verify();
    const cfg = getConfig();
    return { ok: true, message: `SMTP 连接成功：${cfg.user} @ ${cfg.host}:${cfg.port}` };
  } catch (e) {
    return { ok: false, message: describeError(e), code: classify(e) };
  }
}

/** 错误分类 → 决定重试策略 */
export function classify(err) {
  const msg = `${err?.message || ''} ${err?.code || ''} ${err?.responseCode || ''}`.toLowerCase();
  if (/535|authentication failed|invalid credentials|username or password/.test(msg)) {
    return { kind: 'auth', retry: false, alert: 'fatal', hint: '账号或授权码错误。QQ/163 邮箱须使用「应用专用密码」而非登录密码' };
  }
  if (/550.*mailbox|recipient.*rejected|no such user|invalid recipient/.test(msg)) {
    return { kind: 'address', retry: false, alert: 'error', hint: '收件人邮箱地址无效，请在派发对象中修正' };
  }
  if (/552|message too large|attachment too/.test(msg)) {
    return { kind: 'too-large', retry: false, degrade: true, alert: 'error', hint: '附件过大，已自动降级为仅发送链接' };
  }
  if (/421|450|rate limit|too many/.test(msg)) {
    return { kind: 'throttled', retry: true, backoff: [10000, 30000, 60000], alert: 'warn', hint: '服务商限流，已退避重试' };
  }
  if (/550.*reject|spam|blocked/.test(msg)) {
    return { kind: 'rejected', retry: false, alert: 'error', hint: '邮件内容被服务商拒绝' };
  }
  if (/etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed/.test(msg)) {
    return { kind: 'network', retry: true, backoff: [1000, 3000, 7000], alert: 'warn', hint: '网络异常，已退避重试' };
  }
  return { kind: 'unknown', retry: true, backoff: [3000, 7000, 15000], alert: 'error', hint: '未知错误' };
}

/** 生成可读错误说明 */
export function describeError(err) {
  const c = classify(err);
  const raw = err?.message || String(err);
  return `${raw}${c.hint ? `（${c.hint}）` : ''}`;
}

/** 默认退避表 */
const DEFAULT_BACKOFF = [1000, 3000, 7000];

/** 把图片文件转成 data URI（用于邮件内嵌展示） */
async function toDataUri(absPath, mime = 'image/jpeg') {
  const buf = await fs.readFile(absPath);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 组装一封工单邮件（渲染 + 附件）
 * @returns {{subject,html,attachments:Array, inlineDataUris:number}}
 */
export async function composeTicketMail(ticketId, { degrade = false } = {}) {
  const t = ticketRepo.findById(ticketId);
  if (!t) throw new Error('工单不存在');
  const p = patchRepo.findById(t.patchId);
  if (!p) throw new Error('工单对应的图斑不存在');
  const recipient = t.recipientId ? dictRepo.getRecipient(t.recipientId) : null;
  if (!recipient) throw new Error('未设置派发对象');

  const rawImages = patchImageRepo.listByPatch(t.patchId);
  const cfg = getConfig();
  const ctx = buildContext({ ticket: t, patch: { ...p, issueTypeName: t.issueTypeName }, recipient, images: rawImages, config: cfg });

  // 位置示意图：**始终生成**。
  // 降级只应丢弃体积大的航拍图，位置示意图必须保留——
  // 属地拿到工单最需要知道的就是"在哪"，丢了示意图邮件就没有意义了。
  let locatorPng = '';
  try {
    const buf = await renderLocatorPng({
      lat: p.lat,
      lon: p.lon,
      bbox: p.geometry ? bboxFromGeometry(p.geometry) : null,
      label: t.ticketNo,
      adminRegion: p.admin_region,
    });
    locatorPng = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    log.warn('邮件', `位置示意图生成失败: ${e.message}`);
  }
  ctx.locatorPng = locatorPng;

  // 组装附件（用 1600px 压缩图，不附 4.5MB 原图）
  const attachments = [];
  const inline = [];
  let degradedCount = 0;
  for (const im of rawImages) {
    const mailRel = im.mail_path;
    if (!degrade && mailRel) {
      try {
        const abs = toAbsolute(mailRel);
        await fs.access(abs);
        inline.push({ name: im.file_name, dataUri: await toDataUri(abs) });
        continue;
      } catch {
        degradedCount++;
      }
    }
    degradedCount++;
  }

  // 原图作为真实附件（邮件客户端可直接打开）
  if (!degrade) {
    for (const im of rawImages.slice(0, 6)) {
      if (!im.mail_path) continue;
      try {
        attachments.push({ filename: `${im.file_name}.jpg`, path: toAbsolute(im.mail_path) });
      } catch { /* 跳过 */ }
    }
  }
  if (locatorPng) {
    const buf = Buffer.from(locatorPng.split(',')[1], 'base64');
    const tmp = path.join(MAIL_TMP_DIR, `${t.ticket_no}_locator.png`);
    await fs.writeFile(tmp, buf);
    attachments.push({ filename: `${t.ticket_no}_位置示意图.png`, path: tmp });
  }

  const { subject, html } = renderDispatch(ctx, { attachments: inline });
  return { subject, html, attachments, degradedCount, ticket: t, ctx };
}

function bboxFromGeometry(geometry) {
  try {
    const ring = geometry?.type === 'Polygon' ? geometry.coordinates?.[0] : null;
    if (!ring) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of ring) {
      const la = Number(p[1]); const lo = Number(p[0]);
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
    }
    return { minLat, maxLat, minLon, maxLon };
  } catch {
    return null;
  }
}

/** 写发送记录 */
function writeEmailLog({ ticketId, template, to, subject, html, attachments, status, attempts, error, sentAt }) {
  return insert('email_log', {
    ticket_id: ticketId,
    template,
    recipient_email: to || '',
    cc: '',
    subject: subject || '',
    body_html: html || '',
    attachments: JSON.stringify(attachments || []),
    status,
    attempts: attempts ?? 0,
    error: error || null,
    sent_at: sentAt || null,
    created_at: new Date().toISOString(),
  });
}

/** 落告警（失败可捕获，避免告警失败影响主流程） */
function pushAlert(ticketId, { level = 'error', kind, msg, ticketNo }) {
  try {
    alertRepo.push({
      level,
      category: 'mail',
      title: kind === 'not-configured' ? '邮件服务未配置' : '邮件发送失败',
      detail: `工单 ${ticketNo || ticketId}：${msg}`,
      refType: 'ticket',
      refId: String(ticketId),
    });
  } catch (e) {
    log.warn('邮件', `写入告警失败: ${e.message}`);
  }
}

/**
 * 实际发送一封（带重试）
 * @returns {{ok:boolean, messageId?:string, error?:string, attempts:number, degraded:boolean}}
 */
export async function sendMail(ticketId, { maxAttempts = 3, degrade = false } = {}) {
  const t = ticketRepo.findById(ticketId);
  if (!t) return { ok: false, error: '工单不存在', attempts: 0 };
  const recipient = t.recipientId ? dictRepo.getRecipient(t.recipientId) : null;
  const to = recipient?.email;
  if (!to) {
    writeEmailLog({ ticketId, template: 'TPL_DISPATCH', to: '', status: 'failed', attempts: 0, error: '未设置派发对象或邮箱' });
    return { ok: false, error: '未设置派发对象或邮箱', attempts: 0 };
  }

  const tp = getTransporter();
  if (!tp) {
    const msg = 'SMTP 未配置（缺少 SMTP_USER / SMTP_PASS）';
    writeEmailLog({ ticketId, template: 'TPL_DISPATCH', to, status: 'failed', attempts: 0, error: msg });
    // 未配置同样是需要处理的异常：告警而不是静默失败
    pushAlert(ticketId, { level: 'error', kind: 'not-configured', msg });
    emit('mail_failed', { ticketId, error: msg });
    return { ok: false, error: msg, attempts: 0, kind: 'not-configured' };
  }

  let composed;
  try {
    composed = await composeTicketMail(ticketId, { degrade });
  } catch (e) {
    writeEmailLog({ ticketId, template: 'TPL_DISPATCH', to, status: 'failed', attempts: 0, error: e.message });
    return { ok: false, error: `邮件组装失败：${e.message}`, attempts: 0 };
  }

  const cfg = getConfig();
  let attempts = 0;
  let lastErr = null;
  let usedDegrade = degrade;

  for (let i = 0; i < Math.max(1, maxAttempts); i++) {
    attempts++;
    try {
      const info = await tp.sendMail({
        from: cfg.from || cfg.user,
        to,
        subject: composed.subject,
        html: composed.html,
        attachments: composed.attachments,
      });
      writeEmailLog({
        ticketId, template: 'TPL_DISPATCH', to,
        subject: composed.subject, html: composed.html,
        attachments: composed.attachments.map((a) => ({ name: a.filename, size: 0 })),
        status: 'sent', attempts, sentAt: new Date().toISOString(),
      });
      log.ok('邮件', `工单 ${composed.ticket.ticketNo} 已发送至 ${to}（第 ${attempts} 次，附件 ${composed.attachments.length} 个）`);
      emit('mail_sent', { ticketId, to, subject: composed.subject });
      return { ok: true, messageId: info.messageId, attempts, degraded: usedDegrade };
    } catch (e) {
      lastErr = e;
      const c = classify(e);
      if (!c.retry) {
        log.error('邮件', `发送失败（不重试）：${describeError(e)}`);
        break;
      }
      if (c.degrade && !usedDegrade) {
        // 附件过大 → 降级为仅发链接，重新组装后再试一次
        log.warn('邮件', '附件过大，降级为仅发送链接重试');
        usedDegrade = true;
        try {
          composed = await composeTicketMail(ticketId, { degrade: true });
        } catch { /* 用原 composed 继续 */ }
      }
      if (i < maxAttempts - 1) {
        const wait = (c.backoff || DEFAULT_BACKOFF)[Math.min(i, (c.backoff || DEFAULT_BACKOFF).length - 1)];
        log.warn('邮件', `发送失败，${wait}ms 后重试（${i + 2}/${maxAttempts}）：${describeError(e)}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  const msg = describeError(lastErr);
  const c = classify(lastErr);
  writeEmailLog({
    ticketId, template: 'TPL_DISPATCH', to,
    subject: composed?.subject, html: composed?.html,
    attachments: composed?.attachments?.map((a) => ({ name: a.filename, size: 0 })),
    status: 'failed', attempts, error: msg,
  });
  // 告警：认证失败为 fatal
  pushAlert(ticketId, {
    level: c.alert || 'error',
    kind: c.kind,
    msg,
    ticketNo: composed?.ticket?.ticketNo,
  });
  emit('mail_failed', { ticketId, error: msg });
  return { ok: false, error: msg, attempts, kind: c.kind };
}

// ================================================================
// 队列 worker
// ================================================================

let timer = null;

/** 扫描一次到期任务并发送 */
export async function runQueueOnce() {
  const now = new Date().toISOString();
  const jobs = all(
    `SELECT * FROM mail_queue
     WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= @now)
     ORDER BY priority ASC, id ASC LIMIT 5`,
    { now }
  );
  if (!jobs.length) return { processed: 0 };

  for (const job of jobs) {
    run(`UPDATE mail_queue SET status='processing', updated_at=@now WHERE id=@id`, { id: job.id, now: new Date().toISOString() });
    const t = ticketRepo.findById(job.ticket_id);
    if (!t) {
      run(`UPDATE mail_queue SET status='failed', last_error=@e, updated_at=@n WHERE id=@id`, {
        id: job.id, e: '工单不存在', n: new Date().toISOString(),
      });
      continue;
    }
    const r = await sendMail(job.ticket_id, { maxAttempts: 3 });
    const n = new Date().toISOString();
    if (r.ok) {
      run(`UPDATE mail_queue SET status='done', attempts=@a, updated_at=@n WHERE id=@id`, { id: job.id, a: r.attempts, n });
      ticketRepo.updateMailStatus(job.ticket_id, { status: 'sent' });
      // 发送成功 → 工单转已派发
      const cur = ticketRepo.findById(job.ticket_id);
      if (cur && cur.status === 'draft') {
        ticketRepo.transition({ id: job.ticket_id, to: 'dispatched', remark: '邮件发送成功', operator: 'system' });
      }
    } else {
      // 队列层最终失败（sendMail 内已按分类做过重试）
      run(`UPDATE mail_queue SET status='failed', attempts=@a, last_error=@e, updated_at=@n WHERE id=@id`, {
        id: job.id, a: r.attempts, e: r.error, n,
      });
      ticketRepo.updateMailStatus(job.ticket_id, { status: 'failed', error: r.error });
    }
  }
  return { processed: jobs.length };
}

/** 启动 worker（每 5 秒扫描） */
export function startWorker(intervalMs = 5000) {
  if (timer) return;
  timer = setInterval(() => {
    runQueueOnce().catch((e) => log.error('邮件', `队列执行异常: ${e.message}`));
  }, intervalMs);
  // 不阻止进程退出
  if (timer.unref) timer.unref();
  log.info('邮件', `邮件队列已启动（每 ${intervalMs / 1000}s 扫描）`);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 队列统计（系统状态页） */
export function queueStats() {
  const rows = all('SELECT status, COUNT(*) AS n FROM mail_queue GROUP BY status');
  const out = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
