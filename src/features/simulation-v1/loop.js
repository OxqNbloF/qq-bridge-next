// 一代仿真调度：延迟回复、5 秒心跳、摘要投喂
import { boundedTimerDelay } from '../../infra/async.js';

// 创建一代调度函数，b 为桥接访问器
export function createSocialLoopV1(b) {
  // 取 [min, max] 间的随机整数
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  // 随机延迟后投递一次社交回复
  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = boundedTimerDelay(randInt(
      boundedTimerDelay(minDelay, 2000), boundedTimerDelay(maxDelay, 8000)
    ), 2000);
    b.log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = b.setTimeout(() => {
      const timers = b.social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) b.social.pendingTimers.delete(key);
      }
      b.deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => b.log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = b.social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    b.social.pendingTimers.set(key, timers);
  }

  // 心跳：主动开话题、活跃检测、冷场与试探回退
  function socialLoopTick() {
    if (!b.isSocialEnabled()) return;
    const now = Date.now();
    // 有消息或状态的群都参与状态机
    const keys = new Set([...b.social.states.keys(), ...b.social.recentMessages.keys()]);
    for (const key of keys) {
      const st = b.socialState(key);
      if (st.phase === 'idle') {
        // 观望期主动开话题（仅群聊）
        if (b.cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = b.social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(b.cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(b.cfg.social?.proactiveCheckMinMs ?? 2700000), Number(b.cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(b.cfg.social?.proactiveCheckMinMs ?? 2700000), Number(b.cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(b.cfg.social?.proactiveProbability ?? 0.2)) {
                b.enterActive(key);
                const roleHint = b.currentRoleHint();
                const promptText = b.buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(b.cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(b.cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                b.log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：到随机上限主动退场
        if (b.triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (b.social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(b.cfg.social?.activeCheckMinMs ?? 20000), Number(b.cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || b.isMustReplyText(m.plain ?? m.text));

            // 选择性沉默只对普通闲聊；点名提问必回
            if (!mustReply) {
              // 基准沉默概率；刚发言后被快速接话则不沉默
              let skipProb = Math.min(1, Math.max(0, Number(b.cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                b.log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 没回的消息存进 silentContext，下次一起带上
                const silent = b.social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                b.social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) b.appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时带上之前看到但没回的消息
            const seenMsgs = b.social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            b.social.silentContext.delete(key);
            const promptText = b.buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(b.cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(b.cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            b.log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(b.cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望，小概率试探一句
            if (Math.random() < Number(b.cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(b.cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = b.buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(b.cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(b.cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              b.log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              b.leaveActive(key);
              b.log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中等收尾发言；超 60 分钟强制回观望防卡死
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          b.log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = b.state.sessions[key];
          if (sid) b.social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话则回观望
        b.leaveActive(key);
        b.log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  // 启动 5 秒心跳
  function startSocialLoop() {
    if (b.social.loopTimer) b.clearInterval(b.social.loopTimer);
    b.social.loopTimer = b.setInterval(socialLoopTick, 5000);
    b.social.loopTimer.unref?.();
  }

  // 把累积的摘要投喂给模型
  async function flushSummaries(key = null) {
    const targets = key ? (b.social.pendingSummaries.has(key) ? [[key, b.social.pendingSummaries.get(key)]] : []) : [...b.social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${b.sanitizeUntrustedText(m.sender)}：${b.sanitizeUntrustedText(m.text)}${b.mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await b.ensureSession(k);
      } catch (error) {
        b.log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = b.currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${b.buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      b.social.silentTurns.set(sessionId, [...(b.social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
            // 取出并清空这个会话记着的沉默信息
      const popSilent = () => {
        const arr = b.social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) b.social.silentTurns.set(sessionId, next);
        else b.social.silentTurns.delete(sessionId);
      };
      try {
        const result = await b.deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          b.log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          b.log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        b.log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...b.social.pendingSummaries.keys()]) {
      if (b.social.pendingSummaries.get(k)?.items?.length === 0) b.social.pendingSummaries.delete(k);
    }
  }

  return { randInt, scheduleSocialReply, socialLoopTick, startSocialLoop, flushSummaries };
}
