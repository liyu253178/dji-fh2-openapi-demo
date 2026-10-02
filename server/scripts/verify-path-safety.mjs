/**
 * 模型库路径安全验证（P0-2 回归断言）
 *
 * 历史漏洞：路由用 path.join(CACHE_ROOT, id) 构造目录，再以该目录为基准做越界校验。
 * id 未校验 → '../..' 把基准本身抬出根目录 → 校验恒真 → 可读到 data/tokens.json（明文 TK）。
 *
 * 本脚本用真实文件系统验证修复后的三层防线（id 白名单 / CACHE_ROOT 基准 / realpath）。
 * 运行：node scripts/verify-path-safety.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.resolve(__dirname, '../data/models');
const SERVER_DATA = path.resolve(__dirname, '../data');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const { safeModelDir, resolveModelFile } = await import('../src/routes/model.js');

console.log('\n=== 模型库路径安全验证 ===\n');

console.log('1. id 白名单');
check('纯数字 id 放行', safeModelDir('280292876') === path.join(CACHE_ROOT, '280292876'));
check('含字母/下划线/短横 id 放行', safeModelDir('abc-123_X') === path.join(CACHE_ROOT, 'abc-123_X'));
check('拒绝 ../.. 穿越', safeModelDir('../../../../etc') === null);
check('拒绝单层 ..', safeModelDir('..') === null);
check('拒绝单点 .', safeModelDir('.') === null);
check('拒绝绝对路径', safeModelDir('/etc/passwd') === null);
check('拒绝含斜杠', safeModelDir('a/b') === null);
check('拒绝含反斜杠', safeModelDir('a\\b') === null);
check('拒绝空串', safeModelDir('') === null);
check('拒绝非法类型', safeModelDir(null) === null && safeModelDir(123) === null);
check('拒绝超长 id', safeModelDir('a'.repeat(200)) === null);

// 即使构造出的路径合法，也必须落在 CACHE_ROOT 之内
const escaped = safeModelDir('280292876');
check('合法 id 的结果仍在 CACHE_ROOT 内', escaped !== null && escaped.startsWith(CACHE_ROOT + path.sep));

console.log('\n2. 真实穿越尝试（必须拿不到数据区文件）');
const traversalTargets = [
  ['../../../../tokens.json', '../../tokens.json'],
  ['..', 'tokens.json'],
  ['../..', 'data/tokens.json'],
  ['..%2f..', 'tokens.json'],
];
for (const [id, rel] of traversalTargets) {
  const got = await resolveModelFile(id, rel);
  check(`id=${JSON.stringify(id)} rel=${JSON.stringify(rel)} 被拒`, got === null, got || '');
}
// 旧实现下这条能读到明文 TK 文件，是本次修复的核心用例
check(
  '核心用例：无法越出 CACHE_ROOT 读取 data/tokens.json',
  (await resolveModelFile('..', 'tokens.json')) === null
);

console.log('\n3. 真实文件仍能正常读取');
fs.mkdirSync(CACHE_ROOT, { recursive: true });
const testId = 'pathguard-test-000';
const testDir = path.join(CACHE_ROOT, testId);
await fsp.rm(testDir, { recursive: true, force: true });
await fsp.mkdir(path.join(testDir, 'sub'), { recursive: true });
await fsp.writeFile(path.join(testDir, 'hello.txt'), 'hello');
await fsp.writeFile(path.join(testDir, 'sub', 'deep.bin'), Buffer.from([1, 2, 3]));

check(
  '包内普通文件可读',
  (await resolveModelFile(testId, 'hello.txt')) === path.join(testDir, 'hello.txt')
);
check(
  '包内子目录文件可读',
  (await resolveModelFile(testId, 'sub/deep.bin')) === path.join(testDir, 'sub', 'deep.bin')
);
check('不存在的文件返回 null', (await resolveModelFile(testId, 'nope.txt')) === null);
check('目录默认不放行', (await resolveModelFile(testId, 'sub')) === null);
check('目录在 allowDir 下放行', (await resolveModelFile(testId, 'sub', { allowDir: true })) !== null);
check('空 rel 返回 null', (await resolveModelFile(testId, '')) === null);

console.log('\n4. 符号链接逃逸');
// 模型目录内放一个指向数据区的符号链接：逻辑路径检查看不出来，必须 realpath
const linkPath = path.join(testDir, 'leak.json');
let symlinkOk = true;
try {
  const realTokenFile = path.join(SERVER_DATA, 'tokens.json');
  if (!fs.existsSync(realTokenFile)) {
    await fsp.writeFile(realTokenFile + '.pathtest', 'x');
    fs.symlinkSync(realTokenFile + '.pathtest', linkPath);
  } else {
    fs.symlinkSync(realTokenFile, linkPath);
  }
} catch {
  symlinkOk = false;
}
if (symlinkOk) {
  check('指向外部的符号链接被拒', (await resolveModelFile(testId, 'leak.json')) === null);
  await fsp.unlink(linkPath).catch(() => {});
  await fsp.rm(path.join(SERVER_DATA, 'tokens.json.pathtest'), { force: true }).catch(() => {});
} else {
  console.log('  · 无法创建符号链接，跳过');
}

await fsp.rm(testDir, { recursive: true, force: true });

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过\n');
