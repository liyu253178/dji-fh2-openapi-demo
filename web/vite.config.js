import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Cesium 的运行时静态资源（Worker / 内置影像与地形 / 第三方解码器 / 控件样式） */
const CESIUM_SRC = path.resolve(__dirname, 'node_modules/cesium/Build/Cesium');
/** 对外暴露路径。改这里请同步改 index.html 里的 window.CESIUM_BASE_URL */
const CESIUM_BASE = '/cesium/';
/** 需要整目录复制的子目录（Cesium.js 本体由打包器处理，不在这里复制） */
const CESIUM_DIRS = ['Workers', 'Assets', 'ThirdParty', 'Widgets'];

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2',
};

function dirSize(p) {
  let n = 0;
  if (!fs.existsSync(p)) return 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return n;
}

/**
 * Cesium 静态资源桥接（不引入 vite-plugin-cesium，少一个依赖）：
 *  - 构建：把上述四个目录原样复制到 dist/cesium/
 *  - 开发：用中间件把 /cesium/* 直接映射到 node_modules 里的源目录
 * 两处都保证 CESIUM_BASE_URL 指向的地址能真实取到文件，这是「离线可跑」的前提。
 */
function cesiumAssets() {
  return {
    name: 'duav-cesium-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(CESIUM_BASE)) return next();
        const rel = decodeURIComponent(req.url.slice(CESIUM_BASE.length).split('?')[0]);
        const file = path.resolve(CESIUM_SRC, rel);
        if (!file.startsWith(CESIUM_SRC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        const ext = path.extname(file).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist');
      for (const d of CESIUM_DIRS) {
        const from = path.join(CESIUM_SRC, d);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(outDir, 'cesium', d), { recursive: true });
      }
      const total = CESIUM_DIRS.reduce((n, d) => n + dirSize(path.join(outDir, 'cesium', d)), 0);
      console.log(`[cesium] 已复制静态资源到 dist/cesium（${(total / 1048576).toFixed(1)} MB）`);
    },
  };
}

export default defineConfig({
  plugins: [vue(), cesiumAssets()],
  define: {
    // 让 Cesium 内部 buildModuleUrl 走我们托管的路径（index.html 里还会兜一道 window.CESIUM_BASE_URL）
    CESIUM_BASE_URL: JSON.stringify(CESIUM_BASE),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 只把 Cesium 单独切开（路由级懒加载 + 独立 chunk，不进业务页首屏）。
          // 不动 three.js 的既有切法，避免 POC 波及现有页面。
          if (id.includes('node_modules/cesium') || id.includes('node_modules/@cesium/')) return 'cesium';
        },
      },
    },
  },
});
