/**
 * v-count —— 数字滚动指令（大屏 KPI 用）
 *
 * 用法：<span v-count="kpi.sorties"></span>
 *  - 值变化时从上一个数滚到新数（约 900ms，easeOutCubic）
 *  - 支持小数位：v-count="obj.x" :decimals="1"
 *  - 首次渲染也滚动（从 0 起），大屏首屏更有"数据在生长"的感觉
 *  - 支持 [起始, 结束] 区间动画：v-count="range"（range 是 [from, to] 数组）
 *
 * 为什么不直接用 CSS 动画：CSS 只能做 opacity/transform，
 * 数字本身的递增必须用 JS 逐帧改文本。
 *
 * 尊重 prefers-reduced-motion：用户要求减少动效时直接跳到终值。
 */
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

function parseArg(binding) {
  // 指令值可能是数字，也可能是 [from, to] 区间
  if (Array.isArray(binding.value)) return { from: Number(binding.value[0]) || 0, to: Number(binding.value[1]) || 0 };
  return { to: Number(binding.value) || 0 };
}

function animate(el, from, to, decimals, done) {
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || from === to) {
    el.textContent = to.toFixed(decimals);
    done?.();
    return;
  }
  const dur = 900;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const v = from + (to - from) * easeOutCubic(p);
    el.textContent = v.toFixed(decimals);
    if (p < 1) requestAnimationFrame(step);
    else done?.();
  };
  requestAnimationFrame(step);
}

export const countUp = {
  mounted(el, binding) {
    const decimals = Number(binding.arg || 0);
    const { to } = parseArg(binding.value);
    // 首次从 0 滚起；区间动画则从区间起点滚
    const from = Array.isArray(binding.value) ? Number(binding.value[0]) || 0 : 0;
    el.__count = { from, decimals };
    animate(el, from, to, decimals);
  },
  updated(el, binding) {
    if (binding.value === binding.oldValue) return;
    const decimals = Number(binding.arg || 0);
    // 从当前显示值接着滚，数字变化才连贯，不会每次都从 0 重来
    const current = parseFloat(el.textContent) || 0;
    const { to } = parseArg(binding.value);
    el.__count = { from: current, decimals };
    animate(el, current, to, decimals);
  },
  unmounted(el) {
    delete el.__count;
  },
};

export default countUp;
