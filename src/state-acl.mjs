// 收紧 state/ 目录（700）和凭据文件（600）的权限

import fs from 'node:fs';

/** 组和其他人无任何权限位即视为已收紧 */
export function isHardened(target) {
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) return false;
    return (st.mode & 0o077) === 0;
  } catch { return false; }
}

/**
 * 收紧目录权限（拒绝符号链接，防止沿链接改写目标权限）
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return { ok: false, detail: '目标为符号链接，拒绝修改权限' };
    if (!st.isDirectory()) return { ok: false, detail: '目标不是目录' };
    fs.chmodSync(dir, 0o700);
    return { ok: true, detail: 'chmod 700' };
  } catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
}

/**
 * 收紧凭据文件权限（拒绝符号链接）
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return { ok: false, detail: '目标为符号链接，拒绝修改权限' };
    if (!st.isFile()) return { ok: false, detail: '目标不是普通文件' };
    fs.chmodSync(file, 0o600);
    return { ok: true, detail: 'chmod 600' };
  } catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
}

/** 失败时打印给人看的手动收紧命令（单引号转义防 shell 展开） */
export function manualDirCommand(dir) {
  const escaped = String(dir ?? '').replace(/'/g, `'\\''`);
  return `chmod -R go-rwx '${escaped}'`;
}
