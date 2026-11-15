import { buildStickerStrategyHint, buildStickerContext } from '../sticker-lib.js';
import { looksLikeUnfinished } from '../v2-wait.js';

// 只描述模式策略；状态、调度和副作用由执行层持有。
export const reserved2Mode = Object.freeze({
  id: 'reserved2', displayName: '二代仿真',
  capabilities: { schedule: ['immediate', 'batched', 'probability', 'timer', 'manual'], memory: ['light', 'terms', 'long'], tools: 'restricted', send: 'tools-only', context: 'snapshot', exit: 'wake', permission: 'allowlist' },
  toolPolicy: { groups: ['turn', 'read', 'memory', 'identity', 'web', 'send', 'sticker', 'voice'], deny: [], allowed: "preset" },
  memoryPolicy: { read: ['light', 'terms', 'long'], write: ['activeTopic', 'pendingThought', 'memberImpression', 'term', 'alias'], maxChars: 1500 },
  sendPolicy: { mode: 'tools-only', burst: false, audit: true },
  decide(evt, state) {
    if (!evt.flags.respond || evt.paused) return { action: 'drop', reason: evt.paused ? 'paused' : 'respond-disabled' };
    const reason = !state.bootstrapSent ? 'bootstrap' : evt.reason;
    return { action: reason ? 'wake' : 'defer', strategy: 'batched', reason, priority: 0 };
  },
  buildPrompt(ctx) {
    const { key, reason, state: st, roleState, rolePick, memoryText, roster } = ctx;
    const roleLine = roleState.role
      ? (rolePick.full
        ? `【当前角色】${roleState.role}\n【角色卡 —— 以下是你的设定，必须按它说话，不要复述这份卡】\n${rolePick.text || '（角色卡为空，按仿真提示词行动）'}\n【角色卡结束】\n\n`
        : `${rolePick.text}\n\n`)
      : '';
    const identityLine = ctx.identity;
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    const rosterLine = roster ? `【群成员】\n${roster}\n\n` : '';
    const participationText = ctx.participation;
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const stickerCfg = ctx.config?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(ctx.stickers, stickerCfg.promptMaxStickers ?? 8, key)}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(ctx.config?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const replyTiming = ctx.replyTiming;
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。【不要靠猜】：等待返回里的 canSleepNow/hint 就是闸门的判断结果——canSleepNow=true 立刻收尾（mark_read 或 set_wake_config）；false 时按 hint 给出的 timeoutMs 一次等满，别用更短的 timeoutMs 去凑（更短的等待不算观察，只会白等一轮）。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf && !m.noContext);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((ctx.now - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).filter((m) => m && !m.noContext && !m.no_context).length} 条`];
    if (lastMsg) {
      const lastAgo = ctx.describeAge(lastMsg.time, ctx.now);
      statusBits.push(`最近一条来自 ${ctx.sanitize(lastMsg.sender || '未知')}${lastAgo ? `（${lastAgo} 前）` : ''}：${ctx.sanitize(String(lastMsg.text || lastMsg.plain || '')).slice(0, 30)}`);
    }
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 初始提示词只在首次唤醒时写进去，放在靠前位置
    const initialPromptText = ctx.initialPrompt;
    const initialPromptLine = initialPromptText ? `${initialPromptText}\n\n` : '';
    // 时间感放 base 末尾，紧挨唤醒原因
    const timeSenseLine = ctx.timeSense;
    const currentInputLine = ctx.currentInput ? `【当前输入（仅本回合，不作历史上下文）】\n${ctx.sanitize(String(ctx.currentInput.sender || '群友'))}：${ctx.sanitize(String(ctx.currentInput.text || ctx.currentInput.plain || '')).slice(0, 2000)}\n\n` : '';
    const base = roleLine + identityLine + tokenLine + initialPromptLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + rosterLine + participationLine + preSleepLine + timeSenseLine + currentInputLine;
    // 取触发唤醒的消息 seq，用于算消息新旧
    const triggeredSeq = ctx.triggeredSeq;
    const triggeredMsg = triggeredSeq ? ctx.triggeredMessage : null;
    const triggeredAgo = triggeredMsg ? ctx.describeAge(triggeredMsg.time, ctx.now) : '';
    const triggeredLine = triggeredAgo ? `（触发这条是 ${triggeredAgo} 前发的${triggeredMsg?.sender ? `，来自「${triggeredMsg.sender}」` : ''}，不是刚刚）` : '';
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}${triggeredLine}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  },
  onTurnStart() { return null; },
  onTurnEnd() { return null; },
});
