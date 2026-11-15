// 测试桥接能不能用正确的方式连上 DSH（0.1.7 起）
//
// 老办法是从日志里找启动令牌，新版 DSH 已经不用了，
// 现在改用本地保存的密钥现做一个登录凭证。
// 这里确认新办法能通、老办法确实不通。
// 需要 DSH 正在运行：node scripts/test-dsh-auth.mjs
import {
  NodeApiClient, discoverDshLaunchToken, discoverDshSessionCookie,
  readBrowserSessionSecret, resolveDshHome, mintBrowserSessionCookie, isLoopbackBase
} from '../src/dsh-client.js';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

let pass = 0;
let fail = 0;
const results = [];
// 记一次检查结果，错了就记一次失败
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`OK   ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`FAIL ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}

// ── 不需要 DSH 在线就能测的部分 ──
check('isLoopbackBase 认回环', isLoopbackBase('http://127.0.0.1:3080') === true);
check('isLoopbackBase 拒非回环', isLoopbackBase('http://10.0.0.5:3080') === false);

const secret = readBrowserSessionSecret();
check('读到 browser-session 签名密钥（32 字节）', secret?.byteLength === 32, secret ? `${secret.byteLength} bytes` : `未读到（${resolveDshHome()}）`);

if (secret) {
  // 登录凭证的格式必须和服务端的检查方式对上：
  // 名字是 dsh-auth- 加一串摘要，值由三段用点连起来
  const cookie = mintBrowserSessionCookie(BASE, secret);
  const [name, value] = cookie.split('=');
  const parts = value.split('.');
  check('Cookie 名以 dsh-auth- 开头', name.startsWith('dsh-auth-'));
  check('Cookie 值形如 v1.<body>.<sig>', parts.length === 3 && parts[0] === 'v1');
  const payload = JSON.parse(Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  check('payload.authority 等于 baseUrl 的 authority', payload.authority === new URL(BASE).host, payload.authority);
  check('payload 有效期为正且不超过 30 天上限', payload.expiresAt > payload.issuedAt && (payload.expiresAt - payload.issuedAt) <= 30 * 86400000);
}

// ── 需要 DSH 在线才能测的部分 ──
const rpc = async (cookie, method, args) => {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'ta' + Math.random().toString(36).slice(2, 8), method, payload: { args } })
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const cookie = discoverDshSessionCookie(BASE);
if (!check('铸造出会话 Cookie', Boolean(cookie))) {
  console.log(results.join('\n'));
  console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
  process.exit(1);
}

const st = await rpc(cookie, 'settings/describe', {});
check('铸造的 Cookie 能过鉴权（settings/describe）', st.status === 200 && st.body?.result?.ok === true, `HTTP ${st.status}`);

const ap = await rpc(cookie, 'agentPresets/list', {});
const presets = ap.body?.result?.value?.presets?.map((p) => p.id) ?? [];
check('agentPresets/list 可达', ap.status === 200 && presets.length > 0, presets.join(', '));

// 不传登录信息时，客户端应当自己生成凭证
const client = new NodeApiClient(BASE, 15000, { tokenExplicit: false });
const viaClient = await client.callUnary('settings/describe', {});
check('NodeApiClient 无 token 也能鉴权', viaClient.result?.ok === true);
check('NodeApiClient 走的是 minted 策略', client._strategy === 'minted', String(client._strategy));

// 网络断一下就会清掉凭证，重连后必须还能自动重新做
for (let i = 0; i < 3; i += 1) {
  client.invalidateAuth();
  const again = await client.callUnary('settings/describe', {});
  if (!check(`invalidateAuth() 第 ${i + 1} 次后仍走铸造策略`, again.result?.ok === true && client._strategy === 'minted', String(client._strategy))) break;
}

// 凭证过期前要能提前换新的，不然每小时都会断一次
const firstCookie = client.cookie;
client._cookieExpiresAt = Date.now() - 1; // 假装已过期
const refreshed = await client.callUnary('settings/describe', {});
check('Cookie 过期后自动重铸并继续可用', refreshed.result?.ok === true && client.cookie !== firstCookie, `strategy=${client._strategy}`);

// 旧办法必须失败，证明它确实不能用了
const stale = discoverDshLaunchToken();
if (stale) {
  const res = await fetch(`${BASE}/?token=${stale}`, { redirect: 'manual' });
  check('日志里的陈旧 token 换 Cookie 失败（老路径确已失效）', res.status !== 303, `HTTP ${res.status}`);
} else {
  results.push('SKIP 日志里没有可发现的 token（若启动器不再记日志，这是预期结果）');
}

console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
