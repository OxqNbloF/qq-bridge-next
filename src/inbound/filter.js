// 管线薄协调器：保持各入站阶段的执行顺序，不持有记录或控制策略。
import { createInboundAdmission } from './admission.js';
import { createInboundRecording } from './recording.js';
import { createInboundControls } from './commands.js';

export function createInboundFilter(b) {
  const { prepareIncoming, allowIncomingRuntime } = createInboundAdmission(b);
  const { cacheIncomingMedia, recordIncoming } = createInboundRecording(b);
  const { consumeIncomingControl } = createInboundControls(b, allowIncomingRuntime);

  // QQ 消息转 DSH prompt
  async function processIncoming(envelope, cfg, prepared) {
    const { key, kind, id, flags } = prepared;
    const event = envelope.raw;
    const senderName = envelope.sender.displayName;
    const { text: textContent, plain: plainContent, media: mediaList, id: messageRef } = envelope;
    const mentionsSelf = envelope.mentions.some((mention) => String(mention.qq) === String(event.self_id ?? ''));
    cacheIncomingMedia(envelope, key);
    // 引用机器人自己视为对 AI 说；须在空文本过滤前判断
    const quoteTargetIsSelf = await b.isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!b.isSessionAllowedInCurrentMode(key)) return;
    // 存档要在丢掉空文字消息之前，纯图片消息也要记
    if (!recordIncoming(envelope, flags)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = envelope.sender.isOwner;
    const { consumed, roleState } = await consumeIncomingControl({ key, kind, id, cfg, flags, event, textContent, plainContent, isOwner });
    if (consumed) return;

    return b.dispatchModeMessage({ envelope, cfg, key, kind, id, flags, event, senderName, textContent, plainContent, mediaList, messageRef, quoteTargetIsSelf, isOwner, roleState, mentionsSelf });
  }

  return {
    prepareIncoming,
    processIncoming,
  };
}
