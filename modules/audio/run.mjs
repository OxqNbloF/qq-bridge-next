import { callHubExec, runCapability } from '../_lib/ipc.mjs';

runCapability(async ({ action, args }) => callHubExec({ capability: 'audio', action, args }));
