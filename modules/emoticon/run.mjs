import { callHubExec, runCapability } from '../_lib/ipc.mjs';

runCapability(async ({ action, args }) => callHubExec({ capability: 'emoticon', action, args }));
