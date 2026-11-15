// 给 AI 看「现在该不该说话」的参考，和该安静多久的建议
// 也负责把话题、想法、对群友的印象整理成文字，并记下来
import { truncateText } from '../../md-to-plain.js';
import { looksLikeUnfinished } from '../../v2-wait.js';
import { boundedSources, mergeSources as mergeMemorySources } from '../../memory/sources.js';
import { assertMemoryWriteAllowed } from '../../memory/write-guard.js';
import { canonicalV2Key } from '../../policy/access.js';
import { modelMemberVisible, modelMessageVisible, modelStateKey } from '../../gate/model-visibility.js';

// 清理文字的函数要从外面传进来，不能直接 import
// 因为测试环境和运行环境判断对象的方式不一样，直接拿会丢字段
export function createParticipationV2(b) {
  function resolveKey(st, key = null) {
    return canonicalV2Key(key) || modelStateKey(b, st);
  }

  // 给 AI 一段「现在该不该说话」的参考
  function formatParticipationV2(st, key = null, { filterVisibility = true } = {}) {
    if (!st) return '';
    const resolvedKey = resolveKey(st, key);
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const visible = (m) => m && (!filterVisibility || !resolvedKey || modelMessageVisible(b, resolvedKey, m));
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter(visible);
    const aiCount = recent.filter((m) => m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m.sender || m.user_id || '?')).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => visible(m) && b.isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  // 建议说完话后再等多久，别插话太快
  function suggestQuietMsV2(st, key = null) {
    const defaultMs = Number(b.cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const resolvedKey = resolveKey(st, key);
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && (!resolvedKey || modelMessageVisible(b, resolvedKey, m)));
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  // 把话题、想法、群友印象整理成文字
  function formatMemoryV2(st, key = null, { filterVisibility = true } = {}) {
    if (!st) return '';
    const resolvedKey = resolveKey(st, key);
    if (filterVisibility && resolvedKey?.startsWith('private:') && !modelMemberVisible(b, resolvedKey)) return '';
    const memberContextVisible = (qq) => !filterVisibility || modelMemberVisible(b, resolvedKey, qq, { isImpression: true });
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${b.sanitizeUntrustedText(t.text)}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${b.sanitizeUntrustedText(t.pendingQuestion)}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${b.sanitizeUntrustedText(t.text)}${t.motivation ? `（${b.sanitizeUntrustedText(t.motivation)}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions).filter(memberContextVisible);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${b.sanitizeUntrustedText(im.displayName || name.replace(/^legacy:/, ''))}：${traits.length ? b.sanitizeUntrustedText(traits.join('、')) : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    // 整段加起来最多这么多字，超了就把整行丢掉
    const maxChars = Number(b.cfg.socialV2?.context?.memoryMaxChars) || 1500;
    const kept = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > maxChars) break;
      kept.push(line);
      used += line.length + 1;
    }
    return kept.join('\n');
  }

  // 把新的话题、想法或印象记下来
  function appendMemoryV2(st, category, content, extra = {}, conversationKey) {
    if (!st) return;
    const key = canonicalV2Key(conversationKey);
    let target;
    if (category === 'memberImpression') {
      const rawTarget = String(extra.target || '').trim();
      if (rawTarget.startsWith('legacy:')) throw Object.assign(new Error('未解析的历史印象只读，请指定 QQ 重新记录'), { statusCode: 400 });
      const resolved = /^[1-9]\d{0,15}$/.test(rawTarget) ? { qq: rawTarget }
        : key && !rawTarget.startsWith('legacy:') ? b.resolveIdentityAlias?.({ conv: key, group: key.startsWith('group:') ? key.slice(6) : null, text: rawTarget }) : null;
      if (!resolved?.qq || resolved.ambiguous) throw Object.assign(new Error('群友称呼无法唯一解析，请指定 QQ'), { statusCode: 400 });
      target = String(resolved.qq);
    }
    if (key) assertMemoryWriteAllowed(b, key, { state: st, targetQq: target, sourceMessageIds: extra.sourceMessageIds });
    else if (b.cfg?.architecture?.gateV2) throw Object.assign(new Error('无法确认记忆所属会话'), { statusCode: 403 });
    if (target && key?.startsWith('group:')) {
      const people = b.identitySnapshot?.()?.people;
      const person = people && Object.hasOwn(people, target) ? people[target] : null;
      const group = key.slice(6);
      const observed = person?.groups && Object.hasOwn(person.groups, group)
        || [...(st.recentMessages ?? []), ...(st.unread ?? [])].some(message => !message.isSelf && String(message.userId ?? message.user_id ?? '') === target);
      if (!observed) throw Object.assign(new Error('未观察到该群成员，请先确认目标 QQ'), { statusCode: 400 });
    }
    const mergeSources = old => mergeMemorySources(old?.sourceMessageIds, extra.sourceMessageIds);
    const text = b.redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.sourceMessageIds = mergeSources(existing);
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => b.redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(b.redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          sourceMessageIds: boundedSources(extra.sourceMessageIds),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => b.redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: b.redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.sourceMessageIds = mergeSources(existing);
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = b.redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          sourceMessageIds: boundedSources(extra.sourceMessageIds),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: b.redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        sourceMessageIds: st.memberImpressions[target] ? mergeSources(old) : boundedSources(extra.sourceMessageIds),
        displayName: extra.targetName ?? old.displayName ?? b.identityDisplayName?.(target, key?.startsWith('group:') ? key.slice(6) : null) ?? '群友',
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    b.saveSocialV2State();
  }

  return { formatParticipationV2, suggestQuietMsV2, formatMemoryV2, appendMemoryV2 };
}
