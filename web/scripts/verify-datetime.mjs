#!/usr/bin/env node
/**
 * 前端日期边界工具断言（node 直接跑，不需要浏览器）
 *
 * 日期区间曾因两处写法各错一边而反复出问题：
 *   ① new Date('2026-08-30') 会按 UTC 午夜解析，在东八区等于当天 08:00。用它查
 *      「08-30 ~ 09-29」实际成了「08-30 08:00 ~ 09-30 07:59:59」，整体偏移 8 小时
 *      （漏掉首日 0-8 点的架次、又多查末日之后 0-8 点的）；
 *   ② 终点若取「结束日 00:00」，结束日当天的记录会被整体排除
 *      （实测 08-30~09-29 少 5 个架次）。
 * 统一由 dayBounds 按本地时区取 [当天 00:00:00, 当天 23:59:59]。
 *
 * 用法：cd web && node scripts/verify-datetime.mjs
 */

import { dayBounds, localDay } from '../src/utils/format.js';

let pass = 0;
let fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
};

console.log(`\n${'─'.repeat(58)}\n▶ 前端日期边界（本地时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）\n${'─'.repeat(58)}`);

const R = ['2026-08-30', '2026-09-29'];
const sec = dayBounds(R, 'sec');
const iso = dayBounds(R, 'iso');

// 起点：必须是本地当天 00:00:00（若按 UTC 解析会变成 08:00）
const b = new Date(sec.beginAt * 1000);
ok(
  '秒级起点落在本地开始日 00:00:00',
  b.getFullYear() === 2026 && b.getMonth() === 7 && b.getDate() === 30 && b.getHours() === 0 && b.getMinutes() === 0 && b.getSeconds() === 0,
  b.toString().slice(0, 24)
);

// 终点：必须是本地结束日 23:59:59（取 00:00 会漏掉结束日当天）
const e = new Date(sec.endAt * 1000);
ok(
  '秒级终点落在本地结束日 23:59:59（不是 00:00）',
  e.getFullYear() === 2026 && e.getMonth() === 8 && e.getDate() === 29 && e.getHours() === 23 && e.getMinutes() === 59 && e.getSeconds() === 59,
  e.toString().slice(0, 24)
);

ok('终点晚于起点且跨度约 31 天', (sec.endAt - sec.beginAt) / 86400 > 30 && (sec.endAt - sec.beginAt) / 86400 < 32, String((sec.endAt - sec.beginAt) / 86400));
ok('iso 与 sec 表示同一时刻', Math.abs(Date.parse(iso.beginAt) - sec.beginAt * 1000) < 1000 && Math.abs(Date.parse(iso.endAt) - sec.endAt * 1000) < 1000);
ok('iso 输出是可被 Date.parse 解析的 UTC 串', iso.beginAt.endsWith('Z') && !Number.isNaN(Date.parse(iso.beginAt)));

// 入库的 begin_at 是 ISO UTC 文本，比较走字符串；格式必须可比较（补零到毫秒）
ok('iso 串为定长格式（字符串比较才等价于时间比较）', iso.beginAt.length === 24 && iso.endAt.length === 24, `${iso.beginAt.length}/${iso.endAt.length}`);

// 参数缺失不炸
ok('区间为空返回 null', dayBounds(null, 'sec') === null && dayBounds(['2026-08-30'], 'sec') === null && dayBounds([], 'sec') === null);
ok('非法日期返回 null', dayBounds(['foo', 'bar'], 'sec') === null);

// localDay 必须按本地时区，否则东八区凌晨 0-8 点会算成前一天
ok('localDay 按本地时区（凌晨 00:30 仍是当天）', localDay(new Date(2026, 7, 30, 0, 30)) === '2026-08-30', localDay(new Date(2026, 7, 30, 0, 30)));

console.log(`\n${'═'.repeat(58)}`);
console.log(`测试结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败用例：');
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log(`${'═'.repeat(58)}\n`);
process.exit(fail > 0 ? 1 : 0);
