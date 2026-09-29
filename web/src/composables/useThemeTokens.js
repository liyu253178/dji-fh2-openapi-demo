/**
 * 从 tokens.css 读取色值，供 ECharts 等无法直接用 CSS 变量的场景使用。
 * 一次读取，缓存，避免每次渲染都getComputedStyle。
 */

import { ref, onMounted } from 'vue';

const cache = ref(null);

function readVar(name, fallback) {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function build() {
  return {
    bg0: readVar('--c-bg-0', '#0a0a0c'),
    bg1: readVar('--c-bg-1', '#121214'),
    bg2: readVar('--c-bg-2', '#1a1a1e'),
    line: readVar('--c-line', 'rgba(255,255,255,.1)'),
    text0: readVar('--c-text-0', '#f5f5f7'),
    text1: readVar('--c-text-1', '#a1a1a8'),
    text2: readVar('--c-text-2', '#6e6e76'),
    brand: readVar('--c-brand', '#ff6a00'),
    ok: readVar('--c-ok', '#35d07f'),
    warn: readVar('--c-warn', '#ffb020'),
    err: readVar('--c-err', '#ff4d4f'),
    info: readVar('--c-info', '#3b82f6'),
    purple: readVar('--c-purple', '#a78bfa'),
  };
}

export function useThemeTokens() {
  if (!cache.value) cache.value = build();
  const t = cache.value;

  return {
    ...t,
    /** 坐标轴通用样式 */
    axis: () => ({ color: t.text2, fontSize: 11 }),
    /** 图表分类配色 */
    palette: [t.brand, t.info, t.ok, t.warn, t.purple, t.err],
  };
}
