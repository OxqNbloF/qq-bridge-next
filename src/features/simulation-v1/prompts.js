import { modelMessageVisible } from '../../gate/model-visibility.js';
import { rememberModelSources } from '../../memory/model-sources.js';
// 一代仿真社交引擎的各类提示词
import { getModeAdapter } from '../../modes/registry.js';

// 创建一代仿真提示词构造器
export function createSocialPromptsV1(b) {
  // 把一批新消息拼成回复提示词
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const visible = newMsgs.filter(message => modelMessageVisible(b, key, message));
    rememberModelSources(b, key, visible);
    const lines = visible.map((m) => `${m.isOwner ? '【管理员】' : ''}${b.sanitizeUntrustedText(m.sender)}：${b.sanitizeUntrustedText(m.text)}${b.mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    return getModeAdapter('reserved').buildPrompt({ promptType: 'batch', lines, allowSilent, directionHint: b.DIRECTION_HINT, splitHint: b.SPACE_SPLIT_HINT });
  }
  function buildProbePrompt(key) {
    return getModeAdapter('reserved').buildPrompt({ promptType: 'probe', context: b.buildContextBlock(key), splitHint: b.SPACE_SPLIT_HINT });
  }
  function buildActiveExitPrompt(key, roleHint) {
    return getModeAdapter('reserved').buildPrompt({ promptType: 'exit', context: b.buildContextBlock(key), roleHint });
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
    b.armSocialTimer?.(key);
    b.log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 观望阶段主动开话题
  function buildProactivePrompt(key, roleHint) {
    return getModeAdapter('reserved').buildPrompt({ promptType: 'proactive', context: b.buildContextBlock(key), roleHint, splitHint: b.SPACE_SPLIT_HINT });
  }

  return { buildBatchPrompt, buildProbePrompt, buildActiveExitPrompt, triggerActiveDurationExit, buildProactivePrompt };
}
