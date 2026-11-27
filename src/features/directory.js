// 成员名录与隐私脱敏投影：称呼/别名归并，模型侧隐藏真实账号并保护图片 Base64
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

const SENSITIVE_ID_KEYS = new Set(['senderId', 'userId', 'user_id', 'qq', 'senderAccount']);
const SAFE_ALIAS_RE = /^[\p{L}\p{N}_\-\s·]{1,32}$/u;

export function memberTag(rawId) {
  return `u-${crypto.createHash('sha256').update(String(rawId ?? '')).digest('hex').slice(0, 16)}`;
}

export function isBinaryImageField(parent, field, value) {
  if (typeof value !== 'string' || value.length < 64) return false;
  if (field === 'base64' || field === 'data') return true;
  if (value.startsWith('data:image/')) return true;
  return Boolean(parent && typeof parent === 'object' && parent.type === 'image' && field === 'content');
}

export function createMemberDirectory({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'directory.json') : '';
  const records = new Map();

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (saved && typeof saved.records === 'object' && !Array.isArray(saved.records)) {
      for (const [id, rec] of Object.entries(saved.records)) {
        if (rec && typeof rec === 'object') records.set(id, rec);
      }
    }
  }

  function persist() {
    if (filePath) atomicWriteJson(filePath, { records: Object.fromEntries(records.entries()) }, { mode: 0o600 });
  }

  function pushUniqueCapped(arr, val, cap) {
    const clean = String(val ?? '').trim();
    if (!clean || !SAFE_ALIAS_RE.test(clean)) return false;
    const next = arr.filter((x) => x !== clean);
    next.unshift(clean);
    if (next.length > cap) next.length = cap;
    arr.splice(0, arr.length, ...next);
    return true;
  }

  function ensureRecord(rawId) {
    const id = String(rawId ?? '').trim();
    let r = records.get(id);
    if (!r) {
      r = { memberId: id, tag: memberTag(id), globalNames: [], roomNames: {}, aliases: {}, updatedAt: Date.now() };
      records.set(id, r);
    }
    return r;
  }

  function observe({ roomId = '', senderId, nickname = '', card = '' } = {}) {
    const cfg = getConfig();
    if (cfg?.directory?.enabled === false || cfg?.directory?.autoLearn === false) return null;
    const id = String(senderId ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) return null;
    const cap = Math.max(1, Number(cfg?.directory?.maxAliases ?? 8));
    const r = ensureRecord(id);
    let changed = false;
    if (nickname) changed = pushUniqueCapped(r.globalNames, nickname, cap) || changed;
    if (card && roomId) {
      r.roomNames[roomId] ??= [];
      changed = pushUniqueCapped(r.roomNames[roomId], card, cap) || changed;
    }
    if (changed) { r.updatedAt = Date.now(); persist(); }
    return r;
  }

  function addAlias({ roomId = 'global', memberId, alias } = {}) {
    const id = String(memberId ?? '').trim();
    const clean = String(alias ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) throw new Error('成员 ID 必须为纯数字');
    if (!clean || !SAFE_ALIAS_RE.test(clean)) throw new Error('别名格式非法或过长');
    const cap = Math.max(1, Number(getConfig()?.directory?.maxAliases ?? 8));
    const r = ensureRecord(id);
    const scope = roomId || 'global';
    r.aliases[scope] ??= [];
    pushUniqueCapped(r.aliases[scope], clean, cap);
    r.updatedAt = Date.now();
    persist();
    return r;
  }

  function removeAlias({ roomId = 'global', memberId, alias } = {}) {
    const r = records.get(String(memberId ?? '').trim());
    if (!r) return false;
    const scope = roomId || 'global';
    const arr = r.aliases?.[scope];
    if (!arr) return false;
    const next = arr.filter((x) => x !== alias);
    if (next.length === arr.length) return false;
    r.aliases[scope] = next;
    r.updatedAt = Date.now();
    persist();
    return true;
  }

  function displayNameFor(roomId, memberId) {
    const id = String(memberId ?? '').trim();
    const r = records.get(id);
    if (!r) return memberTag(id);
    return r.aliases?.[roomId]?.[0]
      || r.roomNames?.[roomId]?.[0]
      || r.aliases?.global?.[0]
      || r.globalNames?.[0]
      || r.tag;
  }

  function snapshot() {
    return [...records.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function formatRoster(roomId, { revealRawId = false, maxEntries = 20 } = {}) {
    const entries = snapshot().filter((r) => (
      r.roomNames?.[roomId]?.length || r.aliases?.[roomId]?.length
    )).slice(0, maxEntries);
    if (!entries.length) return '';
    return entries.map((r) => {
      const name = displayNameFor(roomId, r.memberId);
      const all = [...new Set([...(r.aliases?.[roomId] ?? []), ...(r.roomNames?.[roomId] ?? []), ...r.globalNames])].slice(0, 4);
      const idLabel = revealRawId ? r.memberId : r.tag;
      return `- ${name} (${idLabel})${all.length > 1 ? ` 别名: ${all.join('/')}` : ''}`;
    }).join('\n');
  }

  function maskTextIds(roomId, str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\b(\d{5,15})\b/g, (m, digits) => (
      records.has(digits) ? displayNameFor(roomId, digits) : m
    ));
  }

  function sanitizeForModel(roomId, value, { revealRawId } = {}) {
    const expose = revealRawId !== undefined ? Boolean(revealRawId) : (getConfig()?.directory?.revealRawId === true);
    if (expose) return value;

    const walk = (node, parent = null, keyName = '') => {
      if (node === null || node === undefined) return node;
      if (typeof node === 'string') {
        if (isBinaryImageField(parent, keyName, node)) return node;
        return maskTextIds(roomId, node);
      }
      if (typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map((item, idx) => walk(item, node, String(idx)));
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (SENSITIVE_ID_KEYS.has(k)) {
          if (v && v !== 'self') {
            out.memberTag = memberTag(v);
            if (!out.senderName && !out.nickname) out.senderName = displayNameFor(roomId, v);
          }
          continue;
        }
        out[k] = walk(v, node, k);
      }
      return out;
    };

    return walk(value);
  }

  return { observe, addAlias, removeAlias, displayNameFor, snapshot, formatRoster, sanitizeForModel };
}
