// 控制台里的维护操作：清会话、清空全部聊天、重启桥接
// 请求进来先用 rq 装着，要用外面的功能就通过 b
// 登录和权限在 bridge.js 前面都查过了，这里不重复也不绕过
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../../../dsh-client.js';

// 做出处理清会话、清空聊天、重启的请求处理器
export function createConsoleMaintenanceRoutes(b) {
  return async function consoleMaintenanceRoutes(rq) {
    // ── 清除对话记录 / 清空工作区 ──
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/session/reset') {
      const body = await rq.readBody();
      const key = String(body.key ?? '');
      if (!key || !b.state.sessions[key]) { rq.sendJson({ ok: false, error: '会话不存在' }, 404); return; }
      b.sessionEpoch++;
      const oldSessionId = b.state.sessions[key];
      delete b.state.sessions[key];
      b.modelAppliedSessions.delete(oldSessionId);
      // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
      delete b.state.sessionPolicies[key];
      b.reverse.delete(oldSessionId);
      b.forgetDeliveryCursor(oldSessionId);
      b.collectors.delete(oldSessionId);
      b.sendToolSucceededSessions.delete(oldSessionId);
      b.pendingSendToolCalls.delete(oldSessionId);
      b.v2TurnStartAt.delete(oldSessionId);
      b.turnLeaseNoted.delete(oldSessionId);
      b.toolCallNames.delete(oldSessionId);
      const pe = b.pending.get(key);
      if (pe) {
        b.clearTimeout(pe.timer);
        b.cancelPendingEntry(pe).catch(() => {});
      }
      b.pending.delete(key);
      b.queued.delete(key);
      b.queuedHintAt.delete(key);
      b.sessionPromises.delete(key);
      b.drainPromptQueue(key, '会话已重置');
      b.social.recentMessages.delete(key);
      b.messageMediaStore.delete(key);
      b.social.pendingSummaries.delete(key);
      b.social.states.delete(key);
      b.social.silentContext.delete(key);
      b.social.silentTurns.delete(oldSessionId);
      b.social.exitingSessions.delete(oldSessionId);
      b.slangWindows.delete(key);
      b.slangExtractionCooldowns.delete(key);
      b.slangSubmitTimes.delete(key);
      b.cancelSocialTimers(key);
      b.clearSocialV2Timers(key);
      b.pendingWakeKeys.delete(key);
      b.wakeConfigUpdatedKeys.delete(key);
      b.markReadCalledKeys.delete(key);
      b.wakeConfigMissCount.delete(key);
      b.forgetAgentToken(key);
      b.forgetConversationMemory(key); // 记忆池 / 索引 / 视图一起清（先于删会话状态）
      b.socialV2.conversations.delete(key);
      b.seenForwardIds.delete(key);
      b.saveSocialV2State();
      b.saveState();
      // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
      try { await b.withTimeout(b.api.stopSessionWork(oldSessionId), b.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { b.log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
      try { await b.withTimeout(b.api.workspace.archiveSession({ sessionId: oldSessionId }), b.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
      b.log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
      rq.sendJson({ ok: true, key, archived: oldSessionId });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/workspace/reset') {
      b.sessionEpoch++;
      let archivedCount = 0;
      let stoppedCount = 0;
      try {
        // 新版 DSH 没有工作区列表了，改成扫我们自己建的会话目录
        // 只处理 state/ 下的主会话，子会话由主会话管，不能一起归档
        const list = unwrap(await b.withTimeout(b.api.sessions.list({}), b.DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
        const stateDir = path.resolve(b.STATE_DIR);
        const statePrefix = path.normalize(stateDir + path.sep);
        // 把路径整理成当前系统认识的写法
        const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
        // 看看这个路径是不是在 state 目录底下
        const isUnderState = (cwd) => cwd.startsWith(statePrefix);
        for (const item of list.items ?? []) {
          if (item.origin === 'subagent' || item.parentSessionId) continue;
          const cwd = normPath(item.cwd);
          if (isUnderState(cwd)) {
            // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
            try { await b.withTimeout(b.api.stopSessionWork(item.sessionId), b.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
            catch (error) { b.log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
            try { await b.withTimeout(b.api.workspace.archiveSession({ sessionId: item.sessionId }), b.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
          }
        }
      } catch {}
      for (const entry of b.pending.values()) {
        b.clearTimeout(entry.timer);
        b.cancelPendingEntry(entry).catch(() => {});
      }
      b.pending.clear();
      b.queued.clear();
      b.queuedHintAt.clear();
      b.sessionPromises.clear();
      b.drainAllPromptQueues('工作区已清空');
      b.social.states.clear();
      b.social.recentMessages.clear();
      b.messageMediaStore.clear();
      b.seenForwardIds.clear();
      b.social.pendingSummaries.clear();
      b.social.silentContext.clear();
      b.social.silentTurns.clear();
      b.social.exitingSessions.clear();
      b.slangWindows.clear();
      b.slangExtractionCooldowns.clear();
      b.slangSubmitTimes.clear();
      b.cancelAllSocialTimers();
      b.clearAllSocialV2Timers();
      // 所有会话和令牌一起作废，两张表直接清空最省心
      b.forgetConversationMemory(); // 全部会话的记忆池 / 索引 / 视图
      b.socialV2.conversations.clear();
      b.CONVERSATION_TOKENS.clear();
      b.KNOWN_AGENT_TOKENS.clear();
      b.saveSocialV2State();
      b.state.sessions = {};
      b.state.sessionPolicies = {};
      b.reverse.clear();
      b.collectors.clear();
      b.sendToolSucceededSessions.clear();
      b.pendingSendToolCalls.clear();
      b.v2TurnStartAt.clear();
      b.toolCallNames.clear();
      b.saveState();
      try { fs.writeFileSync(b.ACTIVITY_LOG, ''); } catch {}
      b.log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
      rq.sendJson({ ok: true, archivedCount, stoppedCount });
      return;
    }
    // ── 重启桥接（守护模式下 5 秒后自动恢复） ──
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/restart') {
      rq.sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
      b.setTimeout(() => {
        b.log('控制台：重启桥接');
        // 退出前先把状态存到硬盘，不然这 500 毫秒里改的东西会丢
        try { b.saveState(); } catch (error) { b.log('重启前保存会话映射失败:', error?.message ?? error); }
        try { b.saveSocialV2State(); } catch (error) { b.log('重启前保存二代会话状态失败:', error?.message ?? error); }
        b.releaseLock();
        b.process.exit(0);
      }, 500);
      return;
    }
    return ROUTE_NEXT;
  };
}
