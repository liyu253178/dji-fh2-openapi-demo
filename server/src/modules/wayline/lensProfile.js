/**
 * 镜头参数与航带间距系数
 *
 * 核心公式（已用本队真实航线验证）：
 *     地面覆盖宽度 swath = 航高 H × (等效画幅宽 / 等效焦距) = H × 36 / f
 *     航线间距 spacing   = swath × (1 − 旁向重叠率)
 *     航向片基  base     = H × 27 / f × (1 − 航向重叠率)
 *
 * 取 36 × 27 作为等效画幅：35mm 全画幅的 4:3 裁切（8064×6048 正是 4:3）。
 *
 * 实测校验：本机队库里的 Matrice 4TD 真实航线 payloadLensIndex 为 "visable,ir"，
 * 即同时用可见光 + 红外采集，红外等效焦距 53mm → 系数 36/53 = 0.679；
 * 而从三条真实航线反演出的系数分别是 0.644 / 0.653 / 0.714 —— 与理论值吻合。
 * 这既验证了公式，也解释了为什么实测间距比"广角"理论值小：被更窄的红外视场约束了。
 *
 * ⚠️ WPML 的 payloadLensIndex 对可见光镜头不区分广角/长焦（本机队真实航线里
 *    可见光一律写作 visable），所以镜头选择体现为**间距与片基**的差异；
 *    界面上会明确说明，避免误以为选了长焦就会自动切换机载镜头。
 */

/** 35mm 等效画幅（4:3 裁切） */
export const FRAME_W = 36;
export const FRAME_H = 27;

/**
 * 镜头定义：等效焦距来自 DJI 官方规格（Matrice 4 系列）
 * 焦距是公开参数、不随设备变，所以这里写死是安全的；
 * 而**机型枚举**（droneEnumValue 等）绝不能写死，必须走 /project/device。
 */
export const LENSES = [
  { key: 'wide', name: '广角', focalEq: 24, fov: '82°', payloadLensIndex: 'visable', note: '默认。覆盖面最大、效率最高' },
  { key: 'medium', name: '中长焦', focalEq: 70, fov: '35°', payloadLensIndex: 'visable', note: '折中：细节更好，航带更密' },
  { key: 'tele', name: '长焦', focalEq: 168, fov: '15°', payloadLensIndex: 'visable', note: '细节最好，同样测区航带数最多、耗时最长' },
  { key: 'ir', name: '红外热成像', focalEq: 53, fov: '45°', payloadLensIndex: 'ir', thermal: true, note: '仅 M4T/4TD 具备；视场比广角窄，会成为间距的约束项' },
];

export const lensByKey = (key) => LENSES.find((l) => l.key === key) || LENSES[0];

/** 理论系数：地面覆盖宽度 / 航高 */
export const swathKOf = (focalEq) => FRAME_W / focalEq;
/** 理论系数：沿航向片基 / 航高 */
export const stepKOf = (focalEq) => FRAME_H / focalEq;

/**
 * 取一组镜头的有效间距系数
 * 多镜头同时采集时，间距必须取**最小的那个**（视场最窄的镜头也要满足重叠率），
 * 否则窄视场那一路会漏拍。
 */
export function effectiveCoef(lensKeys = ['wide'], overrides = {}) {
  const list = (lensKeys.length ? lensKeys : ['wide']).map(lensByKey);
  let swathK = Infinity;
  let stepK = Infinity;
  let governing = null;
  for (const l of list) {
    const ov = overrides[l.key];
    const k = ov?.swathK ?? swathKOf(l.focalEq);
    const ks = ov?.stepK ?? stepKOf(l.focalEq);
    if (k < swathK) {
      swathK = k;
      governing = l;
    }
    stepK = Math.min(stepK, ks);
  }
  return {
    swathK,
    stepK,
    governing: governing || list[0],
    lenses: list,
    // 覆盖宽度（航高 1m 时的米数），用于界面提示
    swathRatio: swathK,
  };
}

/** 多镜头时的 payloadLensIndex 写法（实测航线里为 "visable,ir"） */
export function lensIndexText(lensKeys = ['wide']) {
  const set = new Set();
  for (const k of lensKeys.length ? lensKeys : ['wide']) {
    const l = lensByKey(k);
    set.add(l.payloadLensIndex);
  }
  return [...set].join(',');
}
