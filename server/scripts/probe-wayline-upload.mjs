/**
 * 探针 3：自建航线 KMZ → 上传司空 2 → 验证是否被接受
 *
 * 验证目标（决定整个「航线规划」模块的技术路线）：
 *   A) 只提交 wpmz/template.kml（面状航线：多边形+重叠率，由大疆侧展开）是否通过？
 *   B) 若 A 失败，补上自己展开的 wpmz/waylines.wpml 是否通过？
 *
 * ⚠️ 会在当前项目里留下测试航线，名称带「DUAV自研规划验证」前缀便于识别。
 *
 * 用法：node scripts/probe-wayline-upload.mjs [a|b]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OSS from 'ali-oss';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/tokens.json'), 'utf8'));
const tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || {};
const TOKEN = tok.token || tok.value || '';
const PROJECT = store.activeProjectUuid || '';
const BASE = 'https://es-flight-api-cn.djigate.com';
const MODE = (process.argv[2] || 'a').toLowerCase();

async function req(method, p, body, query) {
  const url = new URL('/openapi/v0.1' + p, BASE);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const opt = {
    method,
    headers: { 'X-User-Token': TOKEN, 'X-Project-Uuid': PROJECT, 'X-Request-Id': crypto.randomUUID(), 'X-Language': 'zh-CN' },
  };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch(url, opt);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { ok: false, http: res.status, raw: text.slice(0, 300) }; }
  return { ok: Number(j.code) === 0 && res.ok, http: res.status, code: j.code, message: j.message, data: j.data };
}

/** 机型：Matrice 4TD（实测 /project/device → device_model）
 *  c 模式故意写成别的机型枚举，用来检验「司空 2 是否真的做机型校验」 */
const AC = MODE === 'c'
  ? { name: '（错误机型）0-91-1', key: '0-91-1', domain: 0, type: 91, subType: 1, payload: 99 }
  : { name: 'Matrice 4TD', key: '0-100-1', domain: 0, type: 100, subType: 1, payload: 99 };
/** 测区：广州 100×100m 方块 */
const AREA = [
  [113.493512, 23.092449],
  [113.494488, 23.092449],
  [113.494488, 23.091551],
  [113.493512, 23.091551],
];
const CFG = { height: 60, speed: 10, overlapH: 80, overlapW: 70, direction: 0 };

const poly = AREA.map(c => `                ${c[0]},${c[1]},0`).join('\n');
const now = Date.now();

const templateKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <wpml:author>DUAV</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>goContinue</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${CFG.speed}</wpml:globalTransitionalSpeed>
      <wpml:globalRTHHeight>100</wpml:globalRTHHeight>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${AC.type}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${AC.subType}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
      <wpml:waylineAvoidLimitAreaMode>0</wpml:waylineAvoidLimitAreaMode>
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${AC.payload}</wpml:payloadEnumValue>
        <wpml:payloadSubEnumValue>0</wpml:payloadSubEnumValue>
        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      </wpml:payloadInfo>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateType>mapping2d</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
        <wpml:globalShootHeight>${CFG.height}</wpml:globalShootHeight>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${CFG.speed}</wpml:autoFlightSpeed>
      <Placemark>
        <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
        <wpml:elevationOptimizeEnable>1</wpml:elevationOptimizeEnable>
        <wpml:smartObliqueEnable>0</wpml:smartObliqueEnable>
        <wpml:quickOrthoMappingEnable>0</wpml:quickOrthoMappingEnable>
        <wpml:facadeWaylineEnable>0</wpml:facadeWaylineEnable>
        <wpml:isLookAtSceneSet>0</wpml:isLookAtSceneSet>
        <wpml:shootType>time</wpml:shootType>
        <wpml:direction>${CFG.direction}</wpml:direction>
        <wpml:margin>0</wpml:margin>
        <wpml:efficiencyFlightModeEnable>0</wpml:efficiencyFlightModeEnable>
        <wpml:doubleGridWaylineEnable>0</wpml:doubleGridWaylineEnable>
        <wpml:overlap>
          <wpml:orthoCameraOverlapH>${CFG.overlapH}</wpml:orthoCameraOverlapH>
          <wpml:orthoCameraOverlapW>${CFG.overlapW}</wpml:orthoCameraOverlapW>
          <wpml:inclinedCameraOverlapH>${CFG.overlapH}</wpml:inclinedCameraOverlapH>
          <wpml:inclinedCameraOverlapW>${CFG.overlapW}</wpml:inclinedCameraOverlapW>
        </wpml:overlap>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>
${poly}
              </coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
        <wpml:ellipsoidHeight>${CFG.height}</wpml:ellipsoidHeight>
        <wpml:height>${CFG.height}</wpml:height>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

/** 自己按重叠率展开航点（B 方案用）—— 简化的往返扫描 */
function expandWaypoints() {
  // 用航线间距/航点间距示意值（真实值应取机型能力表），这里只验证结构是否被接受
  const spacing = 30, wpSpacing = 40;
  const xs = AREA.map(p => p[0]), ys = AREA.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const mPerDeg = 111320, mPerLng = 111320 * Math.cos(((minY + maxY) / 2) * Math.PI / 180);
  const w = (maxX - minX) * mPerLng, h = (maxY - minY) * mPerDeg;
  const n = Math.max(1, Math.ceil(h / spacing) + 1);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const lat = minY + (i / (n - 1 || 1)) * (maxY - minY);
    const cnt = Math.ceil(w / wpSpacing) + 1;
    const row = [];
    for (let j = 0; j < cnt; j++) row.push([minX + (j / (cnt - 1 || 1)) * (maxX - minX), lat]);
    if (i % 2 === 1) row.reverse();
    pts.push(...row);
  }
  return pts;
}

const gimbal = (angle) => `          <wpml:action>
            <wpml:actionId>1</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalHeadingYawBase>aircraft</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>${angle}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>10</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;

function buildWaylinesWpml() {
  const pts = expandWaypoints();
  const placemarks = pts.map((p, i) => `      <Placemark>
        <Point>
          <coordinates>${p[0]},${p[1]}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${CFG.height}</wpml:executeHeight>
        <wpml:waypointSpeed>${CFG.speed}</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>1</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
        </wpml:waypointHeadingParam>
        <wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>
        <wpml:useStraightLine>1</wpml:useStraightLine>
        <wpml:actionGroup>
          <wpml:actionGroupId>0</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${i}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${pts.length - 1}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>betweenAdjacentPoints</wpml:actionTriggerType>
          </wpml:actionTrigger>
          <wpml:action>
            <wpml:actionId>0</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalAngleLock</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
${gimbal(-90)}
          <wpml:action>
            <wpml:actionId>2</wpml:actionId>
            <wpml:actionActuatorFunc>startTimeLapse</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>
              <wpml:payloadLensIndex>visable</wpml:payloadLensIndex>
              <wpml:minShootInterval>2</wpml:minShootInterval>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
        <wpml:isRisky>0</wpml:isRisky>
        <wpml:waypointWorkType>0</wpml:waypointWorkType>
      </Placemark>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>goContinue</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${CFG.speed}</wpml:globalTransitionalSpeed>
      <wpml:globalRTHHeight>100</wpml:globalRTHHeight>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${AC.type}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${AC.subType}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
      <wpml:waylineAvoidLimitAreaMode>0</wpml:waylineAvoidLimitAreaMode>
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${AC.payload}</wpml:payloadEnumValue>
        <wpml:payloadSubEnumValue>0</wpml:payloadSubEnumValue>
        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      </wpml:payloadInfo>
    </wpml:missionConfig>
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:autoFlightSpeed>${CFG.speed}</wpml:autoFlightSpeed>
${placemarks}
    </Folder>
  </Document>
</kml>`;
}

// ---- 打包 KMZ（zip）----
const { zipSync, strToU8 } = await import('fflate');
const entries = { 'wpmz/template.kml': strToU8(templateKml) };
if (MODE !== 'a') entries['wpmz/waylines.wpml'] = strToU8(buildWaylinesWpml());
const kmz = Buffer.from(zipSync(entries, { level: 6 }));

const label = `DUAV自研规划验证-${MODE.toUpperCase()}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
console.log(`模式 ${MODE.toUpperCase()}：包含文件 ${Object.keys(entries).join(', ')}，KMZ ${kmz.length}B`);

// ---- STS 三步上传 ----
const sts = await req('GET', '/project/sts-token');
if (!sts.ok) { console.error('取 STS 失败', sts); process.exit(1); }
const { endpoint, bucket, region, credentials, object_key_prefix } = sts.data || {};
const c = credentials || {};
const REGION_MAP = { hz: 'oss-cn-hangzhou', bj: 'oss-cn-beijing', sh: 'oss-cn-shanghai', sz: 'oss-cn-shenzhen', gz: 'oss-cn-guangzhou', cd: 'oss-cn-chengdu', hk: 'oss-cn-hongkong' };
const normRegion = (region || '').startsWith('oss-') ? region : (REGION_MAP[(region || '').toLowerCase()] || `oss-cn-${region}`);
const prefix = (object_key_prefix || '').replace(/\/+$/, '');
const objectKey = `${prefix}/${label}.kmz`;

const client = new OSS({
  accessKeyId: c.access_key_id, accessKeySecret: c.access_key_secret, stsToken: c.security_token,
  bucket, region: normRegion,
  ...(endpoint ? { endpoint: endpoint.startsWith('http') ? endpoint : `https://${endpoint}` } : {}),
  secure: true,
});
await client.put(objectKey, kmz);
console.log('已上传存储桶 object_key=', objectKey);

const finish = await req('POST', '/wayline/finish-upload', { object_key: objectKey, name: label });
console.log('finish-upload:', JSON.stringify(finish));

// ---- 回查列表：验证是否进入航线库 ----
await new Promise(r => setTimeout(r, 1500));
const list = await req('GET', '/wayline', null, { page: 1, page_size: 100 });
const hit = (list.data?.list || []).find(i => i.name === label);
console.log(hit ? `✔ 已进入航线库：${JSON.stringify(hit)}` : '✘ 未出现在 /wayline 列表中');
