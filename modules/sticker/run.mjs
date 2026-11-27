import { callSocketAction, runModule } from '../_lib/client.mjs';

await runModule(async (action, args) => callSocketAction({ module: 'sticker', action, args }));
