// 群术语与行话词典库（按房间隔离 + 全局词条，仅后台维护与只读注入）
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

const MAX_ENTRIES = 500;

export function createGlossaryVault({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'glossary.json') : '';
  let items = [];

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (Array.isArray(saved?.items)) items = saved.items;
  }

  function persist() {
    if (filePath) atomicWriteJson(filePath, { items }, { mode: 0o600 });
  }

  function list(roomId = '', { includeGlobal = true, limit = 100 } = {}) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 100));
    const filtered = roomId
      ? items.filter((it) => it.scope === roomId || (includeGlobal && it.scope === 'global'))
      : items;
    return filtered.slice(0, lim);
  }

  function put(roomId, { term, meaning, scope = 'room' } = {}) {
    const cleanTerm = String(term ?? '').trim().slice(0, 64);
    const cleanMeaning = String(meaning ?? '').trim().slice(0, 300);
    if (!cleanTerm || !cleanMeaning) throw new Error('词条与释义不能为空');
    const targetScope = scope === 'global' || !roomId ? 'global' : String(roomId);

    const existing = items.find((it) => it.scope === targetScope && it.term === cleanTerm);
    if (existing) {
      existing.meaning = cleanMeaning;
      existing.updatedAt = Date.now();
      persist();
      return existing;
    }

    const entry = {
      id: `gloss_${crypto.randomBytes(6).toString('hex')}`,
      scope: targetScope,
      term: cleanTerm,
      meaning: cleanMeaning,
      updatedAt: Date.now(),
    };
    items.unshift(entry);
    if (items.length > MAX_ENTRIES) items.length = MAX_ENTRIES;
    persist();
    return entry;
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((it) => it.id !== String(id ?? '').trim());
    if (items.length !== before) { persist(); return true; }
    return false;
  }

  function find(roomId, query, { limit = 20 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const pool = list(roomId, { includeGlobal: true, limit: 200 });
    const hits = q
      ? pool.filter((it) => it.term.toLowerCase().includes(q) || it.meaning.toLowerCase().includes(q))
      : pool;
    return hits.slice(0, Math.min(50, Math.max(1, Number(limit) || 20)));
  }

  function formatPromptSection(roomId) {
    const cfg = getConfig();
    if (cfg?.glossary?.enabled === false) return '';
    const cap = Math.max(0, Number(cfg?.glossary?.maxInject ?? 12));
    if (cap === 0) return '';
    const slice = list(roomId, { includeGlobal: true, limit: cap });
    if (!slice.length) return '';
    return slice.map((it) => `- ${it.term}: ${it.meaning}`).join('\n');
  }

  return { list, put, remove, find, formatPromptSection };
}
