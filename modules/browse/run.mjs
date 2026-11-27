import { safeFetch, webSearch } from '../../src/security/safe-fetch.js';
import { runCapability } from '../_lib/ipc.mjs';

runCapability(async ({ action, args }) => {
  if (action === 'search') {
    return webSearch(args.query, { maxResults: args.maxResults ?? 6 });
  }
  if (action === 'fetch') {
    const res = await safeFetch(args.url, { maxChars: args.maxChars ?? 30000 });
    return { ok: true, status: res.status, url: res.url, text: res.text };
  }
  return { ok: false, code: 'UNKNOWN_ACTION', error: `不支持的动作: ${action}` };
});
