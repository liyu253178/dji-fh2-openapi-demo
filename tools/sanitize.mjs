/**
 * 开源前脱敏：把仓库里的真实标识替换成占位符
 *
 * 用法：node tools/sanitize.mjs [目标目录]   （默认当前仓库根目录）
 * 只处理文本类文件（.js/.mjs/.vue/.md/.txt/.json/.sh/.html），跳过二进制与 node_modules。
 *
 * 规则可自行扩展；改完务必再跑一次 tools/check-secrets.mjs 确认干净。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.vue', '.md', '.txt', '.json', '.sh', '.html', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'api']);

const RULES = [
  {
    name: 'JWT / OpenAPI Token',
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    to: 'YOUR_FH2_TOKEN',
  },
  {
    name: '设备序列号（机场 / 飞行器）',
    // 大疆机场常见 8UUXN2* / 1581F8* 前缀，按自己的设备前缀扩展
    re: /\b(?:8UUXN2|1581F8)[A-Z0-9]{4,}\b/g,
    to: 'YOUR_DEVICE_SN',
  },
  {
    name: '项目 / 组织 UUID',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    to: 'YOUR_PROJECT_UUID',
  },
];

let touched = 0;
let hits = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    let text = fs.readFileSync(full, 'utf8');
    let changed = false;
    for (const rule of RULES) {
      const next = text.replace(rule.re, rule.to);
      if (next !== text) {
        const count = text.match(rule.re)?.length || 0;
        hits += count;
        console.log(`  [${rule.name}] ${path.relative(ROOT, full)} → ${count} 处`);
        text = next;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(full, text, 'utf8');
      touched += 1;
    }
  }
}

console.log(`脱敏目标目录：${ROOT}`);
walk(ROOT);
console.log(`完成：修改 ${touched} 个文件，替换 ${hits} 处`);
