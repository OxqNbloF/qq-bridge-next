import { buildMessagePrompt } from './mode-prompt.js';
import { extractForwardIds } from '../forward.js';
import { getModeAdapter } from '../modes/registry.js';

export function createModeDispatch(b) {
  async function dispatchModeMessage(input) {
    const { envelope, cfg, key, kind, id, flags, event, senderName, textContent, plainContent, mediaList, messageRef, quoteTargetIsSelf, isOwner, roleState, mentionsSelf } = input;
    const adapter = getModeAdapter(b.modeForKey(key));
    if (!adapter || flags.converse === false) return;
    // 来源只包含被拼入正文的作者；@ 和名字指认不是正文来源。
    const sourceQqs = [...new Set((envelope.sourceQqs ?? [envelope.sender.qq, ...(envelope.quote?.text ? [envelope.quote.senderQq] : [])])
      .filter(qq => /^[1-9]\d{0,15}$/.test(String(qq ?? ''))).map(String))];
    const identityRoster = adapter.capabilities.context !== 'snapshot' && kind === 'group' ? b.renderIdentityRoster(key, { exposeQq: cfg.identity?.exposeQqInPrompt === true }) : '';
    // 二代仿真：唤醒调度
    if (adapter.capabilities.context === 'snapshot') {
      const sender = kind === 'group' ? senderName : '私聊';
      b.appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), { unread: flags.respond, converse: true, noContext: !flags.context, sourceQqs });
      if (!flags.respond) {
        b.appendActivity(`${key} [reserved2] 消息仅入最近记录（该成员不计入回应）：${textContent.slice(0, 80)}`, event.message_id ?? event.msg_id ?? null);
        return;
      }
      if (!b.gateDecide({ kind, id, qq: event.user_id, cfg, closedAgentOk: b.modeForKey(key, b.currentMode, cfg) === 'closed-agent', runtime: { paused: b.socialV2.paused, aiReply: true }, applyMemberPolicy: cfg.architecture?.gateV2 === true }).allowed) {
        b.appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`, event.message_id ?? event.msg_id ?? null);
        return;
      }
      const st = b.getSocialV2State(key);
      const decision = adapter.decide({ flags, reason: st.bootstrapSent ? b.evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) : null }, st);
      if (decision.action === 'wake') {
        if (decision.reason === 'bootstrap') { st.bootstrapSent = true; b.saveSocialV2State(); }
        b.scheduleWakeV2(key, decision.reason, decision);
      }
      b.appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`, event.message_id ?? event.msg_id ?? null);
      return;
    }


    // 角色扮演提示，只给 agent
    const roleHint = b.currentRoleHint();

    // 群聊带发送者，角色提示放开头，管理员加身份标记
    const modelContent = b.modeForKey(key) === 'closed-agent' && isOwner ? textContent : b.sanitizeUntrustedText(textContent);
    const promptText = (adapter.capabilities.exit === 'phase' ? buildMessagePrompt : adapter.buildPrompt)({ roleHint, roster: identityRoster, isOwner, kind, sender: b.sanitizeUntrustedText(senderName), text: modelContent, mediaHint: b.mediaHintFor(key, messageRef, mediaList) });

    b.appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${senderName}：${textContent.slice(0, 80)}`, event.message_id ?? event.msg_id ?? null);

    // 一代仿真：走社交状态机
    if (adapter.capabilities.exit === 'phase' && b.isSocialEnabled(key)) {
      const sender = kind === 'group' ? senderName : '私聊';
      if (flags.context) b.appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef, { userId: envelope.sender.qq, respondAllowed: flags.respond, sourceQqs });
      if (!flags.respond) return;
      // 摘要会在之后喂给模型，不进上下文的成员不写
      const appendSummary = (...args) => { if (flags.context) b.appendSummary(...args, { userId: envelope.sender.qq, sourceQqs }); };
      const st = b.socialState(key);
      const phaseDecision = adapter.decide({ flags, kind }, st);

      // 退场中：不再接话，新消息进摘要
      if (phaseDecision.reason === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        b.log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：到随机上限主动退场
      if (st.phase === 'active' && b.triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        b.log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃/试探中有新消息则保持活跃
      if (phaseDecision.reason === 'active') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊直接即时投递
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${b.sanitizeUntrustedText(textContent)}${b.mediaHintFor(key, messageRef, mediaList)}`;
          b.scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList, sourceQqs, phaseDecision
          );
          b.log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        b.log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 观望期：明确对 AI 说或小概率触发；只看本条文字
      const direct = b.isDirectAddress(plainContent, event, kind, envelope.mentions) || mentionsSelf || quoteTargetIsSelf;
      const decision = adapter.decide({ flags, kind, direct, random: Math.random(), probability: Number(cfg.social?.triggerProbability ?? 0.15) }, st);
      if (decision.action !== 'wake') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        b.log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃状态，带上聊天记录和人格去回复
      if (adapter.onTurnStart({ activate: true })?.phase === 'active') b.enterActive(key);
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${b.sanitizeUntrustedText(sender)}：${b.sanitizeUntrustedText(textContent)}` : `${b.sanitizeUntrustedText(sender)}：${b.sanitizeUntrustedText(textContent)}`;
      const promptText = adapter.buildPrompt({ roleHint, context: b.buildContextBlock(key), roster: identityRoster, line: currentLine, text: textContent, direct, directionHint: b.DIRECTION_HINT, splitHint: b.SPACE_SPLIT_HINT, mediaHint: b.mediaHintFor(key, messageRef, mediaList) });
      if (isOwner && kind === 'private') {
        b.log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await b.deliverPrompt(key, promptText, { media: mediaList, sourceQqs, scheduleDecision: decision });
      } else {
        b.scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList, sourceQqs, decision
        );
      }
      return;
    }

    if (adapter.capabilities.exit === 'phase' ? !flags.respond : adapter.decide({ flags }).action !== 'wake') return;
    // 普通聊天也按到达顺序一条条处理，图片和文字不会乱序
    if (!b.dshReady) await b.sendQueueHintOnce(key);
    const result = await b.deliverPrompt(key, promptText, { media: mediaList, sourceQqs });
    if (result?.queued) {
      if (!b.dshReady) await b.sendQueueHintOnce(key);
      b.log(`消息已排队 (${key})`);
      return;
    }
    if (result?.retried) return;
    if (result?.ok && !result.command && cfg.ackMessage && adapter.sendPolicy.mode !== 'tools-only') {
      await b.sendToQQ(key, cfg.ackMessage);
    }
    if (result?.ok) b.log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  return { dispatchModeMessage };
}
