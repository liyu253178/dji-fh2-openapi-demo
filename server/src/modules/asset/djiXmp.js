/**
 * DJI 航拍影像元数据解析（XMP 私有命名空间）
 *
 * 实测结论（2026-09-29，Matrice 4TD / M4TD，DJI 司空 2 公有云）：
 *   DJI 机型【不写标准 EXIF GPS IFD（0x8825）】，GPS 与飞行姿态全部存放在
 *   XMP 的 `drone-dji` 私有命名空间中。通用 exif 库读不到坐标，必须解析 XMP。
 *
 * 坐标精度：WGS84 + RTK 状态位（实测 14/14 全部为 RTK）
 *
 * 提供字段（实测样本）：
 *   drone-dji:GpsLatitude / GpsLongitude   经纬度（WGS84）
 *   drone-dji:AbsoluteAltitude             椭球高（米）
 *   drone-dji:RelativeAltitude             相对起飞点高（米）
 *   drone-dji:GpsStatus                    定位质量（RTK / PPS / RTKFloat）
 *   drone-dji:GimbalRollDegree/Yaw/Pitch   云台三轴角
 *   drone-dji:FlightRollDegree/Yaw/Pitch   机身三轴角
 *   drone-dji:DroneSerialNumber            飞行器 SN
 *   drone-dji:CameraSerialNumber           相机 SN
 *   drone-dji:ImageSource                  镜头类型（ZoomCamera / WideCamera / IRCamera）
 *   drone-dji:DroneModel / ProductName     机型
 *   drone-dji:SensorTemperature            传感器温度
 *   drone-dji:LRFTargetLat/Lon/Alt         激光测距目标点（若开启）
 *   drone-dji:FlightLineInfo               飞行航线 ID（可用于同架次聚合）
 */

const F64 = 10;

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 提取 XMP 文本块 */
export function extractXmp(buf) {
  const s = buf.toString('latin1');
  const a = s.indexOf('<x:xmpmeta');
  const z = s.indexOf('</x:xmpmeta>');
  if (a < 0 || z < 0) return null;
  return s.slice(a, z + 12);
}

/** 读取 XMP 中某个属性的字符串值 */
function attr(xmp, key) {
  const m = xmp.match(new RegExp(`${key}="([^"]*)"`));
  return m ? m[1] : null;
}

/**
 * 解析 DJI 影像元数据
 * @param {Buffer} buf 原始 JPEG 字节
 * @returns {object|null} 解析结果；无 XMP 时返回 null
 */
export function parseDjiMeta(buf) {
  const xmp = extractXmp(buf);
  if (!xmp) return null;

  const lat = toNum(attr(xmp, 'drone-dji:GpsLatitude'));
  const lon = toNum(attr(xmp, 'drone-dji:GpsLongitude'));
  const absAlt = toNum(attr(xmp, 'drone-dji:AbsoluteAltitude'));
  const gpsStatus = attr(xmp, 'drone-dji:GpsStatus');

  return {
    // ---- 空间身份（第一层关联：空间关联）----
    lat,
    lon,
    altitudeAbs: absAlt,
    altitudeRelative: toNum(attr(xmp, 'drone-dji:RelativeAltitude')),
    // RTK / PPS / RTKFloat / None；非 RTK 时定位可能有米级误差
    gpsStatus,
    isRtk: gpsStatus === 'RTK' || gpsStatus === 'RTKFloat',
    // 坐标系固定 WGS84（DJI 原生），无需转换；与 CGCS2000 差距 < 1m
    crs: 'EPSG:4326',

    // ---- 拍摄姿态（用于 footprint 计算与复原）----
    gimbal: {
      roll: toNum(attr(xmp, 'drone-dji:GimbalRollDegree')),
      yaw: toNum(attr(xmp, 'drone-dji:GimbalYawDegree')),
      pitch: toNum(attr(xmp, 'drone-dji:GimbalPitchDegree')),
    },
    flight: {
      roll: toNum(attr(xmp, 'drone-dji:FlightRollDegree')),
      yaw: toNum(attr(xmp, 'drone-dji:FlightYawDegree')),
      pitch: toNum(attr(xmp, 'drone-dji:FlightPitchDegree')),
    },

    // ---- 设备身份（第一层关联：任务关联）----
    droneSn: attr(xmp, 'drone-dji:DroneSerialNumber'),
    droneModel: attr(xmp, 'drone-dji:DroneModel') || attr(xmp, 'drone-dji:ProductName'),
    cameraSn: attr(xmp, 'drone-dji:CameraSerialNumber'),
    imageSource: attr(xmp, 'drone-dji:ImageSource'),
    // ZoomCamera=变焦 / WideCamera=广角 / IRCamera=红外
    lensType: (() => {
      const v = attr(xmp, 'drone-dji:ImageSource');
      // 归一为库表约定的两值：infrared | visible
      // （实测 M4TD 的 ImageSource 取值为 InfraredCamera / ZoomCamera / WideCamera）
      return { InfraredCamera: 'infrared', IRCamera: 'infrared', ZoomCamera: 'visible', WideCamera: 'visible' }[v] || null;
    })(),

    // ---- 时间（第一层关联：任务关联）----
    shootTime: attr(xmp, 'xmp:CreateDate') || attr(xmp, 'xmp:ModifyDate'),
    cameraMake: attr(xmp, 'tiff:Make'),
    cameraModel: attr(xmp, 'tiff:Model'),

    // ---- 扩展 ----
    sensorTemperature: toNum(attr(xmp, 'drone-dji:SensorTemperature')),
    lensPosition: toNum(attr(xmp, 'drone-dji:LensPosition')),
    ndValue: toNum(attr(xmp, 'drone-dji:NdValue')),
    surveyingMode: attr(xmp, 'drone-dji:SurveyingMode'),
    // 激光测距目标点：可作为疑似问题的精确指向
    lrf: (() => {
      const la = toNum(attr(xmp, 'drone-dji:LRFTargetLat'));
      const lo = toNum(attr(xmp, 'drone-dji:LRFTargetLon'));
      if (la === null || lo === null) return null;
      return { lat: la, lon: lo, alt: toNum(attr(xmp, 'drone-dji:LRFTargetAbsAlt')), dist: toNum(attr(xmp, 'drone-dji:LRFTargetDistance')) };
    })(),
    // 飞行航线 ID：同一次架次的照片共享该值，可用于自动聚类
    flightLineId: attr(xmp, 'drone-dji:FlightLineInfo'),
  };
}

/**
 * 估算单张照片的地面覆盖范围（footprint）
 *
 * 注意：这是**粗略估算**，仅用于"点在不在图里"的初筛与地图缩略框。
 * 要精确到实际图斑边界，需要相机内参 + 姿态角，或依赖 PPK / POS 数据。
 *
 * @param {object} meta parseDjiMeta 的结果
 * @param {object} opts sensorWidthMm 传感器宽度（默认 M4TD 广角 13.2mm）
 */
export function estimateFootprint(meta, opts = {}) {
  const { sensorWidthMm = 13.2, fovDeg = 84 } = opts;
  if (!meta || meta.lat === null || meta.altitudeRelative === null) return null;

  const pitch = meta.gimbal?.pitch;
  if (pitch === null || pitch === undefined) return null;

  // 云台俯角 -90°（垂直向下）为正射；接近 0°（平视）时地面覆盖估算不成立
  const nadir = Math.abs(pitch) >= 60;
  const h = meta.altitudeRelative;
  // 修正：非垂直时地面距离变长
  const slant = nadir ? h : h / Math.max(0.2, Math.abs(Math.sin((pitch * Math.PI) / 180)));
  const half = (fovDeg / 2) * (Math.PI / 180);
  const width = 2 * slant * Math.tan(half);
  const height = width * 0.75; // 4:3 画幅
  const mPerDegLat = 111320;

  return {
    // 中心点
    center: { lat: meta.lat, lon: meta.lon },
    // 覆盖范围（度）
    bbox: {
      minLat: meta.lat - height / 2 / mPerDegLat,
      maxLat: meta.lat + height / 2 / mPerDegLat,
      minLon: meta.lon - width / 2 / (mPerDegLat * Math.cos((meta.lat * Math.PI) / 180)),
      maxLon: meta.lon + width / 2 / (mPerDegLat * Math.cos((meta.lat * Math.PI) / 180)),
    },
    widthM: width,
    heightM: height,
    isNadir: nadir,
    // 精度声明：粗估，不可作为执法证据
    accuracy: 'rough',
  };
}

export const DJI_META_FIELDS = F64;
