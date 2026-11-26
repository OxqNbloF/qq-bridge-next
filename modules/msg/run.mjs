import { callDaemon, runHandler } from '../_lib/sock-client.mjs';

await runHandler(async (action, args) => {
  switch (action) {
    case 'send': {
      const raw = args.messages;
      const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
      return callDaemon({
        module: 'msg',
        method: 'POST',
        path: '/api/agent/send-message',
        body: {
          messages: list,
          ...(args.replyToMessageId !== undefined ? { replyToMessageId: args.replyToMessageId } : {}),
          ...(args.atUserId !== undefined ? { atUserId: args.atUserId } : {}),
        },
      });
    }
    case 'read_unread':
      return callDaemon({
        module: 'msg',
        method: 'GET',
        path: '/api/agent/unread',
        query: {
          ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      });
    case 'read_recent':
      return callDaemon({
        module: 'msg',
        method: 'GET',
        path: '/api/agent/recent',
        query: {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        },
      });
    case 'message_detail':
      return callDaemon({
        module: 'msg',
        method: 'GET',
        path: '/api/agent/message-detail',
        query: { messageId: args.messageId },
      });
    case 'wait':
      return callDaemon({
        module: 'msg',
        method: 'POST',
        path: '/api/agent/wait',
        body: {
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(args.quietMs !== undefined ? { quietMs: args.quietMs } : {}),
          ...(args.purpose !== undefined ? { purpose: args.purpose } : {}),
        },
      });
    case 'done': {
      if (args.wakeConfig && typeof args.wakeConfig === 'object') {
        return callDaemon({
          module: 'msg',
          method: 'POST',
          path: '/api/agent/wake-config',
          body: {
            config: args.wakeConfig,
            ...(args.throughSeq !== undefined ? { throughSeq: args.throughSeq } : {}),
          },
        });
      }
      return callDaemon({
        module: 'msg',
        method: 'POST',
        path: '/api/agent/mark-read',
        body: args.throughSeq !== undefined ? { throughSeq: args.throughSeq } : {},
      });
    }
    case 'active_members':
      return callDaemon({
        module: 'msg',
        method: 'GET',
        path: '/api/agent/active-members',
        query: args.limit !== undefined ? { limit: args.limit } : {},
      });
    case 'group_members':
      return callDaemon({
        module: 'msg',
        method: 'GET',
        path: '/api/agent/group-members',
        query: args.limit !== undefined ? { limit: args.limit } : {},
      });
    default:
      return { ok: false, error: `未知 msg 动作：${action}` };
  }
});
