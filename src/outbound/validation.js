import { splitForQQ } from '../md-to-plain.js';

export function planOutboundTimeline(b, text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条发送，只做安全硬拆
    if (!enabled) {
      return { main: b.splitLongSegment(src, maxChars).map(b.singleLineForQQ), followUp: null };
    }

    // 按空格拆条，每条再按 maxChars 硬拆
    const parts = b.splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: b.splitLongSegment(parts[0] || src, maxChars).map(b.singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...b.splitLongSegment(part, maxChars).map(b.singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

export function outboundError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// Length/splitting runs only after gate, rate reservation and full-batch audit.
export function prepareOutboundItems(b, key, intent, items) {
  const cfg = b.cfg.socialV2?.send ?? {};
  if (intent.split === 'timeline') {
    if (intent.timelineText !== undefined) {
      const segments = planOutboundTimeline(b, intent.timelineText, b.cfg.social).main;
      const base = items[0] ?? intent;
      items = segments.map((text, index) => ({
        ...base,
        text,
        afterDelay: index === segments.length - 1 ? 0
          : (index < items.length - 1 ? items[index].afterDelay : (intent.nextTimelineDelay?.() ?? base.afterDelay ?? 0)),
      }));
    } else {
      items = items.flatMap(item => {
        const parts = planOutboundTimeline(b, item.text, b.cfg.social).main;
        return parts.map((text, index) => ({
          ...item,
          text,
          afterDelay: index === parts.length - 1 ? item.afterDelay : (intent.nextTimelineDelay?.() ?? 0),
        }));
      });
    }
  }
  if (intent.split === 'qq') items = items.flatMap(item => splitForQQ(item.text).map(text => ({ ...item, text })));
  if (intent.channel === 'tool' && !intent.segments && !intent.action) {
    if (cfg.burstEnabled === false && items.length > 1) throw outboundError('已禁用多条发送，请合并为一条消息', 403);
    const maxMsgs = Math.max(1, Number(cfg.burstMaxMessages) || 8);
    const maxChars = Math.max(1, Number(cfg.maxMessageChars) || 500);
    if (items.length > maxMsgs) throw outboundError(`最多发送 ${maxMsgs} 条`);
    for (const item of items) {
      if (!item.text) throw outboundError('message 不能为空');
      if (item.text.length > maxChars) throw outboundError(`单条消息不能超过 ${maxChars} 字`);
    }
  }
  return items;
}

// Never coerce message IDs to Number: signed IDs may exceed safe integer range.
export async function validateOutboundReferences(b, key, intent, items) {
  const [kind, id] = key.split(':');
  let quoted = null;
  if (intent.pokeTarget !== undefined) {
    const target = String(intent.pokeTarget);
    if (kind === 'group' && !target) throw outboundError('群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）');
    if (target && !/^[1-9]\d*$/.test(target)) throw outboundError('targetUserId 必须是正整数 QQ 号');
    if (kind === 'group') {
      const error = await b.assertGroupMember(Number(id), target);
      if (error) throw outboundError(error, 403);
    }
  }
  for (const item of items) {
    const reply = item.replyTo === undefined || item.replyTo === null ? '' : String(item.replyTo).trim();
    const at = item.at === undefined || item.at === null ? '' : String(item.at).trim();
    if (intent.requireReply && !reply) throw outboundError('replyToMessageId 不能为空');
    if (intent.noReply && reply) throw outboundError('qq_send_burst 暂不支持引用，请使用 qq_reply');
    if (reply && !/^-?[1-9]\d*$/.test(reply)) throw outboundError('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    if (at && kind === 'private') throw outboundError('私聊不需要 @');
    if (at && !/^[1-9]\d*$/.test(at)) throw outboundError('atUserId 必须是正整数 QQ 号，且不能为 all');
    if (reply && intent.resolveReply) {
      const resolved = await b.resolveReplyTargetV2(b.getSocialV2State(key), kind, Number(id), reply);
      if (!resolved) throw outboundError('无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）');
      item.replyTo = resolved.messageId;
      quoted = resolved.info;
    } else if (reply) item.replyTo = reply;
    if (at) item.at = at;
  }
  return quoted;
}
