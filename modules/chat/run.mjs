import { callHubExec, runCapability } from '../_lib/ipc.mjs';

runCapability(async ({ action, args }) => {
  const timeoutMs = action === 'linger' ? Math.max(20000, Number(args.timeoutMs || 60000) + 5000) : 20000;
  return callHubExec({ capability: 'chat', action, args, timeoutMs });
});
