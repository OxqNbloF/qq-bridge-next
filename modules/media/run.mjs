import { callDaemon, runHandler } from '../_lib/sock-client.mjs';

await runHandler(async (action, args) => {
  switch (action) {
    case 'get_images':
      return callDaemon({ module: 'media', method: 'GET', path: '/api/agent/images/message', query: { messageId: args.messageId } });
    case 'get_forward':
      return callDaemon({ module: 'media', method: 'GET', path: '/api/agent/forward-message', query: { id: args.id } });
    case 'list_stickers':
      return callDaemon({
        module: 'media',
        method: 'GET',
        path: '/api/agent/sticker-list',
        query: {
          ...(args.keyword !== undefined ? { keyword: args.keyword } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      });
    case 'get_sticker_image':
      return callDaemon({ module: 'media', method: 'GET', path: '/api/agent/sticker-image', query: { stickerId: args.stickerId } });
    case 'send_sticker':
      return callDaemon({
        module: 'media',
        method: 'POST',
        path: '/api/agent/send-sticker',
        body: {
          stickerId: args.stickerId,
          ...(args.replyToMessageId !== undefined ? { replyToMessageId: args.replyToMessageId } : {}),
          ...(args.atUserId !== undefined ? { atUserId: args.atUserId } : {}),
        },
      });
    case 'sticker_note':
      return callDaemon({
        module: 'media',
        method: 'POST',
        path: '/api/agent/sticker-note',
        body: {
          stickerId: args.stickerId,
          ...(args.note !== undefined ? { note: args.note } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.usage !== undefined ? { usage: args.usage } : {}),
        },
      });
    case 'collect_sticker':
      return callDaemon({
        module: 'media',
        method: 'POST',
        path: '/api/agent/collect-sticker',
        body: {
          messageId: args.messageId,
          ...(args.remark !== undefined ? { remark: args.remark } : {}),
        },
      });
    case 'poke':
      return callDaemon({
        module: 'media',
        method: 'POST',
        path: '/api/agent/send-poke',
        body: args.targetUserId ? { targetUserId: args.targetUserId } : {},
      });
    case 'list_voices':
      return callDaemon({ module: 'media', method: 'GET', path: '/api/agent/voices' });
    case 'send_voice':
      return callDaemon({ module: 'media', method: 'POST', path: '/api/agent/send-voice', body: { file: args.file } });
    default:
      return { ok: false, error: `未知 media 动作：${action}` };
  }
});
