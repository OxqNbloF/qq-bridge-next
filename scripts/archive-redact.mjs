#!/usr/bin/env node
// 删掉聊天记录里的隐私内容（正文、昵称、图片）
// 用前必须先停桥接，不然会和正在写的程序抢同一个文件
// 用法：node scripts/archive-redact.mjs <会话> <消息号> …
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessageArchive } from '../src/store/archive.js';
import { canonicalV2Key } from '../src/policy/access.js';

const args = process.argv.slice(2);
let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootIdx = args.indexOf('--root');
if (rootIdx >= 0) {
  root = path.resolve(args[rootIdx + 1] ?? '');
  args.splice(rootIdx, 2);
}
const [convArg, ...msgIds] = args;
const convId = canonicalV2Key(convArg ?? '');
if (!convId || !msgIds.length) {
  console.error('用法：node scripts/archive-redact.mjs <group:号|private:号> <msg_id> [<msg_id> …]');
  process.exit(64);
}

const stateDir = path.join(root, 'state');
const lockFile = path.join(stateDir, 'bridge.lock');
const archiveDir = path.join(stateDir, 'archive');
if (!fs.existsSync(archiveDir)) {
  console.error(`没有找到消息池目录：${archiveDir}（archive 可能从未启用）`);
  process.exit(1);
}
try {
  fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error?.code === 'EEXIST') {
    console.error(`桥接似乎正在运行（${lockFile} 存在）。请先停止桥接再执行隐私删除；若确认桥接已退出，删除该锁文件后重试。`);
    process.exit(2);
  }
  throw error;
}
let total = 0;
try {
  const archive = createMessageArchive({ dir: archiveDir, log: (m) => console.log(m) });
  for (const id of msgIds) {
    const changed = archive.redact(convId, String(id));
    total += changed;
    console.log(`${changed ? '已删除' : '未找到'}：${convId} ${id}${changed > 1 ? `（${changed} 行）` : ''}`);
  }
} finally {
  try {
    if (Number(fs.readFileSync(lockFile, 'utf8').trim()) === process.pid) fs.unlinkSync(lockFile);
  } catch {}
}
process.exit(total > 0 ? 0 : 3);
