// 检查网页接口的登录和权限关卡：谁能进、谁被挡。
// 控制台和智能体共用一个服务，靠请求头区分身份。
// 每一关按顺序检查：令牌、来源、暂停状态、模式等。
// 这里把「身份 × 运行状态 × 路径」逐个请求一遍，
// 记下状态码和报错，和存好的快照比对，防止行为悄悄改变。
// 另有一组固定检查，不看快照，危险改动拦得住。
//
// 用法：
//   node scripts/test-http-auth-matrix.mjs
//   node scripts/test-http-auth-matrix.mjs --update
// 加 --update 会在有意改安全行为时重写快照，要在提交说明里讲清。
//
// 全程用临时目录和假的 DSH，不会碰真实数据。
// 管理面 POST 故意发错格式，能走到「请求体不对」说明关卡放行了。
// 长轮询、重启、换令牌这几个接口不在这里测。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT = path.join(ROOT, 'tests', 'contracts', 'http-auth-matrix.json');
const UPDATE = process.argv.includes('--update');
const KEY = 'group:456';
const CONSOLE = 'fixture-console-token';

// ── 路径：每类关卡挑一个代表 ──
const PATHS = [
  ['GET', '/favicon.ico'],                                  // 任何鉴权之前 204
  ['GET', '/'],                                             // 控制台页面（未授权时是令牌提示页）
  ['GET', '/api/console/status'],
  ['GET', '/api/agent/status'],                                   // 智能体可达，但只回最小对象
  ['GET', '/api/console/sessions'],                                 // 管理面（只读）
  ['GET', '/api/console/whitelist'],                                // 管理面（只读，含白名单）
  ['GET', '/api/console/gate/member-policy?group=456'],
  ['PUT', '/api/console/gate/member-policy/456', []],
  ['PATCH', '/api/console/gate/member-policy/456/members/789', { flags: { respond: false } }],
  ['DELETE', '/api/console/gate/member-policy/456/members/789'],
  ['POST', '/api/console/gate/member-policy/import', { group: '456', expectedUpdatedAt: null, mode: 'all', entries: [], dryRun: true }],
  ['GET', '/api/console/gate/member-policy/export?group=456'],
  ['GET', '/api/console/gate/member-policy/effective?group=456&qq=789'],
  ['GET', '/api/console/tokens/summary'],                           // 用量面板：控制台专用
  ['POST', '/api/console/mode'],                                    // 管理面（写）
  ['POST', '/api/console/roles/create'],                            // 管理面（写）
  ['POST', '/api/console/conversations/set'],                       // 管理面（写）：每会话策略覆盖表，智能体绝不可达
  ['POST', '/api/console/memory/terms', { key: KEY, content: '词', meaning: '义' }],                                   // 管理面（写）+ 黑话库只能只读
  ['GET', '/api/console/stickers'],                                 // 表情库管理：仅控制台
  ['POST', '/api/console/stickers/note'],                           // 表情库管理（写）+ 表情库只能只读
  ['GET', '/api/console/scheduler/config'],                          // 管理端专用 v2
  ['GET', '/api/console/scheduler/states'],                          // 管理端专用 v2
  ['GET', '/api/console/scheduler/feedback'],                        // GET 仅控制台
  ['GET', '/api/console/scheduler/tool-log'],                        // GET 仅控制台
  ['GET', `/api/agent/state?key=${KEY}`],                // 智能体工具面（读）
  ['GET', '/api/agent/state?key=group:789'],             // 智能体读**别的会话**
  ['POST', '/api/agent/mark-read', { key: KEY }],        // 智能体工具面（写）：带真实 key，才能走到自己的令牌检查
  ['POST', '/api/agent/mark-read#other', { key: 'group:789' }], // 智能体写**别的会话**
  ['POST', '/api/agent/memory-append', { key: KEY, category: 'term', content: '词', extra: { meaning: '义' } }],                 // 智能体工具面（写）+ 黑话库只能只读
  ['POST', '/api/agent/sticker-note', { key: KEY }],                 // 智能体工具面（写）+ 表情库只能只读
  ['GET', `/api/agent/sticker-list?key=${KEY}`],         // 各模式的表情读取都走统一网关
  ['POST', '/api/agent/send/group', { key: KEY }],                           // 所有模式发送均需会话令牌
  ['GET', `/api/agent/images/message?key=${KEY}&messageId=1`],    // 图片读取也需会话令牌
  ['POST', '/api/agent/authorize/read', { key: KEY }],            // agent 白名单里的单条路径
  ['GET', '/api/console/definitely-not-a-route'],                   // 404 时的保底处理
];

// ── 身份 ──
// 请求头是现算的，有些身份要用运行时的令牌和端口
const IDENTITIES = {
  'no-token': () => ({}),
  'wrong-console-token': () => ({ 'x-console-token': 'x'.repeat(CONSOLE.length) }),
  'operator': () => ({ 'x-console-token': CONSOLE }),
  'operator-query-token': () => ({ __query: `token=${CONSOLE}` }),
  'operator-bad-host': () => ({ 'x-console-token': CONSOLE, host: 'evil.example:3100' }),
  'operator-cross-origin': () => ({ 'x-console-token': CONSOLE, origin: 'https://evil.example' }),
  'operator-same-origin': (ctx) => ({ 'x-console-token': CONSOLE, origin: `http://127.0.0.1:${ctx.port}` }),
  'operator-form-post': () => ({ 'x-console-token': CONSOLE, 'content-type': 'application/x-www-form-urlencoded' }),
  'agent-valid-token': (ctx) => ({ 'x-console-token': CONSOLE, 'x-agent-call': '1', 'x-agent-token': ctx.agentToken }),
  'agent-valid-token-no-call-header': (ctx) => ({ 'x-console-token': CONSOLE, 'x-agent-token': ctx.agentToken }),
  'agent-invalid-token': () => ({ 'x-console-token': CONSOLE, 'x-agent-call': '1', 'x-agent-token': 'f'.repeat(48) }),
  'agent-invalid-token-no-call-header': () => ({ 'x-console-token': CONSOLE, 'x-agent-token': 'f'.repeat(48) }),
  'agent-empty-token': () => ({ 'x-console-token': CONSOLE, 'x-agent-call': '1', 'x-agent-token': '' }),
  'agent-tokenless': () => ({ 'x-console-token': CONSOLE, 'x-agent-call': '1' }),
  'agent-token-without-console-token': (ctx) => ({ 'x-agent-call': '1', 'x-agent-token': ctx.agentToken }),
};

// ── 运行状态 ──
const STATES = {
  'reserved2': { mode: 'reserved2' },
  'reserved2-paused': { mode: 'reserved2', apply: (h) => { h.socialV2.paused = true; } },
  'reserved2-v2-disabled': { mode: 'reserved2', apply: (h) => { h.cfg.socialV2.enabled = false; } },
  'chat': { mode: 'chat' },
  'closed-agent': { mode: 'closed-agent' },
  // 数据文件坏了时只能只读：写接口要报错，不能假装成功
  'reserved2-stores-readonly': { mode: 'reserved2', files: { 'state/slang.json': '{not json', 'state/stickers.json': '{not json' } },
};

// 发一次请求，拿回状态码和内容
function request(port, method, rawPath, headers, body) {
  const pathname = rawPath.split('#')[0]; // '#other' 只是这一行的名字后缀
  const { __query, ...rest } = headers;
  const full = __query ? `${pathname}${pathname.includes('?') ? '&' : '?'}${__query}` : pathname;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: full, method,
      headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), ...rest } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`timeout ${method} ${pathname}`)));
    req.end(method === 'GET' ? undefined : JSON.stringify(body ?? []));
  });
}

/** 把一次响应变成可比较的文字：状态码加报错 */
const cell = (res, port) => {
  const err = typeof res.json?.error === 'string' ? res.json.error.replaceAll(String(port), '<port>')
    .replace(/约 \d+ (分钟|秒)/g, '约 <n> $1') // 剩余等待时间会变，先换成固定文字
    .slice(0, 80) : '';
  return err ? `${res.status} ${err}` : String(res.status);
};

const matrix = {};
const bodies = {}; // 硬断言要看的响应体
for (const [stateName, state] of Object.entries(STATES)) {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 }, files: state.files ?? {} });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    // 先在 reserved2 模式下拿到会话令牌，再切到要测的模式
    h.setMode('reserved2');
    await h.ensureSession(KEY);
    const ctx = { port: server.address().port, agentToken: h.getSocialV2State(KEY).agentToken };
    assert.ok(ctx.agentToken, '夹具应签发会话令牌');
    h.setMode(state.mode);
    state.apply?.(h);
    matrix[stateName] = {};
    for (const [idName, makeHeaders] of Object.entries(IDENTITIES)) {
      const row = {};
      for (const [method, p, body] of PATHS) {
        const res = await request(ctx.port, method, p, makeHeaders(ctx), body);
        row[`${method} ${p}`] = cell(res, ctx.port);
        bodies[`${stateName}|${idName}|${method} ${p}`] = res;
      }
      matrix[stateName][idName] = row;
    }
  } finally {
    await new Promise((r) => server.close(r));
    await h.close();
  }
}

// ── 固定检查（不看快照） ──
let failures = 0;
// 跑一个检查，出错就记失败
const check = (name, fn) => {
  try { fn(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error.message); }
};
// 取出矩阵里某一格的记录
const at = (state, id, route) => matrix[state][id][route];
// 取出某一格的状态码
const status = (state, id, route) => Number(at(state, id, route).slice(0, 3));
const ROUTES = PATHS.map(([m, p]) => `${m} ${p}`);
const ADMIN_ROUTES = ['GET /api/console/sessions', 'GET /api/console/whitelist', 'GET /api/console/gate/member-policy?group=456', 'PUT /api/console/gate/member-policy/456',
  'PATCH /api/console/gate/member-policy/456/members/789', 'DELETE /api/console/gate/member-policy/456/members/789',
  'POST /api/console/gate/member-policy/import', 'GET /api/console/gate/member-policy/export?group=456',
  'GET /api/console/gate/member-policy/effective?group=456&qq=789', 'GET /api/console/tokens/summary', 'POST /api/console/mode', 'POST /api/console/roles/create', 'POST /api/console/conversations/set',
  'POST /api/console/memory/terms', 'GET /api/console/stickers', 'POST /api/console/stickers/note', 'GET /api/console/scheduler/config', 'GET /api/console/scheduler/states',
  'GET /api/console/scheduler/feedback', 'GET /api/console/scheduler/tool-log'];
const AGENT_IDS = ['agent-valid-token', 'agent-valid-token-no-call-header', 'agent-invalid-token', 'agent-invalid-token-no-call-header',
  'agent-empty-token', 'agent-tokenless'];

check('没有有效控制台令牌：除 favicon 外一律 401', () => {
  for (const state of Object.keys(STATES)) for (const id of ['no-token', 'wrong-console-token', 'agent-token-without-console-token']) {
    for (const route of ROUTES) assert.equal(status(state, id, route), route === 'GET /favicon.ico' ? 204 : 401, `${state}/${id}/${route}`);
  }
});
check('控制台拒绝所有 agent 头；Agent API 要精确 caller 和活跃 token', () => {
  for (const state of Object.keys(STATES)) {
    for (const id of AGENT_IDS) for (const route of ADMIN_ROUTES) assert.equal(status(state, id, route), 403, `${state}/${id}/${route}`);
    for (const id of ['operator', 'agent-valid-token-no-call-header', 'agent-invalid-token', 'agent-invalid-token-no-call-header', 'agent-empty-token', 'agent-tokenless']) {
      for (const route of ROUTES.filter(route => route.includes('/api/agent/') && route !== 'GET /api/agent/status')) assert.equal(status(state, id, route), 403, `${state}/${id}/${route}`);
    }
    for (const id of ['agent-invalid-token', 'agent-invalid-token-no-call-header', 'agent-empty-token']) assert.equal(status(state, id, 'GET /api/agent/status'), 403);
    assert.equal(status(state, 'agent-tokenless', 'GET /api/agent/status'), 200);
  }
});
check('Host、CSRF 与 content-type 边界始终生效', () => {
  for (const state of Object.keys(STATES)) {
    for (const route of ROUTES.filter(route => route !== 'GET /favicon.ico')) assert.equal(status(state, 'operator-bad-host', route), 403);
    for (const route of ROUTES.filter(route => !route.startsWith('GET '))) {
      assert.equal(status(state, 'operator-cross-origin', route), 403);
      assert.equal(status(state, 'operator-form-post', route), 415);
    }
  }
});
check('控制台保留完整状态；工具状态只输出最小视图', () => {
  assert.equal(status('reserved2', 'operator', 'GET /api/console/status'), 200);
  assert.equal(status('reserved2', 'agent-valid-token', 'GET /api/console/status'), 403);
  assert.equal(status('reserved2', 'agent-valid-token', 'GET /api/agent/status'), 200);
  for (const state of Object.keys(STATES)) for (const field of ['ownerQQ', 'allowGroups', 'allowPrivate', 'activity', 'snowluma']) {
    assert.equal(Object.hasOwn(bodies[`${state}|operator|GET /api/console/status`].json, field), true);
    assert.equal(Object.hasOwn(bodies[`${state}|agent-tokenless|GET /api/agent/status`].json, field), false);
  }
});
check('会话绑定、暂停和只读降级不能绕过', () => {
  for (const state of ['reserved2', 'chat']) {
    assert.equal(status(state, 'agent-valid-token', `GET /api/agent/state?key=${KEY}`), 200);
    assert.equal(status(state, 'agent-valid-token', 'GET /api/agent/state?key=group:789'), 403);
  }
  for (const state of ['reserved2-paused', 'reserved2-v2-disabled']) {
    assert.equal(status(state, 'agent-valid-token', `GET /api/agent/state?key=${KEY}`), 403);
    assert.equal(status(state, 'operator', 'GET /api/console/scheduler/config'), 200);
  }
  for (const route of ['POST /api/console/memory/terms', 'POST /api/console/stickers/note']) assert.equal(status('reserved2-stores-readonly', 'operator', route), 503);
  for (const route of ['POST /api/agent/memory-append', 'POST /api/agent/sticker-note']) assert.equal(status('reserved2-stores-readonly', 'agent-valid-token', route), 503);
});
check('未知路径保持鉴权优先，不泄漏接口存在性', () => {
  assert.equal(status('reserved2', 'operator', 'GET /api/console/definitely-not-a-route'), 404);
  assert.equal(status('reserved2', 'no-token', 'GET /api/console/definitely-not-a-route'), 401);
});

// ── 快照 ──
const cells = Object.values(matrix).reduce((n, ids) => n + Object.values(ids).reduce((m, row) => m + Object.keys(row).length, 0), 0);
if (UPDATE) {
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, `${JSON.stringify(matrix, null, 1)}\n`);
  console.log(`已更新快照：${Object.keys(STATES).length} 种状态 × ${Object.keys(IDENTITIES).length} 种身份 × ${PATHS.length} 条路径 = ${cells} 格`);
} else {
  check(`与快照逐格一致（${cells} 格）`, () => {
    assert.ok(fs.existsSync(SNAPSHOT), '缺少快照；首次运行请加 --update');
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const diffs = [];
    for (const state of new Set([...Object.keys(expected), ...Object.keys(matrix)])) {
      for (const id of new Set([...Object.keys(expected[state] ?? {}), ...Object.keys(matrix[state] ?? {})])) {
        for (const route of new Set([...Object.keys(expected[state]?.[id] ?? {}), ...Object.keys(matrix[state]?.[id] ?? {})])) {
          const want = expected[state]?.[id]?.[route]; const got = matrix[state]?.[id]?.[route];
          if (want !== got) diffs.push(`${state} / ${id} / ${route}: 快照「${want}」≠ 实际「${got}」`);
        }
      }
    }
    assert.equal(diffs.length, 0, `${diffs.length} 格漂移：\n  ${diffs.slice(0, 12).join('\n  ')}\n若是有意变更安全行为，运行 --update 并在 PR 中说明`);
  });
}
console.log(failures ? `\n${failures} 项失败` : '\nALL PASS');
process.exit(failures ? 1 : 0);
