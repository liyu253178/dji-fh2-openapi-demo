/**
 * 开源前自检：确认仓库里没有残留的敏感信息
 *
 * 用法：node tools/check-secrets.mjs [目标目录]   （默认当前仓库根目录）
 * 命中即非零退出，可挂到 CI / pre-commit。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.vue', '.md', '.txt', '.json', '.sh', '.html', '.yml', '.yaml', '.env']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', 'api', 'tools']);

const PATTERNS = [
  { name: 'JWT / OpenAPI Token', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: '设备序列号', re: /\b(?:8UUXN2|1581F8)[A-Z0-9]{4,}\b/ },
  { name: 'UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: '疑似私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '阿里云 AK', re: /\bLTAI[A-Za-z0-9]{12,}\b/ },
  { name: '硬编码内网地址', re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
];

const found = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    // .env.example 是模板，不算泄露
    if (entry.name === '.env.example') continue;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/YOUR_[A-Z_]+/.test(line)) return; // 已经是占位符
      for (const p of PATTERNS) {
        if (p.re.test(line)) {
          found.push(`${path.relative(ROOT, full)}:${i + 1}  [${p.name}]  ${line.trim().slice(0, 100)}`);
        }
      }
    });
  }
}

walk(ROOT);

if (found.length) {
  console.error(`❌ 发现 ${found.length} 处疑似敏感信息：`);
  found.forEach((f) => console.error('  ' + f));
  process.exit(1);
}
console.log('✅ 未发现敏感信息');
