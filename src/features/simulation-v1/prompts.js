// 一代仿真社交引擎的各类提示词
import { SILENT_MARKER } from '../../policy/audit.js';

// 创建一代仿真提示词构造器
export function createSocialPromptsV1(b) {
  // 把一批新消息拼成回复提示词
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${b.sanitizeUntrustedText(m.sender)}：${b.sanitizeUntrustedText(m.text)}${b.mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${b.DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${b.SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${b.SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：只给状态背景，让 AI 自然说一句
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${b.buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${b.SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：暗示收尾，不暴露计时机制
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${b.buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时后安排一次退场发言，状态切 exiting
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊自动退场
    if (b.cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消旧回复定时器，避免退场时冒出旧发言
    b.cancelSocialTimers(key);
    const roleHint = b.currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    b.scheduleSocialReply(
      key, promptText,
      Number(b.cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(b.cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    b.log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 观望阶段主动开话题
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${b.buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${b.SPACE_SPLIT_HINT}`;
    return p;
  }

  return { buildBatchPrompt, buildProbePrompt, buildActiveExitPrompt, triggerActiveDurationExit, buildProactivePrompt };
}
