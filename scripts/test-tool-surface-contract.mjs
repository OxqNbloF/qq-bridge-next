#!/usr/bin/env node
// 钉住工具面和 HTTP 接口清单，改动必须显式确认
// 用法：node scripts/test-tool-surface-contract.mjs
// 传 --update 重写快照；不连 QQ/DSH，只问工具清单
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = path.join(ROOT, 'scripts', 'contracts');
const TOOL_SNAPSHOT = path.join(SNAPSHOT_DIR, 'qq-tool-surface.json');
const ROUTE_SNAPSHOT = path.join(SNAPSHOT_DIR, 'http-routes.json');
const UPDATE = process.argv.includes('--update');

let failures = 0;
// 记一次失败并打印
const fail = (message) => { failures += 1; console.log(`FAIL ${message}`); };
// 打印一次通过
const pass = (message) => console.log(`PASS ${message}`);

// ── 1. 源码里注册了哪些工具 ──
// 从源码里找出注册的全部工具名
function sourceToolNames() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  const names = [...source.matchAll(/server\.tool\(\s*'(qq_[a-z0-9_]+)'/g)].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) fail(`源码里重复注册：${dup.join(', ')}`);
  return [...new Set(names)].sort();
}

// ── 2. 真起服务，看实际注册的工具 ──
// 在临时目录搭一份能启动的副本
function makeRoot({ mode, config }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-tool-surface-'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(temp, 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(temp, 'package.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(temp, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'state', 'mode.json'), JSON.stringify({ mode }));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(config));
  return temp;
}

// 取工具的入参名单和必填项
function shapeOf(tool) {
  const schema = tool.inputSchema ?? {};
  return {
    params: Object.keys(schema.properties ?? {}).sort(),
    required: [...(schema.required ?? [])].sort(),
  };
}

// 真起服务，问它注册了哪些工具
async function listRuntimeTools(profile) {
  const temp = makeRoot(profile);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(temp, 'src', 'mcp-snowluma-safe.js')],
    cwd: temp,
    stderr: 'pipe',
    env: { ...process.env, QQ_BRIDGE_SELF_KEY: '' },
  });
  const client = new Client({ name: 'tool-surface-contract', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const out = {};
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) out[tool.name] = shapeOf(tool);
    return out;
  } finally {
    try { await client.close(); } catch {}
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const allOn = structuredClone(example);
for (const key of Object.keys(allOn.socialV2?.tools ?? {})) allOn.socialV2.tools[key] = true;
// 语音工具还要求 socialV2.voice.enabled 打开
allOn.socialV2.voice = { ...(allOn.socialV2.voice ?? {}), enabled: true };

const PROFILES = {
  'closed-agent/all-tools-on': { mode: 'closed-agent', config: allOn },
  'reserved2/config.example.json': { mode: 'reserved2', config: example },
  'reserved2/no-tools-config': { mode: 'reserved2', config: {} },
};

// ── 3. 桥接的 HTTP 路由表 ──
// 递归找出所有源码文件
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(m?js)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name) ? [full] : [];
  });
}
// 找出桥接里写死的 HTTP 路径
function httpRoutes() {
  const routes = new Set();
  for (const file of walk(path.join(ROOT, 'src'))) {
    if (/mcp-|self-test/.test(path.basename(file))) continue; // MCP 客户端只调用、不提供服务，跳过
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(?:url\.)?pathname\s*===\s*'(\/[^']*)'/g)) routes.add(m[1]);
  }
  return [...routes].sort();
}

// ── 开始执行 ──
const actualTools = { sourceAll: sourceToolNames(), profiles: {} };
for (const [name, profile] of Object.entries(PROFILES)) {
  actualTools.profiles[name] = await listRuntimeTools(profile);
}
const actualRoutes = httpRoutes();

if (UPDATE) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(TOOL_SNAPSHOT, `${JSON.stringify(actualTools, null, 2)}\n`);
  fs.writeFileSync(ROUTE_SNAPSHOT, `${JSON.stringify(actualRoutes, null, 2)}\n`);
  console.log(`已更新快照：sourceAll=${actualTools.sourceAll.length}，`
    + Object.entries(actualTools.profiles).map(([k, v]) => `${k}=${Object.keys(v).length}`).join('，')
    + `，routes=${actualRoutes.length}`);
  process.exit(0);
}

const expectedTools = JSON.parse(fs.readFileSync(TOOL_SNAPSHOT, 'utf8'));
const expectedRoutes = JSON.parse(fs.readFileSync(ROUTE_SNAPSHOT, 'utf8'));

// 对比快照和实际，列出少了什么多了什么
function diffList(label, expected, actual) {
  const missing = expected.filter((x) => !actual.includes(x));
  const extra = actual.filter((x) => !expected.includes(x));
  if (missing.length || extra.length) {
    fail(`${label}：缺少 [${missing.join(', ')}]，多出 [${extra.join(', ')}]`);
  } else pass(`${label}：${actual.length} 项与快照一致`);
}

diffList('源码 qq_* 全集', expectedTools.sourceAll, actualTools.sourceAll);
for (const [profile, expected] of Object.entries(expectedTools.profiles)) {
  const actual = actualTools.profiles[profile];
  if (!actual) { fail(`画像 ${profile} 未运行`); continue; }
  diffList(`画像 ${profile} 工具名`, Object.keys(expected), Object.keys(actual));
  for (const [tool, shape] of Object.entries(expected)) {
    if (!actual[tool]) continue;
    if (JSON.stringify(shape) !== JSON.stringify(actual[tool])) {
      fail(`画像 ${profile} 的 ${tool} 参数变化：期望 ${JSON.stringify(shape)}，实际 ${JSON.stringify(actual[tool])}`);
    }
  }
}
for (const name of Object.keys(actualTools.profiles['closed-agent/all-tools-on'])) {
  if (name.startsWith('qq_') && !actualTools.sourceAll.includes(name)) fail(`运行期出现源码全集外的工具 ${name}`);
}
diffList('桥接 HTTP 精确路由', expectedRoutes, actualRoutes);

console.log(failures ? `\n${failures} 项契约漂移；若是有意变更，运行 --update 并在 PR 中说明` : '\n工具面 / HTTP 面契约与快照一致');
process.exit(failures ? 1 : 0);
