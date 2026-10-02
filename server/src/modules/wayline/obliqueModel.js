/**
 * 摆拍（智能摆动拍摄）对航线参数的量化影响
 *
 * ============================================================================
 * ⚠️ 这份模型的边界，先写在最前面
 * ============================================================================
 *
 * 官方只给了定性结论（「减少旁向重叠率」「效率提升 40% / 一倍以上」），
 * **没有给出任何可验算的公式或角度**。所以下面是**我们自己推的**，
 * 不是大疆的承诺。用法是在保守前提下把收益算出来，并给出安全下限，
 * **绝不把厂商宣传的效率数字直接当参数用**。
 *
 * 三条不可逾越的纪律：
 *   1. 侧摆影像的覆盖贡献必须打折（η < 1）——它是斜视的，GSD 变差、有遮挡、几何变形，
 *      拿它和正射影像等价对待是错的。
 *   2. **正射影像自身的旁向重叠不能突破重建下限**（minSideOrtho），
 *      侧摆只是补充，不能用来救已经漏拍的航带间隙。
 *   3. 算不出确定值的参数（如侧摆角）一律外置为可调项，并在结果里标注 `assumed:true`。
 *
 * ---------------------------------------------------------------------------
 * 机理一：3 向正射摆拍（ortho3）—— 降低旁向重叠率
 * ---------------------------------------------------------------------------
 * 每个航点拍 3 张：下视 + 左摆 θ + 右摆 θ。
 * 侧摆 θ 时，影像中心在地面沿侧向偏移
 *      Δ = H · tan(θ)                                        (m)
 * 斜视影像质量不如正射，只按 η 折算其有效贡献：Δ_eff = η·Δ，左右各一，合计
 *      gain = 2 · η · H · tan(θ)                             (m)
 *
 * 关键在「重叠率」到底以什么为基准。设航带中心间距 D：
 *   正射影像自身的重叠宽度 = W − D
 *   侧摆在两条航带之间的间隙上额外提供的覆盖 = gain
 *   总覆盖重叠度（以正射宽度 W 归一）= (W − D + gain) / W
 * 要求总覆盖重叠度不低于用户设定的 o：
 *      (W − D + gain)/W ≥ o   ⟹   D ≤ W·(1 − o) + gain
 * 取等号即为摆拍下的航线间距：
 *      **D = W·(1 − o) + gain**
 * 不摆拍时 gain = 0，退化回 D = W·(1 − o)，与普通正射完全一致。
 *
 * 摆角越大 → gain 越大 → D 越大 → 航带越少，这就是「大幅优化」的来源。
 *
 * 代价是正射影像自身的重叠率被摊薄了：
 *      orthoOverlap = (W − D)/W = o − gain/W
 * 它必须守住重建下限 minOrthoSideOverlap（低于此值侧摆救不回来，重建会失败）：
 *      o − gain/W ≥ minOrthoSideOverlap  ⟹  **o ≥ minOrthoSideOverlap + gain/W**
 * 这就是摆拍下「用户至少该设多少旁向重叠率」。
 *
 * ⚠️ 注意一个反直觉但正确的结论：摆角越大，gain 越大，间距拉得越开，
 *    于是**名义重叠率的下限 o_min 反而越高**（要设更高的 o 才能守住正射底线）。
 *    所以衡量收益要看**间距**，不能看 o_min 的数值。
 * ---------------------------------------------------------------------------
 * 修正记录（2026-10-02）：初版把约束错写成「正射重叠 ≥ 下限」，
 * 导致间距上限被 W·(1−minOrtho) 锁死、与摆角无关，摆角增大反而没有收益，
 * 与摆拍的实际机理矛盾。已改为「总覆盖重叠度 ≥ o」的正确形式。
 *
 * ---------------------------------------------------------------------------
 * 机理二：5 向倾斜摆拍（smart5）—— 用 1 条航线替代 5 条
 * ---------------------------------------------------------------------------
 * 传统倾斜摄影模板（mapping3d）要飞 5 条航线（下视 + 前后左右），
 * 每条都要完整覆盖测区一次。摆拍是一条航线内由云台完成多角度采集，
 * 里程约降为 1/5。但**时长不能按 1/5 算**：每个航点要摆多次、拍多张，
 * 官方明确「飞行器会根据摆动序列调整飞行速度」，照片越多段速度越慢。
 * 因此时长按「里程/速度」给出，并对速度做保守折扣，输出区间而非单点。
 */

// 仅引入枚举常量；aircraftLens.js 无外部依赖，不会形成循环引用
import { OBLIQUE_MODE } from './aircraftLens.js';

/** 侧摆有效贡献折算系数（保守）：斜视影像不能与正射等价 */
export const DEFAULT_ETA = 0.6;

/** 正射影像自身的旁向重叠率重建下限（低于此值三维重建基本会失败） */
export const MIN_ORTHO_SIDE_OVERLAP = 0.3;

/** 默认侧摆角（度）。官方未公布正射摆拍角度，这里取保守值并标 assumed */
export const DEFAULT_SIDE_TILT_DEG = 20;

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const deg2rad = (d) => d * DEG;

/**
 * 正射覆盖宽度（m）：W = H · 等效画幅宽 / 等效焦距
 * @param {{height:number, focalEq:number, frameW:number}} p
 */
export function orthoSwath({ height, focalEq, frameW = 36 }) {
  return (height * frameW) / focalEq;
}

/**
 * 侧摆引起的地面横向偏移与有效扩展
 * @param {{height:number, sideTiltDeg?:number, eta?:number}} p
 * @returns {{offset:number, effective:number, assumed:boolean}}
 */
export function sideGain({ height, sideTiltDeg = DEFAULT_SIDE_TILT_DEG, eta = DEFAULT_ETA, oblique }) {
  if (oblique !== OBLIQUE_MODE.ORTHO3) {
    return { offset: 0, effective: 0, gain: 0, assumed: false };
  }
  const theta = clamp(Number(sideTiltDeg) || 0, 0, 80);
  const offset = height * Math.tan(theta * DEG);
  const effective = eta * offset;
  return {
    offset,
    effective,
    /** 左右两侧合计的有效补充宽度 */
    gain: 2 * effective,
    assumed: true, // 侧摆角与折算系数都是假设值，不是官方常数
  };
}

/**
 * 摆拍后的等效覆盖宽度
 * swathEff 只用于解释「这条航带横向能覆盖到多宽的地面」，
 * **不要**直接用 swathEff·(1−o) 解算间距——正确公式见 spacingOf。
 */
export function effectiveSwath({ height, focalEq, frameW = 36, sideTiltDeg = DEFAULT_SIDE_TILT_DEG, eta = DEFAULT_ETA, oblique }) {
  const swath = orthoSwath({ height, focalEq, frameW });
  const g = sideGain({ height, sideTiltDeg, eta, oblique });
  return {
    swath,
    swathEff: swath + g.gain,
    gain: g.gain,
    sideOffset: g.offset,
    sideEffective: g.effective,
    assumed: g.assumed,
  };
}

/**
 * 航线间距（摆拍优化的核心公式）
 *
 *      D = W·(1 − o) + gain
 *
 * 由「总覆盖重叠度 (W − D + gain)/W ≥ o」解出。
 * 不摆拍时 gain = 0，严格退化回 D = W·(1 − o)。
 *
 * @returns {{spacing:number, orthoOverlap:number, swath:number, gain:number}}
 *          orthoOverlap = 正射影像自身的旁向重叠率 = o − gain/W（决定重建能不能成）
 */
export function spacingOf({ height, focalEq, frameW = 36, overlapSide = 0.7, sideTiltDeg = DEFAULT_SIDE_TILT_DEG, eta = DEFAULT_ETA, oblique }) {
  const { swath, gain } = effectiveSwath({ height, focalEq, frameW, sideTiltDeg, eta, oblique });
  const spacing = swath * (1 - overlapSide) + gain;
  const orthoOverlap = 1 - spacing / swath;
  return { spacing, orthoOverlap, swath, gain };
}

/**
 * 摆拍下「用户至少该设多少旁向重叠率」
 *
 * 由 orthoOverlap = o − gain/W ≥ minOrthoSideOverlap 解得：
 *      o_min = minOrthoSideOverlap + gain/W
 *
 * ⚠️ 摆角越大 → gain 越大 → 间距拉得越开 → o_min 反而越高。
 *    这是正确结论：间距拉开了，自然要设更高的名义重叠率才能守住正射底线。
 *    **衡量收益请比较间距，不要看 o_min 的数值大小。**
 */
export function minNominalOverlap({ height, focalEq, frameW = 36, sideTiltDeg = DEFAULT_SIDE_TILT_DEG, eta = DEFAULT_ETA, minOrthoSideOverlap = MIN_ORTHO_SIDE_OVERLAP, oblique }) {
  const { swath, gain } = effectiveSwath({ height, focalEq, frameW, sideTiltDeg, eta, oblique });
  const required = minOrthoSideOverlap + gain / swath;
  // 不可行的含义：侧摆补充量已经超过了保留正射底线所能腾出的全部宽度，
  // 此时「再怎么提高名义重叠率也守不住底线」（o=100% 时间距已等于 gain > 0.7W）。
  // 这代表该摆角/折算组合已超出模型适用范围，**不能静默 clamp**——
  // clamp 会让调用方以为拿到了可用参数，实际却突破重建底线。
  const feasible = required <= 1;
  const minOverlap = clamp(required, 0, 1);
  const at = spacingOf({ height, focalEq, frameW, overlapSide: minOverlap, sideTiltDeg, eta, oblique });
  return {
    minOverlap,
    feasible,
    /** 不可行时给出可读解释 */
    infeasibleReason: feasible ? '' :
      `侧摆角 ${sideTiltDeg}° / 折算 η=${eta} 下，单个航点的横向补充量 ${gain.toFixed(1)} m ` +
      `已超过在正射重叠底线 ${(minOrthoSideOverlap * 100).toFixed(0)}% 下可腾出的宽度 ` +
      `${(swath * (1 - minOrthoSideOverlap)).toFixed(1)} m，` +
      `即使名义重叠率设到 100%，航带间距仍有 ${gain.toFixed(1)} m、正射之间必出现漏拍。` +
      `该摆角已超出本模型的适用范围，需实飞验证或减小摆角。`,
    /** 按该最低值布设时，正射影像自身的重叠率（可行时应恰好等于 minOrthoSideOverlap） */
    orthoOverlapAt: at.orthoOverlap,
    spacing: at.spacing,
    spacingOrtho: swath * (1 - minOrthoSideOverlap),
    swath,
    gain,
  };
}

/** 兼容旧命名 */
export const minSideOverlap = minNominalOverlap;

/**
 * 给定用户设定的旁向重叠率，返回布设结果与安全性判定
 * @returns {{spacing:number, orthoOverlap:number, safe:boolean, reason:string, swath:number, gain:number}}
 */
export function sideLayout({ height, focalEq, frameW = 36, overlapSide = 0.7, sideTiltDeg = DEFAULT_SIDE_TILT_DEG, eta = DEFAULT_ETA, minOrthoSideOverlap = MIN_ORTHO_SIDE_OVERLAP, oblique }) {
  const { spacing, orthoOverlap, swath, gain } = spacingOf({ height, focalEq, frameW, overlapSide, sideTiltDeg, eta, oblique });
  const safe = orthoOverlap >= minOrthoSideOverlap;
  let reason = '';
  if (!safe) {
    reason =
      `旁向重叠率 ${(overlapSide * 100).toFixed(0)}% 在摆拍下解出间距 ${spacing.toFixed(1)} m，` +
      `已使正射影像之间的重叠率降到 ${(orthoOverlap * 100).toFixed(1)}%` +
      `（低于 ${(minOrthoSideOverlap * 100).toFixed(0)}% 底线）。` +
      `侧摆补充的是斜视影像，救不了正射影像之间的漏拍，三维重建会失败。` +
      `请将旁向重叠率提到 ${((minOrthoSideOverlap + gain / swath) * 100).toFixed(0)}% 以上，或减小侧摆角。`;
  }
  return { spacing, orthoOverlap, safe, reason, swath, gain };
}

/**
 * 【摆拍收益的正确度量】在同一「用户设定旁向重叠率」下比较
 *
 * ⚠️ 为什么必须用这种方式比？
 *    正射影像两两之间的重叠率 = 1 − D/W，**只取决于间距 D 与覆盖宽度 W，
 *    与是否摆拍无关**。因此：
 *      · 若用「能把重叠率压到多低」来衡量，两边退化到同一个 D = W(1−floor)，收益恒为 0；
 *      · 真正有意义的问法是：**同样输入 70% 重叠率，能把间距拉开多少？**
 *    摆拍的价值在于：同一个 D 下，斜视影像提供了额外的多视角冗余（交向角更好），
 *    使这个更大的 D 依然可以重建。
 *
 * @returns {{spacingOblique:number, spacingOrtho:number, gainRatio:number,
 *            stripReduction:number, nadirOverlapOblique:number, safe:boolean, assumed:boolean}}
 *          stripReduction = 同等测区宽度下可少飞的航带比例（0.5 = 航带减半）
 */
export function obliqueBenefit({ height, focalEq, frameW = 36, overlapSide = 0.7, sideTiltDeg = DEFAULT_SIDE_TILT_DEG, eta = DEFAULT_ETA, minOrthoSideOverlap = MIN_ORTHO_SIDE_OVERLAP }) {
  const noOb = spacingOf({ height, focalEq, frameW, overlapSide, oblique: OBLIQUE_MODE.OFF });
  const withOb = spacingOf({ height, focalEq, frameW, overlapSide, sideTiltDeg, eta, oblique: OBLIQUE_MODE.ORTHO3 });
  return {
    spacingOrtho: noOb.spacing,
    spacingOblique: withOb.spacing,
    /** 间距放大倍数 */
    gainRatio: noOb.spacing > 0 ? withOb.spacing / noOb.spacing : 0,
    /** 航带数减少比例：1 − D₀/D */
    stripReduction: withOb.spacing > 0 ? 1 - noOb.spacing / withOb.spacing : 0,
    /** 摆拍后正射影像自身的重叠率——这才是重建安不安全的判据 */
    nadirOverlapOblique: withOb.orthoOverlap,
    safe: withOb.orthoOverlap >= minOrthoSideOverlap,
    swath: withOb.swath,
    assumed: true, // 摆角与 η 均为假设值，收益区间会随之变化
  };
}

/**
 * 5 向倾斜摆拍（smart5）相对传统 5 条倾斜航线的收益
 *
 * @param {{lengthPerPass:number, passCount:number, speed:number, speedFactor?:number}} p
 *        lengthPerPass 单条航线覆盖测区的里程；passCount 传统倾斜的航线数（通常 5）
 *        speedFactor 摆拍时因摆动/多拍导致的平均速度折扣（保守取 0.6，官方未给）
 * @returns {{lengthSaving:number, lengthRatio:number, timeTraditional:number, timeOblique:number, assumed:boolean}}
 */
export function smart5Saving({ lengthPerPass = 0, passCount = 5, speed = 10, speedFactor = 0.6 }) {
  const traditional = lengthPerPass * passCount;
  const oblique = lengthPerPass; // 摆拍只需 1 条
  const lengthSaving = traditional - oblique;
  // 时长：摆拍里程短但速度慢
  const timeTraditional = traditional / speed;
  const timeOblique = oblique / (speed * speedFactor);
  return {
    lengthTraditional: traditional,
    lengthOblique: oblique,
    lengthSaving,
    lengthRatio: traditional > 0 ? oblique / traditional : 0,
    timeTraditional,
    timeOblique,
    assumed: true, // speedFactor 是假设值
  };
}
