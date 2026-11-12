// 黑话：整理出能公开给 AI 的条目，再插到提示词里
import { SLANG_STATUS, slangScopeVisible, buildSlangContext } from '../../slang-learner.js';

// 做出整理黑话、拼提示词的小工具组
export function createSlangInject(b) {
  // 给 AI 看的黑话条目，只放能公开的字段
  // 不带证据原话，免得 A 群看到 B 群的聊天内容
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2(currentKey) {
    const max = Math.max(1, Math.min(30, Number(b.cfg.slang?.injectMax) || 8));
    return b.slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning && slangScopeVisible(e.scope, currentKey))
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  // 把当前时间、令牌和黑话插到提示词前面
  function withSlangContext(promptText, currentKey = '') {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (b.modeForKey(currentKey) === 'closed-agent') {
      const st = b.getSocialV2State(currentKey);
      parts.push(`【私聊媒体工具】key="${currentKey}"；【会话令牌】${st.agentToken}。查看或发送收藏表情时必须带上此 key 和 token；仅限当前管理员私聊。`);
    }
    if (b.cfg.slang?.enabled !== false) {
      const block = buildSlangContext(b.slangEntries, b.cfg.slang?.injectMax ?? 8, currentKey);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  return { publicSlangEntry, confirmedSlangListV2, withSlangContext };
}
