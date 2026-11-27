// 房间会话状态、未读缓冲、最近历史、引擎会话句柄与撤回涂黑存储
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from './fs-atomic.js';

const MAX_UNREAD = 200;
const MAX_RECENT = 100;

function createEmptyRoom(roomId) {
  return {
    roomId,
    seq: 0,
    readCursor: 0,
    unread: [],
    recent: [],
    engineSessions: {},
    handoffSummary: '',
    lastEngineId: '',
    rhythm: {
      state: 'dormant',
      dormantMs: 900000,
      dormantUntil: 0,
      quietSince: 0,
    },
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
    lastTriggerAt: 0,
    lastReplyAt: 0,
    lastInboundAt: 0,
    lastActivityAt: 0,
  };
}

export function createRoomStore({ dataDir = '' } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'rooms.json') : '';
  const rooms = new Map();
  let dirty = false;
  let flushTimer = null;

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, item] of Object.entries(saved)) {
        if (!item || typeof item !== 'object') continue;
        rooms.set(id, {
          ...createEmptyRoom(id),
          ...item,
          roomId: id,
          unread: Array.isArray(item.unread) ? item.unread : [],
          recent: Array.isArray(item.recent) ? item.recent : [],
          engineSessions: item.engineSessions && typeof item.engineSessions === 'object' ? { ...item.engineSessions } : {},
          rhythm: { ...createEmptyRoom(id).rhythm, ...(item.rhythm ?? {}) },
          usage: { ...createEmptyRoom(id).usage, ...(item.usage ?? {}) },
        });
      }
    }
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!filePath || !dirty) return;
    atomicWriteJson(filePath, Object.fromEntries(rooms.entries()), { mode: 0o600 });
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (!filePath || flushTimer) return;
    flushTimer = setTimeout(() => flush(), 100);
    flushTimer.unref?.();
  }

  function ensure(roomId) {
    let st = rooms.get(roomId);
    if (!st) {
      st = createEmptyRoom(roomId);
      rooms.set(roomId, st);
      scheduleSave();
    }
    return st;
  }

  function get(roomId) { return rooms.get(roomId) ?? null; }
  function list() { return [...rooms.values()]; }

  function recordInbound(roomId, msg) {
    const st = ensure(roomId);
    st.seq += 1;
    const seq = st.seq;
    const ts = Number(msg.ts) || Date.now();
    const record = {
      seq,
      messageId: String(msg.messageId ?? ''),
      senderId: String(msg.senderId ?? ''),
      senderName: String(msg.senderName ?? msg.senderId ?? '成员'),
      text: String(msg.text ?? ''),
      ts,
      mentionedBot: Boolean(msg.mentionedBot),
      repliedBot: Boolean(msg.repliedBot),
      replyToId: msg.replyToId ? String(msg.replyToId) : '',
      attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
      bundleIds: Array.isArray(msg.bundleIds) ? msg.bundleIds : [],
      inContext: msg.inContext !== false,
      fromSelf: false,
    };
    st.unread.push(record);
    if (st.unread.length > MAX_UNREAD) st.unread.splice(0, st.unread.length - MAX_UNREAD);
    st.recent.push(record);
    if (st.recent.length > MAX_RECENT) st.recent.splice(0, st.recent.length - MAX_RECENT);
    st.lastInboundAt = ts;
    st.rhythm.quietSince = ts;
    scheduleSave();
    return record;
  }

  function recordOutbound(roomId, texts = [], { senderName = '我' } = {}) {
    const st = ensure(roomId);
    const now = Date.now();
    for (const t of texts) {
      st.seq += 1;
      const entry = {
        seq: st.seq,
        messageId: '',
        senderId: 'self',
        senderName,
        text: String(t ?? ''),
        ts: now,
        mentionedBot: false,
        repliedBot: false,
        replyToId: '',
        attachments: [],
        bundleIds: [],
        inContext: true,
        fromSelf: true,
      };
      st.recent.push(entry);
      if (st.recent.length > MAX_RECENT) st.recent.splice(0, st.recent.length - MAX_RECENT);
    }
    st.lastReplyAt = now;
    st.lastActivityAt = now;
    scheduleSave();
  }

  function markReadThrough(roomId, throughSeq = null) {
    const st = ensure(roomId);
    const targetSeq = throughSeq === null || throughSeq === undefined
      ? (st.unread.length ? st.unread[st.unread.length - 1].seq : st.readCursor)
      : Number(throughSeq);
    if (!Number.isFinite(targetSeq) || targetSeq < 0) {
      return { marked: 0, unreadCount: st.unread.length, readCursor: st.readCursor };
    }
    const before = st.unread.length;
    st.unread = st.unread.filter((m) => m.seq > targetSeq);
    if (targetSeq > st.readCursor) st.readCursor = targetSeq;
    st.lastActivityAt = Date.now();
    scheduleSave();
    return { marked: before - st.unread.length, unreadCount: st.unread.length, readCursor: st.readCursor };
  }

  function readUnread(roomId, { afterSeq = null, limit = 30, modelOnly = false } = {}) {
    const st = ensure(roomId);
    const lim = Math.min(100, Math.max(1, Number(limit) || 30));
    const base = modelOnly ? st.unread.filter((m) => m.inContext !== false) : st.unread;
    const filtered = afterSeq === null || afterSeq === undefined
      ? base
      : base.filter((m) => m.seq > Number(afterSeq));
    const slice = filtered.slice(0, lim);
    const readCursor = slice.length ? slice[slice.length - 1].seq : st.readCursor;
    return { messages: slice, unreadCount: filtered.length, partial: filtered.length > slice.length, readCursor };
  }

  function readRecent(roomId, { limit = 20, offset = 0, modelOnly = false } = {}) {
    const st = ensure(roomId);
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    const off = Math.max(0, Number(offset) || 0);
    const base = modelOnly ? st.recent.filter((m) => m.inContext !== false) : st.recent;
    const end = Math.max(0, base.length - off);
    const start = Math.max(0, end - lim);
    return base.slice(start, end);
  }

  function redactByMessageId(roomId, messageId) {
    const st = rooms.get(roomId);
    const targetId = String(messageId ?? '').trim();
    if (!st || !targetId) return false;
    let changed = false;
    for (const list of [st.unread, st.recent]) {
      for (const item of list) {
        if (String(item.messageId) === targetId) {
          item.text = '[已撤回]';
          item.attachments = [];
          item.bundleIds = [];
          item.redacted = true;
          changed = true;
        }
      }
    }
    if (changed) scheduleSave();
    return changed;
  }

  function getEngineSession(roomId, engineId) { return rooms.get(roomId)?.engineSessions?.[engineId] || ''; }

  function setEngineSession(roomId, engineId, externalSessionId) {
    const st = ensure(roomId);
    if (externalSessionId) st.engineSessions[engineId] = String(externalSessionId);
    else delete st.engineSessions[engineId];
    st.lastEngineId = engineId;
    scheduleSave();
  }

  function clearEngineSession(roomId, engineId) {
    const st = ensure(roomId);
    if (engineId) delete st.engineSessions[engineId];
    else st.engineSessions = {};
    scheduleSave();
  }

  function setHandoffSummary(roomId, summary) {
    const st = ensure(roomId);
    st.handoffSummary = String(summary ?? '').slice(0, 400);
    scheduleSave();
  }

  function takeHandoffSummary(roomId) {
    const st = rooms.get(roomId);
    if (!st || !st.handoffSummary) return '';
    const s = st.handoffSummary;
    st.handoffSummary = '';
    scheduleSave();
    return s;
  }

  function recordUsage(roomId, usage = {}) {
    const st = ensure(roomId);
    st.usage.inputTokens += Math.max(0, Number(usage.inputTokens) || 0);
    st.usage.outputTokens += Math.max(0, Number(usage.outputTokens) || 0);
    st.usage.turns += 1;
    scheduleSave();
  }

  function markTriggered(roomId) {
    const st = ensure(roomId);
    st.lastTriggerAt = Date.now();
    scheduleSave();
  }

  function setRhythm(roomId, nextRhythm) {
    const st = ensure(roomId);
    st.rhythm = { ...st.rhythm, ...nextRhythm };
    scheduleSave();
    return st.rhythm;
  }

  function resetRoom(roomId) {
    const st = ensure(roomId);
    st.engineSessions = {};
    st.handoffSummary = '';
    st.usage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    scheduleSave();
    return st;
  }

  return {
    get, ensure, list,
    recordInbound, recordOutbound, markReadThrough, readUnread, readRecent, redactByMessageId,
    getEngineSession, setEngineSession, clearEngineSession,
    setHandoffSummary, takeHandoffSummary, recordUsage, markTriggered, setRhythm, resetRoom, flush,
  };
}
