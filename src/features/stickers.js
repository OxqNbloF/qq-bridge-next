// 收藏表情库管理：从 SnowLuma 同步、按作用域备注、检索与安全发送
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from '../storage/fs-atomic.js';

function cleanStr(v, max = 200) {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

export function createStickerStore({ dataDir = '', getConfig = () => ({}) } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'stickers.json') : '';
  let entries = [];

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (Array.isArray(saved?.entries)) entries = saved.entries;
  }

  function persist() {
    if (!filePath) return;
    atomicWriteJson(filePath, { entries }, { mode: 0o600 });
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

  async function syncFromOneBot(onebot) {
    if (getConfig()?.sticker?.enabled === false) return { ok: false, error: '表情库未启用', count: entries.length };
    const fetched = await onebot.fetchCustomFaces?.();
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

  function list(convKey = '', { query = '', limit = 30 } = {}) {
    const q = cleanStr(query, 80).toLowerCase();
    const lim = Math.min(100, Math.max(1, Number(limit) || 30));
    const hits = entries.filter((e) => {
      if (!q) return true;
      const localNote = String(e.notes?.[convKey] ?? '').toLowerCase();
      return e.id.toLowerCase().includes(q)
        || e.remark.toLowerCase().includes(q)
        || localNote.includes(q);
    });
    return hits.slice(0, lim).map((e) => ({
      id: e.id,
      remark: e.remark,
      note: convKey ? (e.notes?.[convKey] || '') : '',
      hasUrl: Boolean(e.url || e.file),
      usedCount: e.usedCount,
    }));
  }

  function find(ref) {
    const key = cleanStr(ref, 256);
    if (!key) return null;
    return entries.find((e) => e.id === key) ?? entries.find((e) => e.remark === key) ?? null;
  }

  function setNote(id, convKey, note) {
    const item = find(id);
    if (!item) throw new Error(`未找到表情：${id}`);
    const scope = convKey || 'global';
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

  async function sendSticker(convKey, ref, { onebot, outboundGuard }) {
    if (getConfig()?.sticker?.enabled === false) {
      return { ok: false, code: 'STICKER_DISABLED', error: '表情功能已关闭' };
    }
    const item = find(ref);
    if (!item) return { ok: false, code: 'STICKER_NOT_FOUND', error: `未知表情：${ref}` };
    const gateCheck = outboundGuard.auditAndPrepare(convKey, '[表情]');
    if (!gateCheck.ok) return gateCheck;
    const mediaTarget = item.url || item.file;
    if (!mediaTarget) return { ok: false, error: '表情缺少可用地址' };
    await onebot.sendImage(convKey, mediaTarget);
    markUsed(item.id);
    return { ok: true, id: item.id };
  }

  function addFixtures(rawList = []) {
    for (const raw of rawList) {
      const norm = normalizeEntry(raw);
      if (norm && !entries.some((e) => e.id === norm.id)) entries.push(norm);
    }
    persist();
  }

  return {
    syncFromOneBot,
    list,
    find,
    setNote,
    markUsed,
    sendSticker,
    addFixtures,
  };
}
