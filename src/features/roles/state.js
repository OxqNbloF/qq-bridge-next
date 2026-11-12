// 当前角色/静默模式状态、角色清单与角色名清洗
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, atomicWriteJson } from '../../store/fs-atomic.js';

// 创建角色状态读写函数，b 为桥接访问器
export function createRoleState(b) {
  // 列出 roles/ 下的角色名（去掉 README）
  function listRoles() {
    try {
      return fs.readdirSync(path.join(b.ROOT, 'roles'))
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .map((f) => f.slice(0, -3))
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch {
      return [];
    }
  }
  // 读角色/模式状态：{ role, mode: active|silent }
  function readRoleState() {
    return readJsonSafe(b.ROLE_STATE_FILE, { role: null, mode: 'active' });
  }
  // 写角色/模式状态
  function writeRoleState(role, mode) {
    atomicWriteJson(b.ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
  }
  // 角色名只保留字母数字、汉字和连字符
  function sanitizeRoleName(name) {
    return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
  }

  return { listRoles, readRoleState, writeRoleState, sanitizeRoleName };
}
