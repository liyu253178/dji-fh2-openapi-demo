/**
 * 仓储层：司空同步缓存 + 影像资产 + 字典 + 派发对象 + 告警
 */

import { all, get, run, insert, patch, tx, scalar } from '../index.js';

const now = () => new Date().toISOString();

// ===================================================================
// 项目 / 设备 / 任务（司空同步缓存）
// ===================================================================

export const syncRepo = {
  upsertProject(p) {
    const ts = now();
    run(
      `INSERT INTO project (uuid, org_uuid, name, work_center_lat, work_center_lng, synced_at)
       VALUES (@uuid, @orgUuid, @name, @lat, @lng, @ts)
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name,
         work_center_lat = excluded.work_center_lat,
         work_center_lng = excluded.work_center_lng,
         synced_at = excluded.synced_at`,
      { uuid: p.uuid, orgUuid: p.orgUuid ?? null, name: p.name, lat: p.lat ?? null, lng: p.lng ?? null, ts }
    );
  },

  listProjects() {
    return all('SELECT * FROM project ORDER BY name');
  },

  upsertDevice(d) {
    const ts = now();
    run(
      `INSERT INTO device (sn, project_uuid, role, model, callsign, online, camera_list, synced_at)
       VALUES (@sn, @projectUuid, @role, @model, @callsign, @online, @cameraList, @ts)
       ON CONFLICT(sn) DO UPDATE SET
         project_uuid = excluded.project_uuid,
         role = excluded.role,
         model = excluded.model,
         callsign = excluded.callsign,
         online = excluded.online,
         camera_list = excluded.camera_list,
         synced_at = excluded.synced_at`,
      {
        sn: d.sn,
        projectUuid: d.projectUuid ?? null,
        role: d.role,
        model: d.model ?? '',
        callsign: d.callsign ?? '',
        online: d.online ? 1 : 0,
        cameraList: d.cameraList ? JSON.stringify(d.cameraList) : null,
        ts,
      }
    );
  },

  listDevices(projectUuid) {
    if (projectUuid) {
      return all('SELECT * FROM device WHERE project_uuid = @projectUuid ORDER BY role, sn', { projectUuid });
    }
    return all('SELECT * FROM device ORDER BY role, sn');
  },

  /**
   * upsert 飞行任务。
   * 已存在时不覆盖 media_total / flight_line_id 等本地聚合字段。
   */
  upsertTask(t) {
    const ts = now();
    run(
      `INSERT INTO flight_task (uuid, project_uuid, dock_sn, name, task_type, status,
                                wayline_uuid, begin_at, end_at, media_total,
                                sync_status, sync_error, synced_at, updated_at)
       VALUES (@uuid, @projectUuid, @dockSn, @name, @taskType, @status,
               @waylineUuid, @beginAt, @endAt, @mediaTotal, 'ok', NULL, @ts, @ts)
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name,
         task_type = excluded.task_type,
         status = excluded.status,
         media_total = excluded.media_total,
         begin_at = excluded.begin_at,
         end_at = excluded.end_at,
         sync_status = excluded.sync_status,
         synced_at = excluded.synced_at,
         updated_at = excluded.updated_at`,
      {
        uuid: t.uuid,
        projectUuid: t.projectUuid,
        dockSn: t.dockSn ?? null,
        name: t.name ?? '',
        taskType: t.taskType ?? '',
        status: t.status ?? '',
        waylineUuid: t.waylineUuid ?? null,
        beginAt: t.beginAt ?? null,
        endAt: t.endAt ?? null,
        mediaTotal: t.mediaTotal ?? 0,
        ts,
      }
    );
  },

  findTask(uuid) {
    return get('SELECT * FROM flight_task WHERE uuid = @uuid', { uuid });
  },

  /**
   * 删除架次及其名下的影像记录（不含磁盘文件清理，磁盘层面由调用方决定）。
   * 用于「自动剔除无图片航线」：判定为无影像时不该留一条空壳架次污染列表。
   */
  deleteTask(uuid) {
    run('DELETE FROM asset_image WHERE task_uuid = @uuid', { uuid });
    const info = run('DELETE FROM flight_task WHERE uuid = @uuid', { uuid });
    return info.changes || 0;
  },

  /**
   * 某项目下「历史同步出过架次」的机场清单（按最近作业时间倒序）。
   * 同步弹窗的机场下拉数据源 = 当前在线设备 ∪ 这里，否则「项目曾有数据但机场
   * 当前不在线/不在该项目」时下拉为空且必选，用户会被卡死（实测复现）。
   */
  knownDocks(projectUuid) {
    return all(
      `SELECT dock_sn AS dockSn, COUNT(*) AS tasks, MAX(begin_at) AS lastAt
       FROM flight_task
       WHERE project_uuid = @projectUuid AND dock_sn IS NOT NULL AND dock_sn != ''
       GROUP BY dock_sn
       ORDER BY lastAt DESC`,
      { projectUuid }
    );
  },

  /**
   * 批量删除「没有任何照片」的架次记录（同步选项只管新数据，存量靠这里清）。返回删除行数。
   *
   * 判定口径与同步时的「自动剔除无图片航线」保持一致：名下没有 file_type='image'
   * 的记录即为无影像架次。只挂了 PPK 等辅助文件的同样算——实测某项目 49 个架次里
   * 47 个是 FlyToTask 定点飞行 / 纯辅助下载，一条照片都没有。
   */
  deleteEmptyTasks(projectUuid) {
    const cond = `NOT EXISTS (
       SELECT 1 FROM asset_image WHERE asset_image.task_uuid = flight_task.uuid
         AND asset_image.file_type = 'image')`;
    const info = projectUuid
      ? run(`DELETE FROM flight_task WHERE project_uuid = @projectUuid AND ${cond}`, { projectUuid })
      : run(`DELETE FROM flight_task WHERE ${cond}`);
    return info.changes || 0;
  },

  markTaskSync(uuid, { status, error, mediaTotal, flightLineId }) {
    const sets = { sync_status: status, sync_error: error ?? null, updated_at: now() };
    if (mediaTotal !== undefined) sets.media_total = mediaTotal;
    if (flightLineId !== undefined) sets.flight_line_id = flightLineId;
    return updateTaskByUuid(uuid, sets);
  },

  listTasks({ projectUuid, dockSn, beginAt, endAt, page = 1, pageSize = 20 } = {}) {
    const where = [];
    const params = { limit: pageSize, offset: (page - 1) * pageSize };
    if (projectUuid) {
      where.push('project_uuid = @projectUuid');
      params.projectUuid = projectUuid;
    }
    if (dockSn) {
      where.push('dock_sn = @dockSn');
      params.dockSn = dockSn;
    }
    if (beginAt) {
      where.push('begin_at >= @beginAt');
      params.beginAt = beginAt;
    }
    if (endAt) {
      where.push('begin_at <= @endAt');
      params.endAt = endAt;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = scalar(`SELECT COUNT(*) AS n FROM flight_task ${w}`, params) || 0;
    const list = all(
      `SELECT * FROM flight_task ${w} ORDER BY begin_at DESC LIMIT @limit OFFSET @offset`,
      params
    ).map((t) => {
      const img = get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN lens_type = 'visible' THEN 1 ELSE 0 END) AS visible,
                SUM(CASE WHEN lens_type = 'infrared' THEN 1 ELSE 0 END) AS infrared,
                SUM(CASE WHEN file_type = 'ppk' THEN 1 ELSE 0 END) AS ppk,
                SUM(CASE WHEN parse_status = 'no_gps' THEN 1 ELSE 0 END) AS no_gps,
                SUM(CASE WHEN review_state != 'none' THEN 1 ELSE 0 END) AS patched,
                SUM(CASE WHEN review_state = 'dispatched' THEN 1 ELSE 0 END) AS dispatched,
                MIN(lat) AS min_lat, MAX(lat) AS max_lat,
                MIN(lon) AS min_lng, MAX(lon) AS max_lng
         FROM asset_image WHERE task_uuid = @uuid`,
        { uuid: t.uuid }
      );
      return {
        taskUuid: t.uuid,
        name: t.name,
        status: t.status,
        taskType: t.task_type,
        dockSn: t.dock_sn,
        projectUuid: t.project_uuid,
        beginAt: t.begin_at,
        endAt: t.end_at,
        flightLineId: t.flight_line_id,
        syncStatus: t.sync_status,
        imageCount: img?.total || 0,
        imageStats: {
          visible: img?.visible || 0,
          infrared: img?.infrared || 0,
          ppk: img?.ppk || 0,
          noGps: img?.no_gps || 0,
        },
        review: { total: img?.total || 0, patched: img?.patched || 0, dispatched: img?.dispatched || 0 },
        bbox:
          img?.min_lat != null
            ? { minLat: img.min_lat, maxLat: img.max_lat, minLon: img.min_lng, maxLon: img.max_lng }
            : null,
      };
    });
    return { total, list };
  },
};

// flight_task 是 uuid 唯一，没有自增 id，需按 uuid 更新
function updateTaskByUuid(uuid, sets) {
  const keys = Object.keys(sets);
  if (!keys.length) return { changes: 0 };
  const assigns = keys.map((k) => `${k} = @${k}`).join(', ');
  return run(`UPDATE flight_task SET ${assigns} WHERE uuid = @uuid`, { ...sets, uuid });
}

// ===================================================================
// 影像资产
// ===================================================================

export const assetRepo = {
  /**
   * 写入一条影像（同 task+media 幂等，用 INSERT ... ON CONFLICT DO UPDATE）
   * 返回 { id, created }
   */
  upsertImage(img) {
    const ts = now();
    const before = get('SELECT id FROM asset_image WHERE task_uuid = @taskUuid AND media_uuid = @mediaUuid', {
      taskUuid: img.taskUuid,
      mediaUuid: img.mediaUuid,
    });
    /**
     * ⚠️ 实测缺陷：PPK 等非影像文件没有镜头概念，早期统一兜底成 'visible'，
     *    污染了两处 —— ①「仅可见光」筛选无法排除 PPK；② 架次统计的 visible 计数虚高
     *    （该架次 63 张真图被算成 67）。这里只对真实影像兜底。
     */
    const fileType = img.fileType ?? 'image';
    const rec = {
      taskUuid: img.taskUuid,
      mediaUuid: img.mediaUuid,
      projectUuid: img.projectUuid,
      dockSn: img.dockSn ?? null,
      fileName: img.fileName,
      fileHash: img.fileHash ?? null,
      fileSize: img.fileSize ?? null,
      filePath: img.filePath ?? null,
      thumbPath: img.thumbPath ?? null,
      mailPath: img.mailPath ?? null,
      fileType,
      lensType: img.lensType ?? (fileType === 'image' ? 'visible' : null),
      imageSource: img.imageSource ?? null,
      lat: img.lat ?? null,
      lon: img.lon ?? null,
      altitudeAbs: img.altitudeAbs ?? null,
      altitudeRel: img.altitudeRel ?? null,
      gpsStatus: img.gpsStatus ?? null,
      crs: img.crs || 'EPSG:4326',
      footprintBbox: img.footprintBbox ? JSON.stringify(img.footprintBbox) : null,
      footprintW: img.footprintW ?? null,
      footprintH: img.footprintH ?? null,
      isNadir: img.isNadir ? 1 : 0,
      gimbalRoll: img.gimbalRoll ?? null,
      gimbalYaw: img.gimbalYaw ?? null,
      gimbalPitch: img.gimbalPitch ?? null,
      flightRoll: img.flightRoll ?? null,
      flightYaw: img.flightYaw ?? null,
      flightPitch: img.flightPitch ?? null,
      droneSn: img.droneSn ?? null,
      cameraSn: img.cameraSn ?? null,
      droneModel: img.droneModel ?? null,
      flightLineId: img.flightLineId ?? null,
      shotAt: img.shotAt ?? null,
      parseStatus: img.parseStatus || 'ok',
      parseError: img.parseError ?? null,
      ts,
    };
    run(
      `INSERT INTO asset_image (task_uuid, media_uuid, project_uuid, dock_sn, file_name, file_hash,
         file_size, file_path, thumb_path, mail_path, file_type, lens_type, image_source,
         lat, lon, altitude_abs, altitude_rel, gps_status, crs, footprint_bbox, footprint_w, footprint_h,
         is_nadir, gimbal_roll, gimbal_yaw, gimbal_pitch, flight_roll, flight_yaw, flight_pitch,
         drone_sn, camera_sn, drone_model, flight_line_id, shot_at, synced_at, updated_at,
         parse_status, parse_error)
       VALUES (@taskUuid, @mediaUuid, @projectUuid, @dockSn, @fileName, @fileHash,
         @fileSize, @filePath, @thumbPath, @mailPath, @fileType, @lensType, @imageSource,
         @lat, @lon, @altitudeAbs, @altitudeRel, @gpsStatus, @crs, @footprintBbox, @footprintW, @footprintH,
         @isNadir, @gimbalRoll, @gimbalYaw, @gimbalPitch, @flightRoll, @flightYaw, @flightPitch,
         @droneSn, @cameraSn, @droneModel, @flightLineId, @shotAt, @ts, @ts,
         @parseStatus, @parseError)
       ON CONFLICT(task_uuid, media_uuid) DO UPDATE SET
         file_path = COALESCE(excluded.file_path, asset_image.file_path),
         thumb_path = COALESCE(excluded.thumb_path, asset_image.thumb_path),
         mail_path = COALESCE(excluded.mail_path, asset_image.mail_path),
         lat = excluded.lat, lon = excluded.lon,
         altitude_abs = excluded.altitude_abs, altitude_rel = excluded.altitude_rel,
         gps_status = excluded.gps_status, footprint_bbox = excluded.footprint_bbox,
         footprint_w = excluded.footprint_w, footprint_h = excluded.footprint_h,
         is_nadir = excluded.is_nadir, parse_status = excluded.parse_status,
         flight_line_id = COALESCE(excluded.flight_line_id, asset_image.flight_line_id),
         updated_at = excluded.updated_at`,
      rec
    );
    const id = before
      ? before.id
      : scalar('SELECT id FROM asset_image WHERE task_uuid = @t AND media_uuid = @m', {
          t: rec.taskUuid,
          m: rec.mediaUuid,
        });
    return { id, created: !before };
  },

  updateFootprint(id, { bbox, widthM, heightM, isNadir }) {
    return patch('asset_image', id, {
      footprint_bbox: bbox ? JSON.stringify(bbox) : null,
      footprint_w: widthM ?? null,
      footprint_h: heightM ?? null,
      is_nadir: isNadir ? 1 : 0,
      updated_at: now(),
    });
  },

  /** 配对红外与可见光（按架次 + 序号） */
  pairByFlightLine(flightLineId) {
    if (!flightLineId) return 0;
    const imgs = all(
      `SELECT id, file_name, lens_type FROM asset_image
       WHERE flight_line_id = @f AND file_type = 'image' AND pair_image_id IS NULL
       ORDER BY file_name`,
      { f: flightLineId }
    );
    const visible = imgs.filter((i) => i.lens_type === 'visible');
    const infrared = imgs.filter((i) => i.lens_type === 'infrared');
    let n = 0;
    tx(() => {
      // 文件名形如 DJI_20260714140727_0001_V / _T，按后缀前的时间戳与序号配对
      for (const v of visible) {
        const base = v.file_name.replace(/_[VT]$/, '');
        const match = infrared.find((ir) => ir.file_name.replace(/_[VT]$/, '') === base);
        if (match) {
          run('UPDATE asset_image SET pair_image_id = @other, updated_at = @ts WHERE id = @id', {
            id: v.id,
            other: match.id,
            ts: now(),
          });
          run('UPDATE asset_image SET pair_image_id = @other, updated_at = @ts WHERE id = @id', {
            id: match.id,
            other: v.id,
            ts: now(),
          });
          n++;
        }
      }
    });
    return n;
  },

  findById(id) {
    const r = get('SELECT * FROM asset_image WHERE id = @id', { id });
    if (!r) return null;
    return {
      ...r,
      taskUuid: r.task_uuid,
      mediaUuid: r.media_uuid,
      projectUuid: r.project_uuid,
      dockSn: r.dock_sn,
      fileName: r.file_name,
      fileHash: r.file_hash,
      fileSize: r.file_size,
      filePath: r.file_path,
      thumbPath: r.thumb_path,
      mailPath: r.mail_path,
      fileType: r.file_type,
      lensType: r.lens_type,
      imageSource: r.image_source,
      altitudeAbs: r.altitude_abs,
      altitudeRel: r.altitude_rel,
      gpsStatus: r.gps_status,
      footprint: r.footprint_bbox
        ? { bbox: JSON.parse(r.footprint_bbox), widthM: r.footprint_w, heightM: r.footprint_h }
        : null,
      isNadir: !!r.is_nadir,
      gimbal: { roll: r.gimbal_roll, yaw: r.gimbal_yaw, pitch: r.gimbal_pitch },
      flight: { roll: r.flight_roll, yaw: r.flight_yaw, pitch: r.flight_pitch },
      droneSn: r.drone_sn,
      cameraSn: r.camera_sn,
      droneModel: r.drone_model,
      flightLineId: r.flight_line_id,
      shotAt: r.shot_at,
      parseStatus: r.parse_status,
      parseError: r.parse_error,
      pairImageId: r.pair_image_id,
      reviewState: r.review_state,
    };
  },

  /**
   * 某架次的影像列表（审核工作台缩略图数据源）
   *
   * ⚠️ 排序坑（实测缺陷）：PPK 等非影像文件没有 shot_at，而 SQLite 的
   *    `ORDER BY shot_at ASC` 会把 NULL 排在**最前面**。于是工作台默认选中的
   *    images[0] 恰好是一条没有原图、没有 XMP 的 PPK 记录 ——
   *    表现为「大图全黑 + 右侧属性全为 —」，看起来像影像全部同步失败。
   *    这里强制三段排序：真实影像优先 → 有拍摄时间优先 → 文件名自然序。
   */
  listByTask(taskUuid) {
    return all(
      `SELECT id FROM asset_image WHERE task_uuid = @taskUuid
       ORDER BY (file_type IS NULL OR file_type <> 'image'),
                (shot_at IS NULL),
                shot_at ASC,
                file_name ASC`,
      { taskUuid }
    ).map((r) => assetRepo.findById(r.id));
  },

  /** 多维检索 */
  search({ projectUuid, taskUuid, lensType, reviewState, minLat, minLon, maxLat, maxLon, beginAt, endAt, page = 1, pageSize = 50 } = {}) {
    const where = [];
    const params = { limit: pageSize, offset: (page - 1) * pageSize };
    if (projectUuid) {
      where.push('project_uuid = @projectUuid');
      params.projectUuid = projectUuid;
    }
    if (taskUuid) {
      where.push('task_uuid = @taskUuid');
      params.taskUuid = taskUuid;
    }
    if (lensType) {
      where.push('lens_type = @lensType');
      params.lensType = lensType;
    }
    if (reviewState) {
      where.push('review_state = @reviewState');
      params.reviewState = reviewState;
    }
    if (minLat != null) {
      where.push('lat BETWEEN @minLat AND @maxLat');
      params.minLat = minLat;
      params.maxLat = maxLat;
    }
    if (minLon != null) {
      where.push('lon BETWEEN @minLon AND @maxLon');
      params.minLon = minLon;
      params.maxLon = maxLon;
    }
    if (beginAt) {
      where.push('shot_at >= @beginAt');
      params.beginAt = beginAt;
    }
    if (endAt) {
      where.push('shot_at <= @endAt');
      params.endAt = endAt;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = scalar(`SELECT COUNT(*) AS n FROM asset_image ${w}`, params) || 0;
    const list = all(`SELECT id FROM asset_image ${w} ORDER BY shot_at DESC LIMIT @limit OFFSET @offset`, params);
    return { total, list: list.map((r) => assetRepo.findById(r.id)) };
  },

  /** 航迹重建：按架次的影像 GPS 序列（因司空 track 接口实测不可用，作兜底） */
  trackByFlightLine(flightLineId) {
    const rows = all(
      `SELECT lat, lon, shot_at, altitude_rel FROM asset_image
       WHERE flight_line_id = @f AND lat IS NOT NULL
       ORDER BY shot_at ASC`,
      { f: flightLineId }
    );
    return rows.map((r) => [r.lon, r.lat, r.altitude_rel, r.shot_at]);
  },

  /** 统计：某任务的架次聚合键（取众数） */
  dominantFlightLineId(taskUuid) {
    return scalar(
      `SELECT flight_line_id FROM asset_image WHERE task_uuid = @t AND flight_line_id IS NOT NULL
       GROUP BY flight_line_id ORDER BY COUNT(*) DESC LIMIT 1`,
      { t: taskUuid }
    );
  },
};

// ===================================================================
// 字典 / 派发对象
// ===================================================================

export const dictRepo = {
  listIssueTypes({ enabledOnly = true } = {}) {
    const w = enabledOnly ? 'WHERE enabled = 1' : '';
    return all(`SELECT * FROM issue_type ${w} ORDER BY sort_order, name`).map((r) => ({
      code: r.code,
      name: r.name,
      defaultOrg: r.default_org,
      defaultDays: r.default_days,
      requireArea: !!r.require_area,
      requireLandType: !!r.require_land_type,
      sortOrder: r.sort_order,
      enabled: !!r.enabled,
    }));
  },

  getIssueType(code) {
    const r = get('SELECT * FROM issue_type WHERE code = @code', { code });
    if (!r) return null;
    return {
      code: r.code,
      name: r.name,
      defaultOrg: r.default_org,
      defaultDays: r.default_days,
      requireArea: !!r.require_area,
      requireLandType: !!r.require_land_type,
      sortOrder: r.sort_order,
      enabled: !!r.enabled,
    };
  },

  /** code 唯一；已存在则更新 */
  upsertIssueType(t) {
    const ts = now();
    const exist = get('SELECT code FROM issue_type WHERE code = @code', { code: t.code });
    if (exist) {
      run(
        `UPDATE issue_type SET name=@name, default_org=@defaultOrg, default_days=@defaultDays,
           require_area=@requireArea, require_land_type=@requireLandType,
           sort_order=@sortOrder, enabled=@enabled, updated_at=@ts
         WHERE code=@code`,
        {
          code: t.code,
          name: t.name,
          defaultOrg: t.defaultOrg ?? null,
          defaultDays: t.defaultDays ?? null,
          requireArea: t.requireArea ? 1 : 0,
          requireLandType: t.requireLandType ? 1 : 0,
          sortOrder: t.sortOrder ?? 0,
          enabled: t.enabled === false ? 0 : 1,
          ts,
        }
      );
      return { created: false };
    }
    insert('issue_type', {
      code: t.code,
      name: t.name,
      default_org: t.defaultOrg ?? null,
      default_days: t.defaultDays ?? null,
      require_area: t.requireArea ? 1 : 0,
      require_land_type: t.requireLandType ? 1 : 0,
      sort_order: t.sortOrder ?? 0,
      enabled: t.enabled === false ? 0 : 1,
      created_at: ts,
      updated_at: ts,
    });
    return { created: true };
  },

  /** 删除问题类型；若被工单引用则拒绝 */
  deleteIssueType(code) {
    const used = scalar('SELECT COUNT(*) AS n FROM ticket WHERE issue_type = @code', { code }) || 0;
    if (used > 0) return { ok: false, message: `该问题类型已被 ${used} 张工单引用，无法删除` };
    const usedPatch = scalar('SELECT COUNT(*) AS n FROM patch WHERE issue_type = @code', { code }) || 0;
    if (usedPatch > 0) return { ok: false, message: `该问题类型已被 ${usedPatch} 个图斑引用，无法删除` };
    const r = run('DELETE FROM issue_type WHERE code = @code', { code });
    return { ok: r.changes > 0, message: r.changes ? '' : '问题类型不存在' };
  },

  listRecipients({ activeOnly = true } = {}) {
    const w = activeOnly ? 'WHERE active = 1' : '';
    return all(`SELECT * FROM recipient ${w} ORDER BY name`).map((r) => ({
      id: r.id,
      name: r.name,
      contact: r.contact,
      phone: r.phone,
      email: r.email,
      adminRegion: r.admin_region,
      addressDesc: r.address_desc,
      active: !!r.active,
    }));
  },

  getRecipient(id) {
    const r = get('SELECT * FROM recipient WHERE id = @id', { id });
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      contact: r.contact,
      phone: r.phone,
      email: r.email,
      adminRegion: r.admin_region,
      addressDesc: r.address_desc,
      active: !!r.active,
    };
  },

  createRecipient(data) {
    const ts = now();
    const { id } = insert('recipient', {
      name: data.name,
      contact: data.contact ?? '',
      phone: data.phone ?? '',
      email: data.email,
      admin_region: data.adminRegion ?? '',
      address_desc: data.addressDesc ?? '',
      active: data.active === false ? 0 : 1,
      created_at: ts,
      updated_at: ts,
    });
    return id;
  },

  updateRecipient(id, data) {
    const map = {
      name: 'name',
      contact: 'contact',
      phone: 'phone',
      email: 'email',
      adminRegion: 'admin_region',
      addressDesc: 'address_desc',
    };
    const payload = { updated_at: now() };
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) payload[col] = data[k];
    }
    if (data.active !== undefined) payload.active = data.active ? 1 : 0;
    return patch('recipient', id, payload);
  },

  /** 删除派发对象；被工单引用则拒绝 */
  deleteRecipient(id) {
    const used = scalar('SELECT COUNT(*) AS n FROM ticket WHERE recipient_id = @id', { id }) || 0;
    if (used > 0) return { ok: false, message: `该派发对象已被 ${used} 张工单引用，无法删除` };
    const r = run('DELETE FROM recipient WHERE id = @id', { id });
    return { ok: r.changes > 0, message: r.changes ? '' : '派发对象不存在' };
  },
};

// ===================================================================
// 告警
// ===================================================================

export const alertRepo = {
  push({ level = 'info', category = 'system', title, detail, refType, refId }) {
    const { id } = insert('alert', {
      level,
      category,
      title,
      detail: detail ?? null,
      ref_type: refType ?? null,
      ref_id: refId ?? null,
      acknowledged: 0,
      created_at: now(),
    });
    return id;
  },

  list({ level, acknowledged, limit = 100 } = {}) {
    const where = [];
    const params = { limit };
    if (level) {
      where.push('level = @level');
      params.level = level;
    }
    if (acknowledged !== undefined) {
      where.push('acknowledged = @ack');
      params.ack = acknowledged ? 1 : 0;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return all(
      `SELECT * FROM alert ${w} ORDER BY acknowledged ASC, created_at DESC LIMIT @limit`,
      params
    ).map((r) => ({
      id: r.id,
      level: r.level,
      category: r.category,
      title: r.title,
      detail: r.detail,
      refType: r.ref_type,
      refId: r.ref_id,
      acknowledged: !!r.acknowledged,
      createdAt: r.created_at,
    }));
  },

  unacknowledgedCount() {
    return scalar('SELECT COUNT(*) AS n FROM alert WHERE acknowledged = 0') || 0;
  },

  acknowledge(id) {
    return patch('alert', id, { acknowledged: 1 });
  },
};
