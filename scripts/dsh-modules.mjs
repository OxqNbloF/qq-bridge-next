// 找到 DSH 装在哪，以及它的 node_modules 在哪
// 找的顺序：先看环境变量 DSH_INSTALL_MODULES 或 DSH_MODULES；
// 再从 DSH_HOME/profiles/<配置名>/package.json 反查真实位置。
// 都找不到就直接报错，不会乱猜一个路径去用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// 找出 DSH 的数据目录在哪
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 随便哪个包能找到，就说明 node_modules 找到了
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

// 从某个文件开始往上找 node_modules 文件夹
function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// 列出可能要试的 DSH 配置目录名字
function candidateProfiles(home) {
  const names = [];
  // 把名字加进列表，重复的不加
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* 没有这个目录就当没有 */ }
  return names;
}

// 找到 DSH 的 node_modules 目录
export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try {
        const dir = findNodeModules(req.resolve(spec));
        if (dir) return dir;
      } catch { /* 这个不行就换下一个再试 */ }
    }
  }

  const err = new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
  // 用专门的错误码告诉调用方：是没装 DSH，不是脚本写坏了
  err.code = 'DSH_MODULES_NOT_FOUND';
  throw err;
}
