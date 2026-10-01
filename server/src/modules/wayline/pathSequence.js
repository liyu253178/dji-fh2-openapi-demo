/**
 * 航点串接与架次切分
 *
 * 对应专家结构的第四段「航点排序：井字形路径的连接策略」：
 *   1. 组内排序：平行航带奇数行正向、偶数行反向 → 之字形往复（这一步在 planArea 生成时已完成）
 *   2. 组间连接：第二组从「离第一组终点最近的那一端」接入，避免长距离空飞
 *   3. 起终点处理：可选在首尾插入起飞点、末尾附加测区质心点
 *   4. 多架次分割：按最大航程／续航把序列切成多个子序列，每个子序列是一次完整的起降循环
 *
 * 全部作用于**局部平面 XY（米）**坐标，最后统一转回经纬度。
 */

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 折线长度（米） */
export function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** 把一组已排好的航带展开成一条连续飞行序列 */
export function flattenGroup(strips) {
  const out = [];
  for (const s of strips) for (const p of s) out.push([p[0], p[1]]);
  return out;
}

/**
 * 整组反向：航带顺序倒过来、每条航带内部也倒过来。
 * 这样得到的仍是合法的之字形遍历（相邻航带依旧首尾相接），只是飞行的起点换到了另一端。
 */
export function reverseSequence(pts, groupStrips) {
  if (!groupStrips) return pts.slice().reverse();
  const out = [];
  for (let i = groupStrips.length - 1; i >= 0; i--) {
    const s = groupStrips[i];
    for (let j = s.length - 1; j >= 0; j--) out.push([s[j][0], s[j][1]]);
  }
  return out;
}

/** 多边形的面积质心（XY 米）；退化时回退到顶点算术平均 */
export function centroidXY(poly) {
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a2 += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a2) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

/**
 * 多组航线串成一条完整路径（组间按最近端点择优接入）
 *
 * @param {Array<{name?:string, strips:number[][][]}>} groups 每组内部已按之字形排好
 * @param {{homeXY?:number[], centroidXY?:number[]}} [opts]
 * @returns {{points:number[][], links:Array<{to:string,distM:number,reversed:boolean}>, transitionsM:number}}
 */
export function sequenceGroups(groups, opts = {}) {
  if (!groups.length) return { points: [], links: [], transitionsM: 0 };

  const parts = [];
  const links = [];
  let cursor = null;

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const forward = flattenGroup(g.strips);
    if (!forward.length) continue;

    let chosen = forward;
    let reversed = false;
    if (cursor) {
      const last = cursor[cursor.length - 1];
      const dForward = dist(last, forward[0]);
      const backward = reverseSequence(forward, g.strips);
      const dBackward = dist(last, backward[0]);
      if (dBackward < dForward) {
        chosen = backward;
        reversed = true;
      }
      links.push({
        to: g.name || `第 ${gi + 1} 组`,
        distM: Math.round(Math.min(dForward, dBackward) * 10) / 10,
        reversed,
      });
    }
    parts.push(chosen);
    cursor = chosen;
  }

  const points = [];
  for (const p of parts) for (const q of p) points.push(q);

  // 起终点处理：起飞点插在最前，质心点附在最后（可选）
  if (opts.homeXY) points.unshift([opts.homeXY[0], opts.homeXY[1]]);
  if (opts.centroidXY) points.push([opts.centroidXY[0], opts.centroidXY[1]]);

  return {
    points,
    links,
    transitionsM: Math.round(links.reduce((s, l) => s + l.distM, 0) * 10) / 10,
  };
}

/**
 * 多架次切分：把一条完整路径按最大航程切成 N 个起降循环
 *
 * 切分点是航点边界（不会在两点之间腰斩），每个子序列的首尾可自动补起飞点。
 * 最后一架次若太短（< minTailM），会并入上一架次，避免为了几百米单独起降一次。
 */
export function splitSorties(points, { maxLengthM = 15000, minTailM = 800, homeXY = null } = {}) {
  const max = Math.max(100, Number(maxLengthM) || 15000);
  if (!points.length) return [];

  const sorties = [];
  let cur = [];
  let len = 0;

  const close = () => {
    if (!cur.length) return;
    const seq = homeXY ? [[homeXY[0], homeXY[1]], ...cur, [homeXY[0], homeXY[1]]] : cur.slice();
    sorties.push({
      index: sorties.length,
      waypointCount: seq.length,
      lengthM: Math.round(pathLength(seq) * 10) / 10,
      points: seq,
    });
    cur = [];
    len = 0;
  };

  for (let i = 0; i < points.length; i++) {
    const step = i > 0 ? dist(points[i - 1], points[i]) : 0;
    if (cur.length && len + step > max) close();
    if (!cur.length) cur.push(points[i]);
    else {
      cur.push(points[i]);
      len += step;
    }
  }
  close();

  // 尾巴太短就并回上一架次：多一次起降的代价远大于多飞几百米。
  // 但合并后若超过续航上限就不合并 —— 航线任务是「电量算不过来」比「多起降一次」严重得多。
  if (sorties.length > 1) {
    const tail = sorties[sorties.length - 1];
    const prev = sorties[sorties.length - 2];
    const core = [...prev.points.slice(0, homeXY ? -1 : undefined), ...tail.points.slice(homeXY ? 1 : 0)];
    const merged = homeXY ? [[homeXY[0], homeXY[1]], ...core, [homeXY[0], homeXY[1]]] : core;
    const mergedLen = pathLength(merged);
    if (tail.lengthM < minTailM && mergedLen <= max) {
      sorties[sorties.length - 2] = {
        index: prev.index,
        waypointCount: merged.length,
        lengthM: Math.round(mergedLen * 10) / 10,
        points: merged,
      };
      sorties.pop();
      sorties.forEach((s, i) => (s.index = i));
    }
  }

  return sorties;
}
