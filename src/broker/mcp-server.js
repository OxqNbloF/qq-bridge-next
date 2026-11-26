// 薄壳 5 工具 MCP Broker：渐进式披露、家长控制实时鉴权、零 Shell 本地脚本调度
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadModuleManifests, validateActionArgs } from './manifest.js';
import { runModuleScript } from './runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MODULES_DIR = path.join(REPO_ROOT, 'modules');

export function fetchSocketPolicy(socketPath, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!socketPath) {
      reject(new Error('缺少 QQ_SESSION_SOCK：拒绝无会话能力访问'));
      return;
    }
    const req = http.request({ socketPath, path: '/broker/policy', method: 'GET' }, (res) => {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('读取会话策略超时')));
    req.end();
  });
}

export function createBrokerEngine({
  modulesDir = DEFAULT_MODULES_DIR,
  socketPath = process.env.QQ_SESSION_SOCK || '',
  scope = process.env.QQ_MODULE_SCOPE || 'chat',
  repoRoot = REPO_ROOT,
  fetchPolicy = () => fetchSocketPolicy(socketPath),
  runScript = runModuleScript,
  useBwrap = process.env.QQ_USE_BWRAP === '1',
} = {}) {
  const manifests = loadModuleManifests(modulesDir);

  async function resolveAllowed() {
    const policy = await fetchPolicy();
    const effectiveScope = policy?.scope === 'admin' && scope === 'admin' ? 'admin' : 'chat';
    const enabled = new Set(Array.isArray(policy?.enabledModules) ? policy.enabledModules.map(String) : []);
    const allowed = new Map();
    for (const [name, entry] of manifests) {
      if (!enabled.has(name)) continue;
      if (entry.manifest.scope === 'admin' && effectiveScope !== 'admin') continue;
      allowed.set(name, entry);
    }
    return { policy, effectiveScope, allowed };
  }

  async function manual({ module: targetModule } = {}) {
    const { allowed } = await resolveAllowed();
    if (!targetModule) {
      const lines = [...allowed.values()].map((e) => `- ${e.manifest.name}: ${e.manifest.summary}`);
      return {
        ok: true,
        modules: [...allowed.keys()],
        manual: lines.length
          ? `当前开放模块（qq_manual({ module }) 查参数，qq_call({ module, action, args }) 调用）：\n${lines.join('\n')}`
          : '当前会话无可用模块（已被控制台全部关闭）。',
      };
    }
    const name = String(targetModule).trim();
    const entry = allowed.get(name);
    if (!entry) {
      return { ok: false, code: 'MODULE_DISABLED', error: `模块 ${name} 未启用或不存在` };
    }
    const actionsSummary = Object.entries(entry.manifest.actions).map(([act, spec]) => {
      const params = Object.entries(spec.params ?? {})
        .map(([p, ps]) => `${p}${ps.required ? '*' : '?'}:${ps.type}`)
        .join(', ');
      return `  - ${act}(${params}): ${spec.desc || ''}`;
    }).join('\n');
    return {
      ok: true,
      module: name,
      summary: entry.manifest.summary,
      actions: entry.manifest.actions,
      manual: `${name} — ${entry.manifest.summary}\n${actionsSummary}`,
    };
  }

  async function call({ module: targetModule, action, args } = {}) {
    const modName = String(targetModule ?? '').trim();
    const actName = String(action ?? '').trim();
    if (!modName || !actName) {
      return { ok: false, code: 'INVALID_INPUT', error: 'module 与 action 不能为空' };
    }
    const { policy, effectiveScope, allowed } = await resolveAllowed();
    const entry = allowed.get(modName);
    if (!entry) {
      return { ok: false, code: 'MODULE_DISABLED', error: `家长控制未授权调用模块：${modName}` };
    }
    const actionSpec = entry.manifest.actions[actName];
    if (!actionSpec) {
      return { ok: false, code: 'UNKNOWN_ACTION', error: `模块 ${modName} 不存在动作 ${actName}` };
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
      useBwrap,
    });
  }

  return {
    manifests,
    manual,
    call,
    send: (params = {}) => call({ module: 'msg', action: 'send', args: params }),
    wait: (params = {}) => call({ module: 'msg', action: 'wait', args: params }),
    done: (params = {}) => call({ module: 'msg', action: 'done', args: params }),
  };
}

function asToolResult(res) {
  return {
    ...(res?.ok === false ? { isError: true } : {}),
    content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res) }],
  };
}

export async function startBrokerStdioServer() {
  const engine = createBrokerEngine();
  const server = new McpServer({ name: 'qq-broker', version: '3.0.0' });

  server.registerTool('qq_send', {
    description: '发送 QQ 消息到当前会话（单条字符串或短句数组，可选引用与 @）。',
    inputSchema: z.object({
      messages: z.union([z.string(), z.array(z.string())]),
      replyToMessageId: z.string().optional(),
      atUserId: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.send(params)));

  server.registerTool('qq_wait', {
    description: '等待群友继续发言或观察新消息后再决定要不要插嘴。',
    inputSchema: z.object({
      timeoutMs: z.number().int().optional(),
      quietMs: z.number().int().optional(),
      purpose: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.wait(params)));

  server.registerTool('qq_done', {
    description: '结束本轮处理，确认已读到本地 seq 并可选调整下一次唤醒设置。',
    inputSchema: z.object({
      throughSeq: z.number().int().optional(),
      wakeConfig: z.object({
        mode: z.enum(['sleep', 'active']).optional(),
        sleepMs: z.number().int().optional(),
      }).optional(),
    }),
  }, async (params) => asToolResult(await engine.done(params)));

  server.registerTool('qq_manual', {
    description: '按需查看当前会话开放的本地模块列表，或指定模块的参数手册。',
    inputSchema: z.object({
      module: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.manual(params)));

  server.registerTool('qq_call', {
    description: '调用控制台开放的模块化本地脚本能力（请先用 qq_manual 查参）。',
    inputSchema: z.object({
      module: z.string(),
      action: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (params) => asToolResult(await engine.call(params)));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBrokerStdioServer().catch((err) => {
    process.stderr.write(`[qq-broker] 启动失败: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
