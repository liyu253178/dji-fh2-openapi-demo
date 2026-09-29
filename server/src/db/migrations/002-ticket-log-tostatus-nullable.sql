-- ============================================================================
-- v2：ticket_log.to_status 改为可空
--
-- 背景：基线 schema.sql 把 to_status 定义为 NOT NULL，
--      但「备注」这类不改变状态的事件也要写入 ticket_log，
--      传入 NULL 会触发 SQLite NOT NULL 约束失败（接口 500）。
--
-- 语义：备注/认领等事件 to_status 为空，仅 from_status + remark 记录。
--
-- 注：SQLite 不支持直接 ALTER COLUMN ... SET NULL，
--      采用「新建表 → 拷贝 → 删旧表 → 改名」的方式。
-- ============================================================================

CREATE TABLE IF NOT EXISTS ticket_log_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  operator    TEXT,
  remark      TEXT,
  created_at  TEXT NOT NULL
);

INSERT INTO ticket_log_new (id, ticket_id, from_status, to_status, operator, remark, created_at)
SELECT id, ticket_id, from_status, to_status, operator, remark, created_at
FROM ticket_log;

DROP TABLE ticket_log;

ALTER TABLE ticket_log_new RENAME TO ticket_log;

CREATE INDEX IF NOT EXISTS idx_tlog_ticket ON ticket_log(ticket_id, created_at);
