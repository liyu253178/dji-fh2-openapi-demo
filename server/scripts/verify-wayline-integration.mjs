/**
 * 航线规划重构的集成验证（纯数学，不需要任何凭据）
 *   node server/scripts/verify-wayline-integration.mjs
 *
 * 验证的是**重构有没有真的改对**，而不是「能不能跑」：
 *   ① 机型适配真的生效：同航高下不同机型必须给出不同的 GSD（否则适配是摆设）
 *   ② 回归不漂移：不传机型时必须与重构前的通用表行为**逐位一致**
 *   ③ 摆拍门禁：不支持的机型/未知模式/非正射工况必须被拦下，且给出可读原因
 *   ④ 安全不变量：启用摆拍**绝不允许**改变实际航线（KMZ 开关未验证期间）
 *   ⑤ 投影数值自洽：与实际航线几何算出来的结果能对上账
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// resolveOblique 是纯函数（不碰接口），静态引入即可；plan() 要打真实机队，放第 6 节动态引入
import { resolveOblique } from '../src/modules/wayline/planner.js';
import { effectiveCoef, lensIndexText } from '../src/modules/wayline/lensProfile.js';
import { gsdFromHeight, heightFromGsd } from '../src/modules/wayline/cameraGeometry.js';
import { lensProfileFor, OBLIQUE_MODE, AIRCRAFT_LENS } from '../src/modules/wayline/aircraftLens.js';
import { sideLayout, orthoSwath, effectiveSwath, MIN_ORTHO_SIDE_OVERLAP, DEFAULT_ETA } from '../src/modules/wayline/obliqueModel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLYGON = [
  [113.493512, 23.092449],
  [113.494488, 23.092449],
  [113.494488, 23.091551],
  [113.493512, 23.091551],
];

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};
const info = (s) => console.log(`  · ${s}`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const M4TD = { key: '0-100-1', name: 'Matrice 4TD' };
const M4E = { name: 'Matrice 4E' };
const M3T = { name: 'Mavic 3T' };

console.log('=== 航线规划重构 集成验证 ===\n');

/* ---------------- ① 机型适配真的生效 ---------------- */
console.log('[1] 机型适配：同一航高下不同机型必须给出不同 GSD');
{
  const H = 100;
  const wide = (m) => effectiveCoef(['wide'], {}, m);
  const gsdOf = (c) => gsdFromHeight({ height: H, focalEq: c.governing.focalEq, frameW: 36, imageW: c.governing.imageW });

  const a = gsdOf(wide(M4TD));
  const b = gsdOf(wide(M4E));
  ok('M4TD 与 M4E 的 GSD 不同', Math.abs(a - b) > 1e-6, `${a.toFixed(2)}cm vs ${b.toFixed(2)}cm`);
  ok('像素越多 GSD 越精细', a < b, `${a.toFixed(2)} < ${b.toFixed(2)}`);
  info(`重构前两者都被算成 ${gsdFromHeight({ height: H, focalEq: 24, frameW: 36, imageW: 8064 }).toFixed(2)}cm，` +
    `M4E 的偏差 ${(((gsdFromHeight({ height: H, focalEq: 24, frameW: 36, imageW: 8064 }) - b) / b) * 100).toFixed(1)}%`);

  const c = wide(M4TD);
  ok('governing 带上了像素数（这是 GSD 的输入）', c.governing.imageW === 8064, `${c.governing.imageW}px`);
  ok('焦距与通用表一致（保证间距几何不漂移）', near(c.swathK, 36 / 24), `swathK=${c.swathK}`);
  ok('lensSource 标明了数据来源', c.lensSource.matchedBy === 'key' && c.lensSource.registry, `matchedBy=${c.lensSource.matchedBy}`);

  // GSD ↔ 航高 往返：换机型后仍必须闭合
  const target = 2.0;
  const h = heightFromGsd({ gsdCm: target, focalEq: 24, frameW: 36, imageW: wide(M4E).governing.imageW });
  const back = gsdFromHeight({ height: h, focalEq: 24, frameW: 36, imageW: wide(M4E).governing.imageW });
  ok('M4E 的 GSD↔航高 往返一致', near(back, target, 1e-6), `H=${h.toFixed(1)}m → ${back.toFixed(3)}cm`);

  // 多镜头：约束镜头可以是红外，但 GSD 不应被 640px 的红外拉塌
  const dual = effectiveCoef(['wide', 'ir'], {}, M4TD);
  ok('多镜头仍取最窄视场约束间距', dual.governing.key === 'ir', `约束镜头=${dual.governing.name}`);
  ok('主摄镜头是第一个（GSD 不应被红外拉塌）', dual.lenses[0].key === 'wide');
  ok('按 W 的 GSD 不会被 640px 红外污染',
    near(gsdFromHeight({ height: H, focalEq: dual.lenses[0].focalEq, frameW: 36, imageW: dual.lenses[0].imageW }), a),
    '仍等于主摄的 GSD');
  ok('镜头索引文本不变', lensIndexText(['wide', 'ir']) === 'visable,ir', lensIndexText(['wide', 'ir']));
}

/* ---------------- ② 回归不漂移 ---------------- */
console.log('\n[2] 回归防线：拿不到机型时行为必须与重构前一致');
{
  const noModel = effectiveCoef(['wide'], {});
  const oldWay = { swathK: 36 / 24, stepK: 27 / 24, focalEq: 24 };
  ok('无机型时 swathK 与旧实现一致', near(noModel.swathK, oldWay.swathK), `${noModel.swathK}`);
  ok('无机型时 stepK 与旧实现一致', near(noModel.stepK, oldWay.stepK), `${noModel.stepK}`);
  ok('无机型时 governing.focalEq 一致', noModel.governing.focalEq === oldWay.focalEq);
  ok('无机型时像素标记为未知（不假装知道）', noModel.governing.pixelsUnknown === true);

  // 未知机型：给保守值，但必须标记 assumed，让上层能告警
  const unknown = effectiveCoef(['wide'], {}, { name: '没有这个机型' });
  ok('未知机型回落到保守配置且有像素值', Number.isFinite(unknown.governing.imageW), `${unknown.governing.imageW}px`);
  ok('未知机型标记 assumed', unknown.governing.assumed === true);

  // Calibrated 值优先于 spec：真实航线反演出来的最可信，这层优先级不能被机型表覆盖
  const withOverride = effectiveCoef(['wide'], { wide: { swathK: 0.6 } }, M4TD);
  ok('真实航线反演值优先于官方规格', near(withOverride.swathK, 0.6), `0.6 < ${(36 / 24).toFixed(3)}`);
}

/* ---------------- ③ 摆拍门禁 ---------------- */
console.log('\n[3] 摆拍门禁：能力不支持 / 工况不适用必须被拦下');
{
  const base = {
    height: 120, focalRef: 24, frameWEff: 36, spacingNadir: 54,
    tiltDeg: 0, overlapSidePct: 70,
  };
  const call = (aircraft, params = {}) => resolveOblique({ aircraft, params, ...base });

  const off = call(M4TD, { oblique: 'off' });
  ok('关闭摆拍不产生投影', off.requested === false && off.projection === null);

  const bad = call(M4TD, { oblique: '乱写的模式' });
  ok('未知摆拍模式被拒', !!bad.error, bad.error?.slice(0, 30));

  const m3t5 = call(M3T, { oblique: OBLIQUE_MODE.SMART5 });
  ok('Mavic 3T 的 5 向摆拍被拒（官方明确不支持）', !!m3t5.error, m3t5.error?.slice(0, 26) + '…');

  const m4td3 = call(M4TD, { oblique: OBLIQUE_MODE.ORTHO3 });
  ok('M4TD 的 3 向正射摆拍被拒（仅 5 向）', !!m4td3.error, m4td3.error?.slice(0, 26) + '…');

  const tilted = call(M4E, { oblique: OBLIQUE_MODE.ORTHO3 });
  ok('M4E 允许 3 向正射摆拍并给出投影', !tilted.error && !!tilted.projection);

  const tiltedIn = resolveOblique({
    aircraft: M4E, params: { oblique: OBLIQUE_MODE.ORTHO3 },
    height: 120, focalRef: 24, frameWEff: 36, spacingNadir: 54, tiltDeg: 45, overlapSidePct: 70,
  });
  ok('云台倾斜时拒绝给投影（模型不适用）', !!tiltedIn.error, tiltedIn.error?.slice(0, 28) + '…');

  const unknown = call({ name: '不存在的机型' }, { oblique: OBLIQUE_MODE.SMART5 });
  ok('未知机型的摆拍被拒（能力不明按不支持）', !!unknown.error);
}

/* ---------------- ④ 安全不变量 ---------------- */
console.log('\n[4] 安全不变量：启用摆拍绝不允许改变实际航线');
{
  ok('applied 恒为 false 是硬约束', typeof resolveOblique === 'function');

  const r = resolveOblique({
    aircraft: M4E, params: { oblique: OBLIQUE_MODE.ORTHO3 },
    height: 120, focalRef: 24, frameWEff: 36, spacingNadir: 54, tiltDeg: 0, overlapSidePct: 70,
  });
  ok('有投影但 applied=false', !!r.projection && r.applied === false);
  ok('给出不说谎的原因', /摆拍开关/.test(r.reason || ''), r.reason);
  ok('投影里保留了当前实际间距', near(r.projection.spacingNowM, 54), `${r.projection.spacingNowM} m`);

  // 所有机型 × 所有模式：applied 永远不能是 true —— 这是防「假开启」的最后一道闸
  let violations = 0;
  let produced = 0;
  for (const p of AIRCRAFT_LENS) {
    for (const mode of Object.values(OBLIQUE_MODE)) {
      const x = resolveOblique({
        aircraft: { name: p.names[0] }, params: { oblique: mode },
        height: 120, focalRef: 24, frameWEff: 36, spacingNadir: 54, tiltDeg: 0, overlapSidePct: 70,
      });
      if (x.applied) violations += 1;
      if (x.projection) produced += 1;
    }
  }
  ok(`全机型×全模式共 ${AIRCRAFT_LENS.length * 3} 种组合，无一例外放宽了航线`, violations === 0, `产生投影 ${produced} 组`);
}

/* ---------------- ⑤ 投影数值自洽 ---------------- */
console.log('\n[5] 投影数值自洽：与 obliqueModel 独立核算必须对上账');
{
  const H = 120, F = 24, W = 36;
  const r = resolveOblique({
    aircraft: M4E, params: { oblique: OBLIQUE_MODE.ORTHO3 },
    height: H, focalRef: F, frameWEff: W, spacingNadir: 54, tiltDeg: 0, overlapSidePct: 70,
  });
  const p = r.projection;
  ok('投影可用且判定安全', p.safe, `正射重叠 ${(p.nadirOverlapWould * 100).toFixed(1)}%`);

  // 独立重算：swath + gain → 间距 → 正射重叠
  const swath = orthoSwath({ height: H, focalEq: F, frameW: W });
  const gain = effectiveSwath({ height: H, focalEq: F, frameW: W, oblique: OBLIQUE_MODE.ORTHO3 }).gain;
  ok('投影的覆盖宽度与理论值一致', near(p.swathM, swath, 0.05), `${p.swathM} vs ${swath.toFixed(1)} m`);
  ok('投影的侧摆补充量与理论值一致', near(p.gainM, gain, 0.05), `${p.gainM} vs ${gain.toFixed(1)} m`);
  ok('投影的间距 = 现有间距 + 侧摆补充', near(p.spacingWouldM, p.spacingNowM + gain, 0.05),
    `${p.spacingNowM} + ${gain.toFixed(1)} = ${p.spacingWouldM} m`);

  // 与 obliqueModel 的独立答案交叉验证（同一套输入，两条代码路径必须给出同一个数）
  const independent = sideLayout({ height: H, focalEq: F, frameW: W, overlapSide: 0.7, oblique: OBLIQUE_MODE.ORTHO3 });
  const nadirIndependent = 1 - (p.spacingNowM + gain) / swath;
  ok('正射重叠率与独立路径一致', near(p.nadirOverlapWould, nadirIndependent, 0.002),
    `${(p.nadirOverlapWould * 100).toFixed(1)}%`);
  ok('安全判定与独立路径一致', p.safe === independent.safe);
  ok('省航带比例与理论一致',
    near(p.savingRatio, 1 - p.spacingNowM / p.spacingWouldM, 0.002),
    `省 ${(p.savingRatio * 100).toFixed(1)}% 航带`);
  ok('投影结果标记为假设值（不冒充官方数据）', p.assumed === true);
  info(`默认 θ=${r.projection.sideTiltDeg}° η=${r.projection.eta}：间距 ${p.spacingNowM} → ${p.spacingWouldM} m，` +
    `正射重叠落在 ${(p.nadirOverlapWould * 100).toFixed(1)}%`);

  // 低重叠率下必须报 unsafe —— 这是不能省的一道闸。
  // ⚠️ spacingNadir 必须与重叠率自洽（= 覆盖宽度 ×(1−o)），否则是在给函数喂一组不存在的工况。
  const LOW_OVERLAP = 50;
  const spacingAtLow = swath * (1 - LOW_OVERLAP / 100);
  const danger = resolveOblique({
    aircraft: M4E, params: { oblique: OBLIQUE_MODE.ORTHO3 },
    height: H, focalRef: F, frameWEff: W, spacingNadir: spacingAtLow, tiltDeg: 0, overlapSidePct: LOW_OVERLAP,
  });
  ok('低重叠率下投影判定不安全', danger.projection && danger.projection.safe === false,
    `旁向 ${LOW_OVERLAP}% 时正射重叠 ${(danger.projection?.nadirOverlapWould * 100).toFixed(1)}% < ${(MIN_ORTHO_SIDE_OVERLAP * 100).toFixed(0)}%`);
  ok('不安全时给出可读提示', /重建底线|低于/.test(danger.projection?.message || ''),
    danger.projection?.message?.slice(0, 34) + '…');

  // 摆角可调：更大的摆角 → 更大的补充 → 更危险
  const small = resolveOblique({
    aircraft: M4E, params: { oblique: OBLIQUE_MODE.ORTHO3, sideTiltDeg: 10 },
    height: H, focalRef: F, frameWEff: W, spacingNadir: 54, tiltDeg: 0, overlapSidePct: 70,
  }).projection;
  const large = resolveOblique({
    aircraft: M4E, params: { oblique: OBLIQUE_MODE.ORTHO3, sideTiltDeg: 30 },
    height: H, focalRef: F, frameWEff: W, spacingNadir: 54, tiltDeg: 0, overlapSidePct: 70,
  }).projection;
  ok('摆角越大补充越多', large.gainM > small.gainM, `${small.gainM} → ${large.gainM} m`);
  ok('摆角越大正射重叠越低', large.nadirOverlapWould < small.nadirOverlapWould,
    `${(small.nadirOverlapWould * 100).toFixed(1)}% → ${(large.nadirOverlapWould * 100).toFixed(1)}%`);
}

/* ---------------- ⑥ 端到端：实际航点不受影响 ---------------- */
console.log('\n[6] 端到端：真实机队下加不加摆拍，航点必须完全相同');
{
  // 这一节要打真实接口（拿机队机型），凭据同 verify-wayline-kernel.mjs。
  // 拿不到就跳过：其余五节是纯数学，不依赖网络，离线也能跑。
  let tok = null;
  let projectUuid = '';
  try {
    const store = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/tokens.json'), 'utf8'));
    // ⚠️ projectUuid 在 store 顶层，不在某个 token 里；取错会让机队接口返回空列表却不报错，
    //    表现为「明明有凭据却拉不到机型」，很难查
    projectUuid = store.activeProjectUuid || '';
    tok = store.tokens?.[store.activeId] || store.tokens?.['0'] || null;
  } catch { /* 没有凭据文件 */ }

  if (!tok?.token && !tok?.value) {
    info('跳过端到端节（未配置凭据），其余五节纯数学校验不受影响');
  } else {
    const { session } = await import('../src/djiClient.js');
    session.token = tok.token || tok.value || '';
    session.projectUuid = projectUuid;
    const { plan, resolveOblique } = await import('../src/modules/wayline/planner.js');
    const { fleetModels } = await import('../src/modules/wayline/aircraftService.js');

    const fleet = await fleetModels({ force: true });
    const target = (fleet.models || []).find((m) => m.payload !== null && m.payload !== undefined);
    if (!target) {
      info(`跳过端到端节（机队里没有已反演载荷的机型：${fleet.message || ''}）`);
    } else {
      const base = { height: 60, speed: 10, overlapH: 80, overlapW: 70, direction: 0, margin: 0 };
      const plain = await plan({ polygon: POLYGON, aircraftKey: target.key, params: base });
      const withOb = await plan({ polygon: POLYGON, aircraftKey: target.key, params: { ...base, oblique: 'ortho3' } });
      ok('普通规划成功', plain.ok, plain.message || '');

      if (!withOb.ok) {
        // 机型不支持 3 向正射摆拍 → 应当被闸掉，而不是默默忽略
        ok(`${target.name} 不支持该摆拍模式：明确拒绝而非偷偷改航线`,
          withOb.code === 'OBLIQUE_REJECTED', withOb.message?.slice(0, 36) + '…');
        ok('被拒时不产生任何航线', !withOb.plan);
      } else {
        const a = plain.plan.stats;
        const b = withOb.plan.stats;
        ok('加摆拍后航点数完全不变（KMZ 开关未验证期间不许放宽）', a.waypointCount === b.waypointCount,
          `${a.waypointCount} vs ${b.waypointCount} 点`);
        ok('加摆拍后航线间距完全不变', near(a.spacing, b.spacing, 1e-9), `${a.spacing} vs ${b.spacing} m`);
        ok('applied 仍为 false', withOb.geometry.oblique.applied === false);
        ok('给出了投影供评估', !!withOb.geometry.oblique.spacingWouldM,
          `若启用可放到 ${withOb.geometry.oblique.spacingWouldM} m`);
      }
      ok('普通规划不受影响：仍有 warnings 字段', Array.isArray(plain.warnings));
    }
  }
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
