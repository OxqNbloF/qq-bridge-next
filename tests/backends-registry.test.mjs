// 多后端注册表（DSH / agy / gemini / 通用 CLI）、模型选择、热切换与跨后端平滑交接单测
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createConfigStore } from '../src/config/schema.js';
import { createChatStore } from '../src/storage/chat-store.js';
import { createBackendRegistry } from '../src/backends/registry.js';

function makeMockSpawn(handler) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    const ch = new EventEmitter();
    ch.stdout = new PassThrough();
    ch.stderr = new PassThrough();
    ch.kill = () => {};
    queueMicrotask(() => handler({ cmd, args, opts, child: ch, idx: calls.length - 1 }));
    return ch;
  };
  fn.calls = calls;
  return fn;
}

test('支持 agy / gemini / dsh / 自定义 CLI 热切换、选模型并保持共享会话状态交接', async () => {
  const configStore = createConfigStore({
    initialConfig: {
      access: { allowAllWhenEmpty: true },
      runtime: { activeBackend: 'agy', activeModel: 'agy-v1' },
      backends: {
        cliProfiles: {
          codex: {
            label: 'Codex CLI',
            command: 'codex',
            argsTemplate: ['exec', '{{prompt}}'],
            modelFlag: '-m',
            resumeFlag: '',
            outputFormat: 'text',
            model: 'gpt-5-codex',
            models: ['gpt-5-codex', 'o3'],
            timeoutMs: 60000,
            env: { CODEX_CUSTOM: 'yes' },
          },
        },
      },
    },
  });
  const chatStore = createChatStore();
  chatStore.appendIncoming('group:100', { userId: '1', senderName: '群友A', text: '晚上吃什么？' });

  const mockSpawn = makeMockSpawn(({ cmd, child }) => {
    if (cmd === 'agy') {
      child.stdout.end(`${JSON.stringify({ type: 'init', conversation_id: 'agy-1' })}\n${JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 150, output_tokens: 20 } })}\n`);
      child.emit('close', 0);
      return;
    }
    if (cmd === 'gemini') {
      child.stdout.end(`${JSON.stringify({ type: 'init', session_id: 'gem-1' })}\n${JSON.stringify({ type: 'result', response: 'gemini ok', stats: { input_tokens: 80, output_tokens: 12 } })}\n`);
      child.emit('close', 0);
      return;
    }
    child.stdout.end('codex plain output\n');
    child.emit('close', 0);
  });

  const dshCalls = [];
  const dshClientFactory = () => ({
    resolveBase: () => 'http://127.0.0.1:3080',
    models: { list: async () => ({ result: { ok: true, value: { models: ['deepseek-flash', 'deepseek-reasoner'] } } }) },
    workspace: { create: async () => ({ result: { ok: true, value: { workspace: { workspaceId: 'ws-1' } } } }) },
    sessions: {
      create: async () => ({ result: { ok: true, value: { sessionId: 'dsh-s1' } } }),
      selectModel: async (p) => { dshCalls.push(p); return { result: { ok: true } }; },
      events: async () => (async function* () {
        yield { type: 'assistant/message', data: { text: 'dsh reply', usage: { input_tokens: 90 } } };
        yield { type: 'turn/end', data: {} };
      })(),
      prompt: async () => ({ result: { ok: true } }),
    },
  });

  const registry = createBackendRegistry({
    configStore,
    chatStore,
    spawnFn: mockSpawn,
    detectCapsFn: (cmd) => (cmd === 'agy'
      ? { systemPrompt: true, settings: true }
      : { resume: true, model: true, allowedMcpServerNames: true }),
    dshClientFactory,
  });

  const list = await registry.listBackends();
  assert.deepEqual(list.map((b) => b.id), ['dsh', 'agy', 'gemini', 'codex']);

  // 1. 运行在 agy + agy-v1
  const r1 = await registry.runTurn({
    convKey: 'group:100',
    systemPrompt: 'SYS',
    deltaPrompt: 'DELTA1',
    socketPath: '/tmp/g100.sock',
    scope: 'chat',
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.backendId, 'agy');
  assert.equal(mockSpawn.calls[0].args.includes('agy-v1'), true);
  assert.equal(mockSpawn.calls[0].opts.env.QQ_SESSION_SOCK, '/tmp/g100.sock');
  assert.equal(chatStore.getBackendSession('group:100', 'agy'), 'agy-1');

  // 2. 热切换到 gemini 并选择 gemini-2.5-pro
  registry.switchRuntime({ backendId: 'gemini', model: 'gemini-2.5-pro' });
  const r2 = await registry.runTurn({
    convKey: 'group:100',
    systemPrompt: 'SYS',
    deltaPrompt: 'DELTA2',
    socketPath: '/tmp/g100.sock',
    scope: 'chat',
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.backendId, 'gemini');
  assert.equal(mockSpawn.calls[1].cmd, 'gemini');
  assert.equal(mockSpawn.calls[1].args.includes('gemini-2.5-pro'), true);
  assert.equal(mockSpawn.calls[1].args.includes('--allowed-mcp-server-names'), true);
  assert.equal(mockSpawn.calls[1].args.some((a) => a.includes('后端切换交接')), true, '跨后端切换应注入交接摘要');

  // 3. 热切换到自定义 codex CLI
  registry.switchRuntime({ backendId: 'codex', model: 'o3' });
  const r3 = await registry.runTurn({
    convKey: 'group:100',
    systemPrompt: 'SYS',
    deltaPrompt: 'DELTA3',
    socketPath: '/tmp/g100.sock',
    scope: 'chat',
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.text, 'codex plain output');
  assert.equal(mockSpawn.calls[2].opts.env.CODEX_CUSTOM, 'yes');
  assert.equal(mockSpawn.calls[2].args.includes('o3'), true);

  // 4. 单聊覆盖到 dsh 并拉取模型列表
  const dshModels = await registry.listModels('dsh');
  assert.equal(dshModels.models.includes('deepseek-reasoner'), true);
  registry.switchRuntime({ backendId: 'dsh', model: 'deepseek-reasoner', convKey: 'group:100' });
  const r4 = await registry.runTurn({ convKey: 'group:100', systemPrompt: 'SYS', deltaPrompt: 'DELTA4' });
  assert.equal(r4.ok, true);
  assert.equal(r4.text, 'dsh reply');
  assert.equal(dshCalls[0].model, 'deepseek-reasoner');
});
