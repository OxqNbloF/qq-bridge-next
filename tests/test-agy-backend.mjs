// 多后端工厂与 Antigravity CLI (agy) 后端离线回归测试
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';

import {
  AgyApiClient,
  DEFAULT_DISALLOWED_LOCAL_TOOLS,
  DEFAULT_SAFE_ALLOWED_TOOLS,
  decodeSelfKeyFromSessionId,
  parseAgyStreamLine,
} from '../src/backends/agy-client.js';
import { createBackendClient, normalizeBackendType } from '../src/backends/index.js';
import { loadConfig } from '../src/infra/config.js';
import { createTurnCollector, unwrap } from '../src/dsh-client.js';
import { encodeSelfKey } from '../src/policy/self-key.js';
import { readJsonSafe } from '../src/store/fs-atomic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function makeTempDir(prefix = 'qqb-agy-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeChild(lines, { exitCode = 0, delayMs = 5, holdOpen = false } = {}) {
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

test('loadConfig 与 createBackendClient 支持多后端切换与非法值拒绝', () => {
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

test('parseAgyStreamLine 正确解析 agy stream-json 各事件类型并忽略非 JSON 杂音', () => {
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
    result: { conversation_id: 'conv-1', text: '完整回复', usage: { input_tokens: 10, output_tokens: 20 } },
  }));
  assert.equal(res.kind, 'result');
  assert.equal(res.conversationId, 'conv-1');
  assert.equal(res.text, '完整回复');
  assert.equal(res.usage.input_tokens, 10);
});

test('decodeSelfKeyFromSessionId 正确还原 group/private 会话身份', () => {
  const gSid = encodeSelfKey('group:123456');
  const pSid = encodeSelfKey('private:987654');
  assert.equal(decodeSelfKeyFromSessionId(gSid), 'group:123456');
  assert.equal(decodeSelfKeyFromSessionId(pSid), 'private:987654');
  assert.equal(decodeSelfKeyFromSessionId('plain-id'), '');
});

test('AgyApiClient 端到端回合执行、安全工具限制、会话续聊、图片落盘与取消', async () => {
  const dir = makeTempDir();
  const calls = [];
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
    // 第三轮挂起，测试 stopSessionWork 取消
    return createFakeChild([], { holdOpen: true });
  };

  try {
    const client = new AgyApiClient({
      command: 'agy-fake',
      model: 'gemini-3-flash',
      rootDir: REPO_ROOT,
      stateDir: dir,
      spawn: fakeSpawn,
      checkAvailable: async () => true,
    });

    const desc = unwrap(await client.settings.describe({}), 'settings.describe');
    assert.ok(desc.namespaces.some((n) => n.ns === 'agent-presets'));

    const { presets } = unwrap(await client.agentPresets.list({}), 'agentPresets.list');
    assert.ok(presets.some((p) => p.id === 'qq-chat'));
    assert.ok(presets.some((p) => p.id === 'qq-chat-v2'));
    assert.ok(presets.some((p) => p.id === 'default' && p.isDefault));

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
        if (endedTurns.length === 3) ac.abort();
      }
    })();

    // Turn 1: 带图片
    unwrap(await client.sessions.prompt({
      sessionId: sid,
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image', mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64'), name: 'test.png' },
      ],
    }), 'sessions.prompt');

    while (endedTurns.length < 1) await new Promise((r) => setTimeout(r, 10));

    // 验证第一轮参数：安全工具白名单/黑名单、系统提示词、QQ_BRIDGE_SELF_KEY、图片落盘
    assert.equal(calls[0].cmd, 'agy-fake');
    assert.equal(calls[0].opts.env.QQ_BRIDGE_SELF_KEY, 'group:10001');
    assert.ok(calls[0].args.includes('--system-prompt'));
    assert.ok(calls[0].args.includes('--allowedTools'));
    assert.ok(calls[0].args.includes(DEFAULT_SAFE_ALLOWED_TOOLS.join(',')));
    assert.ok(calls[0].args.includes('--disallowedTools'));
    assert.ok(calls[0].args.includes(DEFAULT_DISALLOWED_LOCAL_TOOLS.join(',')));
    assert.ok(!calls[0].args.includes('--conversation'));
    const pIdx = calls[0].args.indexOf('-p');
    assert.match(calls[0].args[pIdx + 1], /附带图片本地路径/);
    assert.equal(endedTurns[0].reason.kind, 'completed');
    assert.equal(endedTurns[0].text, '你好，群友！');
    assert.ok(collected.some((e) => e.type === 'tool/call' && e.data.name === 'mcp__snowluma__qq_send_group'));
    assert.ok(collected.some((e) => e.type === 'assistant/message' && e.data.usage?.input_tokens === 120));

    // Turn 2: 续聊自动带 --conversation，且不重复传 --system-prompt
    unwrap(await client.sessions.prompt({
      sessionId: sid,
      content: [{ type: 'text', text: '继续聊' }],
    }), 'sessions.prompt');
    while (endedTurns.length < 2) await new Promise((r) => setTimeout(r, 10));
    assert.ok(calls[1].args.includes('--conversation'));
    assert.equal(calls[1].args[calls[1].args.indexOf('--conversation') + 1], 'agy-conv-abc');
    assert.ok(!calls[1].args.includes('--system-prompt'));
    assert.equal(endedTurns[1].text, '第二轮回复');

    // Turn 3: 取消进行中的回合与排队消息
    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '卡住的回合' }] }), 'sessions.prompt');
    unwrap(await client.sessions.prompt({ sessionId: sid, content: [{ type: 'text', text: '排队中的回合' }] }), 'sessions.prompt');
    await new Promise((r) => setTimeout(r, 15));
    const stopRes = await client.stopSessionWork(sid);
    assert.equal(stopRes.removed, 1);
    while (endedTurns.length < 3) await new Promise((r) => setTimeout(r, 10));
    assert.equal(endedTurns[2].reason.kind, 'cancelled');

    await streamPromise;

    // 重启恢复：持久化文件包含 agyConversationId
    const client2 = new AgyApiClient({
      command: 'agy-fake',
      rootDir: REPO_ROOT,
      stateDir: dir,
      spawn: fakeSpawn,
      checkAvailable: async () => true,
    });
    const list2 = unwrap(await client2.sessions.list({}), 'sessions.list');
    assert.ok(list2.sessions.some((s) => s.sessionId === sid));

    // closed-agent (无 preset) 不注入 --disallowedTools
    const adminSid = encodeSelfKey('private:88888');
    unwrap(await client.sessions.create({
      workspaceId: wsDir,
      sessionId: adminSid,
    }), 'sessions.create admin');
    const adminArgs = client._buildCliArgs(client._sessions.get(adminSid), 'hello');
    assert.ok(!adminArgs.includes('--disallowedTools'));
    assert.ok(!adminArgs.includes('--allowedTools'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/setup-agy.mjs 幂等写入 mcp_config.json 与 settings.json 并保留原有配置', () => {
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
      permissions: { allow: ['command(git)'] },
    }));

    const run = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'setup-agy.mjs')], {
      env: { ...process.env, AGY_GEMINI_HOME: dir },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);

    const mcp = JSON.parse(fs.readFileSync(path.join(mcpDir, 'mcp_config.json'), 'utf8'));
    assert.ok(mcp.mcpServers.existing);
    assert.ok(mcp.mcpServers.snowluma.args[0].endsWith(path.join('src', 'mcp-snowluma-safe.js')));
    assert.ok(mcp.mcpServers['snowluma-host'].args[0].endsWith(path.join('src', 'mcp-host-server.js')));
    assert.ok(mcp.mcpServers['web-search-safe'].args[0].endsWith(path.join('src', 'mcp-web-search-safe.js')));

    const settings = JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'));
    assert.ok(settings.permissions.allow.includes('command(git)'));
    assert.ok(settings.permissions.allow.includes('mcp(snowluma)'));
    assert.ok(settings.permissions.allow.includes('mcp(snowluma-host)'));
    assert.ok(settings.permissions.allow.includes('mcp(web-search-safe)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
