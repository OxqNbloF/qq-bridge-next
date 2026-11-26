import { callDaemon, runHandler } from '../_lib/sock-client.mjs';

await runHandler(async (action, args) => {
  switch (action) {
    case 'state':
      return callDaemon({ module: 'wake', method: 'GET', path: '/api/agent/state' });
    case 'prompt':
      return callDaemon({ module: 'wake', method: 'GET', path: '/api/agent/prompt' });
    case 'set_config':
      return callDaemon({
        module: 'wake',
        method: 'POST',
        path: '/api/agent/wake-config',
        body: {
          config: args.config,
          ...(args.throughSeq !== undefined ? { throughSeq: args.throughSeq } : {}),
        },
      });
    default:
      return { ok: false, error: `未知 wake 动作：${action}` };
  }
});
