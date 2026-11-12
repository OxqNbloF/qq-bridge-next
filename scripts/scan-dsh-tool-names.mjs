// 扫描 DSH 里真实存在的工具名，和 QQ 守卫的禁用名单核对
// 名字拼错或过期，禁用就会悄悄失效
//
// 为什么要有这个脚本
// 工具名写错时，禁用那一步会悄悄失效
// 名字过时了也一样，等于白写
// DSH 升级会加新工具，名单漏掉就漏掉
// 所以要常拿安装包重新核对一遍
//
// 取名字的代码在 scripts/dsh-tool-names.mjs
// 这个文件只负责打印结果
//
// 脚本只读，不改任何文件
//
// 用法：
// node scripts/scan-dsh-tool-names.mjs 全部核对
// 加 --missing 只列出建议补进名单的名字
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectDshToolNames, dshPackagesDir, DANGER_TOOL_RE, SAFE_MODEL_TOOLS, TOOL_NAME_RE,
} from './dsh-tool-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { names, packages } = collectDshToolNames();
const guardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = await import(pathToFileURL(guardPath).href);
const guarded = new Set(guard.RESTRICTED_TOOL_NAMES);
// Codex 和 Claude Code 是选装插件，默认扫不到
// 所以扫不到不算名字写错
const optional = new Set(guard.OPTIONAL_BUNDLE_TOOL_NAMES ?? []);

const sorted = [...names.keys()].sort();
const onlyFlag = process.argv.includes('--missing');

console.log(`DSH 包目录：${dshPackagesDir()}`);
console.log(`扫描包数：${packages.length}；抽到工具名候选：${sorted.length}\n`);

// 一、名单里的名字必须真实存在，否则禁用会失效
const fabricated = [...guarded]
  .filter((n) => TOOL_NAME_RE.test(n) && !n.startsWith('dev_') && !optional.has(n) && !names.has(n));
console.log('=== ① 守卫名单里、但安装包中找不到的名字（restrict 会抛错并静默失效） ===');
console.log(fabricated.length ? fabricated.map((n) => `  ${n}`).join('\n') : '  (无)');
if (optional.size) {
  console.log(`  （另：${[...optional].join(', ')} 属于按需安装的可选组合包，默认扫不到但仍在名单里）`);
}

// 二、安装包里有、但名单没盖住的敏感工具名
const missing = sorted.filter((n) => DANGER_TOOL_RE.test(n) && !guarded.has(n) && !SAFE_MODEL_TOOLS.has(n));
console.log('\n=== ② 安装包里有、守卫名单里没有的「危险语义」名字（可能漏隐藏） ===');
console.log(missing.length ? missing.map((n) => `  ${n}  ← ${[...names.get(n)].join(', ')}`).join('\n') : '  (无)');

if (!onlyFlag) {
  console.log('\n=== ③ 全部候选名字（含来源包） ===');
  for (const n of sorted) {
    console.log(`  ${guarded.has(n) ? '[在名单]' : '[      ]'} ${n}  ← ${[...names.get(n)].join(', ')}`);
  }
}

console.log(`\n守卫名单 ${guarded.size} 个名字；其中悬空（假名）${fabricated.length} 个；候选里未覆盖的危险名 ${missing.length} 个。`);
process.exitCode = (fabricated.length === 0 && missing.length === 0) ? 0 : 1;
