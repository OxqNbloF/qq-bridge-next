import { inspectRemoteImage } from '../../src/features/attachments.js';
import { callHubExec, runCapability } from '../_lib/ipc.mjs';

runCapability(async ({ action, args }) => {
  if (action === 'check_image') {
    const res = await inspectRemoteImage(args.url);
    return { ok: true, ...res };
  }
  return callHubExec({ capability: 'attach', action, args });
});
