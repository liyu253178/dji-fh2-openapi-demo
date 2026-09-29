-- 图斑「具体地址」：由影像 GPS 坐标自动逆地理匹配，可人工改写
--
-- 业务原因：工单要派到属地单位，光有经纬度一线没法找，得是「XX镇XX村XX路旁」。
-- address_source 区分自动/人工：人工改过之后，前端不再用自动结果覆盖它（避免"改了又被冲掉"）。
ALTER TABLE patch ADD COLUMN address        TEXT;                          -- 具体地址（逆地理编码结果）
ALTER TABLE patch ADD COLUMN address_source TEXT;                          -- auto | manual | nearby
ALTER TABLE patch ADD COLUMN address_at     TEXT;                          -- 最近一次匹配/修改时间
