// 薄壳 5 工具 MCP Hub：渐进式能力披露、外部控制实时裁切、零 Shell 脚本执行
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadCapabilityManifests, validateActionArgs } from './manifest.js';
import { runCapabilityScript } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MODULES_DIR = path.join(REPO_ROOT, 'modules');

export function fetchRoomPolicy(socketPath, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!socketPath) {
      reject(new Error('缺少 RELAY_ROOM_SOCK：拒绝无房间上下文访问'));
      return;
    }
    const req = http.request({ socketPath, path: '/hub/policy', method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const body = JSON.parse(text);
          if (res.statusCode >= 400 || body?.ok === false) {
            reject(new Error(body?.error || `HTTP ${res.statusCode}`));
            return;
          }
          resolve(body);
        } catch {
          reject(new Error(`策略解析失败 (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('读取房间策略超时')));
    req.end();
  });
}

export function createHubEngine({
  modulesDir = DEFAULT_MODULES_DIR,
  socketPath = process.env.RELAY_ROOM_SOCK || '',
  scope = process.env.RELAY_SCOPE || 'standard',
  repoRoot = REPO_ROOT,
  fetchPolicy = () => fetchRoomPolicy(socketPath),
  runScript = runCapabilityScript,
  useSandbox = process.env.RELAY_SANDBOX === '1',
} = {}) {
  const manifests = loadCapabilityManifests(modulesDir);

  async function resolveAllowed() {
    const policy = await fetchPolicy();
    const effectiveScope = policy?.scope === 'admin' && scope === 'admin' ? 'admin' : 'standard';
    const enabled = new Set(Array.isArray(policy?.enabledCapabilities) ? policy.enabledCapabilities.map(String) : []);
    const allowed = new Map();
    for (const [name, entry] of manifests) {
      if (!enabled.has(name)) continue;
      if (entry.manifest.scope === 'admin' && effectiveScope !== 'admin') continue;
      allowed.set(name, entry);
    }
    return { policy, effectiveScope, allowed };
  }

  async function inspectTools({ capability } = {}) {
    const { allowed } = await resolveAllowed();
    if (!capability) {
      const lines = [...allowed.values()].map((e) => `- ${e.manifest.name}: ${e.manifest.summary}`);
      return {
        ok: true,
        capabilities: [...allowed.keys()],
        manual: lines.length
          ? `当前开放能力（inspect_tools({ capability }) 查参数，invoke_tool({ capability, action, args }) 调用）：\n${lines.join('\n')}`
          : '当前房间无可用扩展能力（已被外部控制台禁用）。',
      };
    }
    const name = String(capability).trim();
    const entry = allowed.get(name);
    if (!entry) {
      return { ok: false, code: 'CAPABILITY_DISABLED', error: `能力 ${name} 未启用或不存在` };
    }
    const actionsSummary = Object.entries(entry.manifest.actions).map(([act, spec]) => {
      const params = Object.entries(spec.params ?? {})
        .map(([p, ps]) => `${p}${ps.required ? '*' : '?'}:${ps.type}`)
        .join(', ');
      return `  - ${act}(${params}): ${spec.desc || ''}`;
    }).join('\n');
    return {
      ok: true,
      capability: name,
      summary: entry.manifest.summary,
      actions: entry.manifest.actions,
      manual: `${name} — ${entry.manifest.summary}\n${actionsSummary}`,
    };
  }

  async function invokeTool({ capability, action, args } = {}) {
    const capName = String(capability ?? '').trim();
    const actName = String(action ?? '').trim();
    if (!capName || !actName) return { ok: false, code: 'INVALID_INPUT', error: 'capability 与 action 不能为空' };

    const { policy, effectiveScope, allowed } = await resolveAllowed();
    const entry = allowed.get(capName);
    if (!entry) {
      return { ok: false, code: 'CAPABILITY_DISABLED', error: `外部控制台未授权调用能力：${capName}` };
    }
    const actionSpec = entry.manifest.actions[actName];
    if (!actionSpec) {
      return { ok: false, code: 'UNKNOWN_ACTION', error: `能力 ${capName} 不存在动作 ${actName}` };
    }
    let cleanArgs;
    try {
      cleanArgs = validateActionArgs(actionSpec, args);
    } catch (error) {
      return { ok: false, code: 'INVALID_ARGS', error: error?.message ?? String(error) };
    }
    return runScript({
      entry,
      action: actName,
      args: cleanArgs,
      socketPath,
      scope: effectiveScope,
      repoRoot,
      timeoutMs: policy?.scriptTimeoutMs,
      useSandbox,
    });
  }

  return {
    manifests,
    inspectTools,
    invokeTool,
    say: (params = {}) => invokeTool({ capability: 'chat', action: 'say', args: params }),
    linger: (params = {}) => invokeTool({ capability: 'chat', action: 'linger', args: params }),
    finish: (params = {}) => invokeTool({ capability: 'chat', action: 'finish', args: params }),
  };
}

function asToolResult(res) {
  return {
    ...(res?.ok === false ? { isError: true } : {}),
    content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res) }],
  };
}

export async function startHubStdioServer() {
  const engine = createHubEngine();
  const server = new McpServer({ name: 'relay-hub', version: '1.0.0' });

  server.registerTool('say', {
    description: '发送消息到当前房间（单句字符串或短句数组，可选引用与 @）。',
    inputSchema: z.object({
      messages: z.union([z.string(), z.array(z.string())]),
      replyToMessageId: z.string().optional(),
      mentionUserId: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.say(params)));

  server.registerTool('linger', {
    description: '等待群友继续发言或观察新消息后再决定要不要插嘴。',
    inputSchema: z.object({
      timeoutMs: z.number().int().optional(),
      quietMs: z.number().int().optional(),
      reason: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.linger(params)));

  server.registerTool('finish', {
    description: '结束本轮处理，确认已读到本地 seq 并可选微调下一次唤醒节奏。',
    inputSchema: z.object({
      throughSeq: z.number().int().optional(),
      pacing: z.object({
        state: z.enum(['dormant', 'engaged']).optional(),
        dormantMs: z.number().int().optional(),
      }).optional(),
    }),
  }, async (params) => asToolResult(await engine.finish(params)));

  server.registerTool('inspect_tools', {
    description: '按需查看当前房间开放的能力列表，或指定能力的动作与参数手册。',
    inputSchema: z.object({
      capability: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.inspectTools(params)));

  server.registerTool('invoke_tool', {
    description: '调用控制台开放的模块化本地能力（建议先用 inspect_tools 查参）。',
    inputSchema: z.object({
      capability: z.string(),
      action: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (params) => asToolResult(await engine.invokeTool(params)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHubStdioServer().catch((err) => {
    process.stderr.write(`[relay-hub] 启动失败: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
