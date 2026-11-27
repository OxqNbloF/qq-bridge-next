// 角色卡库与每会话开场说明（Markdown 文件 + 元数据，按唤醒节奏节能注入）
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, atomicWriteText, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

const SAFE_ROLE_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{1,48}$/;

export function normalizeRoleName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || !SAFE_ROLE_RE.test(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`角色名非法：${JSON.stringify(raw)}（仅允许中英文、数字、_-，最长 48 字符）`);
  }
  return name;
}

export function createRoleStore({ dataDir = '', getConfig = () => ({}) } = {}) {
  const rolesDir = dataDir ? path.join(dataDir, 'roles') : '';
  const metaFile = dataDir ? path.join(dataDir, 'roles.json') : '';
  const memoryRoles = new Map();
  let state = { activeRole: '', initialPrompts: {} };
  const injectCounter = new Map(); // convKey -> { roleName, countSinceFull }

  if (rolesDir) ensureDir(rolesDir);
  if (metaFile) {
    const saved = readJsonSafe(metaFile, null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      state = {
        activeRole: String(saved.activeRole ?? ''),
        initialPrompts: saved.initialPrompts && typeof saved.initialPrompts === 'object' ? { ...saved.initialPrompts } : {},
      };
    }
  }

  function saveMeta() {
    if (!metaFile) return;
    atomicWriteJson(metaFile, state, { mode: 0o600 });
  }

  function roleFilePath(name) {
    const clean = normalizeRoleName(name);
    const full = path.resolve(rolesDir, `${clean}.md`);
    if (!full.startsWith(path.resolve(rolesDir) + path.sep)) throw new Error('禁止角色路径穿越');
    return full;
  }

  function listRoles() {
    const out = [];
    if (rolesDir && fs.existsSync(rolesDir)) {
      for (const entry of fs.readdirSync(rolesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const name = entry.name.slice(0, -3);
        const content = fs.readFileSync(path.join(rolesDir, entry.name), 'utf8');
        out.push({ name, chars: content.length, active: state.activeRole === name });
      }
      return out;
    }
    for (const [name, content] of memoryRoles) {
      out.push({ name, chars: content.length, active: state.activeRole === name });
    }
    return out;
  }

  function getRole(name) {
    const clean = normalizeRoleName(name);
    if (rolesDir) {
      const fp = roleFilePath(clean);
      if (!fs.existsSync(fp)) return null;
      return { name: clean, content: fs.readFileSync(fp, 'utf8'), active: state.activeRole === clean };
    }
    if (!memoryRoles.has(clean)) return null;
    return { name: clean, content: memoryRoles.get(clean), active: state.activeRole === clean };
  }

  function saveRole(name, content) {
    const clean = normalizeRoleName(name);
    const body = String(content ?? '').trim();
    if (!body) throw new Error('角色卡内容不能为空');
    if (rolesDir) {
      atomicWriteText(roleFilePath(clean), `${body}\n`, { mode: 0o600 });
    } else {
      memoryRoles.set(clean, body);
    }
    return { name: clean, chars: body.length, active: state.activeRole === clean };
  }

  function deleteRole(name) {
    const clean = normalizeRoleName(name);
    let existed = false;
    if (rolesDir) {
      const fp = roleFilePath(clean);
      if (fs.existsSync(fp)) {
        fs.rmSync(fp, { force: true });
        existed = true;
      }
    } else {
      existed = memoryRoles.delete(clean);
    }
    if (state.activeRole === clean) {
      state.activeRole = '';
      saveMeta();
    }
    return existed;
  }

  function getActiveRole() {
    if (!state.activeRole) return { name: '', content: '' };
    const card = getRole(state.activeRole);
    return card ? { name: card.name, content: card.content } : { name: '', content: '' };
  }

  function setActiveRole(name) {
    if (!name || !String(name).trim()) {
      state.activeRole = '';
      injectCounter.clear();
      saveMeta();
      return { name: '', content: '' };
    }
    const card = getRole(name);
    if (!card) throw new Error(`角色卡不存在：${name}`);
    state.activeRole = card.name;
    injectCounter.clear();
    saveMeta();
    return { name: card.name, content: card.content };
  }

  function getInitialPrompt(convKey) {
    const limit = Number(getConfig()?.persona?.maxInitialPromptChars) || 1000;
    const raw = String(state.initialPrompts?.[convKey] ?? '').trim();
    return raw.slice(0, limit);
  }

  function setInitialPrompt(convKey, text) {
    const limit = Number(getConfig()?.persona?.maxInitialPromptChars) || 1000;
    const clean = String(text ?? '').trim().slice(0, limit);
    if (!clean) {
      delete state.initialPrompts[convKey];
    } else {
      state.initialPrompts[convKey] = clean;
    }
    saveMeta();
    return clean;
  }

  function listInitialPrompts() {
    return { ...state.initialPrompts };
  }

  function resolvePromptInjection(convKey, { forceFull = false } = {}) {
    const active = getActiveRole();
    const initialPrompt = getInitialPrompt(convKey);
    if (!active.name || !active.content) {
      return { roleName: '', roleCardText: '', initialPrompt, full: false };
    }
    const maxChars = Number(getConfig()?.persona?.maxInjectChars) || 4000;
    const everyN = Math.max(0, Number(getConfig()?.persona?.injectEveryNWakes ?? 4));
    const tracker = injectCounter.get(convKey);
    const shouldFull = forceFull
      || !tracker
      || tracker.roleName !== active.name
      || everyN <= 1
      || tracker.countSinceFull >= everyN;

    if (shouldFull) {
      injectCounter.set(convKey, { roleName: active.name, countSinceFull: 1 });
      return {
        roleName: active.name,
        roleCardText: active.content.slice(0, maxChars),
        initialPrompt,
        full: true,
      };
    }
    tracker.countSinceFull += 1;
    return {
      roleName: active.name,
      roleCardText: '',
      initialPrompt,
      full: false,
    };
  }

  return {
    listRoles,
    getRole,
    saveRole,
    deleteRole,
    getActiveRole,
    setActiveRole,
    getInitialPrompt,
    setInitialPrompt,
    listInitialPrompts,
    resolvePromptInjection,
  };
}
