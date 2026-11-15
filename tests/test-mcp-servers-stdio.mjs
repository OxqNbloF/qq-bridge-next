// 模拟 DSH 去启动桥接里的三个 MCP 服务，
// 看它们在新版 DSH 下还能不能正常连上。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

const SERVERS = [
  { serverName: 'snowluma', script: 'src/mcp-snowluma-safe.js' },
  { serverName: 'snowluma-host', script: 'src/mcp-host-server.js' },
  { serverName: 'web-search-safe', script: 'src/mcp-web-search-safe.js' },
];

let failures = 0;
for (const { serverName, script } of SERVERS) {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [path.join(ROOT, script)],
    cwd: ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'dsh-mcp-probe', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`✅ ${serverName}: ${names.length} tools`);
    console.log(`   ${names.join(', ')}`);
    // 检查工具名是否符合 DSH 的命名要求
    const bad = names.filter((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n));
    if (bad.length) { console.log(`   ⚠️ 不符合 DSH 工具名契约: ${bad.join(', ')}`); failures += 1; }
  } catch (error) {
    console.log(`❌ ${serverName}: ${error?.message ?? error}`);
    failures += 1;
  } finally {
    try { await client.close(); } catch {}
  }
}
console.log(failures === 0 ? '\n全部 MCP server 接入正常' : `\n${failures} 个 MCP server 异常`);
process.exit(failures === 0 ? 0 : 1);
