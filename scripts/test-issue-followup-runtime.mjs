// 检查 issue 里的运行时问题：凭据、网络、权限都用假的
import assert from 'node:assert/strict';
import { createDshModel } from '../src/dsh/model.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';
import { probeDshBaseUrl } from '../src/dsh-endpoint.js';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';
import { normalizeReasoningEffort } from '../src/policy/mode.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-runtime-issues-'));
const previousHome = process.env.DSH_HOME;
const previousToken = process.env.SNOWLUMA_TOKEN;
const previousHttp = process.env.SNOWLUMA_HTTP_URL;
const previousFetch = globalThis.fetch;
process.env.DSH_HOME = tmp;
delete process.env.SNOWLUMA_TOKEN;
delete process.env.SNOWLUMA_HTTP_URL;
let passed = 0;
// 跑一个测试用例，通过就计数
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log('PASS', name);
};
const credentialFile = path.join(tmp, '.credentials.yaml');
// 写一份假的凭据文件
const writeCredentials = () => fs.writeFileSync(credentialFile, JSON.stringify({
  records: { 'client-connection/browser-session': { kind: 'grant', payload: {
    version: 1, secret: Buffer.alloc(32, 7).toString('base64url')
  } } }
}));
// 从登录凭证里取出主体信息
const cookieAuthority = (cookie) => JSON.parse(Buffer.from(cookie.split('.')[1], 'base64url').toString()).authority;

try {
  await test('#110 initial missing credentials recover without restarting the client', async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    await assert.rejects(client.ensureAuth(), /DSH 鉴权不可用/);
    writeCredentials();
    const cookie = await client.ensureAuth();
    assert.equal(cookieAuthority(cookie), '127.0.0.1:3080');
    assert.equal(client._strategy, 'minted');
  });

  await test('#110 malformed credentials are retried after the file is repaired', async () => {
    fs.writeFileSync(credentialFile, 'records: [');
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    assert.equal(client.browserSessionSecret(), null);
    await assert.rejects(client.ensureAuth(), /DSH 鉴权不可用/);
    writeCredentials();
    assert.equal((await client.ensureAuth()).startsWith('dsh-auth-'), true);
    assert.equal(client.browserSessionSecret().length, 32);
  });

  await test('#56 changing DSH port invalidates the cookie and preserves subscriptions', async () => {
    const client = new NodeApiClient('http://127.0.0.1:3080', 1000, {});
    const original = await client.ensureAuth();
    client.events.follow('fixture-session');
    assert.equal(client.rebind('http://127.0.0.1:42000/'), true);
    assert.equal(client.cookie, null);
    assert.equal(client._desiredFollows.has('fixture-session'), true);
    const rebound = await client.ensureAuth();
    assert.notEqual(rebound, original);
    assert.equal(cookieAuthority(rebound), '127.0.0.1:42000');
    assert.equal(client.rebind('http://127.0.0.1:42000'), false);
  });

  await test('#56 endpoint discovery verifies the DSH RPC envelope with an authority-bound cookie', async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:42000/api/settings/describe');
      assert.equal(cookieAuthority(init.headers.cookie), '127.0.0.1:42000');
      assert.equal(init.redirect, 'manual');
      return { ok: true, json: async () => ({ type: 'server-response', result: { ok: true } }) };
    };
    assert.equal(await probeDshBaseUrl('http://127.0.0.1:42000'), true);
    assert.equal(await probeDshBaseUrl('https://remote.invalid'), false);
    assert.equal(calls, 1);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: { ok: true } }) });
    assert.equal(await probeDshBaseUrl('http://127.0.0.1:42000'), false);
  });

  await test('#19 discovery preserves different HTTP and WebSocket credentials', async () => {
    const home = path.join(tmp, 'snowluma');
    fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config', 'onebot_101.json'), JSON.stringify({ networks: {
      httpServers: [{ host: '127.0.0.1', port: 41000, accessToken: 'fixture-http-credential' }],
      wsServers: [{ host: '127.0.0.1', port: 41001, accessToken: 'fixture-ws-credential' }]
    } }));
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:41000/get_login_info');
      assert.equal(init.headers.authorization, 'Bearer fixture-http-credential');
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 101 } }) };
    };
    const result = await discoverSnowLumaConnection({ cfg: {}, homeDirs: [home] });
    assert.equal(result.token, 'fixture-http-credential');
    assert.equal(result.wsToken, 'fixture-ws-credential');
    assert.equal(result.wsUrl, 'ws://127.0.0.1:41001');
    assert.equal(JSON.stringify(result.tried).includes('fixt'), false, '#115 no credential prefix in diagnostics');
    assert.equal(result.tried[0].token, '(已配置)');
  });

  // 这个函数已经搬到 src/policy/mode.js，直接测真模块
  const loadReasoningNormalizer = () => normalizeReasoningEffort;
  // 这个函数在 src/dsh/model.js，直接测真模块
  const loadEnsureChatModel = (effort, selectModel) => {
    const requests = [];
    const context = {
      modelAppliedSessions: new Map(), modelSelectionEpoch: 1,
      cfg: { dsh: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: effort } },
      REASONING_EFFORT_DEFAULT: 'max', REASONING_EFFORT_NONE: 'none', unwrap, log() {}, sleep: async () => {},
      api: { sessions: { selectModel: async (payload) => {
        requests.push(payload);
        return selectModel(payload, requests.length);
      } } }
    };
    const { ensureChatModel: ensure } = createDshModel(context);
    return { ensure, requests, context };
  };
  // 造一个模型选择成功的假返回
  const modelSuccess = (payload) => ({ result: { ok: true, value: {
    selected: { provider: payload.provider, model: payload.model, reasoningEffort: payload.reasoningEffort }
  } } });

  await test('#153 normalizes none and preserves adapter-owned effort identifiers', async () => {
    const normalize = loadReasoningNormalizer();
    assert.equal(normalize('none'), 'none');
    assert.equal(normalize(' NONE '), 'none');
    for (const effort of ['xHigh', 'HIGH', 'Low', 'MAX']) assert.equal(normalize(effort), effort);
    assert.throws(() => normalize(''));
    assert.throws(() => normalize('high\nlow'));
  });

  await test('#153 none omits reasoningEffort on the first and only selection', async () => {
    const { ensure, requests } = loadEnsureChatModel('none', modelSuccess);
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.equal(requests.length, 1);
    assert.equal(Object.hasOwn(requests[0], 'reasoningEffort'), false);
  });

  await test('#153 adapter-owned effort reaches selectModel without case folding', async () => {
    const normalize = loadReasoningNormalizer();
    for (const effort of ['xHigh', 'HIGH', 'Low', 'MAX']) {
      const { ensure, requests } = loadEnsureChatModel(normalize(effort), modelSuccess);
      assert.equal(await ensure('fixture-session'), 'applied');
      assert.deepEqual(requests.map((r) => r.reasoningEffort), [effort]);
    }
  });

  await test('#55 unsupported reasoning effort retries the configured provider/model without effort', async () => {
    const { ensure, requests } = loadEnsureChatModel('max', (payload) => {
      if (payload.reasoningEffort) return { result: { ok: false, error: {
        code: 'session/model-unavailable', message: 'model does not support reasoning effort "max"'
      } } };
      return modelSuccess(payload);
    });
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.deepEqual(requests.map((r) => r.reasoningEffort ?? '<omitted>'), ['max', '<omitted>']);
    assert.ok(requests.every((r) => r.provider === 'fixture-provider' && r.model === 'fixture-model'));
    const count = requests.length;
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.equal(requests.length, count);
  });

  await test('#153 other model-unavailable errors retain their same-plan retry', async () => {
    const { ensure, requests } = loadEnsureChatModel('max', (payload, count) => {
      if (count === 1) return { result: { ok: false, error: {
        code: 'session/model-unavailable', message: 'Select an available model before sending a message.'
      } } };
      return modelSuccess(payload);
    });
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.deepEqual(requests.map((r) => r.reasoningEffort), ['max', 'max']);
  });

  await test('effort saved during an in-flight selection is applied on the next message', async () => {
    let finishFirst;
    const { ensure, requests, context } = loadEnsureChatModel('max', (payload, count) => {
      if (count === 1) return new Promise((resolve) => { finishFirst = () => resolve(modelSuccess(payload)); });
      return modelSuccess(payload);
    });
    const selecting = ensure('fixture-session');
    assert.equal(requests.length, 1);
    context.cfg.dsh.reasoningEffort = 'none';
    context.modelSelectionEpoch += 1;
    finishFirst();
    assert.equal(await selecting, 'applied');
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.deepEqual(requests.map((r) => r.reasoningEffort ?? '<omitted>'), ['max', '<omitted>']);
    assert.equal(await ensure('fixture-session'), 'applied');
    assert.equal(requests.length, 2, 'the new epoch is cached only after its selection completes');
  });
} finally {
  globalThis.fetch = previousFetch;
  for (const [key, value] of [['DSH_HOME', previousHome], ['SNOWLUMA_TOKEN', previousToken], ['SNOWLUMA_HTTP_URL', previousHttp]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nRuntime issue regressions: ${passed} passed`);
