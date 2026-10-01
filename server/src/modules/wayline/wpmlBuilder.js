/**
 * WPML 1.0.6 生成（司空 2 航线文件格式）
 *
 * ⚠️ 本文件的字段骨架来自真实联调结果，不要凭文档或竞品样例改动：
 *   - 命名空间必须是 http://www.dji.com/wpmz/1.0.6（览达智航用的 1.0.2 是上一代，字段少很多）
 *   - KMZ 内必须**同时**有 wpmz/template.kml 与 wpmz/waylines.wpml；
 *     只给 template.kml 会被拒绝（实测 code=200500 server error）
 *   - 拍照方式用 actionTriggerType=betweenAdjacentPoints + startTimeLapse（按间隔连拍），
 *     不是 1.0.2 的逐点 takePhoto
 *   以上三条均由 server/scripts/probe-wayline-upload.mjs 的 A/B 探针在真实司空 2 上验证过。
 *
 * 纯函数、无 IO。
 */

const NS = 'http://www.dji.com/wpmz/1.0.6';

/** XML 文本转义：坐标不会有问题，但航线名是用户输入，必须转义 */
function esc(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 坐标串：WPML 的 Polygon coordinates 要求 "lon,lat,0"，空格分隔 */
function coordsText(polygon) {
  return polygon.map(([lon, lat]) => `${lon.toFixed(8)},${lat.toFixed(8)},0`).join(' ');
}

function missionConfig(ac, cfg) {
  return `    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>goContinue</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${Math.round(cfg.takeOffSecurityHeight ?? 20)}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${cfg.speed}</wpml:globalTransitionalSpeed>
      <wpml:globalRTHHeight>${Math.round(cfg.rthHeight ?? 100)}</wpml:globalRTHHeight>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${ac.type}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${ac.subType}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
      <wpml:waylineAvoidLimitAreaMode>0</wpml:waylineAvoidLimitAreaMode>
      <wpml:payloadInfo>
        <wpml:payloadEnumValue>${ac.payload}</wpml:payloadEnumValue>
        <wpml:payloadSubEnumValue>0</wpml:payloadSubEnumValue>
        <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
      </wpml:payloadInfo>
    </wpml:missionConfig>`;
}

/**
 * 面状模板 wpmz/template.kml
 * 这个文件描述「测区 + 重叠率 + 高度 + 方向」，由大疆侧据此展开；
 * 它是权威定义，waylines.wpml 是我们在平台侧的展开结果（两文件保持一致，规避 R1）。
 */
export function buildTemplateKml(input) {
  const { name, aircraft: ac, polygon } = input;
  const cfg = input.config || {};
  const height = Number(cfg.height) || 60;
  const speed = Number(cfg.speed) || 10;
  const overlapH = Number(cfg.overlapH) || 80;
  const overlapW = Number(cfg.overlapW) || 70;
  const direction = Number(cfg.direction) || 0;
  const now = Date.now();

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS}">
  <Document>
    <wpml:author>DUAV</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>
${missionConfig(ac, cfg)}
    <Folder>
      <wpml:templateType>mapping2d</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
        <wpml:globalShootHeight>${height}</wpml:globalShootHeight>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>
      <Placemark>
        <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
        <wpml:elevationOptimizeEnable>1</wpml:elevationOptimizeEnable>
        <wpml:smartObliqueEnable>0</wpml:smartObliqueEnable>
        <wpml:quickOrthoMappingEnable>0</wpml:quickOrthoMappingEnable>
        <wpml:facadeWaylineEnable>0</wpml:facadeWaylineEnable>
        <wpml:isLookAtSceneSet>0</wpml:isLookAtSceneSet>
        <wpml:shootType>time</wpml:shootType>
        <wpml:direction>${direction}</wpml:direction>
        <wpml:margin>${Math.round(cfg.margin ?? 0)}</wpml:margin>
        <wpml:efficiencyFlightModeEnable>0</wpml:efficiencyFlightModeEnable>
        <wpml:doubleGridWaylineEnable>${cfg.doubleGrid ? 1 : 0}</wpml:doubleGridWaylineEnable>
        <wpml:overlap>
          <wpml:orthoCameraOverlapH>${overlapH}</wpml:orthoCameraOverlapH>
          <wpml:orthoCameraOverlapW>${overlapW}</wpml:orthoCameraOverlapW>
          <wpml:inclinedCameraOverlapH>${overlapH}</wpml:inclinedCameraOverlapH>
          <wpml:inclinedCameraOverlapW>${overlapW}</wpml:inclinedCameraOverlapW>
        </wpml:overlap>
        <Polygon>
          <outerBoundaryIs>
            <LinearRing>
              <coordinates>${coordsText(polygon)}</coordinates>
            </LinearRing>
          </outerBoundaryIs>
        </Polygon>
        <wpml:ellipsoidHeight>${height}</wpml:ellipsoidHeight>
        <wpml:height>${height}</wpml:height>
      </Placemark>
      <wpml:waylineName>${esc(name)}</wpml:waylineName>
    </Folder>
  </Document>
</kml>`;
}

/** 云台俯仰动作：正射用 -90°（垂直向下） */
function gimbalAction(angle) {
  return `          <wpml:action>
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
}

function placemark(p, i, total, cfg, gimbalPitch) {
  const height = Number(cfg.height) || 60;
  const speed = Number(cfg.speed) || 10;
  return `      <Placemark>
        <Point>
          <coordinates>${p.lon.toFixed(8)},${p.lat.toFixed(8)}</coordinates>
        </Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${height}</wpml:executeHeight>
        <wpml:waypointSpeed>${speed}</wpml:waypointSpeed>
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
          <wpml:actionGroupEndIndex>${total - 1}</wpml:actionGroupEndIndex>
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
${gimbalAction(gimbalPitch)}
          <wpml:action>
            <wpml:actionId>2</wpml:actionId>
            <wpml:actionActuatorFunc>startTimeLapse</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
              <wpml:useGlobalPayloadLensIndex>0</wpml:useGlobalPayloadLensIndex>
              <wpml:payloadLensIndex>${cfg.payloadLensIndex || 'visable'}</wpml:payloadLensIndex>
              <wpml:minShootInterval>${Number(cfg.shootInterval) || 2}</wpml:minShootInterval>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>0</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
        <wpml:isRisky>0</wpml:isRisky>
        <wpml:waypointWorkType>0</wpml:waypointWorkType>
      </Placemark>`;
}

/**
 * 展开后的航点文件 wpmz/waylines.wpml
 * 与 template.kml 的机型 / 高度 / 速度 / 方向保持一致（规避 R1：执行时究竟读哪个文件尚未定论）
 */
export function buildWaylinesWpml(input) {
  const { aircraft: ac, waypoints } = input;
  const cfg = input.config || {};
  const gimbalPitch = Number(cfg.gimbalPitch ?? -90);
  const total = waypoints.length;
  const body = waypoints.map((p, i) => placemark(p, i, total, cfg, gimbalPitch)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS}">
  <Document>
${missionConfig(ac, cfg)}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:autoFlightSpeed>${Number(cfg.speed) || 10}</wpml:autoFlightSpeed>
${body}
    </Folder>
  </Document>
</kml>`;
}

/** 一次生成两个文件内容 */
export function buildWaylineFiles(input) {
  return {
    'wpmz/template.kml': buildTemplateKml(input),
    'wpmz/waylines.wpml': buildWaylinesWpml(input),
  };
}

export { NS };
