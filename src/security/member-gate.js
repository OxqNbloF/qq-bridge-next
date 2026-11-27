// 精细成员门禁 gateV2：按群成员独立控制 回应(respond) / 对话(converse) / 上下文(context) / 记忆(memory) 四开关
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';
import { parseConvKey } from './access.js';

export const FLAG_KEYS = Object.freeze(['respond', 'converse', 'context', 'memory']);
export const MEMBER_MODES = Object.freeze(['all', 'blacklist', 'whitelist']);
export const DEFAULT_FLAGS = Object.freeze({ respond: true, converse: true, context: true, memory: true });

export function normalizeFlags(raw, fallback = DEFAULT_FLAGS) {
  const out = {};
  for (const key of FLAG_KEYS) {
    out[key] = raw && typeof raw[key] === 'boolean' ? raw[key] : Boolean(fallback[key]);
  }
  return out;
}

export function createMemberGate({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'member-policy.json') : '';
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

  function getGroupPolicy(rawGroupId) {
    const gid = String(rawGroupId ?? '').trim();
    const g = doc.groups[gid];
    if (!g) {
      return {
        groupId: gid,
        mode: 'all',
        defaultFlags: { ...DEFAULT_FLAGS },
        members: {},
      };
    }
    return {
      groupId: gid,
      mode: MEMBER_MODES.includes(g.mode) ? g.mode : 'all',
      defaultFlags: normalizeFlags(g.defaultFlags, DEFAULT_FLAGS),
      members: g.members && typeof g.members === 'object' ? structuredClone(g.members) : {},
    };
  }

  function setGroupPolicy(rawGroupId, { mode, defaultFlags } = {}) {
    const gid = String(rawGroupId ?? '').trim();
    if (!/^\d{1,20}$/.test(gid)) throw new Error(`群号格式非法：${rawGroupId}`);
    const cur = getGroupPolicy(gid);
    const nextMode = mode !== undefined ? String(mode) : cur.mode;
    if (!MEMBER_MODES.includes(nextMode)) throw new Error(`成员门禁模式非法：${nextMode}`);
    doc.groups[gid] = {
      mode: nextMode,
      defaultFlags: defaultFlags ? normalizeFlags(defaultFlags, cur.defaultFlags) : cur.defaultFlags,
      members: cur.members,
    };
    persist();
    return getGroupPolicy(gid);
  }

  function setMemberFlags(rawGroupId, rawQq, patch = {}) {
    const gid = String(rawGroupId ?? '').trim();
    const qq = String(rawQq ?? '').trim();
    if (!/^\d{1,20}$/.test(gid) || !/^\d{1,20}$/.test(qq)) {
      throw new Error('群号与 QQ 号必须为纯数字');
    }
    const cur = getGroupPolicy(gid);
    const prev = cur.members[qq] ?? {};
    const nextEntry = {
      ...prev,
      ...normalizeFlags(patch, prev.respond === undefined ? cur.defaultFlags : prev),
      ...(patch.note !== undefined ? { note: String(patch.note).slice(0, 120) } : {}),
    };
    cur.members[qq] = nextEntry;
    doc.groups[gid] = { mode: cur.mode, defaultFlags: cur.defaultFlags, members: cur.members };
    persist();
    return getGroupPolicy(gid);
  }

  function deleteMember(rawGroupId, rawQq) {
    const gid = String(rawGroupId ?? '').trim();
    const qq = String(rawQq ?? '').trim();
    if (!doc.groups[gid]?.members?.[qq]) return false;
    delete doc.groups[gid].members[qq];
    persist();
    return true;
  }

  function listGroups() {
    return Object.keys(doc.groups).sort().map((gid) => getGroupPolicy(gid));
  }

  function evaluate(convKey, rawUserId) {
    const cfg = getConfig();
    if (cfg?.gate?.enabled !== true) return { ...DEFAULT_FLAGS, restricted: false };
    const parsed = parseConvKey(convKey);
    if (!parsed || parsed.chatType !== 'group') return { ...DEFAULT_FLAGS, restricted: false };
    if (cfg.ownerQQ && String(rawUserId) === String(cfg.ownerQQ)) {
      return { ...DEFAULT_FLAGS, restricted: false };
    }
    const qq = String(rawUserId ?? '').trim();
    const g = getGroupPolicy(parsed.targetId);
    const listed = Boolean(qq && Object.hasOwn(g.members, qq));

    if (g.mode === 'whitelist') {
      if (!listed) return { respond: false, converse: false, context: false, memory: false, restricted: true };
      return { ...normalizeFlags(g.members[qq], DEFAULT_FLAGS), restricted: true };
    }
    if (g.mode === 'blacklist') {
      if (listed) {
        const entry = g.members[qq];
        const hasExplicitFlags = FLAG_KEYS.some((k) => typeof entry[k] === 'boolean');
        return hasExplicitFlags
          ? { ...normalizeFlags(entry, { respond: false, converse: false, context: false, memory: false }), restricted: true }
          : { respond: false, converse: false, context: false, memory: false, restricted: true };
      }
      return { ...g.defaultFlags, restricted: false };
    }
    // mode === 'all'
    if (listed) return { ...normalizeFlags(g.members[qq], g.defaultFlags), restricted: true };
    return { ...g.defaultFlags, restricted: false };
  }

  return {
    getGroupPolicy,
    setGroupPolicy,
    setMemberFlags,
    deleteMember,
    listGroups,
    evaluate,
  };
}
