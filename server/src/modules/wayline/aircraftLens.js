/**
 * 机型 → 镜头 / 传感器 / 摆拍能力 注册表
 *
 * ============================================================================
 * ⚠️ 先说清楚参数从哪来，这决定了这张表可信到什么程度
 * ============================================================================
 *
 * 1. **司空 2 OpenAPI 不返回任何镜头光学参数**。
 *    2026-10-02 实测（server/scripts/probe-lens-catalog.mjs，新组织 100 个项目 / 18 台设备）：
 *      - /project/device 只给 device_model.{domain,type,sub_type,name,class}
 *      - 飞行器离线时 camera_list 为 null；在线的机场也只给 camera_index / camera_position
 *      - **没有焦距、没有传感器尺寸、没有像素数**
 *    ⇒ 「从接口拉取镜头参数」在物理上做不到，只能拉到**机型枚举**。
 *
 * 2. 所以本表的焦距/画幅/像素一律取自 **DJI 官方公开规格**（企业官网 / 产品对比页 / 用户手册），
 *    每条都标了 source。官方没写明的字段留 `null` 并置 `unknown:true`，
 *    **不拿行业惯例或印象值填充**——宁可让上层告警，也不给一个看起来很像真的错值。
 *
 * 3. 焦距是公开且不随设备变化的常数，写死是安全的；
 *    但**机型枚举**（domain-type-sub_type）绝不能写死，必须走 /project/device（见 aircraftService）。
 *    本表用枚举做主键，只是把「已知机型的官方光学参数」挂上去，
 *    遇到库里没有的机型会回落到保守值并明确告警。
 */

/** 35mm 等效画幅基准（用于把「等效焦距」换算成覆盖宽度） */
export const FRAME_35MM = { w: 36, h: 24 };

/**
 * 机型规格表
 *
 * 字段说明：
 *   keys    司空 2 的 device_model.key（domain-type-sub_type）。多个别名都写上，
 *           实测确认过的加 verified:true
 *   names   机型名（用于按名字兜底匹配）
 *   sensor  主广角相机传感器：等效焦距 + 像素（决定 GSD 换算）
 *   lenses  该机型可用的镜头位（每个都有独立焦距与像素）
 *   oblique 摆拍能力（见文件末尾的 OBLIQUE 说明）
 */
export const AIRCRAFT_LENS = [
  {
    keys: ['0-100-1'],
    verified: true, // 2026-10-02 实测：本组织 8 台 Matrice 4TD，key=0-100-1
    names: ['Matrice 4TD', 'M4TD'],
    sensor: { name: '广角', focalEq: 24, imageW: 8064, imageH: 6048, inch: '1/1.3', mp: 48, dfov: 82 },
    lenses: [
      { key: 'wide', name: '广角', focalEq: 24, imageW: 8064, imageH: 6048, dfov: 82, payloadLensIndex: 'visable' },
      { key: 'medium', name: '中长焦', focalEq: 70, imageW: 8064, imageH: 6048, dfov: 35, payloadLensIndex: 'visable' },
      { key: 'tele', name: '长焦', focalEq: 168, imageW: 8064, imageH: 6048, dfov: 15, payloadLensIndex: 'visable' },
      { key: 'ir', name: '红外热成像', focalEq: 53, imageW: 640, imageH: 512, dfov: 45, payloadLensIndex: 'ir', thermal: true },
    ],
    oblique: { smart5: true, ortho3: false, source: 'Matrice 4 系列支持 5 向倾斜摆拍' },
    source: 'https://www.dji.com/cn/dock-3 · https://enterprise.dji.com/matrice-4-series',
    note: '广角为 1/1.3" 4800 万像素（8064×6048）；与 M4D/M4E 的 4/3" 2000 万不同，GSD 换算必须区分',
  },
  // ⚠️ M4 系列必须按「是否支持 3 向正射摆拍」拆条。同一套光学参数可以共用，
  //    但摆拍能力一经合并且置 true，就等于给未核实的机型开了绿灯——
  //    宁可判不支持（可由用户显式覆盖），也不凭推断放行。
  {
    keys: [],
    verified: false,
    names: ['Matrice 4E', 'M4E'],
    sensor: { name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, inch: '4/3', mp: 20, dfov: 84 },
    lenses: [
      { key: 'wide', name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, dfov: 84, payloadLensIndex: 'visable', mechanicalShutter: true },
      { key: 'medium', name: '中长焦', focalEq: 70, imageW: 8064, imageH: 6048, dfov: 35, payloadLensIndex: 'visable' },
      { key: 'tele', name: '长焦', focalEq: 168, imageW: 8064, imageH: 6048, dfov: 15, payloadLensIndex: 'visable' },
    ],
    oblique: { smart5: true, ortho3: true, source: 'M4 系列支持 5 向倾斜摆拍；M4E 另支持 3 向正射摆拍' },
    source: 'https://enterprise.dji.com/matrice-4-series',
    note: '广角为 4/3" 2000 万（5280×3956），不是 M4TD 的 4800 万；中长焦/长焦仍是 4800 万',
  },
  {
    keys: [],
    verified: false, // 枚举未实测，接入时请以 /project/device 为准
    names: ['Matrice 4D', 'M4D', 'Matrice 4T', 'M4T'],
    sensor: { name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, inch: '4/3', mp: 20, dfov: 84 },
    lenses: [
      { key: 'wide', name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, dfov: 84, payloadLensIndex: 'visable', mechanicalShutter: true },
      { key: 'medium', name: '中长焦', focalEq: 70, imageW: 8064, imageH: 6048, dfov: 35, payloadLensIndex: 'visable' },
      { key: 'tele', name: '长焦', focalEq: 168, imageW: 8064, imageH: 6048, dfov: 15, payloadLensIndex: 'visable' },
    ],
    // 官方明确支持 5 向倾斜摆拍（M4 系列口径）；3 向正射摆拍只在 M4E 上核实过，此处不当作可用
    oblique: { smart5: true, ortho3: false, ortho3Unknown: true, source: 'M4 系列支持 5 向倾斜摆拍；3 向正射摆拍仅 M4E 已核实' },
    source: 'https://enterprise.dji.com/matrice-4-series',
    note: '⚠️ 3 向正射摆拍未经核实，按不支持处理；如确需使用请核实该机型官方规格后显式放行',
  },
  {
    keys: [],
    names: ['Matrice 3D', 'M3D', 'Matrice 3TD', 'M3TD'],
    sensor: { name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, inch: '4/3', mp: 20, dfov: 84 },
    lenses: [
      { key: 'wide', name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, dfov: 84, payloadLensIndex: 'visable' },
      { key: 'tele', name: '长焦', focalEq: 162, imageW: 4000, imageH: 3000, dfov: 15, payloadLensIndex: 'visable', unknown: true },
    ],
    oblique: { smart5: false, ortho3: false, unknown: true, source: '官方未列明摆拍能力' },
    source: 'https://www.dji.com/global/products/comparison-dock（广角 24mm / 长焦 162mm）',
    note: '长焦传感器像素未查到公开值，标 unknown，GSD 换算会告警',
  },
  {
    keys: [],
    names: ['Mavic 3E', 'M3E'],
    sensor: { name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, inch: '4/3', mp: 20, dfov: 84 },
    lenses: [
      { key: 'wide', name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, dfov: 84, payloadLensIndex: 'visable', mechanicalShutter: true },
      { key: 'tele', name: '长焦', focalEq: 162, imageW: 4000, imageH: 3000, dfov: 15, payloadLensIndex: 'visable', unknown: true },
    ],
    oblique: {
      smart5: false,
      ortho3: true,
      source: 'Mavic 3E 三向智能摆拍：井字两条航线，云台摆动，官方称效率提升一倍以上',
    },
    source: 'https://enterprise.dji.com/cn/news/detail/dji-mavic-3-enterprise-v05',
    note: 'Mavic 3E 是单相机 + 长焦；摆拍是靠云台摆动实现的，不需要多镜头',
  },
  {
    keys: [],
    names: ['Mavic 3T', 'M3T'],
    sensor: { name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, inch: '4/3', mp: 20, dfov: 84 },
    lenses: [
      { key: 'wide', name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, dfov: 84, payloadLensIndex: 'visable' },
      { key: 'ir', name: '红外热成像', focalEq: null, imageW: 640, imageH: 512, dfov: null, payloadLensIndex: 'ir', thermal: true, unknown: true },
    ],
    oblique: { smart5: false, ortho3: false, source: '用户手册明确：Smart Oblique is not supported by DJI Mavic 3T' },
    source: 'Mavic 3E/3T User Manual（Smart Oblique 章节）',
    note: '⚠️ Mavic 3T **不支持**智能摆拍，勾选摆拍必须被拦下；红外等效焦距官方未给，标 unknown',
  },
  {
    keys: [],
    names: ['M30', 'M30T', 'Matrice 30', 'Matrice 30T'],
    sensor: { name: '广角', focalEq: 24, imageW: 4000, imageH: 3000, inch: '1/2', mp: 12, dfov: 84 },
    lenses: [
      { key: 'wide', name: '广角', focalEq: 24, imageW: 4000, imageH: 3000, dfov: 84, payloadLensIndex: 'visable' },
      { key: 'tele', name: '变焦', focalEq: 113, imageW: 4000, imageH: 3000, dfov: null, payloadLensIndex: 'visable', unknown: true },
      { key: 'ir', name: '红外热成像', focalEq: null, imageW: 640, imageH: 512, dfov: null, payloadLensIndex: 'ir', thermal: true, unknown: true },
    ],
    oblique: { smart5: false, ortho3: false, unknown: true, source: '官方未列明 M30 系列摆拍能力' },
    source: 'DJI M30/M30T 产品规格',
    note: '变焦与红外焦距为公开规格未明确项，标 unknown',
  },
];

/** 未知机型的保守回落：只敢用「广角 24mm + 4/3" 2000 万」这套最常见的行业配置 */
export const FALLBACK_PROFILE = {
  keys: [],
  names: ['(未知机型)'],
  fallback: true,
  sensor: { name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, inch: '4/3', mp: 20, dfov: 84 },
  lenses: [
    { key: 'wide', name: '广角', focalEq: 24, imageW: 5280, imageH: 3956, dfov: 84, payloadLensIndex: 'visable' },
  ],
  oblique: { smart5: false, ortho3: false, unknown: true, source: '未知机型，摆拍能力不明，按不支持处理' },
  source: '(保守回落值)',
  note: '⚠️ 未在机型库中，光学参数按行业常见配置假设，实测前请勿用于正式作业',
};

/** 按司空 2 的 device_model.key 精确匹配 */
export function profileByKey(key) {
  const k = String(key || '');
  return AIRCRAFT_LENS.find((p) => p.keys.includes(k)) || null;
}

/** 按机型名模糊匹配（key 匹配不上时的兜底） */
export function profileByName(name) {
  const n = String(name || '').toLowerCase().trim();
  if (!n) return null;

  // 第一遍：**完全相等**优先。这一步决定正确性——
  // 机型缩写的大前缀关系（M4T ⊂ M4TD、M30 ⊂ M30T）会让包含匹配天然偏向长机型，
  // 而长短机型的传感器往往不同（M4TD 4800 万 vs M4T 2000 万），串了就是错的 GSD。
  for (const p of AIRCRAFT_LENS) {
    if (p.names.some((c) => String(c).toLowerCase() === n)) return p;
  }

  // 第二遍：子串包含。命中多个时取**最短**的候选——
  // 查询更短通常意味着它是某个长机型的前缀，取最短候选 = 取最贴近查询的那一个，
  // 避免 "M4T" 落到 "M4TD" 上（见下方 M4T 为例的反例）。
  let best = null;
  let bestLen = Infinity;
  for (const p of AIRCRAFT_LENS) {
    for (const cand of p.names) {
      const c = String(cand).toLowerCase();
      if (c.length < 2) continue;
      if ((n.includes(c) || c.includes(n)) && c.length < bestLen) {
        best = p;
        bestLen = c.length;
      }
    }
  }
  return best;
}

/**
 * 解析机型的光学档案
 * @param {{key?:string,name?:string}} model 来自 /project/device 的 device_model
 * @returns {{profile:object, matchedBy:'key'|'name'|'fallback', warnings:string[]}}
 */
export function lensProfileFor(model = {}) {
  const warnings = [];
  let profile = profileByKey(model.key);
  let matchedBy = 'key';

  if (!profile) {
    profile = profileByName(model.name);
    matchedBy = profile ? 'name' : 'fallback';
  }

  if (!profile) {
    profile = FALLBACK_PROFILE;
    warnings.push(
      `机型 ${model.name || model.key || '未知'} 不在镜头库中，已按保守配置（广角 24mm / 4/3" 2000 万）估算，` +
        `GSD 与间距可能偏差较大，请先核实该机型的官方镜头规格`
    );
  } else if (matchedBy === 'name') {
    warnings.push(
      `机型 ${model.name} 的枚举 key（${model.key || '空'}）未在库中，按名称匹配到镜头规格；` +
        `若该机型实际配置不同，请补充 key 映射`
    );
  }

  // 有关键参数缺失时明确告警，不让 unknown 静默通过
  const unknownLenses = profile.lenses.filter((l) => l.unknown || !l.focalEq);
  if (unknownLenses.length) {
    warnings.push(
      `${profile.names[0]} 的 ${unknownLenses.map((l) => l.name).join('、')} 焦距/像素为公开规格未明确项，` +
        `相关镜头的间距计算仅供估算`
    );
  }
  if (profile.oblique?.unknown) {
    warnings.push(`${profile.names[0]} 的摆拍能力官方未列明，按「不支持摆拍」处理`);
  }

  return { profile, matchedBy, warnings };
}

/** 取机型在某个镜头位上的规格（没有该镜头位则返回 null） */
export function lensOf(profile, lensKey) {
  return (profile?.lenses || []).find((l) => l.key === lensKey) || null;
}

/** 该机型实际可用的镜头位 key 列表 */
export function availableLensKeys(profile) {
  return (profile?.lenses || []).filter((l) => Number.isFinite(l.focalEq)).map((l) => l.key);
}

/* ============================================================================
 * 摆拍（Smart Oblique / 智能摆动拍摄）能力判定
 *
 * 官方事实（2026-10-02 核实）：
 *   - 智能摆动拍摄：飞行中控制负载多角度拍摄，**一条航线**即可采集 3D 重建所需的
 *     正射 + 倾斜照片；测区边缘只拍重建相关的方向，精简张数；转弯处设缓冲区不拍照
 *     （避免转弯姿态影响对地角度）。P1（M300 RTK）对地角 -45°~-90°。
 *   - Mavic 3E：三向智能摆拍，井字**两条航线**达到以往五向飞行的效果，效率提升一倍以上。
 *   - **Mavic 3T 不支持** Smart Oblique（用户手册明确）。
 *   - Matrice 4 系列：**5 向倾斜摆拍**（下视 + 4 斜角 ±45°），三维重建效率提升 40%；
 *     **M4E 另有 3 向正射摆拍**：正射同时左右侧摆，**减少旁向重叠率**，
 *     单架次可完成 2.8 km²，高程精度更优。
 *
 * ⇒ 对航线的优化来自两条完全不同的机理，代码里必须分开处理：
 *   ① smart5（倾斜摆拍）：原来 mapping3d 要飞 5 条航线 → 摆拍 1 条搞定，航程骤减
 *   ② ortho3（正射摆拍）：侧向摆拍补了旁向覆盖 → **旁向重叠率可以降低** → 航带间距加大 → 航带数减少
 * ========================================================================== */

/** 摆拍模式枚举 */
export const OBLIQUE_MODE = {
  OFF: 'off',
  /** 5 向倾斜摆拍：替代 mapping3d 的 5 条航线 */
  SMART5: 'smart5',
  /** 3 向正射摆拍：降低旁向重叠率要求，加大航线间距 */
  ORTHO3: 'ortho3',
};

/**
 * 校验某机型能否用某种摆拍模式
 * @returns {{ok:boolean, message:string}}
 */
export function checkOblique(profile, mode) {
  if (!mode || mode === OBLIQUE_MODE.OFF) return { ok: true, message: '' };
  const cap = profile?.oblique || {};
  if (mode === OBLIQUE_MODE.SMART5) {
    if (cap.smart5) return { ok: true, message: '' };
    return {
      ok: false,
      message:
        `${profile?.names?.[0] || '该机型'} 不支持 5 向倾斜摆拍` +
        (cap.source ? `（${cap.source}）` : '') +
        `。请改用普通倾斜摄影（mapping3d，飞 5 条航线）或换用支持摆拍的机型。`,
    };
  }
  if (mode === OBLIQUE_MODE.ORTHO3) {
    if (cap.ortho3) return { ok: true, message: '' };
    return {
      ok: false,
      message:
        `${profile?.names?.[0] || '该机型'} 不支持 3 向正射摆拍` +
        (cap.source ? `（${cap.source}）` : '') +
        `，不能据此降低旁向重叠率。`,
    };
  }
  return { ok: false, message: `未知摆拍模式：${mode}` };
}
