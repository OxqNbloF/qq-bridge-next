// 记角色卡推送次数（存在 state/role-inject.json）和签名
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, atomicWriteJson } from '../store/fs-atomic.js';
import { migrateDocument, stampSchema } from '../store/schema.js';

// 创建「角色卡推送次数」的存储
export function createRoleInjectStore(b) {
  // 算当前角色卡内容的签名
  function roleCardSignature() {
    const rs = b.readRoleState();
    if (!rs.role) return '';
    const safeName = b.sanitizeRoleName(rs.role);
    if (!safeName) return '';
    try {
      const st = fs.statSync(path.join(b.ROLES_DIR, safeName + '.md'));
      return `${safeName}:${Math.round(st.mtimeMs)}:${st.size}`;
    } catch {
      return `${safeName}:missing`;
    }
  }

  const ROLE_INJECT_FILE = path.join(b.STATE_DIR, 'role-inject.json');
  let roleInjectMap = null;
  let roleInjectReadOnly = false;
    // 第一次用到时才读推送次数表
  function roleInjectStore() {
    if (roleInjectMap) return roleInjectMap;
    const loaded = readJsonSafe(ROLE_INJECT_FILE, null);
    roleInjectMap = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
        // 次数丢了最多多推一次；但不能用旧格式覆盖新文件
    try { migrateDocument('role-inject', roleInjectMap); }
    catch (error) {
      roleInjectReadOnly = true;
      b.log(`⚠️ state/role-inject.json：${error?.message ?? error}；计数只在内存里更新`);
    }
    return roleInjectMap;
  }
    // 一次写完推送次数，不会写坏
  function saveRoleInjectStore() {
        // 只读时不写；一次写完，避免留下半截文件
    if (roleInjectReadOnly) return;
    try { atomicWriteJson(ROLE_INJECT_FILE, stampSchema('role-inject', roleInjectMap ?? {})); } catch {}
  }

  return { roleCardSignature, roleInjectStore, saveRoleInjectStore };
}
