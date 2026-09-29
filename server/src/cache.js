/**
 * TTL 缓存：降低对司空 2 的请求频次（物模型/遥测/航线等高频读取）
 */
const store = new Map();

export function get(key) {
  const it = store.get(key);
  if (!it) return undefined;
  if (Date.now() > it.expire) {
    store.delete(key);
    return undefined;
  }
  return it.value;
}

export function set(key, value, ttl = 10000) {
  store.set(key, { value, expire: Date.now() + ttl });
  return value;
}

/**
 * 缓存或计算：miss 时执行 fn 并写入
 *
 * @param {string} key
 * @param {number} ttl
 * @param {Function} fn
 * @param {boolean|{force?:boolean, isEmpty?:(v:any)=>boolean}} opts
 *        - 直接传 boolean：等价于 { force }
 *        - force: 跳过读取、强制重新计算（旧实现忽略了第 4 个参数，
 *          导致 deviceTree(true) 其实是空操作，缓存永远不刷新）
 *        - isEmpty: 判定「空结果」，为空时不写缓存。
 *          否则一次失败（例如启动时 token 还没就绪返回空设备树）会把空值
 *          钉死到 TTL 结束，表现为「设备列表时有时无」「camera_list 一直为空」
 */
export async function remember(key, ttl, fn, opts = {}) {
  const force = typeof opts === 'boolean' ? opts : !!opts.force;
  const isEmpty = typeof opts === 'object' && opts ? opts.isEmpty : null;

  if (!force) {
    const hit = get(key);
    if (hit !== undefined) return hit;
  }
  const value = await fn();
  if (!(isEmpty && isEmpty(value))) set(key, value, ttl);
  return value;
}

export function del(key) {
  store.delete(key);
}

export function clear(prefix = '') {
  for (const k of [...store.keys()]) {
    if (!prefix || k.startsWith(prefix)) store.delete(k);
  }
}

export function stats() {
  return { size: store.size, keys: [...store.keys()] };
}
