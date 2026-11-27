// 身份别名与隐私投影：按 QQ 归并称呼/昵称，对模型隐藏真实 QQ 号（保留图片 Base64 数据完整）
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

const HIDDEN_ID_FIELDS = new Set(['qq', 'userId', 'user_id', 'senderId', 'senderQq', 'isOwner', 'ownerLabel']);
const SAFE_ALIAS_RE = /^[\p{L}\p{N}_\-\s·]{1,32}$/u;

export function memberRef(userId) {
  return `member-${crypto.createHash('sha256').update(String(userId ?? '')).digest('hex').slice(0, 16)}`;
}

export function isImageBase64Field(parent, field, value) {
  if (typeof value !== 'string' || value.length < 64) return false;
  if (field === 'base64' || field === 'data') return true;
  if (value.startsWith('data:image/')) return true;
  return Boolean(parent && typeof parent === 'object' && parent.type === 'image' && field === 'content');
}

export function createIdentityStore({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'identity.json') : '';
  // profiles[userId] = { userId, ref, globalNames: [], groupNames: { [convKey]: [] }, aliases: { [convKey]: [] }, updatedAt }
  const profiles = new Map();

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (saved && typeof saved.profiles === 'object' && !Array.isArray(saved.profiles)) {
      for (const [uid, p] of Object.entries(saved.profiles)) {
        if (p && typeof p === 'object') profiles.set(uid, p);
      }
    }
  }

  function persist() {
    if (!filePath) return;
    atomicWriteJson(filePath, { profiles: Object.fromEntries(profiles.entries()) }, { mode: 0o600 });
  }

  function pushUniqueCapped(arr, val, cap) {
    const clean = String(val ?? '').trim();
    if (!clean || !SAFE_ALIAS_RE.test(clean)) return false;
    const filtered = arr.filter((x) => x !== clean);
    filtered.unshift(clean);
    if (filtered.length > cap) filtered.length = cap;
    arr.splice(0, arr.length, ...filtered);
    return true;
  }

  function ensureProfile(userId) {
    const uid = String(userId ?? '').trim();
    let p = profiles.get(uid);
    if (!p) {
      p = {
        userId: uid,
        ref: memberRef(uid),
        globalNames: [],
        groupNames: {},
        aliases: {},
        updatedAt: Date.now(),
      };
      profiles.set(uid, p);
    }
    return p;
  }

  function observe({ convKey = '', userId, nickname = '', card = '' } = {}) {
    const cfg = getConfig();
    if (cfg?.identity?.enabled === false || cfg?.identity?.learnFromChat === false) return null;
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,20}$/.test(uid)) return null;
    const maxAliases = Math.max(1, Number(cfg?.identity?.maxAliasesPerUser ?? 8));
    const p = ensureProfile(uid);
    let changed = false;
    if (nickname) changed = pushUniqueCapped(p.globalNames, nickname, maxAliases) || changed;
    if (card && convKey) {
      p.groupNames[convKey] ??= [];
      changed = pushUniqueCapped(p.groupNames[convKey], card, maxAliases) || changed;
    }
    if (changed) {
      p.updatedAt = Date.now();
      persist();
    }
    return p;
  }

  function addAlias({ convKey = 'global', userId, alias } = {}) {
    const uid = String(userId ?? '').trim();
    const clean = String(alias ?? '').trim();
    if (!/^\d{1,20}$/.test(uid)) throw new Error('QQ 号必须为纯数字');
    if (!clean || !SAFE_ALIAS_RE.test(clean)) throw new Error('别名格式非法或过长');
    const maxAliases = Math.max(1, Number(getConfig()?.identity?.maxAliasesPerUser ?? 8));
    const p = ensureProfile(uid);
    const scope = convKey || 'global';
    p.aliases[scope] ??= [];
    pushUniqueCapped(p.aliases[scope], clean, maxAliases);
    p.updatedAt = Date.now();
    persist();
    return p;
  }

  function removeAlias({ convKey = 'global', userId, alias } = {}) {
    const p = profiles.get(String(userId ?? '').trim());
    if (!p) return false;
    const scope = convKey || 'global';
    const arr = p.aliases?.[scope];
    if (!arr) return false;
    const next = arr.filter((x) => x !== alias);
    if (next.length === arr.length) return false;
    p.aliases[scope] = next;
    p.updatedAt = Date.now();
    persist();
    return true;
  }

  function resolveDisplayName(convKey, userId) {
    const uid = String(userId ?? '').trim();
    const p = profiles.get(uid);
    if (!p) return memberRef(uid);
    return p.aliases?.[convKey]?.[0]
      || p.groupNames?.[convKey]?.[0]
      || p.aliases?.global?.[0]
      || p.globalNames?.[0]
      || p.ref;
  }

  function listSnapshot() {
    return [...profiles.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function renderRoster(convKey, { exposeQq = false, maxEntries = 20 } = {}) {
    const entries = listSnapshot().filter((p) => (
      p.groupNames?.[convKey]?.length || p.aliases?.[convKey]?.length
    )).slice(0, maxEntries);
    if (!entries.length) return '';
    return entries.map((p) => {
      const name = resolveDisplayName(convKey, p.userId);
      const allAliases = [...new Set([...(p.aliases?.[convKey] ?? []), ...(p.groupNames?.[convKey] ?? []), ...p.globalNames])].slice(0, 4);
      const idLabel = exposeQq ? p.userId : p.ref;
      return `- ${name} (${idLabel})${allAliases.length > 1 ? ` 别名: ${allAliases.join('/')}` : ''}`;
    }).join('\n');
  }

  function maskStringIds(convKey, str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\b(\d{5,15})\b/g, (m, digits) => (
      profiles.has(digits) ? resolveDisplayName(convKey, digits) : m
    ));
  }

  function projectForModel(convKey, value, { exposeQq } = {}) {
    const shouldExpose = exposeQq !== undefined ? Boolean(exposeQq) : (getConfig()?.identity?.exposeQqInPrompt === true);
    if (shouldExpose) return value;

    const walk = (node, parent = null, keyName = '') => {
      if (node === null || node === undefined) return node;
      if (typeof node === 'string') {
        if (isImageBase64Field(parent, keyName, node)) return node;
        return maskStringIds(convKey, node);
      }
      if (typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map((item, idx) => walk(item, node, String(idx)));
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (HIDDEN_ID_FIELDS.has(k)) {
          if ((k === 'userId' || k === 'user_id' || k === 'qq' || k === 'senderId') && v && v !== 'self') {
            out.memberRef = memberRef(v);
            if (!out.senderName && !out.nickname) out.senderName = resolveDisplayName(convKey, v);
          }
          continue;
        }
        out[k] = walk(v, node, k);
      }
      return out;
    };

    return walk(value);
  }

  return {
    observe,
    addAlias,
    removeAlias,
    resolveDisplayName,
    listSnapshot,
    renderRoster,
    projectForModel,
  };
}
