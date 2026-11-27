// 房间笔记与全局备忘仓库
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from './fs-atomic.js';

const MAX_PER_SCOPE = 200;

export function createNotesStore({ dataDir = '' } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'notes.json') : '';
  const buckets = new Map();

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (saved && typeof saved.buckets === 'object' && !Array.isArray(saved.buckets)) {
      for (const [k, items] of Object.entries(saved.buckets)) {
        if (Array.isArray(items)) buckets.set(k, items);
      }
    }
  }

  function persist() {
    if (!filePath) return;
    atomicWriteJson(filePath, { buckets: Object.fromEntries(buckets.entries()) }, { mode: 0o600 });
  }

  function scopeFor(roomId, scope) {
    return scope === 'global' ? 'global' : String(roomId || 'global');
  }

  function list(roomId, { includeGlobal = true, limit = 50 } = {}) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const localItems = [...(buckets.get(String(roomId)) ?? [])];
    const globalItems = includeGlobal && roomId !== 'global' ? [...(buckets.get('global') ?? [])] : [];
    return [...localItems, ...globalItems]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, lim);
  }

  function put(roomId, { content, tags = [], scope = 'room' } = {}) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('笔记内容不能为空');
    const targetScope = scopeFor(roomId, scope);
    const items = [...(buckets.get(targetScope) ?? [])];
    const entry = {
      id: `note_${crypto.randomBytes(6).toString('hex')}`,
      scope: targetScope,
      content: text.slice(0, 1000),
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [],
      updatedAt: Date.now(),
    };
    items.unshift(entry);
    if (items.length > MAX_PER_SCOPE) items.length = MAX_PER_SCOPE;
    buckets.set(targetScope, items);
    persist();
    return entry;
  }

  function remove(roomId, id) {
    const targetId = String(id ?? '').trim();
    if (!targetId) return false;
    let removed = false;
    for (const s of [String(roomId), 'global']) {
      const items = buckets.get(s);
      if (!items) continue;
      const next = items.filter((item) => item.id !== targetId);
      if (next.length !== items.length) {
        buckets.set(s, next);
        removed = true;
      }
    }
    if (removed) persist();
    return removed;
  }

  function find(roomId, query, { limit = 20 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const all = list(roomId, { includeGlobal: true, limit: 200 });
    const hits = q
      ? all.filter((item) => item.content.toLowerCase().includes(q) || item.tags.some((t) => t.toLowerCase().includes(q)))
      : all;
    return hits.slice(0, Math.min(100, Math.max(1, Number(limit) || 20)));
  }

  return { list, put, remove, find };
}
