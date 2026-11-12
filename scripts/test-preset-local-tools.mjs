// 铁律 L7：仿真会话的 preset 不能带本地执行能力
// 从真实 preset 文件拆出组成，查守卫在不在、名单全不全
// 不需要 DSH 在跑，所以每次回归都能跑

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { collectDshToolNames as collectDshToolNamesShared } from './dsh-tool-names.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRESETS_DIR = path.join(ROOT, 'dsh', 'agent-presets');

// 仿真模式用的 preset，不允许有本地执行能力
const SIMULATION_PRESETS = ['qq-chat', 'qq-chat-v2'];

// 封闭 agent 的 preset：按设计允许完整本地工具
const CLOSED_AGENT_PRESETS = ['standard'];

// 本地执行工具清单，一个都不能漏
const LOCAL_EXECUTION_TOOLS = [
  'pwsh', 'bash',
  'read', 'read_image', 'write', 'edit', 'apply_patch', 'str_replace_editor',
  'glob', 'grep',
  'load_workspace_dependencies',
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  'cordis_inspect_list', 'cordis_inspect_query',
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
  // 0.2.0 新增的对账名字
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  // 0.2.2 对账：调度工具的改名
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  // 0.2.1 新增：工作目录和终端类工具
  // terminal 一族就是 shell，session 类能读别的会话
  'working_directory',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'plugin_market', 'create_worktree', 'wait_agent',
  // 可选组合包才装的名字：装上就要挡，所以还在名单
  // 对账时按「可选项」处理，见下面的清单
  'subagent_codex', 'subagent_claude_code',
];

// Codex/Claude Code 改成按需安装，扫不到不算拼错
const OPTIONAL_BUNDLE_TOOLS = new Set(['subagent_codex', 'subagent_claude_code']);

// 工具名在不在：用统一抽取器，抓拼错的假名
function collectDshToolNames() {
  if (process.env.QQ_BRIDGE_TEST_LIVE === '0') {
    console.log('  ⏭  离线套件不枚举实机 DSH 工具包；升级后请单独运行 npm run scan:tool-names');
    return null;
  }
  let shared;
  try {
    shared = collectDshToolNamesShared();
  } catch (err) {
    // 没装 DSH 不算失败，是前提不满足，直接跳过
    // 装了 DSH 的机器仍会真跑这条断言
    // 跳过时会打印原因，不会假装通过
    if (err?.code === 'DSH_MODULES_NOT_FOUND') {
      console.log('  ⏭  ' + String(err.message).split('\n')[0]);
      return null;
    }
    throw err;
  }
  const { names } = shared;
  return names.size === 0 ? null : new Set(names.keys());
}
// 不含本地执行的意思、允许出现的名字
const DEV_TOOL_PREFIX = /^dev_/;

// 允许出现的 MCP 前缀（QQ 动作面）
const EXPECTED_SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
];

// 读一个 preset 的配置文件内容
function readPreset(id) {
  const dir = path.join(PRESETS_DIR, id);
  assert.ok(fs.existsSync(dir), `preset 目录存在：${id}`);
  const cordis = path.join(dir, 'agent.cordis.yml');
  assert.ok(fs.existsSync(cordis), `preset 有 agent.cordis.yml：${id}`);
  return { dir, yml: fs.readFileSync(cordis, 'utf8'), cordis };
}

// ── 下面开始逐项检查 ──
test('模拟会话的 preset 都挂了工具守卫（否则 L7 没有任何载体）', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    assert.match(
      yml,
      /qq-tool-restrict/,
      `${id} 必须挂载 qq-tool-restrict（L7 的落点），否则本地工具会随全局层继承进来`,
    );
    // 源文件里写的是 preset 目录内的相对名
    // 装进 DSH 时由补丁脚本改写成能找到的名字
    // 这条断言只看源文件里有没有守卫行
    // 改写结果由 test-agent-preset-patches 钉住
    assert.match(yml, /\.\/qq-tool-restrict\.mjs/, `${id} 的守卫要指向本目录的 .mjs`);
  }
});

test('模拟会话的 preset 不得挂载 tool-web 的 search/fetch', () => {
  for (const id of SIMULATION_PRESETS) {
    const { yml } = readPreset(id);
    const webRow = /id:\s*tool-web[\s\S]{0,200}/.exec(yml);
    assert.ok(webRow, `${id} 应有 tool-web 条目`);
    assert.match(webRow[0], /search:\s*false/, `${id}: tool-web.search 必须为 false`);
    assert.match(webRow[0], /fetch:\s*false/, `${id}: tool-web.fetch 必须为 false`);
  }
});

test('守卫的 restrict 名单覆盖每一个已知本地执行工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    assert.ok(fs.existsSync(guardPath), `${id} 的守卫文件存在`);

    // 用假 tools 服务调真实守卫，看它发了什么限制请求
    const restricted = new Set();
    const fakeTools = {
      restrict({ deny }) { for (const n of deny ?? []) restricted.add(n); },
      guard(fn) { this._guard = fn; },
    };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    const violations = LOCAL_EXECUTION_TOOLS.filter((t) => !restricted.has(t));
    assert.deepEqual(
      violations, [],
      `${id}: 以下本地执行工具未出现在 restrict 名单里，会留在模型的工具清单中：`
      + `${violations.join(', ')}。注册期隐藏失败 ⇒ §5.2 的 L7 断言不成立。`,
    );

    // 执行期白名单也要拒绝它们，两道关卡都要在
    assert.equal(typeof fakeTools._guard, 'function', `${id}: 守卫注册了执行期白名单`);
    for (const tool of LOCAL_EXECUTION_TOOLS) {
      const verdict = fakeTools._guard({ name: tool });
      assert.ok(
        typeof verdict === 'string' && verdict.length > 0,
        `${id}: 本地工具 "${tool}" 必须在执行期被拒绝，实际返回 ${JSON.stringify(verdict)}`,
      );
    }
  }
});

test('守卫导出的名单与本测试的清单一致（防两份名单各自漂移）', async () => {
  // 以前只复制名单前 19 个名字，多出的从没断言过
  // 现在直接导入守卫导出的数组，两边不会漂移
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    assert.ok(
      Array.isArray(mod.RESTRICTED_TOOL_NAMES) && mod.RESTRICTED_TOOL_NAMES.length > 0,
      `${id}: 守卫必须导出 RESTRICTED_TOOL_NAMES，供测试对账`,
    );
    const missing = LOCAL_EXECUTION_TOOLS.filter((t) => !mod.RESTRICTED_TOOL_NAMES.includes(t));
    assert.deepEqual(missing, [],
      `${id}: 守卫导出的名单缺少本地执行工具：${missing.join(', ')}`);
    // 反过来看：名单里不能混进允许的无害工具
    for (const allowed of ['ask_user_question', 'todo_write']) {
      assert.ok(!mod.RESTRICTED_TOOL_NAMES.includes(allowed),
        `${id}: ${allowed} 是无害模型侧工具，不应出现在 restrict 名单里（会与 SAFE_EXACT 自相矛盾）`);
    }
  }
});

test('守卫名单里的每个名字都是 DSH 真实注册的工具（防拼错假名静默失效）', async () => {
  // 必须测：名字拼错时限制会悄悄不生效
  // 守卫对每个名字单独 try/catch，只打日志
  // 初版就有五个假名，让整批限制悄悄少生效
  // 而当时测试全是绿的
  const dshNames = collectDshToolNames();
  if (dshNames === null) {
    console.log('  ⏭  跳过：未找到 DSH 工具包（设 DSH_TOOL_PACKAGES 指向 @deepseek-ai 目录即可启用）');
    return;
  }
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const mod = await import(pathToFileURL(path.join(dir, 'qq-tool-restrict.mjs')).href);
    const fabricated = mod.RESTRICTED_TOOL_NAMES
      .filter((n) => !DEV_TOOL_PREFIX.test(n) && !OPTIONAL_BUNDLE_TOOLS.has(n) && !dshNames.has(n));
    assert.deepEqual(fabricated, [],
      `${id}: 以下名字在 DSH 已安装的工具包里找不到 ⇒ restrict 会抛错并被吞掉，`
      + `限制静默失效：${fabricated.join(', ')}`);
  }
});

test('守卫仍放行 QQ MCP 命名空间与无害模型侧工具', async () => {
  for (const id of SIMULATION_PRESETS) {
    const { dir } = readPreset(id);
    const guardPath = path.join(dir, 'qq-tool-restrict.mjs');
    const fakeTools = { restrict() {}, guard(fn) { this._guard = fn; } };
    const mod = await import(pathToFileURL(guardPath).href);
    mod.apply({ tools: fakeTools });

    for (const prefix of EXPECTED_SAFE_PREFIXES) {
      const execution = { name: `${prefix}some_tool` };
      if (prefix === 'mcp__snowluma__') {
        execution.agent = { id: 'qqb-g-1' };
        execution.arguments = { key: 'group:1' };
      }
      assert.equal(
        fakeTools._guard(execution), undefined,
        `${id}: MCP 前缀 ${prefix} 应放行`,
      );
    }
    for (const name of ['ask_user_question', 'todo_write']) {
      assert.equal(fakeTools._guard({ name }), undefined, `${id}: ${name} 应放行`);
    }
    // 不认识的工具名必须一律拒绝
    for (const name of ['', null, undefined, 'mcp__unknown__x', 'totally_new_tool']) {
      assert.ok(
        typeof fakeTools._guard({ name }) === 'string',
        `${id}: 未知工具 ${JSON.stringify(name)} 必须被拒绝（fail-closed）`,
      );
    }
  }
});

test('封闭 agent 的预设在创建后必须与仿真 preset 明确区分', () => {
  // standard 是 DSH 自带预设，故意拥有完整本地工具
  // 它的守卫只管 QQ 动作，不管本地工具权限
    // 这条断言初版永远为真：预设不存在就直接跳过
  // 永远不会失败的测试等于没有
  // 现在改为显式记录「还没创建」，创建后就真断言
  const present = CLOSED_AGENT_PRESETS.filter((id) => fs.existsSync(path.join(PRESETS_DIR, id)));
  if (present.length === 0) {
    // 不是失败，但要让人看见这条闸门还没覆盖到
    console.log('  ⏭  standard 是 DSH 内置 preset，不在仓库预设目录；此项覆盖暂为空，不是通过。');
    return;
  }
  for (const id of present) {
    const yml = fs.readFileSync(path.join(PRESETS_DIR, id, 'agent.cordis.yml'), 'utf8');
    assert.match(yml, /qq-tool-restrict/, `${id} 也应挂守卫（用于 QQ 动作可见性）`);
    // 和仿真 preset 的关键区别：封闭 agent 必须能拿本地工具
    // 它的守卫不能把本地执行工具写进限制名单
    const guard = fs.readFileSync(path.join(PRESETS_DIR, id, 'qq-tool-restrict.mjs'), 'utf8');
    for (const tool of ['pwsh', 'read', 'write']) {
      assert.ok(
        !new RegExp(`['"]${tool}['"]`).test(guard),
        `${id}: 封闭 agent 需要本地工具，守卫不应把 "${tool}" 列入 restrict`,
      );
    }
  }
});
