// 不启动 DSH、不连 QQ，单独跑两个预设插件的工具拦截规则
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const { apply } = await import(pathToFileURL(path.join(root, 'dsh/agent-presets', preset, 'qq-tool-restrict.mjs')).href);
  let guard;
  const restricted = [];
  apply({ tools: {
    restrict: ({ deny }) => restricted.push(...deny),
    guard: (callback) => { guard = callback; },
  } });
  assert.equal(typeof guard, 'function');
  assert.ok(restricted.includes('dev_install_package'));
  for (const name of ['ask_user_question', 'todo_write', 'mcp__snowluma__qq_send_message',
    'mcp__snowluma-host__snowluma_status', 'mcp__web-search-safe__web_fetch']) {
    assert.equal(guard({ name, agent: { id: 'qqb-g-1' }, arguments: { key: 'group:1' } }), undefined, `${preset}: expected allowed ${name}`);
  }
  for (const name of ['web_fetch', 'web_search', 'bash', 'read_file', 'dev_future_tool',
    'mcp__untrusted__web_fetch', '', null, undefined]) {
    try { assert.equal(typeof guard({ name }), 'string', `${preset}: must reject ${String(name)}`); }
    catch (error) { failures++; console.error(`FAIL ${error.message}`); }
  }
  console.log(`${preset}: checked allowed tools and denied inherited/local/invalid tools`);
}
// ── 检查启动时收紧文件夹权限的脚本 ──
import fs from 'node:fs';
{
  const helper = fs.readFileSync(path.join(root, 'scripts/harden-state-acl.mjs'), 'utf8');
  for (const needle of ['isHardened', 'hardenDir', 'process.exit(0)']) assert.ok(helper.includes(needle), `权限收紧助手应包含 ${needle}`);
  // 权限设置有失败也不能拦住启动
  assert.ok(!/process\.exit\([1-9]/.test(helper), '权限收紧助手不得以非 0 退出码结束（否则会阻断启动）');
  const startText = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
  assert.ok(startText.includes('harden-state-acl.mjs'), 'start.sh 必须在启动桥接前调用权限收紧助手');
  // 桥接必须用绝对路径启动，重启脚本才找得到它
  assert.ok(startText.includes('node "$ROOT/src/bridge.js"'), 'start.sh 必须用绝对路径启动 bridge');
  assert.ok(startText.indexOf('harden-state-acl.mjs') < startText.indexOf('node "$ROOT/src/bridge.js"'), '权限收紧必须先于桥接启动');
  for (const gone of ['start.bat', 'restart.bat']) assert.equal(fs.existsSync(path.join(root, gone)), false, `${gone} 已在改造 P10 移除，不要加回来`);
  console.log('state permission hardening: helper is non-blocking and wired into start.sh');
}

// ── 只读检查 SnowLuma，绝不自动启动或停掉它 ──
// 许可协议不允许用脚本自动部署 SnowLuma。
// 这条测试防止有人把「启动/停止」功能再加回来。
{
  const host = fs.readFileSync(path.join(root, 'src/mcp-host-server.js'), 'utf8');
  // ① 代码里不能有启动或结束进程的写法
  const code = host.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  for (const bad of ['spawn(', 'taskkill', 'execFileSync', 'child_process']) {
    assert.ok(!code.includes(bad), `mcp-host-server.js 不得再出现「${bad}」（违反 EULA §5.4 的 L6 不变量）`);
  }
  // ② 不得再注册这两个工具
  for (const tool of ['start_snowluma', 'stop_snowluma']) {
    assert.ok(!host.includes(`'${tool}'`), `不得再注册 ${tool}（EULA §5.4）`);
  }
  // ③ 配置项不得复活（代码与模板两侧都查）
  assert.ok(!code.includes('allowProcessControl'), 'mcp-host-server.js 不得再读取 allowProcessControl');
  const example = fs.readFileSync(path.join(root, 'config.example.json'), 'utf8');
  assert.ok(!example.includes('allowProcessControl'), 'config.example.json 不得再提供 allowProcessControl');
  // ④ 只读工具必须还在（别把整个 server 删空）
  assert.ok(host.includes("'snowluma_status'"), 'snowluma_status（只读探活）必须保留');
  // ⑤ 包的说明文件里必须写明许可证
  // 这里写死许可证名字，有人改了就能立刻发现
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'PolyForm-Noncommercial-1.0.0',
    'package.json 的 license 必须是本仓库实际使用的许可（PolyForm Noncommercial 1.0.0，与上游 qq-bridge 一致，见 LICENSE）');
  // 子包也必须用同一个许可证，不能各写各的
  for (const rel of ['plugins/qq-agent-presets/package.json', 'plugins/qq-mode-console/package.json']) {
    const sub = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    assert.equal(sub.license, 'PolyForm-Noncommercial-1.0.0',
      `${rel} 的 license 必须与根清单一致（PolyForm Noncommercial 1.0.0）`);
  }
  console.log('L6 compliance: no SnowLuma process control, no allowProcessControl, license declared');
}

process.exitCode = failures ? 1 : 0;
