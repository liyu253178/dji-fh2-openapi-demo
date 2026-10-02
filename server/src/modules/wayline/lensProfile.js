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

/* ============================================================================
 * 按机型解析镜头 —— 机型适配的落地处
 *
 * ⚠️ 为什么必须有这一步：
 *    上面 LENSES 里的焦距写死是安全的（Matrice 4 各机型焦距确实相同，都是公开常数），
 *    但**像素数不是**：M4TD 广角是 1/1.3" 4800 万（8064×6048），
 *    M4D/M4E/M4T 是 4/3" 2000 万（5280×3956）。旧代码拿到机型不看，
 *    一律按 8064 算 GSD —— M4E 会被算成 1.86cm（真值 2.84cm，偏差 −34.5%）。
 *    所以像素必须跟着机型走，焦距可以共用。
 *
 * 优先级（不要打乱）：
 *     真实航线反演值(overrides)  >  机型注册表的官方规格  >  通用理论表
 *  真实航线是量出来的，比任何标称值都可信；这也是既有设计的选择，保留。
 * ========================================================================== */
import { lensProfileFor as _lensProfileFor, lensOf } from './aircraftLens.js';

/**
 * 解析某机型在给定镜头位上的完整规格
 * @param {{key?:string,name?:string}} [model] 机型；不传或查不到时回落到通用表
 * @param {string[]} lensKeys
 * @returns {{profile:object|null, matchedBy:string, warnings:string[], specs:object[]}}
 */
export function resolveLensSpecs(model, lensKeys = ['wide']) {
  const keys = lensKeys.length ? lensKeys : ['wide'];
  if (!model || (!model.key && !model.name)) {
    // 没有机型信息：严格沿用旧的通用表行为（连像素都不猜），结局与重构前完全一致
    return {
      profile: null,
      matchedBy: 'none',
      warnings: [],
      specs: keys.map((key) => ({ ...lensByKey(key), source: 'generic', pixelsUnknown: true })),
    };
  }
  const { profile, matchedBy, warnings } = _lensProfileFor({ key: model.key, name: model.name });
  const specs = keys.map((key) => {
    const generic = lensByKey(key);
    const spec = lensOf(profile, key);
    const fromRegistry = !!spec;
    const imageW = fromRegistry ? spec.imageW : profile.sensor?.imageW;
    const imageH = fromRegistry ? spec.imageH : profile.sensor?.imageH;
    return {
      key,
      name: spec?.name || generic.name,
      focalEq: fromRegistry ? spec.focalEq : generic.focalEq,
      imageW,
      imageH,
      payloadLensIndex: spec?.payloadLensIndex || generic.payloadLensIndex,
      thermal: !!(spec?.thermal ?? generic.thermal),
      source: fromRegistry ? 'registry' : 'generic',
      pixelsUnknown: !Number.isFinite(imageW) || !Number.isFinite(imageH),
      assumed: !!profile.fallback, // 未知机型回落值，实测前不可用于正式作业
    };
  });
  return { profile, matchedBy, warnings, specs };
}

/**
 * 取一组镜头的有效间距系数
 * 多镜头同时采集时，间距必须取**最小的那个**（视场最窄的镜头也要满足重叠率），
 * 否则窄视场那一路会漏拍。
 */
export function effectiveCoef(lensKeys = ['wide'], overrides = {}, model = null) {
  const { specs, profile, matchedBy, warnings } = resolveLensSpecs(model, lensKeys);
  let swathK = Infinity;
  let stepK = Infinity;
  let governing = null;
  let stepGovernor = null;
  for (const l of specs) {
    const ov = overrides[l.key];
    const k = ov?.swathK ?? swathKOf(l.focalEq);
    const ks = ov?.stepK ?? stepKOf(l.focalEq);
    if (k < swathK) {
      swathK = k;
      governing = l;
    }
    if (ks < stepK) {
      stepK = ks;
      stepGovernor = l;
    }
    stepK = Math.min(stepK, ks);
  }
  return {
    swathK,
    stepK,
    governing: governing || specs[0],
    /** 沿航向片基的约束镜头（可以是另一颗，与旁向的约束镜头不必是同一颗） */
    stepGovernor: stepGovernor || specs[0],
    lenses: specs,
    // 覆盖宽度（航高 1m 时的米数），用于界面提示
    swathRatio: swathK,
    /** 机型适配的来源，界面上要能说清「这个 GSD 是量出来的还是查出来的」 */
    lensSource: profile
      ? { model: profile.names?.[0] || model?.name || '', matchedBy, registry: !profile.fallback, source: profile.source }
      : { model: '', matchedBy: 'none', registry: false, source: '' },
    warnings,
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
