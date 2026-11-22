#!/usr/bin/env node
// 删掉聊天记录里的隐私内容（正文、昵称、图片）
// 用前必须先停桥接，不然会和正在写的程序抢同一个文件
// 用法：node scripts/archive-redact.mjs <会话> <消息号> …
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMessageArchive } from '../src/store/archive.js';
import { createMemoryPool } from '../src/store/pool.js';
import { redactMemoryPool, redactLightMemory, redactActivityLog, redactMemoryMigrationBackups } from '../src/memory/redact.js';
import { removeMemoryView, safeConvName } from '../src/store/views.js';
import { atomicWriteJson } from '../src/store/fs-atomic.js';
import { redactIdentityAliases } from '../src/identity/registry.js';
import { migrateDocument } from '../src/store/schema.js';
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
const releaseOwnLock = () => {
  try {
    if (Number(fs.readFileSync(lockFile, 'utf8').trim()) === process.pid) fs.unlinkSync(lockFile);
  } catch {}
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    releaseOwnLock();
    process.exit(130);
  });
}
let foundAny = false;
const cleanupErrors = [];
let partial = false;
const cleanup = (label, action) => {
  try { return action(); }
  catch (error) {
    partial = true;
    cleanupErrors.push(`${label}：${error?.message ?? error}`);
    console.error(`归档脱敏已完成；${label}清理跳过：${error?.message ?? error}`);
    return undefined;
  }
};
try {
  const pool = createMemoryPool({ file: path.join(stateDir, 'pool', 'items.jsonl') });
  const archive = createMessageArchive({ dir: archiveDir, log: (m) => console.log(m), onRedact: (key, id) => {
    const errorOffset = cleanupErrors.length;
    cleanup('活动日志', () => redactActivityLog(path.join(stateDir, 'qq-activity.log'), key, id));
    cleanup('迁移备份', () => redactMemoryMigrationBackups(stateDir, key, id));
    cleanup('学习侧车', () => fs.rmSync(path.join(stateDir, 'memory-session.json'), { force: true }));
    const removed = cleanup('记忆池', () => redactMemoryPool(pool, key, id)) ?? [];
    const socialFile = path.join(stateDir, 'social-v2.json');
    cleanup('会话状态', () => {
      if (fs.existsSync(socialFile)) {
        const social = JSON.parse(fs.readFileSync(socialFile, 'utf8'));
        migrateDocument('social-v2', social);
        const state = social.conversations?.[key];
        if (state) {
          redactLightMemory(state, id);
          for (const field of ['recentMessages', 'unread']) {
            if (Array.isArray(state[field])) state[field] = state[field].filter(item => String(item.messageId) !== String(id));
          }
          atomicWriteJson(socialFile, social);
        }
      }
    });
    const identityFile = path.join(stateDir, 'identity.json');
    cleanup('身份状态', () => {
      if (fs.existsSync(identityFile)) {
        const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        migrateDocument('identity', identity);
        redactIdentityAliases(identity, key, id, removed);
        atomicWriteJson(identityFile, identity);
      }
    });
    cleanup('记忆视图', () => removeMemoryView({ dir: path.join(stateDir, 'views'), convId: key }));
    cleanup('检索索引', () => { for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(stateDir, 'index', `${safeConvName(key)}.sqlite${suffix}`), { force: true }); });
    const errors = cleanupErrors.slice(errorOffset);
    return { ok: errors.length === 0, errors };
  } });
  for (const id of msgIds) {
    const { changed, found, cleanup: result } = archive.redact(convId, String(id));
    foundAny ||= found;
    partial ||= !result.ok;
    console.log(`${changed ? '已删除' : found ? '已脱敏（重试清理）' : '未找到'}：${convId} ${id}${changed > 1 ? `（${changed} 行）` : ''}`);
  }
} finally {
  releaseOwnLock();
}
if (partial) console.error('部分完成：归档已脱敏，以上派生数据需修复后重试清理。');
process.exit(partial ? 4 : foundAny ? 0 : 3);
