// 薄壳 MCP Broker：向 CLI 仅暴露 5 个渐进式披露元工具，策略由外部控制台与 Unix Socket 强制决定
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadModuleManifests, validateActionArgs } from './manifest-loader.js';
import { runModuleScript } from './script-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MODULES_DIR = path.join(REPO_ROOT, 'modules');

/** 通过会话 Unix Socket 查询外部控制台实时下发的家长控制策略 */
export function fetchSocketPolicy(socketPath, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (!socketPath) {
      reject(new Error('缺少 QQ_SESSION_SOCK：拒绝无会话能力上下文访问'));
      return;
    }
    const req = http.request({
      socketPath,
      path: '/broker/policy',
      method: 'GET',
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const body = JSON.parse(text);
          if (res.statusCode >= 400 || body?.ok === false) {
            reject(new Error(body?.error || `policy HTTP ${res.statusCode}`));
            return;
          }
          resolve(body);
        } catch {
          reject(new Error(`策略响应解析失败 (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('读取会话策略超时')));
    req.end();
  });
}

/** 创建可单测的 Broker 核心调度引擎（5 个元工具共用） */
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

  async function resolveAllowedModules() {
    const policy = await fetchPolicy();
    const effectiveScope = policy?.scope === 'admin' && scope === 'admin' ? 'admin' : 'chat';
    const enabledSet = new Set(Array.isArray(policy?.enabledModules) ? policy.enabledModules.map(String) : []);
    const allowed = new Map();
    for (const [name, entry] of manifests) {
      if (!enabledSet.has(name)) continue;
      if (entry.manifest.scope === 'admin' && effectiveScope !== 'admin') continue;
      allowed.set(name, entry);
    }
    return { policy, effectiveScope, allowed };
  }

  async function manual({ module: targetModule } = {}) {
    const { allowed } = await resolveAllowedModules();
    if (!targetModule) {
      const lines = [...allowed.values()].map((entry) => `- ${entry.manifest.name}: ${entry.manifest.summary}`);
      return {
        ok: true,
        modules: [...allowed.keys()],
        manual: lines.length
          ? `可用扩展模块（调 qq_manual({ module }) 看参数，调 qq_call({ module, action, args }) 执行）：\n${lines.join('\n')}`
          : '当前会话无可用模块（已被控制台全部关闭）。',
      };
    }
    const name = String(targetModule).trim();
    const entry = allowed.get(name);
    if (!entry) {
      return { ok: false, code: 'MODULE_DISABLED', error: `模块 ${name} 未启用或不存在` };
    }
    const actionsSummary = Object.entries(entry.manifest.actions).map(([act, spec]) => {
      const params = Object.entries(spec.params ?? {}).map(([p, ps]) => `${p}${ps.required ? '*' : '?'}:${ps.type}`).join(', ');
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
    const { effectiveScope, allowed } = await resolveAllowedModules();
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
  const server = new McpServer({ name: 'qq-broker', version: '1.0.0' });

  server.registerTool('qq_send', {
    description: '发送 QQ 消息到当前会话（支持单条字符串或短句数组，可选引用与 @）。',
    inputSchema: z.object({
      messages: z.union([z.string(), z.array(z.string())]),
      replyToMessageId: z.string().optional(),
      atUserId: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.send(params)));

  server.registerTool('qq_wait', {
    description: '等待群友/对方补充新消息或完成沉睡前观察。purpose 可选 reply / messages。',
    inputSchema: z.object({
      timeoutMs: z.number().int().optional(),
      quietMs: z.number().int().optional(),
      purpose: z.enum(['reply', 'messages']).optional(),
    }),
  }, async (params) => asToolResult(await engine.wait(params)));

  server.registerTool('qq_done', {
    description: '收尾：提交已读水位 throughSeq，并可选更新下一次唤醒条件 wakeConfig（潜水/活跃/触发词）。',
    inputSchema: z.object({
      throughSeq: z.number().int().min(0).optional(),
      wakeConfig: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (params) => asToolResult(await engine.done(params)));

  server.registerTool('qq_call', {
    description: '调用控制台已授权的扩展本地模块（先用 qq_manual 查可用模块与参数）。',
    inputSchema: z.object({
      module: z.string(),
      action: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (params) => asToolResult(await engine.call(params)));

  server.registerTool('qq_manual', {
    description: '查询当前会话可用的本地扩展模块清单或某个模块的动作说明。',
    inputSchema: z.object({
      module: z.string().optional(),
    }),
  }, async (params) => asToolResult(await engine.manual(params)));

  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startBrokerStdioServer();
}
