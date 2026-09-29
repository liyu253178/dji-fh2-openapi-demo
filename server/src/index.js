/**
 * BFF 入口
 */
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bus, log } from './logger.js';
import { subscribe } from './events.js';
import { session } from './djiClient.js';
import * as store from './modules/system/services/store.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { closeDb, health as dbHealth, tableCounts } from './db/index.js';
import { dictReady } from './db/seed.js';
import sessionRoutes from './routes/session.js';
import deviceRoutes from './routes/device.js';
import liveRoutes from './routes/live.js';
import waylineRoutes from './routes/wayline.js';
import taskRoutes from './routes/task.js';
import takeoffRoutes from './routes/takeoff.js';
import adminRoutes from './routes/admin.js';
import opsRoutes from './routes/ops.js';
import modelRoutes from './routes/model.js';
import assetRoutes from './routes/asset.js';
import reviewRoutes from './routes/review.js';
import ticketRoutes from './routes/ticket.js';
import notifyRoutes from './routes/notify.js';
import { startWorker as startMailWorker } from './modules/notify/mailer.js';

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// 初始化数据库（一期成果资产 / 工单闭环的数据底座）
migrate();
seed({ withSampleRecipients: process.env.SEED_SAMPLE_RECIPIENTS !== '0' });
const dict = dictReady();
log.info('DB', `字典就绪：${dict.issueTypes} 个问题类型、${dict.recipients} 个派发对象`);

// 启动邮件队列 worker（无 SMTP 配置时静默跳过，不影响其他功能）
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  startMailWorker();
} else {
  log.warn('BOOT', '未配置 SMTP_USER / SMTP_PASS，邮件派发功能不可用（工单仍可创建与管理）');
}

// 初始化会话
store.load();
session.token = store.getToken();
session.projectUuid = store.getActiveProject();
if (session.token) log.ok('BOOT', `已载入 OpenAPI TK（${store.listTokens().find((t) => t.active)?.name || '默认'}）`);
else log.warn('BOOT', '尚未配置 OpenAPI TK，请在「司空管理」中添加');
if (session.projectUuid) log.ok('BOOT', `已恢复项目选择: ${session.projectUuid}`);

app.use('/api/session', sessionRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/wayline', waylineRoutes);
app.use('/api/task', taskRoutes);
app.use('/api/takeoff', takeoffRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/ops', opsRoutes);
app.use('/api/model', modelRoutes);
app.use('/api/asset', assetRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/notify', notifyRoutes);

/** 领域事件 SSE（设备上下线等） */
app.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write('event: ping\ndata: ok\n\n');
  const off = subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
  req.on('close', off);
});

/** 日志 SSE 流 */
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write('event: ping\ndata: ok\n\n');
  const onLog = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  const onClear = () => res.write('event: clear\ndata: 1\n\n');
  bus.on('log', onLog);
  bus.on('clear', onClear);
  req.on('close', () => {
    bus.off('log', onLog);
    bus.off('clear', onClear);
  });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

/** 数据库状态（一期系统状态页用；工单与成果资产的数据底座） */
app.get('/api/admin/db-status', (req, res) => {
  res.json({ code: 0, message: '', data: { health: dbHealth(), counts: tableCounts() } });
});

/** 优雅退出：checkpoint WAL，确保数据落盘 */
function shutdown(signal) {
  log.info('BOOT', `收到 ${signal}，正在关闭…`);
  try {
    closeDb();
  } catch (e) {
    log.error('BOOT', `关闭数据库失败: ${e.message}`);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * 单端口托管：若前端已构建（web/dist），则直接由 BFF 提供静态资源与 SPA 回退，
 * 这样部署/分享时只需暴露一个端口（默认 8787）。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  /**
   * 缓存策略：index.html 必须每次校验，否则前端重新构建后浏览器仍加载旧的 hash 资源，
   * 表现为「代码已改但页面行为不变」（例如播放器修复不生效）。
   * 带 hash 的 assets 可以长期缓存。
   */
  app.use(
    express.static(DIST, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (/\/assets\//.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );
  app.get(/^\/(?!api|logs|events).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(DIST, 'index.html'));
  });
  log.ok('BOOT', `已托管前端静态资源: ${DIST}`);
} else {
  log.warn('BOOT', '未找到 web/dist，请先执行 npm run build（开发模式可用 5173 端口）');
}

app.listen(PORT, () => {
  log.ok('BOOT', `司空 2 BFF 服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`[BFF] listening on http://127.0.0.1:${PORT}`);
});
