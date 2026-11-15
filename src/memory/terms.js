import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalV2Key } from '../policy/access.js';
import { atomicWriteJson } from '../store/fs-atomic.js';
import { boundedSources, mergeSources } from './sources.js';

export function createTerms({ pool, file, legacyFile, config, sanitize = String }) {
  const marker = path.join(path.dirname(file), '.migrated-terms-v2');
  const scope = (key) => key === 'global' ? key : canonicalV2Key(key);
  const visible = (item, key) => item.kind === 'term' && item.status === 'active' && (item.conv_id === 'global' || item.conv_id === scope(key));

  function migrate() {
    if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8'));
    const all = pool.query();
    // 只在迁移边界读取旧文件；失败不写池或成功标记。
    const legacy = legacyFile && fs.existsSync(legacyFile) ? JSON.parse(fs.readFileSync(legacyFile, 'utf8').replace(/^\uFEFF/, '')) : [];
    if (!Array.isArray(legacy)) throw new Error('旧词汇文件必须是数组，已拒绝迁移');
    const old = [...all.filter(item => item.kind === 'slang'), ...legacy.map(item => ({ ...item, conv_id: item.scope ?? 'global', mention_count: item.count }))];
    const next = all.filter(item => item.kind !== 'slang');
    let converted = 0;
    for (const item of old) {
      if (!['active', 'confirmed'].includes(item.status) || !String(item.content ?? '').trim() || !String(item.meaning ?? '').trim()) continue;
      const key = scope(item.conv_id);
      if (!key) continue;
      const id = termId(key, String(item.content).trim());
      if (next.some(entry => entry.id === id || (entry.kind === 'term' && entry.conv_id === key && entry.content === item.content))) continue;
      const { evidence, ...migrated } = item;
      next.push({ ...migrated, id, conv_id: key, kind: 'term', status: 'active', mention_count: Number(item.mention_count) || 1,
        created_at: item.created_at ?? item.createdAt, updated_at: item.updated_at ?? item.updatedAt, data: { source: item.source ?? 'migration' } });
      converted++;
    }
    for (const source of [file, legacyFile].filter(Boolean)) {
      if (!fs.existsSync(source)) continue;
      const backup = `${source}.bak-terms-v2`;
      if (!fs.existsSync(backup)) fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
    }
    pool.update(() => next);
    const report = { version: 2, input: old.length, converted, excluded: old.length - converted, retained: next.length, at: new Date().toISOString() };
    atomicWriteJson(marker, report);
    return report;
  }

  function query(key, text = '') {
    const search = String(text).toLocaleLowerCase();
    return pool.query().filter(item => visible(item, key) && (!search || [item.content, item.meaning, item.usage, item.example].some(value => String(value ?? '').toLocaleLowerCase().includes(search))))
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')) || b.mention_count - a.mention_count).map(publicTerm);
  }

  function append(key, content, extra = {}) {
    if (config()?.enabled === false) throw new Error('词汇记忆未启用');
    const conv = scope(key);
    const text = sanitize(String(content).trim()).slice(0, 100);
    const meaning = sanitize(String(extra.meaning ?? '').trim()).slice(0, 500);
    if (!conv || !text || !meaning) throw new Error('词汇记忆需要合法会话、content 和 extra.meaning');
    const sources = extra.sourceMessageIds ?? extra.source_msg_ids ?? [];
    if (!Array.isArray(sources) || sources.length > 50 || sources.some(id => !['string', 'number'].includes(typeof id) || !String(id).trim() || String(id).length > 128)) throw new Error('词汇来源必须是最多 50 个有效消息号');
    const now = new Date().toISOString();
    const old = pool.query({ kind: 'term' }).find(item => item.conv_id === conv && item.content === text);
    const item = { ...old, id: old?.id ?? termId(conv, text), conv_id: conv, kind: 'term', status: 'active', content: text, meaning,
      usage: sanitize(String(extra.usage ?? old?.usage ?? '')).slice(0, 300), example: sanitize(String(extra.example ?? old?.example ?? '')).slice(0, 300),
      source_msg_ids: old ? mergeSources(old.source_msg_ids, sources) : boundedSources(sources),
      importance: 3, mention_count: (Number(old?.mention_count) || 0) + 1, created_at: old?.created_at ?? now, updated_at: now, data: { source: extra.source === 'manual' ? 'manual' : 'ai' } };
    const max = Math.max(1, Math.min(2000, Number(config()?.maxPerConv) || 200));
    pool.update(items => {
      const own = [...items.filter(entry => entry.kind === 'term' && entry.conv_id === conv && entry.id !== item.id), item]
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.mention_count - a.mention_count).slice(0, max);
      return [...items.filter(entry => entry.kind !== 'term' || entry.conv_id !== conv), ...own];
    });
    return publicTerm(item);
  }

  function remove(key, content) {
    if (config()?.enabled === false) throw new Error('词汇记忆未启用');
    const conv = scope(key);
    if (!conv) throw new Error('词汇记忆会话非法');
    let removed = 0;
    pool.update(items => items.filter(item => {
      const match = item.kind === 'term' && item.conv_id === conv && (content === undefined || item.content === content);
      if (match) removed++;
      return !match;
    }));
    return removed;
  }

  function buildContext(key) {
    if (config()?.enabled === false) return '';
    const max = Math.max(1, Math.min(30, Number(config()?.injectMax) || 8));
    const lines = [];
    let used = 0;
    for (const item of query(key).slice(0, max)) {
      const line = `- ${sanitize(item.content)}：${sanitize(item.meaning)}${item.usage ? `（${sanitize(item.usage)}）` : ''}`;
      const remaining = 500 - used - 1;
      if (remaining <= 0) break;
      lines.push(line.slice(0, remaining)); used += Math.min(line.length, remaining) + 1;
    }
    return lines.length ? `【记得的说法】\n${lines.join('\n')}` : '';
  }

  return { migrate, query, append, remove, buildContext };
}

function termId(key, content) {
  return `term:${key}:${crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)}`;
}

function publicTerm(item) {
  return { id: item.id, conv_id: item.conv_id, kind: 'term', status: item.status, content: item.content, meaning: item.meaning, usage: item.usage ?? '', example: item.example ?? '', mention_count: item.mention_count, created_at: item.created_at, updated_at: item.updated_at };
}
