// 多后端工厂与 Antigravity CLI (agy) 后端离线回归测试（覆盖 BRG-001 ~ BRG-007）
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import {
  AgyApiClient,
  DEFAULT_AGY_PERMISSIONS_ALLOW,
  DEFAULT_DISALLOWED_LOCAL_TOOLS,
  DEFAULT_SAFE_ALLOWED_TOOLS,
  decodeSelfKeyFromSessionId,
  formatDeniedActions,
  parseAgyHelpCapabilities,
  parseAgyStreamLine,
} from '../src/backends/agy-client.js';
import { createBackendClient, normalizeBackendType } from '../src/backends/index.js';
import { loadConfig } from '../src/infra/config.js';
import { createTurnCollector, unwrap } from '../src/dsh-client.js';
import { applyHotModuleChanges, validateModulePatch } from '../src/features/console/module-registry.js';
import { encodeSelfKey } from '../src/policy/self-key.js';
import { readJsonSafe } from '../src/store/fs-atomic.js';
import { AGY_SAFE_MCP_ALLOW_RULES, LEGACY_SLASHLESS_MCP_RULES, runSelfCheck } from '../scripts/setup-agy.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'qqb-agy-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeChild(lines, { exitCode = 0, delayMs = 5, holdOpen = false, stderrLines = [] } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', 143));
    return true;
  };
  if (!holdOpen) {
    setTimeout(() => {
      if (child.killed) return;
      for (const sLine of stderrLines) {
        child.stderr.write(`${sLine}\n`);
      }
      for (const line of lines) {
        child.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
      }
      child.stdout.end();
      child.stderr.end();
      child.emit('close', exitCode);
    }, delayMs);
  }
  return child;
}

function httpJson(port, method, reqPath, { token = 'fixture-console-token', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-console-token': token } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('loadConfig 与 createBackendClient 支持多后端切换、permissions 默认值与空 allow 覆写', () => {
  const dir = makeTempDir();
  try {
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ backend: { type: 'agy', agy: { model: 'gemini-3-pro' } } }));
    const cfg = loadConfig({
      configFile: cfgPath,
      readJsonSafe,
      discoverDshLaunchToken: () => '',
    });
    assert.equal(cfg.backend.type, 'agy');
    assert.equal(cfg.backend.agy.command, 'agy');
    assert.equal(cfg.backend.agy.model, 'gemini-3-pro');
    assert.deepEqual(cfg.backend.agy.permissions.allow, [...DEFAULT_AGY_PERMISSIONS_ALLOW]);
    assert.deepEqual(cfg.backend.agy.permissions.deny, []);

    fs.writeFileSync(cfgPath, JSON.stringify({
      backend: { type: 'agy', agy: { permissions: { allow: [], deny: ['command(rm)'] } } },
    }));
    const emptyAllowCfg = loadConfig({
      configFile: cfgPath,
      readJsonSafe,
      discoverDshLaunchToken: () => '',
    });
    assert.deepEqual(emptyAllowCfg.backend.agy.permissions.allow, []);
    assert.deepEqual(emptyAllowCfg.backend.agy.permissions.deny, ['command(rm)']);

    const agyClient = createBackendClient(cfg, { rootDir: REPO_ROOT, stateDir: dir });
    assert.equal(agyClient.backendType, 'agy');
    assert.equal(agyClient.supportsPortDiscovery, false);

    fs.writeFileSync(cfgPath, JSON.stringify({}));
    const dshCfg = loadConfig({
      configFile: cfgPath,
      readJsonSafe,
      discoverDshLaunchToken: () => '',
    });
    assert.equal(dshCfg.backend.type, 'dsh');
    const dshClient = createBackendClient(dshCfg, { rootDir: REPO_ROOT, stateDir: dir });
    assert.equal(dshClient.backendType, 'dsh');
    assert.equal(dshClient.supportsPortDiscovery, true);

    assert.throws(() => normalizeBackendType('unknown-cli'), /backend\.type 非法/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseAgyStreamLine 正确解析 agy stream-json、denied_actions 与错误状态', () => {
  assert.equal(parseAgyStreamLine('not json at all'), null);
  assert.deepEqual(parseAgyStreamLine(JSON.stringify({ event: 'init', conversation_id: 'conv-1', model: 'gemini-3' })), {
    kind: 'init',
    conversationId: 'conv-1',
    model: 'gemini-3',
  });
  assert.deepEqual(parseAgyStreamLine(JSON.stringify({ event: 'step_update', step_update: { text_delta: '你好' } })), {
    kind: 'text_delta',
    text: '你好',
  });
  const tc = parseAgyStreamLine(JSON.stringify({
    event: 'step_update',
    step_update: { tool_call: { call_id: 'c1', name: 'mcp__snowluma__qq_send_group', arguments: { text: 'hi' } } },
  }));
  assert.equal(tc.kind, 'tool_call');
  assert.equal(tc.callId, 'c1');
  assert.equal(tc.name, 'mcp__snowluma__qq_send_group');

  const tr = parseAgyStreamLine(JSON.stringify({
    event: 'step_update',
    step_update: { tool_result: { call_id: 'c1', output: 'ok', is_error: false } },
  }));
  assert.equal(tr.kind, 'tool_result');
  assert.equal(tr.isError, false);

  const res = parseAgyStreamLine(JSON.stringify({
    event: 'result',
    result: {
      status: 'SUCCESS',
      conversation_id: 'conv-1',
      response: '完整回复',
      denied_actions: [{ action: 'mcp', display_name: 'McpTool' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  }));
  assert.equal(res.kind, 'result');
  assert.equal(res.conversationId, 'conv-1');
  assert.equal(res.text, '完整回复');
  assert.equal(res.usage.input_tokens, 10);
  assert.equal(res.deniedActions.length, 1);
  assert.equal(formatDeniedActions(res.deniedActions), 'mcp(McpTool)');
});

test('decodeSelfKeyFromSessionId 正确还原 group/private 会话身份', () => {
  const gSid = encodeSelfKey('group:123456');
  const pSid = encodeSelfKey('private:987654');
  assert.equal(decodeSelfKeyFromSessionId(gSid), 'group:123456');
  assert.equal(decodeSelfKeyFromSessionId(pSid), 'private:987654');
  assert.equal(decodeSelfKeyFromSessionId('plain-id'), '');
});

test('BRG-001: 能力探测对 agy 1.5.x 不传无效参数并内联系统提示词，老版本保留兼容参数', async () => {
  const dir = makeTempDir();
  const logs = [];
  try {
    const caps15 = parseAgyHelpCapabilities('Options:\n  --settings <json>\n  --output-format <fmt>\n  --conversation <id>');
    assert.deepEqual(caps15, {
      systemPrompt: false,
      allowedTools: false,
      disallowedTools: false,
      settings: true,
      sandbox: false,
    });

    const modernCalls = [];
    const modernClient = new AgyApiClient({
      command: 'agy-15',
      rootDir: REPO_ROOT,
      stateDir: dir,
      log: (m) => logs.push(m),
      detectCapabilities: () => caps15,
      checkAvailable: async () => true,
      spawn: (cmd, args, opts) => {
        modernCalls.push({ cmd, args, opts });
        return createFakeChild([
          { event: 'init', conversation_id: 'c-15' },
          { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
        ]);
      },
    });

    const sid = encodeSelfKey('group:10002');
    unwrap(await modernClient.sessions.create({ workspaceId: dir, agentPreset: 'qq-chat-v2', sessionId: sid }), 'create');
    unwrap(await modernClient.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '测试消息' }] }), 'prompt');
    await new Promise((r) => setTimeout(r, 30));

    const args15 = modernCalls[0].args;
    assert.equal(args15.includes('--system-prompt'), false, 'agy 1.5.x 不得拼接 --system-prompt');
    assert.equal(args15.includes('--allowedTools'), false, 'agy 1.5.x 不得拼接 --allowedTools');
    assert.equal(args15.includes('--disallowedTools'), false, 'agy 1.5.x 不得拼接 --disallowedTools');
    assert.ok(args15.includes('--settings'), 'agy 1.5.x 应使用 --settings 下发权限');
    const settingsIdx = args15.indexOf('--settings');
    assert.deepEqual(JSON.parse(args15[settingsIdx + 1]), {
      permissions: { allow: [...DEFAULT_AGY_PERMISSIONS_ALLOW], deny: [] },
    });
    const promptVal = args15[args15.indexOf('-p') + 1];
    assert.match(promptVal, /<system>[\s\S]*<\/system>/, '无 --system-prompt 时应内联预设提示词');
    assert.match(promptVal, /【当前已授权工具规则】/);

    // 老版本 CLI（含 --system-prompt / --allowedTools / --disallowedTools）走兼容参数
    const capsLegacy = parseAgyHelpCapabilities('--system-prompt <p> --allowedTools <t> --disallowedTools <d>');
    const legacyCalls = [];
    const legacyClient = new AgyApiClient({
      command: 'agy-legacy',
      rootDir: REPO_ROOT,
      stateDir: dir,
      detectCapabilities: () => capsLegacy,
      checkAvailable: async () => true,
      spawn: (cmd, args, opts) => {
        legacyCalls.push({ cmd, args, opts });
        return createFakeChild([
          { event: 'init', conversation_id: 'c-old' },
          { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
        ]);
      },
    });
    const sid2 = encodeSelfKey('group:10003');
    unwrap(await legacyClient.sessions.create({ workspaceId: dir, agentPreset: 'qq-chat-v2', sessionId: sid2 }), 'create');
    unwrap(await legacyClient.sessions.prompt({ sessionId: sid2, content: [{ type: 'text', text: 'hi' }] }), 'prompt');
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(legacyCalls[0].args.includes('--system-prompt'));
    assert.ok(legacyCalls[0].args.includes('--allowedTools'));
    assert.ok(legacyCalls[0].args.includes(DEFAULT_SAFE_ALLOWED_TOOLS.join(',')));
    assert.ok(legacyCalls[0].args.includes('--disallowedTools'));
    assert.ok(legacyCalls[0].args.includes(DEFAULT_DISALLOWED_LOCAL_TOOLS.join(',')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AgyApiClient 端到端回合执行、续聊、图片落盘与 BRG-003 错误/denied_actions/超时/取消透传', async () => {
  const dir = makeTempDir();
  const calls = [];
  const logs = [];
  const activities = [];
  let turnIndex = 0;

  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    turnIndex += 1;
    if (turnIndex === 1) {
      return createFakeChild([
        { event: 'init', conversation_id: 'agy-conv-abc', model: 'gemini-3-flash' },
        { event: 'step_update', step_update: { tool_call: { call_id: 'tc-1', name: 'mcp__snowluma__qq_send_group', arguments: { text: 'hello' } } } },
        { event: 'step_update', step_update: { tool_result: { call_id: 'tc-1', output: '{"ok":true}', is_error: false } } },
        { event: 'step_update', step_update: { text_delta: '你好，' } },
        { event: 'step_update', step_update: { text_delta: '群友！' } },
        { event: 'result', result: { conversation_id: 'agy-conv-abc', usage: { input_tokens: 120, output_tokens: 35 } } },
      ]);
    }
    if (turnIndex === 2) {
      return createFakeChild([
        { event: 'step_update', step_update: { text_delta: '第二轮回复' } },
        { event: 'result', result: { conversation_id: 'agy-conv-abc', usage: { input_tokens: 50, output_tokens: 15 } } },
      ]);
    }
    if (turnIndex === 3) {
      // BRG-003 场景 A：denied_actions 且无有效回复
      return createFakeChild([
        { event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'mcp', display_name: 'McpTool' }] } },
      ]);
    }
    if (turnIndex === 4) {
      // BRG-003 场景 B：非 0 退出带 stderr
      return createFakeChild([], {
        exitCode: 2,
        stderrLines: ['line-1 error detail', 'Unknown option: --bad-flag'],
      });
    }
    // Turn 5：挂起等待取消
    return createFakeChild([], { holdOpen: true });
  };

  try {
    const client = new AgyApiClient({
      command: 'agy-fake',
      model: 'gemini-3-flash',
      rootDir: REPO_ROOT,
      stateDir: dir,
      log: (m) => logs.push(m),
      appendActivity: (m) => activities.push(m),
      detectCapabilities: () => ({ systemPrompt: false, allowedTools: false, disallowedTools: false, settings: true, sandbox: false }),
      spawn: fakeSpawn,
      checkAvailable: async () => true,
    });

    const desc = unwrap(await client.settings.describe({}), 'settings.describe');
    assert.ok(desc.namespaces.some((n) => n.ns === 'agent-presets'));

    const wsDir = path.join(dir, 'ws-group-10001');
    const ws = unwrap(await client.workspace.create({ path: wsDir }), 'workspace.create');
    const sid = encodeSelfKey('group:10001');
    unwrap(await client.sessions.create({
      workspaceId: ws.workspace.workspaceId,
      agentPreset: 'qq-chat-v2',
      sessionId: sid,
    }), 'sessions.create');

    client.events.follow(sid);
    const ac = new AbortController();
    const collected = [];
    const collector = createTurnCollector();
    const endedTurns = [];

    const streamPromise = (async () => {
      for await (const env of client.events.mux({}, ac.signal)) {
        collected.push(env.payload.event);
        const ended = collector.push(env.payload.event);
        if (ended) endedTurns.push(ended);
        if (endedTurns.length === 5) ac.abort();
      }
    })();

    // Turn 1: 带图片 + 首轮规则摘要
    unwrap(await client.sessions.prompt({
      sessionId: sid,
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image', mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64'), name: 'test.png' },
      ],
    }), 'sessions.prompt');

    while (endedTurns.length < 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls[0].opts.env.QQ_BRIDGE_SELF_KEY, 'group:10001');
    assert.match(calls[0].args[calls[0].args.indexOf('-p') + 1], /附带图片本地路径/);
    assert.equal(endedTurns[0].reason.kind, 'completed');
    assert.equal(endedTurns[0].text, '你好，群友！');

    // Turn 2: 续聊带 --conversation，不重复内联 system prompt
    unwrap(await client.sessions.prompt({
      sessionId: sid,
      content: [{ type: 'text', text: '继续聊' }],
    }), 'sessions.prompt');
    while (endedTurns.length < 2) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls[1].args[calls[1].args.indexOf('--conversation') + 1], 'agy-conv-abc');
    assert.equal(calls[1].args[calls[1].args.indexOf('-p') + 1].includes('<system>'), false);

    // Turn 3: denied_actions 必须进 error.message、log 与 activity
    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '试工具' }] }), 'sessions.prompt');
    while (endedTurns.length < 3) await new Promise((r) => setTimeout(r, 10));
    assert.equal(endedTurns[2].reason.kind, 'error');
    assert.match(endedTurns[2].reason.error.message, /agy 拒绝工具：mcp\(McpTool\)/);
    assert.ok(logs.some((l) => l.includes('mcp(McpTool)')));
    assert.ok(activities.some((a) => a.includes('mcp(McpTool)')));

    // Turn 4: 非 0 退出必须携带退出码与 stderr 尾部
    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '错误退出' }] }), 'sessions.prompt');
    while (endedTurns.length < 4) await new Promise((r) => setTimeout(r, 10));
    assert.equal(endedTurns[3].reason.kind, 'error');
    assert.match(endedTurns[3].reason.error.message, /agy 退出码=2/);
    assert.match(endedTurns[3].reason.error.message, /Unknown option: --bad-flag/);
    assert.ok(activities.some((a) => a.includes('code=2')));

    // Turn 5: 手动取消发出 kind='aborted'
    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '卡住' }] }), 'sessions.prompt');
    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '排队' }] }), 'sessions.prompt');
    await new Promise((r) => setTimeout(r, 15));
    const stopRes = await client.stopSessionWork(sid);
    assert.equal(stopRes.removed, 1);
    while (endedTurns.length < 5) await new Promise((r) => setTimeout(r, 10));
    assert.equal(endedTurns[4].reason.kind, 'aborted');

    await streamPromise;

    // closed-agent (无 preset) 无 deny 时不下发 --settings
    const adminSid = encodeSelfKey('private:88888');
    unwrap(await client.sessions.create({ workspaceId: wsDir, sessionId: adminSid }), 'sessions.create admin');
    const adminArgs = client._buildCliArgs(client._sessions.get(adminSid), 'hello');
    assert.equal(adminArgs.includes('--settings'), false);
    assert.equal(adminArgs.includes('--disallowedTools'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BRG-006 & BRG-007: 权限热更新通过 --settings 下发、作废旧会话并注入最新授权摘要', async () => {
  const dir = makeTempDir();
  const capturedArgs = [];
  let turn = 0;

  try {
    const client = new AgyApiClient({
      command: 'agy-fake',
      rootDir: REPO_ROOT,
      stateDir: dir,
      detectCapabilities: () => ({ systemPrompt: false, allowedTools: false, disallowedTools: false, settings: true, sandbox: false }),
      checkAvailable: async () => true,
      spawn: (_cmd, args) => {
        turn += 1;
        capturedArgs.push(args);
        return createFakeChild([
          { event: 'init', conversation_id: `conv-turn-${turn}` },
          { event: 'result', result: { status: 'SUCCESS', response: `ok-${turn}` } },
        ]);
      },
    });

    const sid = encodeSelfKey('group:20001');
    unwrap(await client.sessions.create({ workspaceId: dir, agentPreset: 'qq-chat-v2', sessionId: sid }), 'create');
    client.events.follow(sid);

    // 模拟控制台保存 backend-agy：先把 allow 清空
    const emptyPatch = validateModulePatch({
      moduleId: 'backend-agy',
      values: { 'backend.agy.permissions.allow': [] },
      currentFile: {},
    });
    const fakeBridge = {
      cfg: { backend: { agy: { permissions: { allow: [...DEFAULT_AGY_PERMISSIONS_ALLOW], deny: [] } } } },
      modelSelectionEpoch: 1,
      api: client,
    };
    applyHotModuleChanges(fakeBridge, emptyPatch);

    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '第一轮' }] }), 'prompt 1');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client._sessions.get(sid).agyConversationId, 'conv-turn-1');
    const s1 = JSON.parse(capturedArgs[0][capturedArgs[0].indexOf('--settings') + 1]);
    assert.deepEqual(s1.permissions.allow, []);

    // 热更新恢复 mcp(snowluma/*)：应清空 conv-turn-1 并在新回合提示注入【工具权限已更新】
    const grantPatch = validateModulePatch({
      moduleId: 'backend-agy',
      values: { 'backend.agy.permissions.allow': ['mcp(snowluma/*)'] },
      currentFile: emptyPatch.nextFile,
    });
    applyHotModuleChanges(fakeBridge, grantPatch);
    assert.equal(client._sessions.get(sid).agyConversationId, '', '权限变更后必须清空旧 agyConversationId');

    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '第二轮' }] }), 'prompt 2');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(capturedArgs[1].includes('--conversation'), false, '重开会话后第二轮不应携带旧 --conversation');
    const s2 = JSON.parse(capturedArgs[1][capturedArgs[1].indexOf('--settings') + 1]);
    assert.deepEqual(s2.permissions.allow, ['mcp(snowluma/*)']);
    const p2 = capturedArgs[1][capturedArgs[1].indexOf('-p') + 1];
    assert.match(p2, /【工具权限已更新】/);
    assert.match(p2, /【当前已授权工具规则】mcp\(snowluma\/\*\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BRG-002: setup-agy 写入带斜杠规则、清理旧无斜杠规则且支持只读自检', () => {
  for (const rule of AGY_SAFE_MCP_ALLOW_RULES) {
    assert.match(rule, /^mcp\([^/]+\/[^/]+\)$/, `规则必须包含斜杠：${rule}`);
  }
  const dir = makeTempDir('qqb-setup-agy-');
  try {
    const mcpDir = path.join(dir, 'config');
    const settingsDir = path.join(dir, 'antigravity-cli');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'mcp_config.json'), JSON.stringify({
      mcpServers: { existing: { command: 'echo', args: ['hi'] } },
    }));
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['command(git)', ...LEGACY_SLASHLESS_MCP_RULES] },
    }));

    const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'setup-agy.mjs'), '--skip-check'], {
      env: { ...process.env, AGY_GEMINI_HOME: dir },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);

    const mcp = JSON.parse(fs.readFileSync(path.join(mcpDir, 'mcp_config.json'), 'utf8'));
    assert.ok(mcp.mcpServers.existing);
    assert.ok(mcp.mcpServers.snowluma.args[0].endsWith(path.join('src', 'mcp-snowluma-safe.js')));

    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('command(git)'));
    for (const legacyRule of LEGACY_SLASHLESS_MCP_RULES) {
      assert.equal(settings.permissions.allow.includes(legacyRule), false, `应清理旧无斜杠规则 ${legacyRule}`);
    }
    for (const validRule of AGY_SAFE_MCP_ALLOW_RULES) {
      assert.ok(settings.permissions.allow.includes(validRule), `应写入新规则 ${validRule}`);
    }

    // 自检：有 denied_actions 时失败，空 denied_actions 时通过
    const deniedCheck = runSelfCheck({
      spawnSyncFn: () => ({
        status: 0,
        stdout: JSON.stringify({ status: 'SUCCESS', denied_actions: [{ action: 'mcp', display_name: 'McpTool' }] }),
        stderr: '',
      }),
    });
    assert.equal(deniedCheck.ok, false);
    assert.match(deniedCheck.reason, /denied_actions/);

    const okCheck = runSelfCheck({
      spawnSyncFn: () => ({
        status: 0,
        stdout: JSON.stringify({ status: 'SUCCESS', response: 'online', denied_actions: [] }),
        stderr: '',
      }),
    });
    assert.equal(okCheck.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BRG-004 & BRG-005: 控制台保存模块不因 getter 报 500；定向唤醒不受限流阻塞且支持重置', async () => {
  const h = await bridgeHarness({
    config: {
      sendDelayMs: 0,
      socialV2: {
        wake: { maxWakePerMinute: 1, maxWakePerHour: 1 },
      },
    },
  });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    // BRG-004: 通过真实 HTTP 接口保存 gate 与 backend-agy，验证非枚举 cfg getter 不再丢失
    const gateRes = await httpJson(port, 'POST', '/api/console/modules/gate', {
      body: { values: { 'allow.groups': ['732746355'] } },
    });
    assert.equal(gateRes.status, 200, JSON.stringify(gateRes.json));
    assert.equal(gateRes.json?.ok, true);
    assert.deepEqual(h.cfg.allow.groups, ['732746355']);

    const agyRes = await httpJson(port, 'POST', '/api/console/modules/backend-agy', {
      body: { values: { 'backend.agy.permissions.allow': ['mcp(snowluma/*)'] } },
    });
    assert.equal(agyRes.status, 200, JSON.stringify(agyRes.json));
    assert.equal(agyRes.json?.ok, true);
    assert.deepEqual(h.cfg.backend.agy.permissions.allow, ['mcp(snowluma/*)']);

    // BRG-005: maxWakePerMinute=1, maxWakePerHour=1 时，连续 @ 与追问不被限流阻塞
    h.setMode('reserved2');
    const convKey = 'group:732746355';
    const st = h.getSocialV2State(convKey);
    st.unread.push({ seq: 1, userId: '111', sender: '群友', text: '@机器人 1', plain: '@机器人 1', time: Date.now() });
    st.lastUnreadSeq = 1;

    await h.sendWakePromptV2(convKey, 'atMention');
    assert.equal(h.calls.prompts.length, 1, '首条 @ 应立即投递');
    h.pendingWakeKeys.delete(convKey); // 模拟首轮 turn/end 结束释放忙标记（wakeTimes 仍保留 1 次）
    await h.sendWakePromptV2(convKey, 'question');
    assert.equal(h.calls.prompts.length, 2, '连续追问应不受 maxWakePerMinute/Hour 阻塞，立即投递');
    h.pendingWakeKeys.delete(convKey);

    // 普通概率唤醒应命中限流并记录计数与来源
    await h.sendWakePromptV2(convKey, 'probability');
    assert.equal(h.calls.prompts.length, 2, '概率唤醒超过配额后应进入限流延迟');
    const bridgeLog = fs.readFileSync(path.join(h.temp, 'state', 'bridge.log'), 'utf8');
    assert.match(bridgeLog, /唤醒频率超限.*来源=触发.*计数=2\/1\/分 2\/1\/时/);

    // 控制台重置唤醒计数接口
    const resetRes = await httpJson(port, 'POST', '/api/console/social/wake-reset', {
      body: { key: convKey },
    });
    assert.equal(resetRes.status, 200, JSON.stringify(resetRes.json));
    assert.deepEqual(resetRes.json?.resetKeys, [convKey]);
    assert.deepEqual(h.getSocialV2State(convKey).wakeTimes, []);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await h.close();
  }
});
