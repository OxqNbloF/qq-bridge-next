// 收紧 state/ 目录（700）和凭据文件（600）的权限

import fs from 'node:fs';

/** 组和其他人无任何权限位即视为已收紧 */
export function isHardened(target) {
  try { return (fs.statSync(target).mode & 0o077) === 0; } catch { return false; }
}

/**
 * 收紧目录权限
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenDir(dir) {
  try { fs.chmodSync(dir, 0o700); return { ok: true, detail: 'chmod 700' }; }
  catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
}

/**
 * 收紧凭据文件权限
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenFile(file) {
  try { fs.chmodSync(file, 0o600); return { ok: true, detail: 'chmod 600' }; }
  catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
}

/** 失败时打印给人看的手动收紧命令 */
export function manualDirCommand(dir) {
  return `chmod -R go-rwx "${dir}"`;
}
