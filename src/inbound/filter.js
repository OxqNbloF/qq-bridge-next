// 收到的 QQ 消息都从这里进：过滤、整理、存档、执行命令、按模式分发
import fs from 'node:fs';
import path from 'node:path';
import { extractForwardIds } from '../forward.js';
import { segmentsToText, extractMediaFromSegments } from '../inbound/normalize.js';
import { ignoredSender, allowed } from '../policy/access.js';
import { SILENT_MARKER } from '../policy/audit.js';

// 清理文字的函数从外面传进来，保证和消息用同一套判断
export function createInboundFilter(b) {
  // QQ 消息转 DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = b.convKey(kind, id);
    if (!b.modeAllowed(key, kind, id, cfg, b.currentMode)) {
      b.log(`忽略未授权会话 ${key}（当前模式 ${b.currentMode}，来自 ${event.user_id}）`);
      return;
    }
    if (ignoredSender(event.user_id, cfg)) {
      b.log(`忽略名单中的发送者消息 ${key}`);
      return;
    }
    // 把 @QQ号 换成群名片或昵称
    const resolveAtName = async (qq) => {
      // 只有群聊需要把 @QQ号 换成名片/昵称
      if (kind !== 'group') return null;
      return b.resolveGroupMemberName(event.group_id, qq);
    };
    // 按消息编号去查被引用的那条消息
    const resolveReply = (messageId) => b.resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 含引用信息；plainContent 只含本条文字
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = b.messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        b.messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 超过上限时删最旧一条
      while (mediaByRef.size > b.MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用机器人自己视为对 AI 说；须在空文本过滤前判断
    const quoteTargetIsSelf = await b.isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!b.isSessionAllowedInCurrentMode(key)) return;
    // 存档要在丢掉空文字消息之前，纯图片消息也要记
    b.archiveIncoming(key, event, { textContent, plainContent, mediaList });
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = b.readRoleState();

    // 挂起的提问/审批只能由管理员回答；群友消息照常处理
    const p = b.pending.get(key);
    if (p && isOwner) {
      await b.handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 静默模式：群友消息只记录不投递
    if (roleState.mode === 'silent' && !isOwner) {
      b.appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      b.log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 角色控制语仅管理员可用，群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await b.sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令仅管理员可用，由桥接直接执行
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        b.log(`忽略非管理员斜杠命令 ${key}`);
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = b.state.sessions[key];
        if (old) {
          b.sessionEpoch++;
          delete b.state.sessions[key];
          b.modelAppliedSessions.delete(old);
          delete b.state.sessionPolicies[key];
          b.reverse.delete(old);
          b.forgetDeliveryCursor(old);
          b.collectors.delete(old);
          b.sendToolSucceededSessions.delete(old);
          b.pendingSendToolCalls.delete(old);
          b.v2TurnStartAt.delete(old);
          b.turnLeaseNoted.delete(old);
          b.toolCallNames.delete(old);
          b.social.silentTurns.delete(old);
          b.social.exitingSessions.delete(old);
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
          b.forgetConversationMemory(key); // 先清记忆，再删会话状态
          b.socialV2.conversations.delete(key);
          b.seenForwardIds.delete(key);
          b.saveSocialV2State();
          b.saveState();
          // 先停 DSH 侧排队工作，再归档
          try { await b.withTimeout(b.api.stopSessionWork(old), b.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { b.log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await b.withTimeout(b.api.workspace.archiveSession({ sessionId: old }), b.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await b.sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = b.readRoleState();
        await b.sendToQQ(key, `会话 ${b.state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = b.sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          b.writeRoleState(null, roleState.mode);
          await b.sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(b.ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await b.sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            b.writeRoleState(name, roleState.mode);
            await b.sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        b.writeRoleState(roleState.role, 'silent');
        await b.sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        b.writeRoleState(roleState.role, 'active');
        await b.sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余斜杠内容原样发给 DSH
    }

    // 二代仿真：唤醒调度
    if (b.modeForKey(key) === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      b.appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代也收集群聊黑话素材
      if (kind === 'group') b.feedSlangWindow(key, sender, plainContent);
      if (b.socialV2.paused) {
        b.appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = b.getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        b.saveSocialV2State();
        b.scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = b.evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          b.scheduleWakeV2(key, reason);
        }
      }
      b.appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 群聊普通消息进黑话窗口，只学本条文字
    if (kind === 'group') {
      b.feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示，只给 agent
    const roleHint = b.currentRoleHint();

    // 群聊带发送者，角色提示放开头，管理员加身份标记
    const modelContent = b.modeForKey(key) === 'closed-agent' && isOwner ? textContent : b.sanitizeUntrustedText(textContent);
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${b.sanitizeUntrustedText(event.sender?.card || event.sender?.nickname || String(event.user_id))}：${modelContent}`
        : modelContent)
      + b.mediaHintFor(key, messageRef, mediaList);

    b.appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 一代仿真：走社交状态机
    if (b.isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      b.appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = b.socialState(key);

      // 退场中：不再接话，新消息进摘要
      if (st.phase === 'exiting') {
        b.appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        b.log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：到随机上限主动退场
      if (st.phase === 'active' && b.triggerActiveDurationExit(key, st, Date.now())) {
        b.appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        b.log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃/试探中有新消息则保持活跃
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊直接即时投递
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${b.mediaHintFor(key, messageRef, mediaList)}`;
          b.scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          b.log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        b.log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 观望期：明确对 AI 说或小概率触发；只看本条文字
      const direct = b.isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        b.appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        b.log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃状态，带上聊天记录和人格去回复
      b.enterActive(key);
      const roleHint = b.currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${b.sanitizeUntrustedText(sender)}：${b.sanitizeUntrustedText(textContent)}` : `${b.sanitizeUntrustedText(sender)}：${b.sanitizeUntrustedText(textContent)}`;
      const directionHint = textContent.includes('[引用') ? b.DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${b.SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${b.SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${b.buildContextBlock(key)}\n【当前消息】${currentLine}${b.mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        b.log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await b.deliverPrompt(key, promptText, { media: mediaList });
      } else {
        b.scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // 普通聊天也按到达顺序一条条处理，图片和文字不会乱序
    if (!b.dshReady) await b.sendQueueHintOnce(key);
    const result = await b.deliverPrompt(key, promptText, { media: mediaList });
    if (result?.queued) {
      await b.sendQueueHintOnce(key);
      b.log(`DSH 不可用，消息入队 (${key})`);
      return;
    }
    if (result?.retried) return;
    if (result?.ok && !result.command && cfg.ackMessage && b.modeForKey(key) !== 'reserved2') {
      await b.sendToQQ(key, cfg.ackMessage);
    }
    if (result?.ok) b.log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  return { handleIncoming };
}
