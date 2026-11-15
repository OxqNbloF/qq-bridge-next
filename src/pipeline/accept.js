import { createDeduper } from './dedupe.js';
import { canonicalV2Key } from '../policy/access.js';
import { buildEnvelope } from './envelope.js';
import { modelMessageVisible } from '../gate/model-visibility.js';

export function createPipelineAccept(b) {
  const deduper = createDeduper();
  return {
    acceptPipelineMessage: async (kind, event, cfg, convId) => {
      const rawId = convId ?? (kind === 'group' ? event?.group_id : event?.user_id);
      const conv = canonicalV2Key(b.convKey(kind, rawId));
      const messageId = event?.message_id ?? event?.msg_id ?? event?.message_seq;
      if (!conv || deduper.seen(conv, messageId)) return;
      const id = conv.slice(kind.length + 1);
      let preparedEnvelope;
      try {
        preparedEnvelope = await prepareEnvelope(kind, id, event, cfg, conv);
      } catch (error) {
        deduper.forget(conv, messageId);
        throw error;
      }
      if (!preparedEnvelope) return;
      preparedEnvelope.envelope.flags = preparedEnvelope.prepared.flags;
      preparedEnvelope.envelope.gate = preparedEnvelope.prepared.decision.gate;
      b.observeAliasEvidence(preparedEnvelope.envelope);
      return b.processIncoming(preparedEnvelope.envelope, cfg, preparedEnvelope.prepared);
    },
  };

  async function prepareEnvelope(kind, id, event, cfg, conv) {
    const prepared = b.prepareIncoming(kind, id, event, cfg);
    if (!prepared) return;
    const resolveAtName = async (qq) => {
      if (kind !== 'group') return null;
      const known = b.identityDisplayName(qq, String(id));
      if (known) return known;
      const name = await b.resolveGroupMemberName(id, qq);
      if (name) b.observeResolvedIdentity({ qq: String(qq), group: String(id), name, source: 'at', conv, messageId: event.message_id ?? event.msg_id });
      return name;
    };
    const envelope = await buildEnvelope(kind, event, {
      convId: id,
      resolveAtName,
      resolveReply: async replyId => {
        const info = await b.resolveReplyInfo(kind, id, replyId, event.self_id);
        if (info && cfg.architecture?.gateV2) {
          const st = b.socialV2?.conversations.get(conv);
          const stored = [...(st?.recentMessages ?? []), ...(st?.unread ?? [])]
            .find(message => String(message.messageId ?? '') === String(replyId));
          // 引用的正文仍是历史，不能借当前发言人的输入例外恢复。
          if (!modelMessageVisible(b, conv, info) || (stored && !modelMessageVisible(b, conv, stored))) return { ...info, text: '' };
        }
        if (info?.userId && info.sender) b.observeResolvedIdentity({ qq: String(info.userId), group: kind === 'group' ? String(id) : null, name: info.sender, source: 'quote', conv, messageId: replyId });
        return info;
      },
      resolveDisplayName: (qq, messageKind, convId) => b.identityDisplayName(String(qq), messageKind === 'group' ? String(convId) : null),
      resolveAliases: (qq, messageKind, convId) => b.identityAliases(String(qq), messageKind === 'group' ? String(convId) : null),
      resolveAlias: (text) => b.resolveIdentityAlias({ conv, group: kind === 'group' ? id : null, text }),
      resolveMentions: (text) => b.resolveIdentityMentions({ conv, group: kind === 'group' ? id : null, text }),
      ownerQQ: cfg.ownerQQ,
    });
    return envelope ? { envelope, prepared } : null;
  }
}
