import fs from 'node:fs';
import { canonicalV2Key } from '../policy/access.js';

// 显式清掉目标会话所有混合上下文及派生记忆，不能只遗忘受限 actor。
// 原始归档不删除；游标移到末尾，旧归档不被下一批压缩重新投喂。
export function resetMemoryContext(b, inputKey, { confirm = false } = {}) {
  if (confirm !== true) throw Object.assign(new Error('清理上下文及派生记忆需明确 confirm=true'), { statusCode: 400 });
  const key = canonicalV2Key(inputKey);
  if (!key) throw Object.assign(new Error('会话 key 非法'), { statusCode: 400 });
  const st = b.socialV2.conversations.get(key);
  const sessionId = b.state.sessions[key];
  if (!st && !sessionId) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
  const state = st ?? b.getSocialV2State(key);
  const save = () => {
    if (b.saveSocialV2State() === false) throw Object.assign(new Error('上下文清理状态保存失败，保持记忆写入冻结'), { statusCode: 503 });
    if (b.SOCIAL_V2_FILE) {
      const saved = JSON.parse(fs.readFileSync(b.SOCIAL_V2_FILE, 'utf8'))?.conversations?.[key];
      if (!saved || Boolean(saved.modelSourcesIncomplete) !== Boolean(state.modelSourcesIncomplete)) {
        throw Object.assign(new Error('上下文清理状态保存失败，保持记忆写入冻结'), { statusCode: 503 });
      }
    }
  };
  // 中途失败或崩溃必须继续拒写；完整清理成功前不清来源账本。
  state.modelSourcesIncomplete = true;
  save();
  try {
    b.retireSession(key, { preserveMemorySources: true });
    // 即使后续主映射/身份持久化失败，也必须先撤销所有在途学习任务。
    if (b.invalidateMemoryLearnerSession(true) !== true) throw new Error('学习会话撤销未持久化');
    if (b.saveState() !== true) throw new Error('会话映射撤销未持久化');
    b.queued.delete(key);
    b.social.recentMessages.delete(key);
    b.social.pendingSummaries.delete(key);
    b.social.silentContext.delete(key);
    b.messageMediaStore.delete(key);
    b.seenForwardIds.delete(key);
    b.forwardMediaRefs.delete(key);
    for (const ref of b.replyInfoCache.keys()) if (String(ref).startsWith(`${key}:`)) b.replyInfoCache.delete(ref);
    state.recentMessages = [];
    state.unread = [];
    state.modelSeenSeqs = new Set();
    state.lastReadThroughSeq = state.lastUnreadSeq || 0;
    state.activeTopics = [];
    state.pendingThoughts = [];
    state.memberImpressions = {};
    state.lastWakeReason = '';
    state.lastIncomingAt = 0;
    state.preSleepWaitSatisfiedAt = 0;
    state.preSleepWaitObservedAt = 0;
    state.preSleepWaitAccumMs = 0;
    state.wakeConfig = b.defaultWakeConfigV2();
    // 在池清理前捕获晋升来源；身份副本必须先持久化撤销，失败可安全重试。
    const removed = b.memoryPool.query().filter(item => item.conv_id === key);
    if (b.resetIdentityContext(key, removed) !== true) throw new Error('身份清理未持久化');
    b.forgetConversationMemory(key); // 包括在途侧车 epoch、未认领轻量记忆。
    // forget 的兼容入口会记录部分错误；此处显式执行、验证，不把部分清理当成功。
    b.memoryPool.update(items => items.filter(item => item.conv_id !== key));
    if (b.memoryPool.query().some(item => item.conv_id === key)) throw new Error('目标会话派生记忆尚未清空');
    b.memoryIndex.drop(key);
    b.removeMemoryView({ convId: key });
    if (b.messageArchive) {
      const lastSeq = b.messageArchive.lastSeq(key);
      b.compressCursor.set(key, lastSeq);
      if (b.compressCursor.get(key) !== lastSeq) throw new Error('压缩游标未完成清理');
    }
    save(); // 先持久化空上下文，仍保持 incomplete。
    state.modelSourceQqs = [];
    state.modelSourcesIncomplete = false;
    save();
  } catch (error) {
    state.modelSourcesIncomplete = true;
    b.saveSocialV2State();
    throw Object.assign(new Error(`上下文清理未完成，记忆写入保持冻结：${error?.message ?? error}`), { statusCode: 503 });
  }
  b.appendActivity(`隐私上下文清理 ${key}：已撤销旧会话、队列、上下文及派生记忆；其他会话与全局条目保留`);
  return { key, scope: 'privacy-context', retiredSessionId: sessionId ?? null, remoteHistoryDeleted: false };
}
