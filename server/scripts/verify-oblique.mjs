/**
 * 机型镜头适配 + 摆拍模型的理论验证
 *
 * 验证的不是「能不能跑」，而是**推导是否自洽、边界是否守得住**：
 *   ① 机型匹配：已知 key 必须精确命中，未知机型必须回落到保守值并告警
 *   ② 传感器差异：同航高下不同机型 GSD 必须不同（证明机型适配不是摆设）
 *   ③ GSD ↔ 航高 往返一致
 *   ④ 摆拍几何：不摆拍时模型必须**严格退化**回普通正射（不能偷偷改基线）
 *   ⑤ 数学自洽：按 minOverlap 布设时，正射影像自身重叠率必须恰好等于设定的下限
 *   ⑥ 单调性：侧摆角越大收益越大；折算系数越保守收益越小
 *   ⑦ 安全边界：过度压低重叠率必须被判为 unsafe，且给出可读原因
 *   ⑧ 机型门禁：不支持摆拍的机型（Mavic 3T）必须被拦下
 *
 * 纯数学，不需要任何凭据。用法：node server/scripts/verify-oblique.mjs
 */
import { lensProfileFor, availableLensKeys, checkOblique, OBLIQUE_MODE, AIRCRAFT_LENS } from '../src/modules/wayline/aircraftLens.js';
import {
  orthoSwath, effectiveSwath, minSideOverlap, sideLayout, smart5Saving, obliqueBenefit,
  DEFAULT_ETA, MIN_ORTHO_SIDE_OVERLAP, DEFAULT_SIDE_TILT_DEG,
} from '../src/modules/wayline/obliqueModel.js';
import { heightFromGsd, gsdFromHeight, SENSOR } from '../src/modules/wayline/cameraGeometry.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};
const info = (s) => console.log(`  · ${s}`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const FRAME_W = 36; // 35mm 等效画幅宽（与 cameraGeometry 的 SENSOR.frameW 一致）

console.log('=== 机型镜头适配 + 摆拍模型 理论验证 ===\n');

/* ---------------- ① 机型匹配 ---------------- */
console.log('[1] 机型匹配');
{
  const m4td = lensProfileFor({ key: '0-100-1', name: 'Matrice 4TD' });
  ok('0-100-1 精确命中 Matrice 4TD', m4td.matchedBy === 'key' && m4td.profile.names.includes('Matrice 4TD'),
    `matchedBy=${m4td.matchedBy}`);
  ok('M4TD 广角像素为 8064×6048（4800 万）', m4td.profile.sensor.imageW === 8064, `${m4td.profile.sensor.imageW}×${m4td.profile.sensor.imageH}`);

  const m4e = lensProfileFor({ key: '0-100-9', name: 'Matrice 4E' });
  ok('未知 key 能按名称命中 Matrice 4E', m4e.matchedBy === 'name' && m4e.profile.names.includes('Matrice 4E'));
  ok('M4E 广角像素为 5280×3956（4/3" 2000 万）', m4e.profile.sensor.imageW === 5280, `${m4e.profile.sensor.imageW}×${m4e.profile.sensor.imageH}`);

  const unknown = lensProfileFor({ key: '9-999-9', name: '不存在的机型' });
  ok('未知机型回落到保守配置', unknown.matchedBy === 'fallback');
  ok('未知机型必须给出告警', unknown.warnings.length > 0, unknown.warnings[0]?.slice(0, 40) + '…');

  const keys = availableLensKeys(m4td.profile);
  ok('M4TD 可用镜头位含 4 个（含红外）', keys.length === 4, keys.join(','));
}

/* ---------------- ② 传感器差异（证明机型适配不是摆设） ---------------- */
console.log('\n[2] 传感器差异：同航高下 GSD 必须不同');
{
  const H = 100;
  const gsd = (imageW, focalEq = 24) => gsdFromHeight({ height: H, focalEq, frameW: FRAME_W, imageW });
  const g4td = gsd(8064); // M4TD 广角 4800 万
  const g4e = gsd(5280);  // M4E 广角 2000 万
  info(`H=100m 广角24mm：M4TD(48MP) GSD=${g4td.toFixed(2)}cm，M4E(20MP) GSD=${g4e.toFixed(2)}cm`);
  ok('两种传感器的 GSD 不同（机型适配确实影响结果）', Math.abs(g4td - g4e) > 0.1,
    `差 ${Math.abs(g4td - g4e).toFixed(2)} cm`);
  ok('像素越多 GSD 越小（更精细）', g4td < g4e, `${g4td.toFixed(2)} < ${g4e.toFixed(2)}`);

  // 若沿用旧代码写死的 8064，M4E 会被算错
  const wrong = gsdFromHeight({ height: H, focalEq: 24, frameW: FRAME_W, imageW: SENSOR.imageW });
  info(`旧代码写死 imageW=${SENSOR.imageW} 时，M4E 会被算成 ${wrong.toFixed(2)}cm（与真实 ${g4e.toFixed(2)}cm 偏差 ${(((wrong - g4e) / g4e) * 100).toFixed(1)}%）`);
  ok('证明写死单一传感器会算错其它机型', Math.abs(wrong - g4e) > 0.1);
}

/* ---------------- ③ GSD ↔ 航高 往返一致 ---------------- */
console.log('\n[3] GSD ↔ 航高 往返一致性');
{
  for (const [name, imageW] of [['M4TD', 8064], ['M4E', 5280]]) {
    for (const gsdCm of [1, 1.5, 2.7, 5]) {
      const h = heightFromGsd({ gsdCm, focalEq: 24, frameW: FRAME_W, imageW });
      const back = gsdFromHeight({ height: h, focalEq: 24, frameW: FRAME_W, imageW });
      ok(`${name} GSD=${gsdCm}cm → H=${h.toFixed(1)}m → 回到 ${back.toFixed(2)}cm`, near(back, gsdCm, 1e-6));
    }
  }
}

/* ---------------- ④ 摆拍几何：不摆拍时必须严格退化 ---------------- */
console.log('\n[4] 不摆拍时模型严格退化回普通正射');
{
  const args = { height: 120, focalEq: 24, frameW: FRAME_W };
  const base = orthoSwath(args);
  const off = effectiveSwath({ ...args, oblique: OBLIQUE_MODE.OFF });
  const smart5 = effectiveSwath({ ...args, oblique: OBLIQUE_MODE.SMART5 });
  ok('关闭摆拍：等效覆盖 == 正射覆盖', near(off.swathEff, base), `${off.swathEff.toFixed(4)} m`);
  ok('5 向倾斜摆拍不改变覆盖宽度（它改的是航线条数，不是间距）', near(smart5.swathEff, base));
  ok('关闭摆拍：侧摆扩展为 0', off.sideEffective === 0);

  const o3 = effectiveSwath({ ...args, oblique: OBLIQUE_MODE.ORTHO3 });
  ok('3 向正射摆拍：等效覆盖大于正射覆盖', o3.swathEff > base, `${o3.swathEff.toFixed(2)} > ${base.toFixed(2)} m`);
  ok('侧摆偏移为 H·tan(θ) 的理论值',
    near(o3.sideOffset, 120 * Math.tan(DEFAULT_SIDE_TILT_DEG * Math.PI / 180), 1e-9),
    `${o3.sideOffset.toFixed(3)} m`);
  ok('有效扩展 = η × 偏移（有折扣）',
    near(o3.sideEffective, DEFAULT_ETA * o3.sideOffset, 1e-9),
    `η=${DEFAULT_ETA}`);
}

/* ---------------- ⑤ 数学自洽 + 适用性边界 ---------------- */
console.log('\n[5] 数学自洽：按最低重叠率布设时，正射重叠率恰好等于重建下限');
{
  let feasibleCount = 0;
  for (const tilt of [10, 20, 30, 45]) {
    for (const eta of [0.4, 0.6, 0.8]) {
      const m = minSideOverlap({
        height: 120, focalEq: 24, frameW: FRAME_W,
        sideTiltDeg: tilt, eta,
        minOrthoSideOverlap: MIN_ORTHO_SIDE_OVERLAP,
        oblique: OBLIQUE_MODE.ORTHO3,
      });
      if (!m.feasible) {
        ok(`θ=${tilt}° η=${eta}: 超出适用范围时必须标记为不可行`,
          m.feasible === false && m.infeasibleReason.length > 30,
          `要求的名义重叠率 ${(m.minOverlap * 100).toFixed(0)}% 已不可能`);
        continue;
      }
      feasibleCount += 1;
      ok(`θ=${tilt}° η=${eta}: 正射重叠率 == ${(MIN_ORTHO_SIDE_OVERLAP * 100).toFixed(0)}%`,
        near(m.orthoOverlapAt, MIN_ORTHO_SIDE_OVERLAP, 1e-9),
        `实得 ${(m.orthoOverlapAt * 100).toFixed(4)}%，最低可设 ${(m.minOverlap * 100).toFixed(1)}%`);
    }
  }
  info(`12 组摆角×折算组合中，${feasibleCount} 组在本模型适用范围内，${12 - feasibleCount} 组因摆角过大被判不可行`);

  // 可行/不可行的分界必须严格落在 required == 1 处，不能靠 clamp 蒙混过关
  const boundary = minSideOverlap({
    height: 120, focalEq: 24, frameW: FRAME_W, sideTiltDeg: 45, eta: 0.6,
    oblique: OBLIQUE_MODE.ORTHO3,
  });
  ok('不可行配置仍如实报告（不做静默钳制）', boundary.feasible === false);
  ok('不可行时正射重叠率确实低于底线（证明不钳制后才暴露）',
    boundary.orthoOverlapAt < MIN_ORTHO_SIDE_OVERLAP,
    `${(boundary.orthoOverlapAt * 100).toFixed(1)}% < ${(MIN_ORTHO_SIDE_OVERLAP * 100).toFixed(0)}%`);
}

/* ---------------- ⑤b 收益的正确度量（关键） ---------------- */
console.log('\n[5b] 收益的正确度量：在同一设定重叠率下比较间距');
{
  // ⚠️ 正射两两重叠率 = 1 − D/W，只取决于 D 与 W，与是否摆拍无关。
  //    所以「能把重叠率压到多低」是无效问题（两边都退化到 D = W·(1−floor)）。
  //    正确的问法：同样输入 70% 重叠率，间距能拉开多少？
  const b70 = obliqueBenefit({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.7 });
  ok('o=70% 时摆拍间距显著大于不摆拍', b70.spacingOblique > b70.spacingOrtho,
    `${b70.spacingOrtho.toFixed(1)} → ${b70.spacingOblique.toFixed(1)} m（×${b70.gainRatio.toFixed(2)}）`);
  ok('o=70% 时仍守住重建底线（这才是真可用的收益）', b70.safe,
    `正射重叠 ${(b70.nadirOverlapOblique * 100).toFixed(1)}% ≥ ${(MIN_ORTHO_SIDE_OVERLAP * 100).toFixed(0)}%`);
  ok('航带数确实减少', b70.stripReduction > 0,
    `少飞 ${(b70.stripReduction * 100).toFixed(1)}% 的航带`);
  info(`默认参数（θ=${DEFAULT_SIDE_TILT_DEG}° η=${DEFAULT_ETA}）：间距 ${b70.spacingOrtho.toFixed(1)} → ${b70.spacingOblique.toFixed(1)} m，` +
    `航带减少 ${(b70.stripReduction * 100).toFixed(1)}%，正射重叠落在 ${(b70.nadirOverlapOblique * 100).toFixed(1)}%`);

  // 压到最低可接受值时，摆拍与不摆拍必须退化到同一个间距——这是几何的必然，不是 bug
  const atFloor = minSideOverlap({ height: 120, focalEq: 24, frameW: FRAME_W, oblique: OBLIQUE_MODE.ORTHO3 });
  ok('压到重建底线时，摆拍与不摆拍间距必然相同（证明收益不来自这里）',
    near(atFloor.spacing, atFloor.spacingOrtho, 1e-9),
    `均为 ${atFloor.spacing.toFixed(1)} m`);

  // 敏感度：收益随摆角/折算系数变化很大，必须给出区间而不是单点
  const rows = [];
  for (const tilt of [10, 20, 30]) {
    for (const eta of [0.4, 0.6, 0.8]) {
      const b = obliqueBenefit({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.7, sideTiltDeg: tilt, eta });
      rows.push({ tilt, eta, ratio: b.gainRatio, nadir: b.nadirOverlapOblique, safe: b.safe });
    }
  }
  const ratios = rows.map((r) => r.ratio);
  info(`敏感度：同一 70% 重叠率下，间距放大倍数随假设在 ${Math.min(...ratios).toFixed(2)}–${Math.max(...ratios).toFixed(2)} 倍之间`);
  ok('收益对假设高度敏感 → 结论必须标 assumed，不能给单点承诺',
    Math.max(...ratios) / Math.min(...ratios) > 1.5,
    `最大/最小 = ${(Math.max(...ratios) / Math.min(...ratios)).toFixed(2)} 倍`);
}

/* ---------------- ⑥ 单调性（按正确的度量方式） ---------------- */
console.log('\n[6] 单调性：摆角越大越省，折算越保守越不省');
{
  // 在**固定的名义重叠率**下比较间距——这才是收益
  const at = (tilt) => obliqueBenefit({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.7, sideTiltDeg: tilt });
  const a = at(10), b = at(20), c = at(30);
  ok('摆角越大，同一重叠率下的间距越大', a.spacingOblique < b.spacingOblique && b.spacingOblique < c.spacingOblique,
    `${a.spacingOblique.toFixed(1)} < ${b.spacingOblique.toFixed(1)} < ${c.spacingOblique.toFixed(1)} m`);
  ok('摆角越大越危险（正射重叠被摊薄）', a.nadirOverlapOblique > b.nadirOverlapOblique && b.nadirOverlapOblique > c.nadirOverlapOblique,
    `${(a.nadirOverlapOblique * 100).toFixed(1)}% > ${(b.nadirOverlapOblique * 100).toFixed(1)}% > ${(c.nadirOverlapOblique * 100).toFixed(1)}%`);
  ok('收益与安全必须同时权衡：大摆角会跌破底线', a.safe && b.safe && !c.safe,
    `θ=10°,20° 安全，θ=30° 已跌到 ${(c.nadirOverlapOblique * 100).toFixed(1)}%`);

  const byEta = (eta) => obliqueBenefit({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.7, eta });
  const e1 = byEta(0.3), e2 = byEta(0.9);
  ok('折算越保守（η 小），收益越小', e1.spacingOblique < e2.spacingOblique,
    `η=0.3 → ${e1.spacingOblique.toFixed(1)} m，η=0.9 → ${e2.spacingOblique.toFixed(1)} m`);

  const zero = obliqueBenefit({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.7, sideTiltDeg: 0 });
  ok('摆角为 0 时没有任何收益（严格退化）', near(zero.spacingOblique, zero.spacingOrtho, 1e-9),
    `${zero.spacingOblique.toFixed(1)} == ${zero.spacingOrtho.toFixed(1)} m`);

  // 收益与安全是一对矛盾：摆角越大越省，但正射重叠被摊薄到重建底线以下就没意义了。
  // 这个 elbow point 才是工程上真正要给出的东西。
  const sweepTilt = (tilt) => obliqueBenefit({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.7, sideTiltDeg: tilt });
  let maxSafeTilt = 0;
  for (let t = 1; t <= 60; t += 0.5) {
    if (sweepTilt(t).safe) maxSafeTilt = t; else break;
  }
  ok('存在一个最大可用摆角：超过它即使省钱也不能飞（安全包线）',
    maxSafeTilt > 0 && maxSafeTilt < 45,
    `o=70% / η=${DEFAULT_ETA} 下最大摆角 ≈ ${maxSafeTilt.toFixed(1)}°`);
  ok('超出最大摆角时模型如实判为不安全', !sweepTilt(maxSafeTilt + 5).safe,
    `θ=${(maxSafeTilt + 5).toFixed(1)}° 时正射重叠 ${(sweepTilt(maxSafeTilt + 5).nadirOverlapOblique * 100).toFixed(1)}%`);

  // 提高重叠率可以把大摆角拉回安全区——这给规划器一条可用的补救路径
  const rescued = obliqueBenefit({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.8, sideTiltDeg: maxSafeTilt + 5 });
  ok('提高重叠率可将大摆角拉回安全区（给规划器的补救路径）', rescued.safe,
    `θ=${(maxSafeTilt + 5).toFixed(1)}° + o=80% → 正射重叠 ${(rescued.nadirOverlapOblique * 100).toFixed(1)}%`);
  info(`适用包线：o=70% 时摆角上限 ${maxSafeTilt.toFixed(1)}°；` +
    `再想加大摆角必须同步提高重叠率（补救示例：o=80% 可支撑 ${(maxSafeTilt + 5).toFixed(1)}°）`);
}

/* ---------------- ⑦ 安全边界 ---------------- */
console.log('\n[7] 安全边界：过度压低重叠率必须被拦下');
{
  const safe = sideLayout({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.7, oblique: OBLIQUE_MODE.ORTHO3 });
  ok('70% 旁向 + 摆拍：判定安全', safe.safe, `正射重叠 ${(safe.orthoOverlap * 100).toFixed(1)}%`);

  const danger = sideLayout({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.2, oblique: OBLIQUE_MODE.ORTHO3 });
  ok('20% 旁向 + 摆拍：判定不安全', !danger.safe, `正射重叠 ${(danger.orthoOverlap * 100).toFixed(1)}%`);
  ok('不安全时给出可读原因', danger.reason.length > 20, danger.reason.slice(0, 46) + '…');

  // 同样的 20%：摆拍时间距更大 → 正射重叠更低 → **更危险**（侧摆补充救不了漏拍）
  const danger2 = sideLayout({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: 0.2, oblique: OBLIQUE_MODE.OFF });
  ok('同一重叠率下摆拍更危险（间距更大），这正是必须查正射重叠的原因',
    !danger2.safe && danger.orthoOverlap < danger2.orthoOverlap,
    `摆拍 ${(danger.orthoOverlap * 100).toFixed(1)}% < 不摆拍 ${(danger2.orthoOverlap * 100).toFixed(1)}%`);

  const sameOverlap = 0.7;
  const noOb = sideLayout({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: sameOverlap, oblique: OBLIQUE_MODE.OFF });
  const withOb = sideLayout({ height: 120, focalEq: 24, frameW: FRAME_W, overlapSide: sameOverlap, oblique: OBLIQUE_MODE.ORTHO3 });
  ok('同一重叠率下，摆拍的航线间距更大（这是省航带的来源）', withOb.spacing > noOb.spacing,
    `${withOb.spacing.toFixed(1)} > ${noOb.spacing.toFixed(1)} m`);
  ok('但摆拍的正射重叠率更低（必须在安全线内）', withOb.orthoOverlap < noOb.orthoOverlap && withOb.safe,
    `${(withOb.orthoOverlap * 100).toFixed(1)}% < ${(noOb.orthoOverlap * 100).toFixed(1)}%`);
}

/* ---------------- ⑧ 机型门禁 ---------------- */
console.log('\n[8] 机型摆拍能力门禁');
{
  const m3t = lensProfileFor({ name: 'Mavic 3T' }).profile;
  const r5 = checkOblique(m3t, OBLIQUE_MODE.SMART5);
  ok('Mavic 3T 的 5 向摆拍被拦下（官方明确不支持）', !r5.ok, r5.message.slice(0, 50) + '…');

  const m4td = lensProfileFor({ key: '0-100-1', name: 'Matrice 4TD' }).profile;
  ok('M4TD 允许 5 向倾斜摆拍', checkOblique(m4td, OBLIQUE_MODE.SMART5).ok);
  ok('M4TD 不允许 3 向正射摆拍', !checkOblique(m4td, OBLIQUE_MODE.ORTHO3).ok);

  const m4e = lensProfileFor({ name: 'Matrice 4E' }).profile;
  ok('M4E 允许 3 向正射摆拍', checkOblique(m4e, OBLIQUE_MODE.ORTHO3).ok);
  ok('M4E 允许 5 向倾斜摆拍', checkOblique(m4e, OBLIQUE_MODE.SMART5).ok);

  const unknown = lensProfileFor({ name: '不存在机型' }).profile;
  ok('未知机型的摆拍被拦下（能力不明按不支持）', !checkOblique(unknown, OBLIQUE_MODE.SMART5).ok);
  ok('关闭摆拍对所有机型都放行', checkOblique(m3t, OBLIQUE_MODE.OFF).ok);

  // 未核实的机型不能共享「已核实机型」的摆拍绿灯
  const m4d = lensProfileFor({ name: 'Matrice 4D' }).profile;
  ok('M4D 的 3 向正射摆拍按未核实处理（不放行）', !checkOblique(m4d, OBLIQUE_MODE.ORTHO3).ok,
    checkOblique(m4d, OBLIQUE_MODE.ORTHO3).message.slice(0, 40) + '…');
  ok('M4D 的 5 向倾斜摆拍仍可用（官方口径覆盖整个 M4 系列）', checkOblique(m4d, OBLIQUE_MODE.SMART5).ok);
}

/* ---------------- ⑧b 机型名匹配的陷阱 ---------------- */
console.log('\n[8b] 机型名匹配：缩写前缀不得串到其它机型');
{
  // M4T ⊂ M4TD，但两者传感器不同（2000 万 vs 4800 万）。
  // 串了会得到看起来正常、实则偏差 30%+ 的 GSD——这类错误最难发现。
  const r1 = lensProfileFor({ name: 'M4TD' });
  const r2 = lensProfileFor({ name: 'M4T' });
  ok('M4TD 命中 4800 万配置', r1.profile.sensor.imageW === 8064, `${r1.profile.names[0]}`);
  ok('M4T 不能被 M4TD 抢走（必须命中 2000 万配置）',
    r2.profile.sensor.imageW === 5280 && r2.profile.names.includes('M4T'),
    `命中 ${r2.profile.names[0]}，${r2.profile.sensor.imageW} px`);
  ok('两者 GSD 不同，证明串匹配的后果是实打实的算错',
    r1.profile.sensor.imageW !== r2.profile.sensor.imageW,
    `${r1.profile.sensor.imageW} vs ${r2.profile.sensor.imageW} px`);

  // 完全名必须精确命中：不能用包含匹配抽查过去
  ok('Matrice 4TD 全称精确命中自身', lensProfileFor({ name: 'Matrice 4TD' }).profile.names.includes('Matrice 4TD'));
  ok('Matrice 4E 全称精确命中自身', lensProfileFor({ name: 'Matrice 4E' }).profile.names.includes('Matrice 4E'));
  ok('M30 不能落到 M30T 以外的机型', lensProfileFor({ name: 'M30' }).profile.names.includes('M30'));
  ok('空机型名不抛错', lensProfileFor({ name: '' }).matchedBy === 'fallback');
}

/* ---------------- ⑨ 5 向摆拍的收益量级 ---------------- */
console.log('\n[9] 5 向倾斜摆拍的收益（含速度折扣，不照搬厂商宣传值）');
{
  const s = smart5Saving({ lengthPerPass: 5000, passCount: 5, speed: 12 });
  info(`单条 ${5000} m × 5 条 = ${s.lengthTraditional} m；摆拍 ${s.lengthOblique} m`);
  ok('里程降为 1/5', near(s.lengthRatio, 0.2, 1e-9), `${(s.lengthRatio * 100).toFixed(0)}%`);
  ok('时长节省小于里程节省（因摆动降速）', s.timeOblique < s.timeTraditional && s.timeOblique / s.timeTraditional > s.lengthRatio,
    `里程 ${(s.lengthRatio * 100).toFixed(0)}% vs 时长 ${((s.timeOblique / s.timeTraditional) * 100).toFixed(0)}%`);
  info(`时长：传统 ${(s.timeTraditional / 60).toFixed(1)} 分钟 → 摆拍 ${(s.timeOblique / 60).toFixed(1)} 分钟（速度折扣已计入）`);
  ok('结果标注为假设值（不冒充官方数据）', s.assumed === true);
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
console.log(`机型库共 ${AIRCRAFT_LENS.length} 个条目（其中 key 经实测确认的 ${AIRCRAFT_LENS.filter((p) => p.verified).length} 个）`);
process.exit(fail === 0 ? 0 : 1);
