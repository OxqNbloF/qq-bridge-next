// 修好 @snowluma 系列包的一个小毛病：
// 包里的文件互相引用时少了 .js，Node 认不出来，这里补上。
// 装完需要的包后自动跑一遍，只补能对上的，其他不动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TARGETS = ['@snowluma/sdk', '@snowluma/mcp'];

// 把这个文件夹里所有文件一层层全找出来
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function resolveRelativeSpec(file, spec) {
  if (!spec.startsWith('.')) return spec;
  if (spec.endsWith('.js') || spec.endsWith('.mjs') || spec.endsWith('.cjs') || spec.endsWith('.json')) return spec;
  const target = path.resolve(path.dirname(file), spec);
  if (fs.existsSync(target + '.js') && fs.statSync(target + '.js').isFile()) return spec + '.js';
  if (fs.existsSync(target + '.json') && fs.statSync(target + '.json').isFile()) return spec + '.json';
  if (fs.existsSync(path.join(target, 'index.js')) && fs.statSync(path.join(target, 'index.js')).isFile()) {
    return spec.replace(/\/+$/, '') + '/index.js';
  }
  return spec;
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 覆盖 from '...' / from "..."、副作用 import '...'、动态 import('...')
const SPEC_RE = /(\b(?:from|import)\s*\(\s*|\bfrom\s+|\bimport\s+)(['"])(\.[^'"\r\n]+)\2/g;

let total = 0;
const presentTargets = [];
for (const pkg of TARGETS) {
  const distRoot = path.join(ROOT, 'node_modules', pkg, 'dist');
  if (!fs.existsSync(distRoot)) {
    console.log(`[patch-snowluma] ${pkg}: dist 不存在，跳过`);
    continue;
  }
  presentTargets.push(pkg);
  let patched = 0;
  for (const file of walk(distRoot)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    const next = src.replace(SPEC_RE, (full, prefix, quote, spec) => {
      const resolved = resolveRelativeSpec(file, spec);
      return resolved === spec ? full : `${prefix}${quote}${resolved}${quote}`;
    });
    if (next !== src) {
      writeAtomic(file, next);
      patched += 1;
    }
  }
  console.log(`[patch-snowluma] ${pkg}: 修补了 ${patched} 个文件`);
  total += patched;
}
console.log(`[patch-snowluma] 合计 ${total} 个文件`);

for (const pkg of presentTargets) {
  try {
    await import(pkg);
  } catch (error) {
    console.error(`[patch-snowluma] 校验导入 ${pkg} 失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
