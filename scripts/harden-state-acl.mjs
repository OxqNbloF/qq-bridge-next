// 收紧 state/ 目录和密码文件的权限，启动器会调用
//
// 几条原则：
// 1. 做不成就给出提示然后正常退出，不拦启动
// 2. 提示写成大白话，并告诉人下一步怎么做
// 具体做法和桥接共用 src/state-acl.mjs
//
// 用法：node scripts/harden-state-acl.mjs [--quiet]
// 加 --quiet 只在真动手或失败时才打印

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenDir, hardenFile, isHardened, manualDirCommand } from '../src/state-acl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const quiet = process.argv.includes('--quiet');
const HARDENED_SCOPE = '当前用户（chmod 700/600）';

// 不是安静模式时才打印提示
function say(msg) { if (!quiet) console.log(msg); }
// 不管什么模式都打印提示
function sayAlways(msg) { console.log(msg); }

// state/ 之外的密码文件：config.json 里存着真令牌
// 拿到它就能控制 QQ 账号，所以也要收紧
const SECRET_FILES = ['config.json']
  .map((name) => path.join(ROOT, name))
  .filter((file) => fs.existsSync(file));

// 收紧密码文件，返回还没收紧的文件数
function hardenSecretFiles() {
  let stillOpen = 0;
  for (const file of SECRET_FILES) {
    const label = path.relative(ROOT, file);
    if (isHardened(file)) { say(`[harden-acl] ${label} 权限已收紧，无需处理`); continue; }
    const result = hardenFile(file);
    if (result.ok) sayAlways(`[harden-acl] ✅ 已收紧 ${label} 权限（只保留${HARDENED_SCOPE}）。`);
    else { stillOpen += 1; sayAlways(`[harden-acl] ⚠️ 未能收紧 ${label}（${result.detail}）。`); }
  }
  return stillOpen;
}

// 先处理密码文件，免得 state/ 已收紧时提前退出漏掉
hardenSecretFiles();

if (!fs.existsSync(STATE_DIR)) {
  say(`[harden-acl] state/ 还不存在（首次启动时桥接会创建并自行收紧）：${STATE_DIR}`);
  process.exit(0);
}

if (isHardened(STATE_DIR)) {
  say(`[harden-acl] state/ 权限已收紧，无需处理：${STATE_DIR}`);
  process.exit(0);
}

sayAlways('[harden-acl] state/ 权限未收紧：其中的控制台令牌、SnowLuma 令牌、各会话令牌与 QQ 聊天记录，本机任何已登录用户都可能读到。');
sayAlways(`[harden-acl] 正在尝试收紧：${STATE_DIR}`);

const result = hardenDir(STATE_DIR);

if (result.ok) {
  sayAlways(`[harden-acl] ✅ 已收紧 state/ 权限（只保留${HARDENED_SCOPE}）。`);
  process.exit(0);
}

// 失败也没关系，桥接照样启动，控制台会给出提示
sayAlways(`[harden-acl] ⚠️ 未能收紧（${result.detail}）。桥接仍会正常启动，但这台机器上的其他登录用户可能读到 state/ 里的令牌与聊天记录。`);
sayAlways('[harden-acl] 你可以手动执行：');
sayAlways(`             ${manualDirCommand(STATE_DIR)}`);
process.exit(0);
