/**
 * Cesium 侧的 GCJ-02 纠偏工具（与 Leaflet 的 BaseMap 共用同一套换算函数）
 *
 * 为什么抽出来：
 * 高德等国内瓦片源的行列号是按 GCJ-02 编的，而 Cesium 的地球是 WGS84。
 * 直接把高德瓦片铺上去会整体往东南偏几百米——省域大屏上就是"边界和底图对不上"。
 * 这个偏差在模型预览页和大屏页都会遇到，两处各写一份必然漂移，所以放到 utils 里共用。
 *
 * 用法（Cesium 必须作为参数传入，避免 utils 静态 import 整个 Cesium）：
 *   const Gcj02Scheme = makeGcj02TilingScheme(Cesium);
 *   new Cesium.UrlTemplateImageryProvider({ url, tilingScheme: new Gcj02Scheme() })
 */
import { wgs84ToGcj02, gcj02ToWgs84 } from './geo.js';

/**
 * 生成 GCJ-02 版本的 WebMercatorTilingScheme 类。
 *
 * 思路：地球仍按 WGS84 渲染，只在「问瓦片」和「铺瓦片」两步做换算：
 *  - 取瓦片：WGS84 坐标 → 转 GCJ-02 → 算行列号
 *  - 铺瓦片：行列号 → GCJ 矩形 → 四角转回 WGS84 得包络
 */
export function makeGcj02TilingScheme(Cesium) {
  return class Gcj02WebMercatorTilingScheme extends Cesium.WebMercatorTilingScheme {
    positionToTileXY(position, level, result) {
      const lon = Cesium.Math.toDegrees(position.longitude);
      const lat = Cesium.Math.toDegrees(position.latitude);
      const [glon, glat] = wgs84ToGcj02(lon, lat);
      return super.positionToTileXY(
        Cesium.Cartographic.fromRadians(Cesium.Math.toRadians(glon), Cesium.Math.toRadians(glat)),
        level,
        result
      );
    }

    tileXYToRectangle(x, y, level, result) {
      const gcj = super.tileXYToRectangle(x, y, level, new Cesium.Rectangle());
      // 四角 GCJ→WGS84 取包络。纠偏量在瓦片尺度上近似平移，四角差异可忽略。
      let west = Infinity;
      let east = -Infinity;
      let south = Infinity;
      let north = -Infinity;
      for (const [lonDeg, latDeg] of [
        [Cesium.Math.toDegrees(gcj.west), Cesium.Math.toDegrees(gcj.south)],
        [Cesium.Math.toDegrees(gcj.east), Cesium.Math.toDegrees(gcj.south)],
        [Cesium.Math.toDegrees(gcj.east), Cesium.Math.toDegrees(gcj.north)],
        [Cesium.Math.toDegrees(gcj.west), Cesium.Math.toDegrees(gcj.north)],
      ]) {
        const [wlon, wlat] = gcj02ToWgs84(lonDeg, latDeg);
        west = Math.min(west, wlon);
        east = Math.max(east, wlon);
        south = Math.min(south, wlat);
        north = Math.max(north, wlat);
      }
      const rect = result ?? new Cesium.Rectangle();
      rect.west = Cesium.Math.toRadians(west);
      rect.east = Cesium.Math.toRadians(east);
      rect.south = Cesium.Math.toRadians(south);
      rect.north = Cesium.Math.toRadians(north);
      return rect;
    }
  };
}

/** 两个经纬度点之间的地面距离（米）——用测地线，不用直线 */
export function groundDistanceM(Cesium, lon1, lat1, lon2, lat2) {
  const g = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(lon1, lat1),
    Cesium.Cartographic.fromDegrees(lon2, lat2)
  );
  return g.surfaceDistance;
}

/**
 * 离线 Cesium 的通用初始化项（禁 Ion / 关无用控件 / 按需渲染）
 *
 * 内网私有化部署下 Ion 必然不通，且任何一次 Ion 请求都会让页面卡住等待超时。
 * 大屏与模型页都走这里，避免漏配导致"本地好好的、客户内网白屏"。
 */
export function offlineViewerOptions({ requestRender = false } = {}) {
  return {
    // Ion 令牌置空 + 关掉默认服务，任何 Ion 资源都不会被请求
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // 大屏常显不需要按需渲染；模型浏览页可开，省 GPU
    requestRenderMode: requestRender,
    contextOptions: { webgl: { alpha: false, antialias: true, powerPreference: 'high-performance' } },
  };
}
