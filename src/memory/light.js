// 轻量记忆和记忆池条目互相转换；没有来源的先当成待确认
import crypto from 'node:crypto';
import { memberRef } from '../identity/project-core.js';
import { boundedSources, mergeSources } from './sources.js';

export const LIGHT_MEMORY_KINDS = ['ongoing', 'impression'];
const DAY_MS = 24 * 60 * 60 * 1000;
// 把毫秒时间换成标准时间文字，没有就返回空
const iso = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);
// 按几个字段算出一个固定编号，同样内容编号不变
const itemId = (kind, key, subtype, name) => `${kind}:${crypto.createHash('sha1').update(`${key}\n${subtype}\n${name}`).digest('hex').slice(0, 16)}`;

/** 一个会话的轻量记忆转成池条目 */
export function lightMemoryToPoolItems(key, st) {
  const items = [];
  for (const t of Array.isArray(st.activeTopics) ? st.activeTopics : []) {
    if (!t || !t.text) continue;
    items.push({
      id: itemId('ongoing', key, 'topic', t.text), conv_id: key, kind: 'ongoing', subtype: 'topic',
      content: String(t.text), status: 'candidate', source_msg_ids: boundedSources(t.sourceMessageIds), mention_count: 1,
      created_at: iso(t.lastMentionAt), updated_at: iso(t.lastMentionAt),
      expire_at: iso(Number(t.lastMentionAt) > 0 ? Number(t.lastMentionAt) + DAY_MS : 0), data: t,
    });
  }
  for (const t of Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []) {
    if (!t || !t.text) continue;
    items.push({
      id: itemId('ongoing', key, 'thought', t.text), conv_id: key, kind: 'ongoing', subtype: 'thought',
      content: String(t.text), status: 'candidate', source_msg_ids: boundedSources(t.sourceMessageIds), mention_count: 1,
      created_at: iso(t.createdAt), updated_at: iso(t.createdAt), expire_at: iso(t.expiresAt), data: t,
    });
  }
  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  for (const [name, im] of Object.entries(impressions)) {
    if (!im || typeof im !== 'object') continue;
    items.push({
      id: itemId('impression', key, 'member', name), conv_id: key, kind: 'impression', subject_uid: name,
      content: Array.isArray(im.traits) ? im.traits.join('；') : '', status: 'candidate', source_msg_ids: boundedSources(im.sourceMessageIds),
      mention_count: Number(im.interactionCount) || 0,
      created_at: iso(im.lastSeenAt), updated_at: iso(im.lastSeenAt), expire_at: null, data: im,
    });
  }
  return items;
}

/** 池条目转回按会话 key 分组的轻量记忆；只认带 data 的条目 */
export function lightMemoryFromPoolItems(items) {
  const byKey = new Map();
  for (const it of items) {
    if (!it || !it.data || typeof it.data !== 'object' || typeof it.conv_id !== 'string') continue;
    let mem = byKey.get(it.conv_id);
    if (!mem) byKey.set(it.conv_id, mem = { activeTopics: [], pendingThoughts: [], memberImpressions: {} });
    const data = { ...it.data };
    if (it.source_msg_ids?.length) data.sourceMessageIds = it.source_msg_ids;
    else delete data.sourceMessageIds;
    if (it.kind === 'ongoing' && it.subtype === 'topic') mem.activeTopics.push(data);
    else if (it.kind === 'ongoing' && it.subtype === 'thought') mem.pendingThoughts.push(data);
    else if (it.kind === 'impression' && typeof it.subject_uid === 'string'
      && !['__proto__', 'constructor', 'prototype'].includes(it.subject_uid)) mem.memberImpressions[it.subject_uid] = data;
  }
  return byKey;
}

// 旧昵称不能可靠识别时保留只读项，不能把同名人的印象写到另一个 QQ。
export function normalizeMemberImpressions(key, values, resolve) {
  const out = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
    const result = /^[1-9]\d{0,15}$/.test(name) ? { qq: name } : name.startsWith('legacy:') ? null : resolve(name);
    const target = result?.qq ?? (name.startsWith('legacy:') ? name : `legacy:${name}`);
    const old = out[target];
    const sources = mergeSources(old?.sourceMessageIds, value?.sourceMessageIds);
    out[target] = { ...value, displayName: value?.displayName ?? (/^[1-9]\d*$/.test(name) ? '群友' : name.replace(/^legacy:/, '')),
      sourceMessageIds: old ? sources : boundedSources(value?.sourceMessageIds),
      ...(old ? { traits: [...new Set([...(old.traits ?? []), ...(value.traits ?? [])])], interactionCount: Math.max(Number(old.interactionCount) || 0, Number(value.interactionCount) || 0) } : {}) };
  }
  return out;
}

export const impressionRef = memberRef;

/** 从单个轻量记忆对象（conversations 条目或未认领池缓存）删除匹配池条目的内容 */
export function removeLightMemoryEntry(mem, key, target) {
  if (!mem || typeof mem !== 'object' || !target || typeof target !== 'object') return false;
  let changed = false;
  if (target.kind === 'ongoing') {
    const matchTopic = !target.subtype || target.subtype === 'topic';
    const matchThought = !target.subtype || target.subtype === 'thought';
    if (matchTopic && Array.isArray(mem.activeTopics)) {
      const next = mem.activeTopics.filter((t) => {
        if (!t || !t.text) return true;
        return !(itemId('ongoing', key, 'topic', t.text) === target.id || (typeof target.content === 'string' && String(t.text) === target.content));
      });
      if (next.length !== mem.activeTopics.length) {
        mem.activeTopics = next;
        changed = true;
      }
    }
    if (matchThought && Array.isArray(mem.pendingThoughts)) {
      const next = mem.pendingThoughts.filter((t) => {
        if (!t || !t.text) return true;
        return !(itemId('ongoing', key, 'thought', t.text) === target.id || (typeof target.content === 'string' && String(t.text) === target.content));
      });
      if (next.length !== mem.pendingThoughts.length) {
        mem.pendingThoughts = next;
        changed = true;
      }
    }
  } else if (target.kind === 'impression' && mem.memberImpressions && typeof mem.memberImpressions === 'object') {
    for (const name of Object.keys(mem.memberImpressions)) {
      if (itemId('impression', key, 'member', name) === target.id || (typeof target.subject_uid === 'string' && name === target.subject_uid)) {
        delete mem.memberImpressions[name];
        changed = true;
      }
    }
  }
  return changed;
}
