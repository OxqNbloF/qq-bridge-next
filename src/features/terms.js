// 群黑话词库管理（按会话隔离 + 全局词条，只读注入模型，后台控制台增删）
import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

const MAX_TERMS = 500;

export function createTermsStore({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'terms.json') : '';
  let items = [];

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (Array.isArray(saved?.items)) items = saved.items;
  }

  function persist() {
    if (!filePath) return;
    atomicWriteJson(filePath, { items }, { mode: 0o600 });
  }

  function list(convKey = '', { includeGlobal = true, limit = 100 } = {}) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 100));
    const filtered = convKey
      ? items.filter((it) => it.scope === convKey || (includeGlobal && it.scope === 'global'))
      : items;
    return filtered.slice(0, lim);
  }

  function save(convKey, { term, meaning, scope = 'chat' } = {}) {
    const cleanTerm = String(term ?? '').trim().slice(0, 64);
    const cleanMeaning = String(meaning ?? '').trim().slice(0, 300);
    if (!cleanTerm || !cleanMeaning) throw new Error('词条与释义不能为空');
    const targetScope = scope === 'global' || !convKey ? 'global' : String(convKey);

    const existing = items.find((it) => it.scope === targetScope && it.term === cleanTerm);
    if (existing) {
      existing.meaning = cleanMeaning;
      existing.updatedAt = Date.now();
      persist();
      return existing;
    }

    const entry = {
      id: `term_${crypto.randomBytes(6).toString('hex')}`,
      scope: targetScope,
      term: cleanTerm,
      meaning: cleanMeaning,
      updatedAt: Date.now(),
    };
    items.unshift(entry);
    if (items.length > MAX_TERMS) items.length = MAX_TERMS;
    persist();
    return entry;
  }

  function remove(id) {
    const targetId = String(id ?? '').trim();
    const before = items.length;
    items = items.filter((it) => it.id !== targetId);
    if (items.length !== before) {
      persist();
      return true;
    }
    return false;
  }

  function search(convKey, query, { limit = 20 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const pool = list(convKey, { includeGlobal: true, limit: 200 });
    const hits = q
      ? pool.filter((it) => it.term.toLowerCase().includes(q) || it.meaning.toLowerCase().includes(q))
      : pool;
    return hits.slice(0, Math.min(50, Math.max(1, Number(limit) || 20)));
  }

  function buildPromptBlock(convKey) {
    const cfg = getConfig();
    if (cfg?.terms?.enabled === false) return '';
    const maxInject = Math.max(0, Number(cfg?.terms?.maxInject ?? 12));
    if (maxInject === 0) return '';
    const slice = list(convKey, { includeGlobal: true, limit: maxInject });
    if (!slice.length) return '';
    return slice.map((it) => `- ${it.term}: ${it.meaning}`).join('\n');
  }

  return { list, save, remove, search, buildPromptBlock };
}
