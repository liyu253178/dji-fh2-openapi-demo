/**
 * 迁移执行器
 *
 * 策略：版本化迁移，每个版本一个 SQL 文件，执行过就记进 schema_version。
 * 一期的基线（schema.sql）作为 v1；二期改表时新增 migrations/002-xxx.sql 即可，
 * 不修改已执行过的文件（否则已部署的库与新代码不一致）。
 *
 * 幂等：同一版本重复执行会跳过；schema.sql 内全部使用 CREATE TABLE IF NOT EXISTS，
 *      因此基线可安全重跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, run, all, get, tx } from './index.js';
import { log } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** 读一个 sql 文件，按分号切分为独立语句 */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--')) // 去整行注释
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 已应用的版本集合 */
export function appliedVersions() {
  const exists = get(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`);
  if (!exists) return new Set();
  return new Set(all('SELECT version FROM schema_version').map((r) => r.version));
}

/**
 * 执行基线建库（v1）
 * schema.sql 内所有语句都是 IF NOT EXISTS，可安全重复执行。
 */
function applyBaseline() {
  const file = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`);
  const sql = fs.readFileSync(file, 'utf8');
  const statements = splitStatements(sql);
  const handle = getDb();
  handle.exec('BEGIN');
  try {
    for (const stmt of statements) handle.exec(stmt);
    // 记录基线已应用（v1）；若之前已记录则保留
    const done = appliedVersions();
    if (!done.has(1)) {
      run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
        1,
        new Date().toISOString(),
      ]);
    }
    handle.exec('COMMIT');
    return statements.length;
  } catch (e) {
    handle.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 执行增量迁移（v2+）
 * 扫描 migrations/ 目录，按版本号升序执行未应用的 SQL 文件。
 */
function applyIncremental() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return 0;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 002-xxx.sql 排在 001 之后
  if (!files.length) return 0;

  const done = appliedVersions();
  let applied = 0;
  for (const f of files) {
    const m = f.match(/^(\d+)-/);
    if (!m) {
      log.warn('DB', `迁移文件名需以版本号开头，已跳过: ${f}`);
      continue;
    }
    const version = Number(m[1]);
    if (done.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const handle = getDb();
    handle.exec('BEGIN');
    try {
      for (const stmt of splitStatements(sql)) handle.exec(stmt);
      run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
        version,
        new Date().toISOString(),
      ]);
      handle.exec('COMMIT');
      applied++;
      log.ok('DB', `已应用迁移 ${f} (v${version})`);
    } catch (e) {
      handle.exec('ROLLBACK');
      throw new Error(`迁移 ${f} 失败: ${e.message}`);
    }
  }
  return applied;
}

/**
 * 启动时调用：确保库是最新的。
 * 幂等，可反复调用。
 */
export function migrate() {
  getDb(); // 确保已连接
  const n = applyBaseline();
  const m = applyIncremental();
  const total = appliedVersions().size;
  log.ok('DB', `数据库就绪（基线 ${n} 条语句，增量 ${m} 个，已应用 ${total} 个版本）`);
  return { baseline: n, incremental: m, versions: total };
}

/** 当前库结构摘要（系统状态页用） */
export function schemaInfo() {
  const tables = all(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).map((r) => r.name);
  const indexes = all(
    `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`
  ).map((r) => r.name);
  return { tables, tableCount: tables.length, indexes, indexCount: indexes.length };
}
