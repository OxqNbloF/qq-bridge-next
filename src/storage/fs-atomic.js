// 原子文件读写与安全目录权限工具
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
}

export function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function atomicWriteText(filePath, text, { mode } = {}) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) {
      try { fs.chmodSync(tmp, mode); } catch {}
    }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

export function atomicWriteJson(filePath, value, { mode, space = 2 } = {}) {
  atomicWriteText(filePath, `${JSON.stringify(value, null, space)}\n`, { mode });
}
