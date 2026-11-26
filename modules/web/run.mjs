import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runModuleMain } from '../_lib/sock-client.mjs';

const ROOT = process.env.QQ_BRIDGE_ROOT || path.resolve(process.cwd(), '../..');

function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

await runModuleMain(async (action, args) => {
  if (action === 'search') {
    const clean = sanitizeQuery(args.query);
    if (!clean) return { ok: false, error: '查询词为空' };
    const { webSearch } = await import(pathToFileURL(path.join(ROOT, 'src', 'web-search.js')).href);
    const result = await webSearch(clean, { root: ROOT });
    return { ok: true, untrusted: true, data: result };
  }
  if (action === 'fetch') {
    const maxChars = Math.min(50000, Math.max(500, Number(args.maxChars) || 12000));
    const { safeFetch } = await import(pathToFileURL(path.join(ROOT, 'src', 'safe-fetch.js')).href);
    const result = await safeFetch(String(args.url ?? ''), maxChars, { allowPorts: [80, 443, 8080, 8443] });
    return { ok: true, untrusted: true, data: result };
  }
  return { ok: false, error: `未知 web 动作：${action}` };
});
