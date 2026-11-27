// 收藏表情包仓库：同步、房间备注、搜索与经出站审查发送
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

function cleanStr(v, max = 200) {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

export function createEmoticonVault({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'emoticons.json') : '';
  let entries = [];

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (Array.isArray(saved?.entries)) entries = saved.entries;
  }

  function persist() {
    if (filePath) atomicWriteJson(filePath, { entries }, { mode: 0o600 });
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = cleanStr(raw.url || raw.customFaceUrl || raw.file || '', 512);
    const id = cleanStr(raw.id || raw.md5 || raw.emojiId || url, 128);
    if (!id) return null;
    return {
      id,
      url,
      file: cleanStr(raw.file || '', 256),
      remark: cleanStr(raw.remark || raw.desc || '', 120),
      notes: raw.notes && typeof raw.notes === 'object' ? { ...raw.notes } : {},
      usedCount: Number(raw.usedCount) || 0,
      lastUsedAt: Number(raw.lastUsedAt) || 0,
    };
  }

  async function syncFromTransport(transport) {
    if (getConfig()?.emoticon?.enabled === false) return { ok: false, error: '表情库未启用', count: entries.length };
    const fetched = await transport.fetchCustomFaces?.();
    if (!Array.isArray(fetched)) return { ok: true, synced: 0, count: entries.length };

    const byId = new Map(entries.map((e) => [e.id, e]));
    let added = 0;
    for (const raw of fetched) {
      const norm = normalizeEntry(raw);
      if (!norm) continue;
      const prev = byId.get(norm.id);
      if (prev) {
        if (norm.url) prev.url = norm.url;
        if (norm.remark && !prev.remark) prev.remark = norm.remark;
      } else {
        byId.set(norm.id, norm);
        added += 1;
      }
    }
    entries = [...byId.values()];
    persist();
    return { ok: true, synced: fetched.length, added, count: entries.length };
  }

  function list(roomId = '', { query = '', limit = 30 } = {}) {
    const q = cleanStr(query, 80).toLowerCase();
    const lim = Math.min(100, Math.max(1, Number(limit) || 30));
    return entries.filter((e) => {
      if (!q) return true;
      const note = String(e.notes?.[roomId] ?? '').toLowerCase();
      return e.id.toLowerCase().includes(q) || e.remark.toLowerCase().includes(q) || note.includes(q);
    }).slice(0, lim).map((e) => ({
      id: e.id,
      remark: e.remark,
      note: roomId ? (e.notes?.[roomId] || '') : '',
      hasUrl: Boolean(e.url || e.file),
      usedCount: e.usedCount,
    }));
  }

  function find(ref) {
    const key = cleanStr(ref, 256);
    if (!key) return null;
    return entries.find((e) => e.id === key) ?? entries.find((e) => e.remark === key) ?? null;
  }

  function annotate(id, roomId, note) {
    const item = find(id);
    if (!item) throw new Error(`未找到表情：${id}`);
    const scope = roomId || 'global';
    item.notes ??= {};
    const clean = cleanStr(note, 160);
    if (!clean) delete item.notes[scope];
    else item.notes[scope] = clean;
    persist();
    return item;
  }

  function markUsed(id) {
    const item = find(id);
    if (!item) return;
    item.usedCount = (Number(item.usedCount) || 0) + 1;
    item.lastUsedAt = Date.now();
    persist();
  }

  async function dispatchEmoticon(roomId, ref, { transport, egressGuard }) {
    if (getConfig()?.emoticon?.enabled === false) {
      return { ok: false, code: 'EMOTICON_DISABLED', error: '表情发送未开启' };
    }
    const item = find(ref);
    if (!item) return { ok: false, code: 'EMOTICON_NOT_FOUND', error: `未知表情：${ref}` };
    const gateCheck = egressGuard.inspectAndFormat(roomId, '[表情]');
    if (!gateCheck.ok) return gateCheck;
    const mediaTarget = item.url || item.file;
    if (!mediaTarget) return { ok: false, error: '表情缺少可用地址' };
    await transport.sendImage(roomId, mediaTarget);
    markUsed(item.id);
    return { ok: true, id: item.id };
  }

  function seed(rawList = []) {
    for (const raw of rawList) {
      const norm = normalizeEntry(raw);
      if (norm && !entries.some((e) => e.id === norm.id)) entries.push(norm);
    }
    persist();
  }

  return { syncFromTransport, list, find, annotate, markUsed, dispatchEmoticon, seed };
}
