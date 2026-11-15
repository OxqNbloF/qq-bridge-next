export function createContextPreamble(b) {
  function withContextPreamble(promptText, currentKey = '') {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (b.modeForKey(currentKey) === 'closed-agent') {
      const st = b.getSocialV2State(currentKey);
      parts.push(`【当前私聊工具】key="${currentKey}"；【会话令牌】${st.agentToken}。调用 QQ 工具（包括发送、读图、表情和语音）时带上此 key 和 token；调用新 Agent API 时必须携带，且仅限当前管理员私聊。`);
    }
    if (b.modeForKey(currentKey) && b.modeForKey(currentKey) !== 'closed-agent' && !promptText.includes('【会话令牌】')) {
      parts.push(`【会话令牌】${b.getSocialV2State(currentKey).agentToken}（仅限当前会话 ${currentKey}，调用 QQ 工具时带上 key 和 token）`);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }
  return { withContextPreamble };
}
