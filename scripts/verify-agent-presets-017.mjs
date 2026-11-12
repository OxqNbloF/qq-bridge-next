// 检查 DSH 上的两个 QQ preset 是不是真的装好了
// 用法：node scripts/verify-agent-presets-017.mjs 地址
// 不用 process.exit()，否则 Windows 上成功跑也会退出码非 0
import { discoverDshSessionCookie } from '../src/dsh-client.js';

const BASE = process.argv[2] || process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';
const WANTED = ['qq-chat', 'qq-chat-v2'];

let failed = 0;
// 打印一项检查结果，失败就记一次
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

// 向 DSH 发一次请求，出错就抛出来
async function rpc(cookie, method, args = {}) {
  const rpcId = `verify-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (res.status !== 200 || (body && body.error)) {
    throw new Error(`${method} 失败：HTTP ${res.status} ${body?.error?.message ?? text.slice(0, 200)}`);
  }
  return body?.result?.value;
}

// 主流程：连上 DSH，一项项检查预设
async function main() {
  console.log(`DSH: ${BASE}`);
  const cookie = discoverDshSessionCookie(BASE);
  if (!cookie) {
    console.error('❌ 拿不到 DSH 会话 Cookie（读不到本机 browser session secret）');
    failed += 1;
    return;
  }

  let presets;
  try {
    const value = await rpc(cookie, 'agentPresets/list');
    presets = value?.presets ?? [];
  } catch (error) {
    console.error(`❌ agentPresets/list 调用失败：${error.message}`);
    failed += 1;
    return;
  }
  console.log(`agentPresets/list → ${presets.map((p) => p.id).join(', ')}`);
  for (const preset of presets) {
    if (preset.broken) console.log(`   ⚠️ ${preset.id} broken: ${preset.broken}`);
  }
  for (const id of WANTED) {
    const found = presets.find((p) => p.id === id);
    check(`agentPresets/list 含 ${id}`, found !== undefined);
    // 挂载失败会写进 broken，只要非空这个预设就不可用
    if (found) check(`${id} 挂载无错误（broken 为空）`, !found.broken, found.broken ?? '');
  }

  // 读回预设的子行清单，看守卫行在不在
  for (const id of WANTED) {
    if (!presets.some((p) => p.id === id)) continue;
    try {
      const doc = await rpc(cookie, 'agentPresets/read', { agentPreset: id });
      const text = String(doc?.content ?? '');
      const rows = text.split('\n').filter((l) => /^- id:/.test(l)).map((l) => l.trim().slice(2));
      check(`${id} 可读回子行清单`, rows.length > 0, rows.join(' | '));
      check(`${id} 含 qq-tool-restrict 守卫行`, text.includes('qq-tool-restrict'));
    } catch (error) {
      check(`${id} agentPresets/read`, false, error.message);
    }
  }
}

await main();
console.log(failed === 0 ? '\n✅ agent preset 验证通过' : `\n❌ ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
