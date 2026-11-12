// 二代仿真会话状态的读写与消息入账
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sanitizeForwardId } from '../forward.js';
import { sanitizeMediaSummary } from '../inbound/normalize.js';
import { truncateText, truncateTextTail } from '../md-to-plain.js';
import { canonicalV2Key } from '../policy/access.js';
import { readJsonSafe, atomicWriteJson } from '../store/fs-atomic.js';
import { migrateDocument, stampSchema } from '../store/schema.js';
import { LIGHT_MEMORY_KINDS, lightMemoryToPoolItems, lightMemoryFromPoolItems } from '../memory/light.js';

// 创建二代会话状态存储
export function createSocialV2Store(b) {
  // 本模块持有的内存状态，其它模块经 b 读取
  const seenForwardIds = new Map(); // key -> Set<string>
  const seenMessageIds = new Set();

  // 轻量记忆以记忆池为准；池读不出时只读，绝不用空记忆覆盖磁盘
  const LIGHT_MEMORY_FIELDS = ['activeTopics', 'pendingThoughts', 'memberImpressions'];
  let poolMemory = new Map();
  let poolMemoryWritable = true;
  let savedMemorySignature = null;
  let savedMemoryFull = null;
  // 启动时从记忆池读轻量记忆；失败则只读
  function loadLightMemoryFromPool() {
    try {
      poolMemory = lightMemoryFromPoolItems(LIGHT_MEMORY_KINDS.flatMap((kind) => b.memoryPool.query({ kind })));
    } catch (error) {
      poolMemoryWritable = false;
      b.log(`⚠️ 记忆池读取失败，轻量记忆本次运行只读不写（不会覆盖原文件）：${error?.message ?? error}`);
    }
  }
  // 会话建立时认领池里的轻量记忆
  function claimPoolMemory(key, st) {
    const mem = poolMemory.get(key);
    if (!mem) return;
    poolMemory.delete(key);
    Object.assign(st, mem);
  }
  /** 会话重置时丢掉未认领的池记忆（不传 key 丢全部） */
  function forgetLightMemory(key) {
    if (key === undefined) poolMemory.clear();
    else poolMemory.delete(key);
  }
  // 有变化才写池，返回池里是否已有当前记忆；false 时须留 json 副本
  // 简化处理：崩溃会丢最近一次刷新，数据多了再改成追加写
  function saveLightMemory(force = false) {
    if (!poolMemoryWritable) return false;
    const items = [...poolMemory.entries()].flatMap(([key, mem]) => lightMemoryToPoolItems(key, mem));
    for (const [key, st] of b.socialV2.conversations) items.push(...lightMemoryToPoolItems(key, st));
    const signature = JSON.stringify(items, (k, v) => (k === 'lastMentionAt' || k === 'updated_at' || k === 'created_at' || k === 'expire_at' ? undefined : v));
    const full = JSON.stringify(items);
    if (force ? full === savedMemoryFull : signature === savedMemorySignature) return true;
    try {
      b.memoryPool.replaceKinds(LIGHT_MEMORY_KINDS, items);
      savedMemorySignature = signature;
      savedMemoryFull = full;
      return true;
    } catch (error) {
      // 写记忆池失败也不影响存状态；标记失效，下次会重写
      savedMemorySignature = null;
      savedMemoryFull = null;
      b.log('保存轻量记忆到记忆池失败（本次改把副本留在 social-v2.json）:', error?.message ?? error);
      return false;
    }
  }

  // 取或建某会话的二代状态
  function getSocialV2State(key) {
    // 只接受规范会话 key，防止同一会话分裂成多个状态
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = b.socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: b.defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      claimPoolMemory(key, st);
      b.rememberAgentToken(key, st.agentToken);
      b.socialV2.conversations.set(key, st);
      b.scheduleProactiveCheckV2(key);
      b.setupSleepTimerV2(key);
    }
    return st;
  }

  // 从 social-v2.json 加载全部会话状态
  function loadSocialV2State() {
    loadLightMemoryFromPool();
    try {
      // 记下读取时的文件指纹，别的进程写过就不能回写覆盖
      const fileStamp = (() => {
        try {
          const s = fs.statSync(b.SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(b.SOCIAL_V2_FILE, null);
      if (raw && typeof raw === 'object') {
        try { migrateDocument('social-v2', raw); }
        catch (error) {
          b.socialV2.storeReadOnlyReason = String(error?.message ?? error);
          b.log(`⚠️ state/social-v2.json：${b.socialV2.storeReadOnlyReason}；本次运行只读不写`);
        }
      }
      b.socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = b.defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          // 把读回来的消息整理一下，去掉旧的管理员标记
          const restoreMessages = (items) => (Array.isArray(items) ? items : []).map((message) => message?.isSelf === true
            ? { ...message, isOwner: false, ownerLabel: '' } : message);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时只保留已知触发器字段
              triggers: b.pickWakeTriggersV2((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: restoreMessages(val.recentMessages),
            unread: restoreMessages(val.unread),
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 把指定成员名单统一格式，去掉不合法的值
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = b.normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍用默认唤醒配置的会话同步到当前默认参数
          b.refreshDefaultWakeConfigV2(st);
          // json 里有这三个字段就用 json 的（写池未成功时的最新副本）
          if (LIGHT_MEMORY_FIELDS.some((field) => field in val)) poolMemory.delete(key);
          else claimPoolMemory(key, st);
          b.rememberAgentToken(key, st.agentToken);
          b.socialV2.conversations.set(key, st);
          // 从存下来的消息里重新找出本聊天见过的转发编号
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          b.ensureWakeableV2(st, { skipSave: true, key });
          b.scheduleProactiveCheckV2(key);
        }
        // 加载完统一存一次；文件已被别的程序改过就不写
        const nowStamp = (() => {
          try {
            const s = fs.statSync(b.SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          b.log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      b.log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // 平时只做个标记，隔一会儿攒一批再写文件；设成 0 就每条都写
  let flushTimer = null;
  let dirty = false; // 有还没写到硬盘的改动（写失败也保持 true）
  let memoryStale = false; // 跳过的 lastMentionAt 写池，退出时要补
  // 做个有改动的标记，安排晚点一起写文件
  function markSocialV2Dirty() {
    dirty = true;
    const ms = Number(b.cfg.socialV2?.flushIntervalMs ?? 1000);
    if (!(ms > 0)) { saveSocialV2State(); return; }
    if (flushTimer) return;
    flushTimer = b.setTimeout(() => { flushTimer = null; saveSocialV2State(); }, ms);
    flushTimer?.unref?.();
  }
  // 退出前只有还没写的内容才写；没加载完不会拿空状态覆盖
  function flushSocialV2State() {
    if (dirty || memoryStale) saveSocialV2State(true);
  }

  // 立即保存二代状态（先写池再写 json）
  function saveSocialV2State(forceMemory = false) {
    if (flushTimer) { b.clearTimeout(flushTimer); flushTimer = null; }
    if (b.socialV2.storeReadOnlyReason) return;
    try {
      const obj = stampSchema('social-v2', { paused: b.socialV2.paused, conversations: Object.create(null) });
      for (const [key, st] of b.socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      // 先写池再写 json；写池失败时轻量记忆照旧写进 json
      if (!saveLightMemory(forceMemory)) {
        for (const [key, st] of b.socialV2.conversations) {
          Object.assign(obj.conversations[key], {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          });
        }
      }
      atomicWriteJson(b.SOCIAL_V2_FILE, obj);
      dirty = false;
      memoryStale = !forceMemory;
    } catch (error) {
      dirty = true;
      b.log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // 二代消息记录：去重、整理媒体、写进最近列表和未读
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(b.cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(b.cfg.socialV2?.context?.unreadLimit) || 30;
    // 同一个消息编号只记一次，记满就把最早的忘掉
    const msgId = messageId != null && String(messageId) !== '' ? String(messageId) : null;
    if (msgId && seenMessageIds.has(msgId)) return;
    if (msgId) {
      seenMessageIds.add(msgId);
      if (seenMessageIds.size > b.MAX_SEEN_MESSAGE_IDS) {
        // Set 按插入顺序迭代，删掉最老的
        for (const old of seenMessageIds) {
          seenMessageIds.delete(old);
          if (seenMessageIds.size <= b.MAX_SEEN_MESSAGE_IDS) break;
        }
      }
    }
    // 媒体要留下 emojiId/subType/summary/kind，认表情和下图片都要用
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 最多保留 1000 个 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: msgId,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${b.cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息，沉睡前等待/观察作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    markSocialV2Dirty();
  }

  // 拍一拍写入消息流，让 AI 看到谁拍了谁
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(b.cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(b.cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${b.cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    markSocialV2Dirty();
    return msg;
  }

  // 记录 AI 自己发出的消息
  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(b.cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = b.redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: false,
        ownerLabel: '',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 发言了，沉睡前观察作废，想睡要重新等待
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    markSocialV2Dirty();
  }

  return {
    seenForwardIds, seenMessageIds, getSocialV2State, loadSocialV2State, saveSocialV2State, flushSocialV2State, markSocialV2Dirty, forgetLightMemory, appendSocialV2Message, appendSocialV2Poke, recordSentMessagesV2 };
}
