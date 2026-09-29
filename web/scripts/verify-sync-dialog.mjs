/**
 * 同步影像弹窗的浏览器断言（需要系统 Chrome + playwright-core）
 *
 * 覆盖三项需求：① 机场非必选（不选 = 全部机场，开始同步不被禁用）；② 机场数据源
 * 含历史同步过的机场；③ 「自动剔除无图片的航线」勾选默认开启且不溢出对话框。
 * ⚠️ 断言注意：已在线的历史机场会被去重到「当前在线」组，所以不能断言「一定出现
 *    历史分组」，要断言「known-docks 返回的 SN 全部出现在候选项里」。
 * 脚本只打开弹窗、不点「开始同步」，避免污染真实数据。
 *
 * 用法：cd web && node scripts/verify-sync-dialog.mjs [BASE_URL]（需先起服务）
 * 依赖：playwright-core + 系统 Chrome，找不到则跳过（退出码 0），避免卡住回归。
 */
const fs0 = await import('node:fs');
const CANDIDATES = [
  process.env.PLAYWRIGHT_CORE_PATH,
  'playwright-core',
  '/Users/candice/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js',
].filter(Boolean);
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
let mod = null;
for (const c of CANDIDATES) {
  try {
    mod = await import(c);
    if (mod.chromium || mod.default?.chromium) break;
  } catch {
    /* 试下一个 */
  }
}
const chromium = mod?.chromium || mod?.default?.chromium;
const chromePath = CHROME_PATHS.find((x) => fs0.existsSync(x));
if (!chromium || !chromePath) {
  console.log('⏭  跳过同步弹窗断言：未找到 playwright-core 或系统 Chrome');
  process.exit(0);
}
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) {
    pass++;
    console.log('  [ok] ' + n);
  } else {
    fail++;
    console.log('  [FAIL] ' + n + ' ' + e);
  }
};

const b = await chromium.launch({ executablePath: chromePath, headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
p.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});

await p.goto(BASE + '/assets', { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(2500);

// 打开「同步影像」弹窗
const opened = await p.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.indexOf('同步影像') >= 0);
  if (!btn) return false;
  btn.click();
  return true;
});
ok('可打开同步影像弹窗', opened);
await p.waitForTimeout(2500);

const dlg = await p.evaluate(() => {
  const el = document.querySelector('.el-dialog');
  if (!el) return null;
  const t = el.innerText;
  const cbs = Array.from(el.querySelectorAll('.el-checkbox')).map((c) => ({
    text: c.innerText.replace(/\s+/g, ' ').trim(),
    checked: c.className.indexOf('is-checked') >= 0,
    // 溢出检测：说明文字是否被 nowrap 挤出对话框
    overflow: (() => {
      const sub = c.querySelector('.sub');
      if (!sub) return 0;
      return Math.round(sub.getBoundingClientRect().right - el.getBoundingClientRect().right);
    })(),
  }));
  const startBtn = Array.from(el.querySelectorAll('button')).find((x) => x.innerText.indexOf('开始同步') >= 0);
  return {
    text: t,
    hasDockLabel: t.indexOf('机场') >= 0,
    placeholderAll: t.indexOf('不选 = 全部机场') >= 0,
    hasSkip: t.indexOf('自动剔除无图片的航线') >= 0,
    hasPrune: t.indexOf('清理无影像架次') >= 0,
    cbs,
    startDisabled: startBtn ? startBtn.disabled : null,
  };
});
ok('弹窗已渲染', !!dlg);
ok('机场项存在且提示「不选 = 全部机场」', dlg && dlg.hasDockLabel && dlg.placeholderAll, dlg ? dlg.text.slice(0, 80) : '');
ok('含「自动剔除无图片的航线」勾选', dlg && dlg.hasSkip);
ok('剔除勾选默认开启', dlg && dlg.cbs.some((c) => c.text.indexOf('自动剔除') >= 0 && c.checked));
ok('剔除说明未溢出对话框', dlg && dlg.cbs.every((c) => c.overflow <= 0), dlg ? JSON.stringify(dlg.cbs.map((c) => c.overflow)) : '');
ok('含「清理无影像架次」入口', dlg && dlg.hasPrune);

// 机场下拉：数据源必须包含历史机场分组
const dockSel = await p.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.el-form-item'));
  const it = items.find((x) => x.innerText.trim().startsWith('机场'));
  if (!it) return null;
  const sel = it.querySelector('.el-select');
  if (!sel) return null;
  sel.querySelector('input')?.click();
  sel.click();
  return { clicked: true };
});
ok('机场下拉可点击', !!dockSel);
await p.waitForTimeout(1200);
const opts = await p.evaluate(() => {
  const groups = Array.from(document.querySelectorAll('.el-select-group__title')).map((g) => g.innerText.trim());
  const items = Array.from(document.querySelectorAll('.el-select-dropdown__item')).map((i) => i.innerText.trim());
  return { groups, items };
});
ok('机场下拉非空', opts.items.length > 0, opts.items.length + ' 项');

// 历史机场必须进入候选。已在线的历史机场会被去重到「当前在线」组（正确行为），
// 所以不能断言「一定出现历史分组」，而要断言「历史 SN 全部出现在候选里」。
const snOf = (s) => {
  const m = String(s).match(/（([^）]+)）\s*$/);
  return m ? m[1] : s;
};
const candSn = new Set(opts.items.map(snOf));
const api = await p.evaluate(async (base) => {
  const s = await fetch(base + '/api/session').then((x) => x.json());
  const pu = (s && s.data && (s.data.projectUuid || s.data.activeProjectUuid)) || '';
  return { pu, r: await fetch(base + '/api/asset/known-docks?projectUuid=' + encodeURIComponent(pu)).then((x) => x.json()) };
}, BASE);
const hist = ((api.r && api.r.data && api.r.data.list) || []).map((d) => d.dockSn);
const missed = hist.filter((s) => !candSn.has(s));
ok(
  '历史机场 SN 全部进入候选（' + hist.length + ' 个）',
  hist.length > 0 && missed.length === 0,
  '缺失 ' + JSON.stringify(missed) + ' | 候选 ' + JSON.stringify(Array.from(candSn))
);

// 机场非必选：不选机场时「开始同步」应可点（时间范围已有默认值）
ok('未选机场时开始同步不被禁用（机场非必选）', dlg && dlg.startDisabled === false, String(dlg && dlg.startDisabled));

// 关闭弹窗（不真正触发同步，避免动真实数据）
await p.keyboard.press('Escape');
await p.waitForTimeout(500);

ok('控制台 0 错误', errs.length === 0, errs.slice(0, 2).join(' | '));

await b.close();
console.log('');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
