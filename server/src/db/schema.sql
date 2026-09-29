-- ============================================================================
-- DUAV 一期 数据库结构
--
-- 约定：
--   1. 所有表带 created_at / updated_at（ISO 8601 字符串，可读性好且便于按时间排序）
--   2. 布尔用 INTEGER 0/1，不用 BOOLEAN（SQLite 无真布尔）
--   3. 空间字段统一 WGS84（EPSG:4326），与 DJI 原生一致
--   4. 影像与业务数据分离：大文件存磁盘，库里只存相对路径与元数据
--   5. overlay_* / data_version 是一期为二期预留的空字段
-- ============================================================================

-- ============ 迁移版本 ============
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- ============ 司空同步缓存 ============
-- 只做展示与检索用，不作为业务权威数据源
CREATE TABLE IF NOT EXISTS project (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid              TEXT NOT NULL UNIQUE,        -- 司空 project uuid
  org_uuid          TEXT,
  name              TEXT NOT NULL,
  work_center_lat   REAL,
  work_center_lng   REAL,
  synced_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sn            TEXT NOT NULL UNIQUE,            -- 设备 SN
  project_uuid  TEXT,
  role          TEXT NOT NULL,                   -- gateway | drone
  model         TEXT,                            -- DJI Dock 3 / Matrice 4TD
  callsign      TEXT,                            -- 机场显示名，如「深圳机场3」
  online        INTEGER DEFAULT 0,
  -- camera_list 为 NULL 表示飞行器未开机（无镜头列表），属正常情况
  camera_list   TEXT,                            -- JSON
  synced_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_project ON device(project_uuid, role);

-- 飞行任务：从司空同步，是影像的父级
CREATE TABLE IF NOT EXISTS flight_task (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid            TEXT NOT NULL UNIQUE,          -- 司空 task uuid
  project_uuid    TEXT NOT NULL,
  dock_sn         TEXT,                          -- 机场 SN（不是飞行器 SN）
  name            TEXT,
  task_type       TEXT,                          -- immediate | others(FlyToTask_*)
  status          TEXT,                          -- success | terminated | starting_failure
  wayline_uuid    TEXT,
  begin_at        TEXT,
  end_at          TEXT,
  media_total     INTEGER DEFAULT 0,
  -- 架次聚合键：同一架次的所有照片共享该值（来自影像 XMP 的 FlightLineInfo）
  flight_line_id  TEXT,
  -- 同步状态：ok | partial | failed
  sync_status     TEXT DEFAULT 'ok',
  sync_error      TEXT,
  synced_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_project ON flight_task(project_uuid, dock_sn);
CREATE INDEX IF NOT EXISTS idx_task_time    ON flight_task(begin_at);
CREATE INDEX IF NOT EXISTS idx_task_line    ON flight_task(flight_line_id);

-- ============ 影像资产（核心表）============
-- 一行 = 一张航拍影像。承载《成果资产》五层关联中的「任务关联」与「空间关联」。
CREATE TABLE IF NOT EXISTS asset_image (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_uuid       TEXT NOT NULL,                -- 司空 task uuid
  media_uuid      TEXT NOT NULL,                -- 司空 media uuid
  project_uuid    TEXT NOT NULL,
  dock_sn         TEXT,

  -- 文件
  file_name       TEXT NOT NULL,
  file_hash       TEXT,                         -- sha256，去重与完整性校验
  file_size       INTEGER,
  file_path       TEXT,                         -- 相对 DATA_DIR
  thumb_path      TEXT,                         -- 200px 缩略图
  mail_path       TEXT,                         -- 1600px 邮件压缩图

  file_type       TEXT,                         -- image | ppk | unsupported
  lens_type       TEXT,                         -- visible | infrared
  image_source    TEXT,                         -- ZoomCamera/WideCamera/IRCamera

  -- 空间身份（来自 XMP）
  lat             REAL,
  lon             REAL,
  altitude_abs    REAL,                         -- 椭球高（米）
  altitude_rel    REAL,                         -- 相对起飞点高（米）
  gps_status      TEXT,                         -- RTK | RTKFloat | PPS
  crs             TEXT DEFAULT 'EPSG:4326',     -- WGS84
  footprint_bbox  TEXT,                         -- JSON {minLat,maxLat,minLon,maxLon}
  footprint_w     REAL,                         -- 覆盖宽（米）
  footprint_h     REAL,
  is_nadir        INTEGER,                      -- 是否接近正射（云台俯角>=60°）

  -- 姿态（度）
  gimbal_roll     REAL, gimbal_yaw REAL, gimbal_pitch REAL,
  flight_roll     REAL, flight_yaw REAL, flight_pitch REAL,

  -- 设备与时间
  drone_sn        TEXT,
  camera_sn       TEXT,
  drone_model     TEXT,
  flight_line_id  TEXT,                         -- 架次聚合键
  shot_at         TEXT,                         -- 拍摄时间
  synced_at       TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- ok | no_gps | failed
  parse_status    TEXT DEFAULT 'ok',
  parse_error     TEXT,
  -- 配对影像（红外 ↔ 可见光），由同步任务按 FlightLineInfo 配对后回填
  pair_image_id   INTEGER,
  -- none | patched | dispatched（冗余自 patch_image，便于列表查询免 JOIN）
  review_state    TEXT DEFAULT 'none',
  -- 同一 task+media 只入库一次
  UNIQUE(task_uuid, media_uuid)
);
CREATE INDEX IF NOT EXISTS idx_img_task  ON asset_image(task_uuid, shot_at);
CREATE INDEX IF NOT EXISTS idx_img_line  ON asset_image(flight_line_id);
CREATE INDEX IF NOT EXISTS idx_img_geo   ON asset_image(lat, lon);
CREATE INDEX IF NOT EXISTS idx_img_hash  ON asset_image(file_hash);
CREATE INDEX IF NOT EXISTS idx_img_state ON asset_image(review_state);
CREATE INDEX IF NOT EXISTS idx_img_pair  ON asset_image(pair_image_id);

-- ============ 图斑（问题）============
-- 审核员在影像上框选出的问题范围。可独立存在，AI 识别结果后续也挂到这里。
CREATE TABLE IF NOT EXISTS patch (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_uuid   TEXT NOT NULL,
  task_uuid      TEXT,                          -- 建议来源架次（可空）
  flight_line_id TEXT,                          -- 架次（可空，便于批量归组）

  issue_type     TEXT NOT NULL,                 -- 字典编码，如 ILLEGAL_BUILD
  title          TEXT,
  description    TEXT,

  -- 空间（GPS 自动取自 XMP，可人工微调）
  lat            REAL NOT NULL,
  lon            REAL NOT NULL,
  crs            TEXT DEFAULT 'EPSG:4326',
  geometry_type  TEXT DEFAULT 'rect',           -- rect | polygon
  geometry       TEXT,                          -- GeoJSON
  area_m2        REAL,

  -- 一期人工填写
  admin_region   TEXT,                          -- 乡镇/街道
  village        TEXT,                          -- 村/社区
  position_desc  TEXT,                          -- 四至与参照物（邮件必含）
  land_type      TEXT,                          -- 现状地类
  is_permanent_farmland INTEGER DEFAULT 0,     -- 0/1
  planning_use   TEXT,                          -- 规划用途
  approval_no    TEXT,                          -- 审批手续号

  -- 二期预留（一期不展示，但必须存在，接数据源直接填值，历史数据不用洗）
  overlay_result     TEXT,                      -- JSON：空间套合输出
  overlay_confidence TEXT,                      -- 套合置信度说明
  data_version       TEXT,                      -- 依据的数据版本与时点

  -- 审核留痕
  reviewed_by    TEXT,                          -- 一期恒为 local_user
  reviewed_at    TEXT,
  review_remark  TEXT,
  assignee       TEXT,                          -- 二期任务分配预留
  -- draft（待派单）| ticketed（已生成工单）
  status         TEXT NOT NULL DEFAULT 'draft',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patch_project ON patch(project_uuid, status);
CREATE INDEX IF NOT EXISTS idx_patch_type    ON patch(issue_type);
CREATE INDEX IF NOT EXISTS idx_patch_line    ON patch(flight_line_id);
CREATE INDEX IF NOT EXISTS idx_patch_geo     ON patch(lat, lon);

-- 图斑 ↔ 影像 多对多（一张影像可含多个图斑，一个图斑可由多张影像支撑）
CREATE TABLE IF NOT EXISTS patch_image (
  patch_id   INTEGER NOT NULL,
  image_id   INTEGER NOT NULL,
  is_primary INTEGER DEFAULT 0,                 -- 主图（邮件附件第一张）
  created_at TEXT NOT NULL,
  PRIMARY KEY (patch_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_pi_image ON patch_image(image_id);

-- ============ 字典与派发对象 ============
-- 问题类型字典：可配置，业务方不需改代码即可调整时限与必填项
CREATE TABLE IF NOT EXISTS issue_type (
  code               TEXT PRIMARY KEY,          -- 大写字母+下划线
  name               TEXT NOT NULL,
  default_org        TEXT,                      -- 默认责任层级
  default_days       INTEGER,                   -- 默认处理时限（天）
  require_area       INTEGER DEFAULT 0,        -- 是否必填面积
  require_land_type  INTEGER DEFAULT 0,        -- 是否必填地类
  sort_order         INTEGER DEFAULT 0,
  enabled            INTEGER DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- 派发对象：责任单位与收件人
CREATE TABLE IF NOT EXISTS recipient (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,                  -- 责任单位名称
  contact       TEXT,                          -- 联系人
  phone         TEXT,
  email         TEXT NOT NULL,
  admin_region  TEXT,                          -- 行政区
  address_desc  TEXT,                          -- 地址描述（邮件里用）
  active        INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipient_region ON recipient(admin_region, active);

-- ============ 工单 ============
CREATE TABLE IF NOT EXISTS ticket (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 编号规则：日期-机场码-序号，如 20260929-D3-007
  ticket_no      TEXT NOT NULL UNIQUE,
  patch_id       INTEGER NOT NULL,
  issue_type     TEXT NOT NULL,
  project_uuid   TEXT NOT NULL,

  -- draft | dispatched | accepted | processing | submitted | rejected | cancelled
  status         TEXT NOT NULL DEFAULT 'draft',

  recipient_id   INTEGER,                      -- 派发对象
  assigned_to    TEXT,                          -- 具体责任人（一期手填）
  contact        TEXT,

  discovered_at  TEXT,                         -- 发现时间（= 影像拍摄时间）
  deadline       TEXT,                         -- 截止日期
  dispatched_at  TEXT,
  accepted_at    TEXT,
  submitted_at   TEXT,
  closed_at      TEXT,

  -- none | pending | sent | failed | partial
  mail_status    TEXT DEFAULT 'none',
  mail_error     TEXT,
  overdue        INTEGER DEFAULT 0,            -- 0/1，由定时任务刷新

  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_status  ON ticket(status, deadline);
CREATE INDEX IF NOT EXISTS idx_ticket_project ON ticket(project_uuid, status);
CREATE INDEX IF NOT EXISTS idx_ticket_type    ON ticket(issue_type);
CREATE INDEX IF NOT EXISTS idx_ticket_region  ON ticket(overdue, status);

-- 状态流转留痕：任何状态变更必须写这里，保证可追溯
-- to_status 允许为 NULL：备注、认领等「不改变状态」的事件也记在这里
CREATE TABLE IF NOT EXISTS ticket_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  operator    TEXT,                            -- local_user | system
  remark      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tlog_ticket ON ticket_log(ticket_id, created_at);

-- ============ 邮件 ============
-- 发送记录（送达凭证）
CREATE TABLE IF NOT EXISTS email_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id       INTEGER NOT NULL,
  template        TEXT NOT NULL,               -- TPL_DISPATCH
  recipient_email TEXT,
  cc              TEXT,
  subject         TEXT,
  body_html       TEXT,
  attachments     TEXT,                        -- JSON 数组
  -- pending | sent | failed | partial
  status          TEXT NOT NULL,
  attempts        INTEGER DEFAULT 0,
  error           TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elog_ticket ON email_log(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_elog_status ON email_log(status, created_at);

-- 发送队列：异步 + 重试
CREATE TABLE IF NOT EXISTS mail_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id      INTEGER NOT NULL,
  priority       INTEGER DEFAULT 5,
  -- pending | processing | done | failed
  status         TEXT DEFAULT 'pending',
  attempts       INTEGER DEFAULT 0,
  next_retry_at  TEXT,                         -- 到期才被 worker 捞起
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON mail_queue(status, next_retry_at);

-- ============ 告警 ============
CREATE TABLE IF NOT EXISTS alert (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  level        TEXT NOT NULL,                  -- fatal | error | warn | info
  category     TEXT,                           -- sync | mail | storage | system
  title        TEXT NOT NULL,
  detail       TEXT,
  ref_type     TEXT,                           -- ticket | task
  ref_id       TEXT,
  acknowledged INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_ack  ON alert(acknowledged, created_at);
CREATE INDEX IF NOT EXISTS idx_alert_level ON alert(level, created_at);
