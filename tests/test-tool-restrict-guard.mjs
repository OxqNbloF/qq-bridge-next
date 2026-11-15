// 检查工具守卫：限制名单失败时不能悄悄吞掉错误
// 测三点：失败要写诊断、3 秒后重试、白名单照旧
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');

let failures = 0;
let tests = 0;
// 跑一条检查，失败就记一次并打印
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 每次重新导入一份干净模块，诊断文件路径要先设好
async function loadPlugin(diagFile) {
  process.env.QQ_TOOL_RESTRICT_LOG = diagFile;
  const url = pathToFileURL(PLUGIN).href + `?t=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  delete process.env.QQ_TOOL_RESTRICT_LOG;
  return mod;
}

// 造一个假的 ctx，模拟工具限制的各种结果
function makeCtx({ restrictImpl, knownAfter = Infinity }) {
  const calls = { restrict: [], guard: null, hidden: new Set() };
  let round = 0;
  const ctx = {
    tools: {
      restrict(filter) {
        const name = filter?.deny?.[0];
        calls.restrict.push(name);
        round += 1;
        const result = restrictImpl({ name, round });
        if (result instanceof Error) throw result;
        calls.hidden.add(name);
        return () => {};
      },
      guard(fn) { calls.guard = fn; }
    }
  };
  return { ctx, calls, knownAfter };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tool-restrict-'));

await test('restrict 全失败时不静默：写诊断文件 + 3 秒后重试', async () => {
  const diag = path.join(tmpDir, 'diag-always-fail.log');
  const mod = await loadPlugin(diag);
  // 前面几次都报「工具名不存在」，重试也失败
  const { ctx, calls } = makeCtx({ restrictImpl: () => new Error('tools.restrict() names unknown global tool "x"') });
  mod.apply(ctx);
  assert.ok(calls.restrict.length > 0, '必须真的调用 restrict');
  const first = fs.readFileSync(diag, 'utf8');
  assert.match(first, /restrict ok=0 failed=\d+/, `诊断文件应记录失败计数：${first}`);
  assert.match(first, /unknown global tool/, '诊断文件必须带 DSH 的原始报错');
  // 等延迟重试落地
  await new Promise((resolve) => setTimeout(resolve, 3400));
  const after = fs.readFileSync(diag, 'utf8');
  assert.match(after, /延迟重试 ok=0/, `重试结果也要落盘：${after}`);
});

await test('时序问题能被 3 秒后的重试补藏（工具晚注册）', async () => {
  const diag = path.join(tmpDir, 'diag-late.log');
  const mod = await loadPlugin(diag);
  const total = mod.RESTRICTED_TOOL_NAMES.length;
  // 第一轮全失败（工具还没注册），第二轮全成功
  const { ctx, calls } = makeCtx({
    restrictImpl: ({ round }) => (round <= total ? new Error('unknown global tool') : undefined)
  });
  mod.apply(ctx);
  assert.equal(calls.hidden.size, 0, '第一轮应当一个都没藏掉');
  await new Promise((resolve) => setTimeout(resolve, 3400));
  assert.equal(calls.hidden.size, total, `重试后应全部藏掉，实际 ${calls.hidden.size}/${total}`);
  const log = fs.readFileSync(diag, 'utf8');
  assert.match(log, new RegExp(`延迟重试 ok=${total}`), `重试结果应写入诊断：${log}`);
});

await test('restrict 一次成功时不写诊断文件（不制造噪声）', async () => {
  const diag = path.join(tmpDir, 'diag-ok.log');
  const mod = await loadPlugin(diag);
  const { ctx, calls } = makeCtx({ restrictImpl: () => undefined });
  mod.apply(ctx);
  assert.equal(calls.hidden.size, mod.RESTRICTED_TOOL_NAMES.length);
  assert.equal(fs.existsSync(diag), false, '全部成功时不该产生诊断文件');
});

await test('执行期 guard 照旧：QQ MCP 放行、dev_* 与本地工具拒绝', async () => {
  const diag = path.join(tmpDir, 'diag-guard.log');
  const mod = await loadPlugin(diag);
  const { ctx, calls } = makeCtx({ restrictImpl: () => undefined });
  mod.apply(ctx);
  assert.equal(typeof calls.guard, 'function', '必须注册执行期 guard');
  const guard = calls.guard;
  for (const name of ['mcp__snowluma__qq_send_message', 'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_search', 'ask_user_question', 'todo_write']) {
    assert.equal(guard({ name, agent: { id: 'qqb-g-1' }, arguments: { key: 'group:1' } }), undefined, `${name} 应放行`);
  }
  for (const name of ['dev_inject_plugin', 'dev_plugin_status', 'pwsh', 'read', 'write', 'dsh_snapshot', 'skill']) {
    assert.match(String(guard({ name })), /不在 QQ 桥接白名单内/, `${name} 必须拒绝`);
  }
  const send = { name: 'mcp__snowluma__qq_send_message', agent: { id: 'qqb-g-1' } };
  assert.equal(guard({ ...send, arguments: { target: 'group:1' } }), undefined);
  assert.equal(guard({ ...send, arguments: { key: 'group:1', target: 'group:01' } }), undefined);
  for (const args of [{}, { target: 'group:2' }, { key: 'group:1', target: 'group:2' }]) {
    assert.equal(guard({ ...send, arguments: args }), '该会话不可用');
  }
  for (const [tool, field, kind] of [
    ['qq_send_group_message', 'groupId', 'group'], ['qq_reply', 'groupId', 'group'],
    ['qq_send_private_message', 'userId', 'private'], ['qq_send_burst', 'groupId', 'group']
  ]) {
    const exec = { name: `mcp__snowluma__${tool}`, agent: { id: `qqb-${kind === 'group' ? 'g' : 'p'}-1` } };
    assert.equal(guard({ ...exec, arguments: { [field]: '1' } }), undefined);
    assert.equal(guard({ ...exec, arguments: { [field]: '2', target: `${kind}:1` } }), '该会话不可用');
    assert.equal(guard({ name: exec.name, arguments: { [field]: '1' } }), '该会话不可用');
  }
  assert.match(String(guard({ name: '' })), /工具名无效/);
  assert.match(String(guard({})), /工具名无效/);
});

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
