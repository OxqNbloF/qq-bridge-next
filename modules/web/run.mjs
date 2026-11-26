import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runModule } from '../_lib/client.mjs';

const root = process.env.QQ_BRIDGE_ROOT || path.resolve(import.meta.dirname, '../..');
const safeFetchMod = await import(pathToFileURL(path.join(root, 'src/security/safe-fetch.js')).href);

await runModule(async (action, args) => {
  if (action === 'search') {
    return safeFetchMod.webSearch(args.query, { maxResults: args.maxResults ?? 6 });
  }
  if (action === 'fetch') {
    const res = await safeFetchMod.safeFetch(args.url, { maxChars: args.maxChars ?? 20000 });
    return { ok: true, status: res.status, url: res.url, text: res.text };
  }
  return { ok: false, error: `未知 web 动作: ${action}` };
});
