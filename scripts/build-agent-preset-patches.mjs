#!/usr/bin/env node
// 生成和更新助手预设补丁文件的小工具。
// 真正干活的代码在 src/preset-patch.js，这里只是入口。
//
// 用法：
//   node scripts/build-agent-preset-patches.mjs
//   直接运行就生成或更新补丁文件
//   加 --check 只检查，不写文件，不一致就报错退出
//   只检查补丁文件是不是最新，不是就报错退出
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPatches } from '../src/preset-patch.js';

export * from '../src/preset-patch.js';

// 直接运行就生成；加 --check 只检查不写。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const results = buildPatches({ check, log: (line) => console.log(`[preset-patches] ${line}`) });
  const stale = results.filter((r) => r.changed);
  if (check && stale.length > 0) {
    console.error(`[preset-patches] ERROR: ${stale.length} 个 patch 文件与源不一致；请运行 node scripts/build-agent-preset-patches.mjs`);
    process.exit(1);
  }
  console.log('[preset-patches] Done');
}
