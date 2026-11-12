// 记忆视图：给人看的只读文本，删了也不丢数据
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteText } from './fs-atomic.js';

/** 把会话名变成安全的文件夹名，防止跳出目录 */
export function safeConvName(convId) {
  return String(convId).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\./, '_') || '_';
}

/** 会话重置：删掉该会话的视图目录。 */
export function removeMemoryView({ dir, convId }) {
  fs.rmSync(path.join(dir, safeConvName(convId)), { recursive: true, force: true });
}

// 把这个会话的记忆写成给人看的文件
export function writeMemoryView({ dir, convId, text }) {
  const file = path.join(dir, safeConvName(convId), 'memory.md');
  atomicWriteText(file, text);
  return file;
}
