// 轻量记忆持久化仓库（按会话隔离 + 全局记忆）
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from './fs-atomic.js';

const MAX_PER_SCOPE = 200;

export function createMemoryStore({ dataDir = '' } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'memories.json') : '';
  const scopes = new Map();

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (saved && typeof saved.scopes === 'object' && !Array.isArray(saved.scopes)) {
      for (const [k, items] of Object.entries(saved.scopes)) {
        if (Array.isArray(items)) scopes.set(k, items);
      }
    }
  }

  function persist() {
    if (!filePath) return;
    const out = { scopes: Object.fromEntries(scopes.entries()) };
    atomicWriteJson(filePath, out, { mode: 0o600 });
  }

  function scopeKeyFor(convKey, scope) {
    return scope === 'global' ? 'global' : String(convKey || 'global');
  }

  function list(convKey, { includeGlobal = true, limit = 50 } = {}) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const chatItems = [...(scopes.get(String(convKey)) ?? [])];
    const globalItems = includeGlobal && convKey !== 'global' ? [...(scopes.get('global') ?? [])] : [];
    return [...chatItems, ...globalItems]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, lim);
  }

  function save(convKey, { content, tags = [], scope = 'chat' } = {}) {
    const text = String(content ?? '').trim();
    if (!text) throw new Error('记忆内容不能为空');
    const targetScope = scopeKeyFor(convKey, scope);
    const items = [...(scopes.get(targetScope) ?? [])];
    const entry = {
      id: `mem_${crypto.randomBytes(6).toString('hex')}`,
      scope: targetScope,
      content: text.slice(0, 1000),
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 10) : [],
      updatedAt: Date.now(),
    };
    items.unshift(entry);
    if (items.length > MAX_PER_SCOPE) items.length = MAX_PER_SCOPE;
    scopes.set(targetScope, items);
    persist();
    return entry;
  }

  function remove(convKey, id) {
    const targetId = String(id ?? '').trim();
    if (!targetId) return false;
    let removed = false;
    for (const scopeKey of [String(convKey), 'global']) {
      const items = scopes.get(scopeKey);
      if (!items) continue;
      const next = items.filter((item) => item.id !== targetId);
      if (next.length !== items.length) {
        scopes.set(scopeKey, next);
        removed = true;
      }
    }
    if (removed) persist();
    return removed;
  }

  function search(convKey, query, { limit = 20 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const all = list(convKey, { includeGlobal: true, limit: 200 });
    const hits = q
      ? all.filter((item) => item.content.toLowerCase().includes(q) || item.tags.some((t) => t.toLowerCase().includes(q)))
      : all;
    return hits.slice(0, Math.min(100, Math.max(1, Number(limit) || 20)));
  }

  return { list, save, remove, search };
}
