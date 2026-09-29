-- 003-asset-non-image-lens-null.sql
--
-- 背景：司空 media 列表里除了真实照片，还夹带 DJI 的 PPK 后处理辅助文件
--       （file_type = 'ppk'，文件名以 _D 结尾，无缩略图、无 XMP 元数据）。
--       同步流程有意保留这些记录（供轨迹重建兜底），但早期统一把 lens_type
--       兜底写成了 'visible'，污染了两处：
--         ① 审核工作台「仅可见光」筛选无法排除它们；
--         ② 架次统计里 visible 计数虚高（某架次 63 张真图被算成 67）。
--       配合代码侧修复（upsertImage 只对 file_type='image' 兜底 visible），
--       这里把存量脏数据一并纠正为 NULL。

UPDATE asset_image SET lens_type = NULL WHERE file_type IS NOT NULL AND file_type <> 'image';
