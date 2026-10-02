/**
 * HTTP 层公共设施
 *
 * 解决两件事：
 * 1. Express 4 不接管 async handler 的 rejected promise —— 路由里任一 await 抛错
 *    都会变成 unhandled rejection，直接终止 Node 进程（全站掉线）。
 *    这里提供 asyncHandler / hardenRouter，把异步异常导回 Express 错误通道。
 * 2. 全站没有统一错误出口 —— 异常发生时请求方永远挂起。这里提供 errorHandler
 *    与 notFound，保证每个请求都有确定响应。
 *
 * 信封说明：项目历史上并行存在 {ok} 与 {code} 两套约定（见 P1-4）。
 * 本文件的错误响应**同时**写 ok:false 与 code:非0，向前兼容两种前端判空方式；
 * 成功响应保持各路由原有形状不变，不在本次改动内统一。
 */
import { log } from './logger.js';

/** 包裹单个 async handler，把 rejection 交给 next(err) */
export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** 兼容别名：部分代码习惯 wrap 命名 */
export const wrap = asyncHandler;

const HARDENED = Symbol('duav.hardened');

function patchHandle(fn) {
  if (typeof fn !== 'function') return fn;
  if (fn[HARDENED]) return fn;
  // 只处理 async 函数：同步 handler 由 Express 自身捕获，包一层反而多一次微任务
  if (!fn.constructor || fn.constructor.name !== 'AsyncFunction') return fn;
  const wrapped = function hardened(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
  Object.defineProperty(wrapped, HARDENED, { value: true });
  return wrapped;
}

/**
 * 就地加固一个 Router：把其下所有已注册 async 路由 handler 包上异常捕获。
 *
 * 采用运行时修补而非逐个改源码，是因为 14 个路由文件里有 60+ 处 async handler，
 * 逐个手写包裹必然漏改；而 Express 的 Router.stack / Route.stack 是可枚举的，
 * 一次遍历即可全覆盖，且新增路由自动生效（只要挂路由时经过本函数）。
 *
 * @param {import('express').Router} router
 * @returns {import('express').Router} 同一个 router（便于 inline 使用）
 */
export function hardenRouter(router) {
  if (!router || !Array.isArray(router.stack)) return router;
  for (const layer of router.stack) {
    // 普通路由：layer.route.stack 是该路由的中间件/handler 链
    if (layer.route && Array.isArray(layer.route.stack)) {
      for (const l of layer.route.stack) l.handle = patchHandle(l.handle);
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      // router.use(subRouter) / router.use('/x', subRouter) 的嵌套情形
      hardenRouter(layer.handle);
    }
  }
  return router;
}

/** 统一的错误出口：保证任何异常都会落成一个 JSON 响应 */
export function errorHandler(err, req, res, next) {
  // 已经发过响应头（例如流式下载中途失败）时不能再改状态码，交给 Express 默认处理
  if (res.headersSent) return next(err);

  const status = Number(err?.status || err?.statusCode) || 500;
  const message = err?.message || '服务器内部错误';
  const code = Number.isFinite(Number(err?.code)) && Number(err.code) !== 0 ? Number(err.code) : status;

  if (status >= 500) log.error('HTTP', `${req.method} ${req.originalUrl} → ${status} ${message}`);
  else log.warn('HTTP', `${req.method} ${req.originalUrl} → ${status} ${message}`);

  res.status(status).json({ ok: false, code, message, data: null });
}

/** /api 下的未匹配路径返回明确 404，避免落到 SPA 回退得到一份 HTML */
export function apiNotFound(req, res) {
  res.status(404).json({ ok: false, code: 404, message: `接口不存在: ${req.method} ${req.originalUrl}`, data: null });
}

/**
 * 进程级兜底：即便有 handler 漏网（例如某个 setInterval 里的异步任务），
 * 也不让整个 BFF 因为一次设备网络抖动而退出。
 * uncaughtException 仍选择退出——此时进程状态已不可信。
 */
export function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    log.error('PROC', `未捕获的 Promise 异常（已拦截，进程继续）: ${reason?.message || reason}`);
  });
  process.on('uncaughtException', (err) => {
    log.error('PROC', `未捕获异常，进程将退出: ${err?.message || err}`);
    process.exit(1);
  });
}
