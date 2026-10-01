-- 自研航线草稿表：平台侧绘制 → 生成 KMZ → 上传司空 2 验证 → 进入航线库
-- status: draft(本地已生成) | validating(已提交待回查) | verified(司空已接受且机型一致) | rejected(未通过)
CREATE TABLE IF NOT EXISTS wayline_draft (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  aircraft_key    TEXT NOT NULL,                -- 目标机型 device_model.key
  aircraft_name   TEXT,
  payload_enum    INTEGER,                      -- 载荷枚举（从同型号真实航线反演）
  template_type   TEXT DEFAULT 'mapping2d',
  -- draft | validating | verified | rejected
  status          TEXT NOT NULL DEFAULT 'draft',
  polygon         TEXT,                         -- JSON [[lon,lat],...] WGS84
  params          TEXT,                         -- JSON 作业参数
  stats           TEXT,                         -- JSON 航带/航点/里程等
  wayline_id      TEXT,                         -- 司空 2 返回的航线 uuid
  model_key_remote TEXT,                        -- 回查到的 device_model_key（闸 2 的比对对象）
  verify_message  TEXT,
  verified_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wdraft_status   ON wayline_draft(status, created_at);
CREATE INDEX IF NOT EXISTS idx_wdraft_aircraft ON wayline_draft(aircraft_key);
CREATE INDEX IF NOT EXISTS idx_wdraft_wayline  ON wayline_draft(wayline_id);
