import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { applyHubSetup } from '../scripts/setup-hub.mjs';
import { createSettingsStore } from '../src/config/schema.js';
import { createContextCompactor } from '../src/core/compactor.js';
import { createEngineRegistry } from '../src/engines/registry.js';
import { createRoomStore } from '../src/storage/room-store.js';

function createFakeSpawn(lines) {
  const calls = [];
  const spawnFn = (command, args, opts) => {
    calls.push({ command, args, env: opts?.env });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      for (const l of lines) child.stdout.write(`${l}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

test('engine registry hot-switches engines, hands off context summary, and compacts on token threshold', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-eng-'));
  const settingsStore = createSettingsStore({
    initialConfig: {
      engine: { active: 'agy', model: 'agy-fast' },
      context: { compactAtTokens: 1000 },
      engines: {
        customCli: {
          claude_local: {
            label: 'Claude Local',
            command: 'claude',
            argsTemplate: ['-p', '{{prompt}}'],
            outputFormat: 'jsonl',
            model: 'claude-sonnet',
            models: ['claude-sonnet'],
          },
        },
      },
    },
  });
  const roomStore = createRoomStore({ dataDir: dir });
  roomStore.recordInbound('group:20001', { senderId: '10002', senderName: '小明', text: '晚上吃啥？' });

  const agyFake = createFakeSpawn([
    JSON.stringify({ type: 'init', conversation_id: 'agy-conv-1', model: 'agy-fast' }),
    JSON.stringify({ type: 'result', conversation_id: 'agy-conv-1', result: 'ok', usage: { input_tokens: 1500, output_tokens: 40 } }),
  ]);

  let dshTurnPrompts = [];
  const dshClientFactory = () => ({
    resolveBase: () => 'http://127.0.0.1:3080',
    system: { health: async () => ({ result: { ok: true } }) },
    sessions: {
      models: async () => ({ result: { value: { groups: [{ models: [{ id: 'deepseek-flash' }, { id: 'deepseek-pro' }] }] } } }),
      create: async () => ({ result: { value: { id: 'dsh-sid-1' } } }),
      send: async () => ({ result: { value: { turnId: 't1' } } }),
      abort: async () => ({}),
    },
    events: { subscribe: () => () => {} },
    turns: {
      execute: async (opts) => {
        dshTurnPrompts.push(opts);
        return { text: '好的', usage: { inputTokens: 120, outputTokens: 15 } };
      },
    },
  });

  let compactor;
  const registry = createEngineRegistry({
    settingsStore,
    roomStore,
    spawnFn: agyFake.spawnFn,
    detectCapsFn: () => '--system-prompt --settings',
    dshClientFactory,
    onUsage: (roomId, engId, usage) => compactor?.observeUsage(roomId, engId, usage),
  });
  compactor = createContextCompactor({ getConfig: () => settingsStore.get(), roomStore, engineRegistry: registry });

  const first = await registry.executeTurn({
    roomId: 'group:20001',
    systemPrompt: 'sys',
    deltaPrompt: 'delta1',
    socketPath: '/tmp/fake.sock',
    scope: 'standard',
  });
  assert.equal(first.ok, true);
  assert.equal(agyFake.calls[0].env.RELAY_ROOM_SOCK, '/tmp/fake.sock');
  // Token threshold (1500 >= 1000) compacted agy session and wrote handoffSummary
  assert.equal(roomStore.getEngineSession('group:20001', 'agy'), '');
  assert.ok(roomStore.get('group:20001').handoffSummary.includes('1500'));

  // Hot-switch room to customCli & verify listEngines
  registry.switchEngine({ engineId: 'claude_local', model: 'claude-sonnet', roomId: 'group:20001' });
  assert.equal(registry.resolveForRoom('group:20001').engineId, 'claude_local');
  const engines = await registry.listEngines();
  assert.ok(engines.some((e) => e.id === 'dsh'));
  assert.ok(engines.some((e) => e.id === 'agy'));
  assert.ok(engines.some((e) => e.id === 'gemini'));
  assert.ok(engines.some((e) => e.id === 'claude_local'));
});

test('setup-hub registers relay-hub without overwriting existing user settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-setup-'));
  const agyPath = path.join(dir, 'agy-settings.json');
  const gemPath = path.join(dir, 'gem-settings.json');
  fs.writeFileSync(agyPath, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));

  applyHubSetup({
    hubPath: '/opt/relay/src/hub/mcp-server.js',
    agySettingsPath: agyPath,
    geminiSettingsPath: gemPath,
  });

  const agySaved = JSON.parse(fs.readFileSync(agyPath, 'utf8'));
  assert.equal(agySaved.theme, 'dark');
  assert.ok(agySaved.mcpServers.other);
  assert.equal(agySaved.mcpServers['relay-hub'].args[0], '/opt/relay/src/hub/mcp-server.js');
  assert.ok(agySaved.permissions.allow.includes('mcp(relay-hub/*)'));

  const gemSaved = JSON.parse(fs.readFileSync(gemPath, 'utf8'));
  assert.equal(gemSaved.mcpServers['relay-hub'].command, 'node');
});
