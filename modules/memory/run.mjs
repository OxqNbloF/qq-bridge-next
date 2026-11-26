import { callDaemon, runHandler } from '../_lib/sock-client.mjs';

await runHandler(async (action, args) => {
  switch (action) {
    case 'query':
      return callDaemon({
        module: 'memory',
        method: 'GET',
        path: '/api/agent/memory',
        query: {
          category: args.category,
          ...(args.q !== undefined ? { q: args.q } : {}),
          ...(args.target !== undefined ? { target: args.target } : {}),
        },
      });
    case 'append':
      return callDaemon({
        module: 'memory',
        method: 'POST',
        path: '/api/agent/memory-append',
        body: {
          category: args.category,
          content: args.content,
          ...(args.target !== undefined ? { target: args.target } : {}),
          ...(args.extra !== undefined ? { extra: args.extra } : {}),
        },
      });
    case 'remove':
      return callDaemon({
        module: 'memory',
        method: 'POST',
        path: '/api/agent/memory-remove',
        body: {
          category: args.category,
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.target !== undefined ? { target: args.target } : {}),
        },
      });
    case 'clear':
      return callDaemon({
        module: 'memory',
        method: 'POST',
        path: '/api/agent/memory-clear',
        body: args.category ? { category: args.category } : {},
      });
    default:
      return { ok: false, error: `未知 memory 动作：${action}` };
  }
});
