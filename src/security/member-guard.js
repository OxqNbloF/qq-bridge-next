// 精细成员策略：按群成员独立控制 canTrigger / canEngage / inContext / inMemory 四开关
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';
import { parseRoomId } from './perimeter.js';

export const CAPABILITY_KEYS = Object.freeze(['canTrigger', 'canEngage', 'inContext', 'inMemory']);
export const MEMBER_POLICY_MODES = Object.freeze(['open', 'deny_listed', 'allow_listed']);
export const DEFAULT_CAPABILITIES = Object.freeze({ canTrigger: true, canEngage: true, inContext: true, inMemory: true });

export function normalizeCapabilities(raw, fallback = DEFAULT_CAPABILITIES) {
  const out = {};
  for (const key of CAPABILITY_KEYS) {
    out[key] = raw && typeof raw[key] === 'boolean' ? raw[key] : Boolean(fallback[key]);
  }
  return out;
}

export function createMemberGuard({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'member-rules.json') : '';
  let doc = { version: 1, groups: {} };

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (saved && typeof saved.groups === 'object' && !Array.isArray(saved.groups)) {
      doc = { version: 1, groups: saved.groups };
    }
  }

  function persist() {
    if (!filePath) return;
    atomicWriteJson(filePath, doc, { mode: 0o600 });
  }

  function getGroupRule(rawGroupId) {
    const gid = String(rawGroupId ?? '').trim();
    const g = doc.groups[gid];
    if (!g) return { groupId: gid, mode: 'open', defaults: { ...DEFAULT_CAPABILITIES }, members: {} };
    return {
      groupId: gid,
      mode: MEMBER_POLICY_MODES.includes(g.mode) ? g.mode : 'open',
      defaults: normalizeCapabilities(g.defaults, DEFAULT_CAPABILITIES),
      members: g.members && typeof g.members === 'object' ? structuredClone(g.members) : {},
    };
  }

  function setGroupRule(rawGroupId, { mode, defaults } = {}) {
    const gid = String(rawGroupId ?? '').trim();
    if (!/^\d{1,20}$/.test(gid)) throw new Error(`群号格式非法：${rawGroupId}`);
    const cur = getGroupRule(gid);
    const nextMode = mode !== undefined ? String(mode) : cur.mode;
    if (!MEMBER_POLICY_MODES.includes(nextMode)) throw new Error(`成员策略模式非法：${nextMode}`);
    doc.groups[gid] = {
      mode: nextMode,
      defaults: defaults ? normalizeCapabilities(defaults, cur.defaults) : cur.defaults,
      members: cur.members,
    };
    persist();
    return getGroupRule(gid);
  }

  function setMemberCapabilities(rawGroupId, rawMemberId, patch = {}) {
    const gid = String(rawGroupId ?? '').trim();
    const mid = String(rawMemberId ?? '').trim();
    if (!/^\d{1,20}$/.test(gid) || !/^\d{1,20}$/.test(mid)) {
      throw new Error('群号与成员 ID 必须为纯数字');
    }
    const cur = getGroupRule(gid);
    const prev = cur.members[mid] ?? {};
    cur.members[mid] = {
      ...prev,
      ...normalizeCapabilities(patch, prev.canTrigger === undefined ? cur.defaults : prev),
      ...(patch.note !== undefined ? { note: String(patch.note).slice(0, 120) } : {}),
    };
    doc.groups[gid] = { mode: cur.mode, defaults: cur.defaults, members: cur.members };
    persist();
    return getGroupRule(gid);
  }

  function removeMemberRule(rawGroupId, rawMemberId) {
    const gid = String(rawGroupId ?? '').trim();
    const mid = String(rawMemberId ?? '').trim();
    if (!doc.groups[gid]?.members?.[mid]) return false;
    delete doc.groups[gid].members[mid];
    persist();
    return true;
  }

  function listGroupRules() {
    return Object.keys(doc.groups).sort().map((gid) => getGroupRule(gid));
  }

  function evaluateMember(roomId, rawSenderId) {
    const cfg = getConfig();
    if (cfg?.memberPolicy?.enabled !== true) return { ...DEFAULT_CAPABILITIES, restricted: false };
    const parsed = parseRoomId(roomId);
    if (!parsed || parsed.kind !== 'group') return { ...DEFAULT_CAPABILITIES, restricted: false };
    if (cfg.ownerId && String(rawSenderId) === String(cfg.ownerId)) {
      return { ...DEFAULT_CAPABILITIES, restricted: false };
    }
    const mid = String(rawSenderId ?? '').trim();
    const g = getGroupRule(parsed.peerId);
    const listed = Boolean(mid && Object.hasOwn(g.members, mid));

    if (g.mode === 'allow_listed') {
      if (!listed) return { canTrigger: false, canEngage: false, inContext: false, inMemory: false, restricted: true };
      return { ...normalizeCapabilities(g.members[mid], DEFAULT_CAPABILITIES), restricted: true };
    }
    if (g.mode === 'deny_listed') {
      if (listed) {
        const entry = g.members[mid];
        const hasExplicit = CAPABILITY_KEYS.some((k) => typeof entry[k] === 'boolean');
        return hasExplicit
          ? { ...normalizeCapabilities(entry, { canTrigger: false, canEngage: false, inContext: false, inMemory: false }), restricted: true }
          : { canTrigger: false, canEngage: false, inContext: false, inMemory: false, restricted: true };
      }
      return { ...g.defaults, restricted: false };
    }
    if (listed) return { ...normalizeCapabilities(g.members[mid], g.defaults), restricted: true };
    return { ...g.defaults, restricted: false };
  }

  return { getGroupRule, setGroupRule, setMemberCapabilities, removeMemberRule, listGroupRules, evaluateMember };
}
