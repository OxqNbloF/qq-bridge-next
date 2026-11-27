// 每会话聊天状态、未读消息队列、最近记录与多后端会话句柄持久化存储
import path from 'node:path';
import { atomicWriteJson, ensureDir, readJsonSafe } from './fs-atomic.js';

const MAX_UNREAD = 200;
const MAX_RECENT = 100;

function createEmptyChat(convKey) {
  return {
    convKey,
    seqCounter: 0,
    readThroughSeq: 0,
    unread: [],
    recent: [],
    backendSessions: {},
    rollingSummary: '',
    lastBackendId: '',
    wakeConfig: {
      mode: 'sleep',
      sleepMs: 900000,
      sleepUntil: 0,
      quietSince: 0,
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
    },
    lastWakeAt: 0,
    lastReplyAt: 0,
    lastIncomingAt: 0,
    lastActionAt: 0,
  };
}

/** 创建会话状态仓库 */
export function createChatStore({ dataDir = '' } = {}) {
  const filePath = dataDir ? path.join(dataDir, 'chats.json') : '';
  const chats = new Map();
  let dirty = false;
  let flushTimer = null;

  if (dataDir) ensureDir(dataDir);
  if (filePath) {
    const saved = readJsonSafe(filePath, null);
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [key, item] of Object.entries(saved)) {
        if (!item || typeof item !== 'object') continue;
        chats.set(key, {
          ...createEmptyChat(key),
          ...item,
          convKey: key,
          unread: Array.isArray(item.unread) ? item.unread : [],
          recent: Array.isArray(item.recent) ? item.recent : [],
          backendSessions: item.backendSessions && typeof item.backendSessions === 'object' ? { ...item.backendSessions } : {},
          wakeConfig: { ...createEmptyChat(key).wakeConfig, ...(item.wakeConfig ?? {}) },
          usage: { ...createEmptyChat(key).usage, ...(item.usage ?? {}) },
        });
      }
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!filePath || !dirty) return;
    const dump = {};
    for (const [k, v] of chats) dump[k] = v;
    atomicWriteJson(filePath, dump, { mode: 0o600 });
    dirty = false;
  }

  function scheduleSave() {
    dirty = true;
    if (!filePath || flushTimer) return;
    flushTimer = setTimeout(() => flush(), 100);
    flushTimer.unref?.();
  }

  function ensure(convKey) {
    let st = chats.get(convKey);
    if (!st) {
      st = createEmptyChat(convKey);
      chats.set(convKey, st);
      scheduleSave();
    }
    return st;
  }

  function get(convKey) {
    return chats.get(convKey) ?? null;
  }

  function list() {
    return [...chats.values()];
  }

  function appendIncoming(convKey, msg) {
    const st = ensure(convKey);
    st.seqCounter += 1;
    const seq = st.seqCounter;
    const ts = Number(msg.ts) || Date.now();
    const record = {
      seq,
      messageId: String(msg.messageId ?? ''),
      userId: String(msg.userId ?? ''),
      senderName: String(msg.senderName ?? msg.userId ?? '成员'),
      text: String(msg.text ?? ''),
      ts,
      atBot: Boolean(msg.atBot),
      replyToBot: Boolean(msg.replyToBot),
      replyToId: msg.replyToId ? String(msg.replyToId) : '',
      media: Array.isArray(msg.media) ? msg.media : [],
      forwardIds: Array.isArray(msg.forwardIds) ? msg.forwardIds : [],
      modelVisible: msg.modelVisible !== false,
      fromSelf: false,
    };
    st.unread.push(record);
    if (st.unread.length > MAX_UNREAD) st.unread.splice(0, st.unread.length - MAX_UNREAD);
    st.recent.push(record);
    if (st.recent.length > MAX_RECENT) st.recent.splice(0, st.recent.length - MAX_RECENT);
    st.lastIncomingAt = ts;
    st.wakeConfig.quietSince = ts;
    scheduleSave();
    return record;
  }

  function recordSent(convKey, texts = [], { senderName = '我' } = {}) {
    const st = ensure(convKey);
    const now = Date.now();
    for (const t of texts) {
      st.seqCounter += 1;
      const entry = {
        seq: st.seqCounter,
        messageId: '',
        userId: 'self',
        senderName,
        text: String(t ?? ''),
        ts: now,
        atBot: false,
        replyToBot: false,
        replyToId: '',
        media: [],
        fromSelf: true,
      };
      st.recent.push(entry);
      if (st.recent.length > MAX_RECENT) st.recent.splice(0, st.recent.length - MAX_RECENT);
    }
    st.lastReplyAt = now;
    st.lastActionAt = now;
    scheduleSave();
  }

  function acknowledgeThrough(convKey, throughSeq = null) {
    const st = ensure(convKey);
    const targetSeq = throughSeq === null || throughSeq === undefined
      ? (st.unread.length ? st.unread[st.unread.length - 1].seq : st.readThroughSeq)
      : Number(throughSeq);
    if (!Number.isFinite(targetSeq) || targetSeq < 0) return { marked: 0, unreadCount: st.unread.length, readThroughSeq: st.readThroughSeq };
    const before = st.unread.length;
    st.unread = st.unread.filter((m) => m.seq > targetSeq);
    if (targetSeq > st.readThroughSeq) st.readThroughSeq = targetSeq;
    st.lastActionAt = Date.now();
    scheduleSave();
    return {
      marked: before - st.unread.length,
      unreadCount: st.unread.length,
      readThroughSeq: st.readThroughSeq,
    };
  }

  function getUnread(convKey, { afterSeq = null, limit = 30, forModel = false } = {}) {
    const st = ensure(convKey);
    const lim = Math.min(100, Math.max(1, Number(limit) || 30));
    const base = forModel ? st.unread.filter((m) => m.modelVisible !== false) : st.unread;
    const filtered = afterSeq === null || afterSeq === undefined
      ? base
      : base.filter((m) => m.seq > Number(afterSeq));
    const slice = filtered.slice(0, lim);
    const readThroughSeq = slice.length ? slice[slice.length - 1].seq : st.readThroughSeq;
    return {
      messages: slice,
      unreadCount: filtered.length,
      partial: filtered.length > slice.length,
      readThroughSeq,
    };
  }

  function getRecent(convKey, { limit = 20, offset = 0, forModel = false } = {}) {
    const st = ensure(convKey);
    const lim = Math.min(100, Math.max(1, Number(limit) || 20));
    const off = Math.max(0, Number(offset) || 0);
    const base = forModel ? st.recent.filter((m) => m.modelVisible !== false) : st.recent;
    const end = Math.max(0, base.length - off);
    const start = Math.max(0, end - lim);
    return base.slice(start, end);
  }

  function redactMessage(convKey, messageId) {
    const st = chats.get(convKey);
    const targetId = String(messageId ?? '').trim();
    if (!st || !targetId) return false;
    let changed = false;
    for (const list of [st.unread, st.recent]) {
      for (const item of list) {
        if (String(item.messageId) === targetId) {
          item.text = '[已撤回]';
          item.media = [];
          item.forwardIds = [];
          item.redacted = true;
          changed = true;
        }
      }
    }
    if (changed) scheduleSave();
    return changed;
  }

  function getBackendSession(convKey, backendId) {
    const st = chats.get(convKey);
    return st?.backendSessions?.[backendId] || '';
  }

  function setBackendSession(convKey, backendId, externalSessionId) {
    const st = ensure(convKey);
    if (externalSessionId) {
      st.backendSessions[backendId] = String(externalSessionId);
    } else {
      delete st.backendSessions[backendId];
    }
    st.lastBackendId = backendId;
    scheduleSave();
  }

  function clearBackendSession(convKey, backendId) {
    const st = ensure(convKey);
    if (backendId) delete st.backendSessions[backendId];
    else st.backendSessions = {};
    scheduleSave();
  }

  function setRollingSummary(convKey, summary) {
    const st = ensure(convKey);
    st.rollingSummary = String(summary ?? '').slice(0, 400);
    scheduleSave();
  }

  function consumeRollingSummary(convKey) {
    const st = chats.get(convKey);
    if (!st || !st.rollingSummary) return '';
    const s = st.rollingSummary;
    st.rollingSummary = '';
    scheduleSave();
    return s;
  }

  function recordUsage(convKey, usage = {}) {
    const st = ensure(convKey);
    st.usage.inputTokens += Math.max(0, Number(usage.inputTokens) || 0);
    st.usage.outputTokens += Math.max(0, Number(usage.outputTokens) || 0);
    st.usage.turns += 1;
    scheduleSave();
  }

  function markWake(convKey) {
    const st = ensure(convKey);
    st.lastWakeAt = Date.now();
    scheduleSave();
  }

  function setWakeConfig(convKey, nextWake) {
    const st = ensure(convKey);
    st.wakeConfig = { ...st.wakeConfig, ...nextWake };
    scheduleSave();
    return st.wakeConfig;
  }

  function resetChat(convKey) {
    const st = ensure(convKey);
    st.backendSessions = {};
    st.rollingSummary = '';
    st.usage = { inputTokens: 0, outputTokens: 0, turns: 0 };
    scheduleSave();
    return st;
  }

  return {
    get,
    ensure,
    list,
    appendIncoming,
    recordSent,
    acknowledgeThrough,
    getUnread,
    getRecent,
    redactMessage,
    getBackendSession,
    setBackendSession,
    clearBackendSession,
    setRollingSummary,
    consumeRollingSummary,
    recordUsage,
    markWake,
    setWakeConfig,
    resetChat,
    flush,
  };
}
