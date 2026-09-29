/**
 * SQLite 连接
 *
 * 一期选型：SQLite 单文件（WAL 模式）——零运维、备份即拷贝文件、单机使用无并发压力。
 * 二期若需多人并发写或换库，只改本文件与 repository 层的 SQL 方言即可，服务层无感。
 *
 * 关键 pragma 说明：
 *   journal_mode=WAL      读写不互相阻塞（审核时同步仍在跑也不会卡）
 *   busy_timeout=5000     遇到写锁等 5s 而不是立刻抛 SQLITE_BUSY
 *   foreign_keys=ON       打开外键约束（SQLite 默认关闭）
 *   synchronous=NORMAL    WAL 下兼顾安全与性能
 */

import Database from 'better-sqlite3';
import { DB_FILE, ensureDirs } from './config.js';
import { log } from '../logger.js';

let db = null;

/** 取得连接（单例，首次调用时打开） */
export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  log.ok('DB', `SQLite 已连接: ${DB_FILE}`);
  return db;
}

/** 关闭连接（测试与优雅退出用） */
export function closeDb() {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* 忽略 checkpoint 失败 */
  }
  db.close();
  db = null;
  log.info('DB', 'SQLite 连接已关闭');
}

/**
 * 查询多行
 * @param {string} sql
 * @param {object} [params] 命名参数用 @key / :key / $key
 */
export function all(sql, params = {}) {
  return getDb().prepare(sql).all(params);
}

/** 查询单行（无结果返回 undefined） */
export function get(sql, params = {}) {
  return getDb().prepare(sql).get(params);
}

/** 执行写操作，返回 { changes, lastInsertRowid } */
export function run(sql, params = {}) {
  return getDb().prepare(sql).run(params);
}

/** 取单值（取第一行第一列） */
export function scalar(sql, params = {}) {
  const row = get(sql, params);
  if (!row) return undefined;
  return Object.values(row)[0];
}

/**
 * 事务包装。
 * fn 内抛异常则整体回滚，避免"插了一半"的数据。
 * 注意：better-sqlite3 是同步 API，事务内不要写 await 的异步逻辑。
 *
 * @example
 * tx(() => {
 *   run('INSERT INTO a ...');
 *   run('INSERT INTO b ...');
 * });
 */
export function tx(fn) {
  const handle = getDb().transaction(fn);
  return handle();
}

/** 便捷插入：insert('ticket', { status:'draft' }) */
export function insert(table, data) {
  const keys = Object.keys(data);
  if (!keys.length) throw new Error(`insert(${table}) 没有字段`);
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const holders = keys.map((k) => `@${k}`).join(', ');
  const r = run(`INSERT INTO "${table}" (${cols}) VALUES (${holders})`, data);
  return { id: Number(r.lastInsertRowid), changes: r.changes };
}

/** 便捷更新：patch('ticket', 7, { status:'sent' }) → WHERE id = @id */
export function patch(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return { changes: 0 };
  const sets = keys.map((k) => `"${k}" = @${k}`).join(', ');
  const r = run(`UPDATE "${table}" SET ${sets} WHERE id = @__id`, { ...data, __id: id });
  return { changes: r.changes };
}

/** 数据库健康检查（系统状态页用） */
export function health() {
  try {
    const t = getDb().prepare('PRAGMA integrity_check').get();
    const size = getDb().prepare('SELECT page_count * page_size / 1024 AS kb FROM pragma_page_count(), pragma_page_size()').get();
    const mode = getDb().pragma('journal_mode', { simple: true });
    return {
      ok: Object.values(t)[0] === 'ok',
      integrity: Object.values(t)[0],
      journalMode: mode,
      sizeKb: Math.round(size?.kb || 0),
      file: DB_FILE,
    };
  } catch (e) {
    return { ok: false, integrity: 'error', error: e.message };
  }
}

/** 各表行数（运维总览用） */
export function tableCounts() {
  const tables = [
    'project', 'device', 'flight_task', 'asset_image', 'patch', 'patch_image',
    'issue_type', 'recipient', 'ticket', 'ticket_log', 'email_log', 'mail_queue', 'alert',
  ];
  const out = {};
  for (const t of tables) {
    try {
      out[t] = scalar(`SELECT COUNT(*) AS n FROM "${t}"`);
    } catch {
      out[t] = null; // 表未创建
    }
  }
  return out;
}
