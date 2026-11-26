import { callDaemon, runHandler } from '../_lib/sock-client.mjs';

await runHandler(async (action, args) => {
  switch (action) {
    case 'my_recent':
      return callDaemon({
        module: 'social',
        method: 'GET',
        path: '/api/agent/my-recent',
        query: args.limit !== undefined ? { limit: args.limit } : {},
      });
    case 'feedback':
      return callDaemon({
        module: 'social',
        method: 'POST',
        path: '/api/agent/feedback',
        body: {
          message: args.message,
          ...(args.level ? { level: args.level } : {}),
        },
      });
    default:
      return { ok: false, error: `未知 social 动作：${action}` };
  }
});
