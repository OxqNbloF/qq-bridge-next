// 验证桥接配 DSH 0.2.2：仓库侧、部署侧、运行侧
// 会建探测会话并切模型；用完停掉并归档，不动全局默认
// 没有 DSH 在跑时，运行侧检查会明确记为跳过
// 用法：node scripts/verify-dsh-022-adaptation.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dshHome, dshModulesDir } from './dsh-modules.mjs';
import { discoverDshSessionCookie, NodeApiClient, unwrap } from '../src/dsh-client.js';
import { cleanupProbeSession, createProbeDirectory, probeMux, probeTurn } from './adaptation-probe-helpers.mjs';

const ROOT = process.cwd();
const DSH_MODULES = dshModulesDir();
const DSH_HOME = dshHome();
const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

let pass = 0, fail = 0;
const results = [];
// 记一项检查结果，失败就累计一次
function check(label, cond, extra = '') {
  if (cond) { pass += 1; results.push(`✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; results.push(`❌ ${label}${extra ? ' — ' + extra : ''}`); }
  return cond;
}
// 环境不允许断言时明确记跳过，不假装通过
function skip(label, why) {
  results.push(`⏭ ${label} — ${why}`);
  return false;
}

// ── 1. 仓库侧：preset 的人设配置 ──
const persona = await import(pathToFileURL(path.join(DSH_MODULES, '@deepseek-ai/dsh-persona/lib/index.js')).href);
const YAML = await import(pathToFileURL(path.join(DSH_MODULES, 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;

let oldRejected = false;
try { persona.Config({ text: 'x' }); } catch { oldRejected = true; }
check('dsh-persona 仍拒绝旧字段 text（故障前提成立）', oldRejected);

// 0.2.1 起只注册 provider 和 model 两个提示词变量
const DSH_PROMPT_VARIABLES = new Set(['provider', 'model']);

for (const p of ['qq-chat', 'qq-chat-v2']) {
  const f = path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml');
  const row = yaml.load(fs.readFileSync(f, 'utf8')).find((r) => r.id === 'persona');
  let schemaOk = false;
  try { persona.Config(row.config); schemaOk = true; } catch {}
  check(`preset ${p}: persona.config 通过 DSH schema`, schemaOk);
  // 变量名写错会直接报错，模型一次都不跑
  // 所以要钉住只用 DSH 真注册过的变量
  const usedVars = [...new Set([...JSON.stringify(row.config).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]))];
  const unknownVars = usedVars.filter((v) => !DSH_PROMPT_VARIABLES.has(v));
  check(`preset ${p}: 只引用 DSH 已注册的提示词变量`,
    unknownVars.length === 0 && /\{\{model\}\}/.test(row.config.prefix),
    unknownVars.length ? `未知变量: ${unknownVars.join(', ')}` : usedVars.join(', '));
}

// ── 2. 部署侧：DSH 0.1.7 的 preset 装法 ──
// 0.1.7 起 preset 不再从 ~/.dsh 目录读
// 而是 bundle 补丁里插入的一行 loader
// 所以这里核对三件事：
// ① 补丁和仓库源文件一致（生成器 --check）
// ② 这个包已登记进 profile，靠链接找到
// ③ 守卫只有一份，不认识的工具名一律拒绝
const norm = (s) => s.replace(/\r\n/g, '\n');
const presetPatches = await import(pathToFileURL(path.join(ROOT, 'scripts/build-agent-preset-patches.mjs')).href);
for (const { file, changed } of presetPatches.buildPatches({ check: true, log: () => {} })) {
  check(`${path.relative(ROOT, file)} 与仓库源一致（未漂移）`, !changed);
}
for (const p of ['qq-chat', 'qq-chat-v2']) {
  const doc = yaml.load(fs.readFileSync(presetPatches.patchFileFor(p), 'utf8'));
  const row = doc?.[0]?.insert?.[0];
  check(`patch ${p}: 是 @deepseek-ai/dsh-agent-preset 行`, row?.name === '@deepseek-ai/dsh-agent-preset');
  check(`patch ${p}: config.id = ${p}`, row?.config?.id === p);
  const source = yaml.load(fs.readFileSync(path.join(ROOT, 'dsh/agent-presets', p, 'agent.cordis.yml'), 'utf8'));
  const srcPersona = source.find((r) => r.id === 'persona');
  const patchPersona = (row?.config?.plugins ?? []).find((r) => r.id === 'persona');
  check(`patch ${p}: persona.prefix 与源逐字一致`, norm(srcPersona?.config?.prefix ?? '') === norm(patchPersona?.config?.prefix ?? ''));
  const guardRow = (row?.config?.plugins ?? []).find((r) => r.id === 'qq-tool-restrict');
  check(`patch ${p}: 守卫行用 Profile 目录可解析的裸说明符`, guardRow?.name === presetPatches.GUARD_SPECIFIER);
}

// 守卫要 fail-closed：非法工具名必须拒绝而不是放行
const canonicalGuardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = fs.readFileSync(canonicalGuardPath, 'utf8');
// 只看可执行代码：注释里也写了旧工具名做说明
// 直接扫原文会把说明误判成「还在用旧名」
// 必须先剥块注释，再剥行注释
// 剥行注释要按换行切，CRLF 下行尾的 \r 会让匹配失效
const guardCode = guard
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('守卫：非法工具名 fail-closed（不接受裸 return 放行）', !/typeof name !== 'string'[^\n]*\)\s*return\s*$/m.test(guardCode));
check('守卫：不额外放行 web_search/web_fetch', !/'(?:web_search|web_fetch)'/.test(guardCode));
check('守卫：拒绝 0.1.7 已删除的 cordis 旧工具名（避免静默失效）', !/cordis_(?:define|undefine|run|stop)/.test(guardCode));

// 0.2.0 工具面重新对账的结果，扫描器和守卫要一致
// 三类必须覆盖：MCP 资源工具、再开子 agent、装载权
// ① 全局默认启用、仿真会话会继承的 MCP 资源工具
// ② 再开子 agent / 执行外部代码
// ③ 插件装载权（等于任意代码执行）和自动调度
const GUARD_020_NAMES = [
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'plugin_manager',
  // 0.2.2 起这两个调度工具改名，旧名已不注册
  'schedule_create', 'schedule_list',
];
// 0.2.1 对账新增的名字
const GUARD_021_NAMES = [
  // dsh-base 0.2.1 默认挂载，全局都会继承
  'working_directory',
  // 终端工具就是 shell
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // 会话查询能读别的会话正文
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  // 装载权、起进程、团队相关的工具
  'plugin_market', 'create_worktree', 'wait_agent',
];
// 0.2.2 新增名字，同时删掉改名前的两个旧名
const GUARD_022_NAMES = [
  // 文件工具新增：一次多文件增删改移
  'apply_patch',
  // 调度工具改名后的新名字
  'schedule_view', 'schedule_edit',
];
const guardMod = await import(pathToFileURL(canonicalGuardPath).href);
const guardNames = new Set(guardMod.RESTRICTED_TOOL_NAMES ?? []);
const optionalNames = new Set(guardMod.OPTIONAL_BUNDLE_TOOL_NAMES ?? []);
const missingFromGuard = GUARD_020_NAMES.filter((n) => !guardNames.has(n));
check('守卫已覆盖 0.2.0 新增的危险工具名', missingFromGuard.length === 0, missingFromGuard.join(', ') || `${guardNames.size} 个名字`);
const missingFromGuard021 = GUARD_021_NAMES.filter((n) => !guardNames.has(n));
check('守卫已覆盖 0.2.1 新增的危险工具名', missingFromGuard021.length === 0, missingFromGuard021.join(', ') || `${GUARD_021_NAMES.length} 个名字`);
const missingFromGuard022 = GUARD_022_NAMES.filter((n) => !guardNames.has(n));
check('守卫已覆盖 0.2.2 新增的危险工具名', missingFromGuard022.length === 0, missingFromGuard022.join(', ') || `${GUARD_022_NAMES.length} 个名字`);

// 名单里每个名字都必须是 DSH 真注册过的工具
// 拼错名字会被悄悄吞掉，等于没限制
// 扫描器和 test-preset-local-tools 共用一份抽取实现
// 所以这里直接复用，不会出现两套口径
const { collectDshToolNames } = await import(pathToFileURL(path.join(ROOT, 'scripts/dsh-tool-names.mjs')).href);
const scanned = collectDshToolNames();
if (scanned.names.size === 0) {
  skip('守卫名单与 DSH 真实工具名对账', '未扫到任何 DSH 包（DSH 未安装？）');
} else {
  const fabricated = [...guardNames]
    .filter((n) => !n.startsWith('dev_') && !optionalNames.has(n) && !scanned.names.has(n));
  check('守卫名单无拼错的假名（restrict 不会静默失效）', fabricated.length === 0, fabricated.join(', ') || `扫过 ${scanned.packages.length} 个包`);
}

const patch = fs.readFileSync(path.join(DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8');
const patchDoc = yaml.load(patch);
const mcpIds = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert.map((x) => x.id));
check('profile patch 含 3 个 MCP 且无重复', mcpIds.length === 3 && new Set(mcpIds).size === 3, mcpIds.join(', '));
const snowlumaEntry = patchDoc.filter((e) => e?.insert).flatMap((e) => e.insert).find((x) => x.id === 'mcp-snowluma');
check('mcp-snowluma 带 toolCallTimeoutMs=725000', snowlumaEntry?.config?.toolCallTimeoutMs === 725000);
check('mcp 路径指向本仓库', mcpIds.every((id) => {
  const e = patchDoc.filter((x) => x?.insert).flatMap((x) => x.insert).find((y) => y.id === id);
  return String(e.config.args[0]).includes('qq-bridge');
}));

const pkg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'profiles/web/package.json'), 'utf8'));
check('profile bundles 含 qq-mode-console', pkg.dsh.profile.bundles.includes('qq-mode-console'));
check('qq-mode-console link 依赖已注册', String(pkg.dependencies['qq-mode-console'] ?? '').startsWith('link:'));
check('qq-mode-console 已 link 进 node_modules', fs.existsSync(path.join(DSH_HOME, 'profiles/web/node_modules/qq-mode-console')));

// ── 3. 仓库配置：模型 ──
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
check('config.json dsh.model = deepseek-flash', cfg.dsh?.model === 'deepseek-flash', `当前 ${cfg.dsh?.model}`);
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8'); // 组装层（原来的 bridge.js 主体）
// 只看可执行代码，忽略注释
// 按换行切行，CRLF 下行尾的 \r 会让剥注释失效
// 否则注释剥不掉，会误报
const stripComments = (src) => src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const bridgeCode = stripComments(bridgeSrc);
check('bridge.js 可执行代码无 deepseek-v4-flash-vision-exp 残留', !bridgeCode.includes('deepseek-v4-flash-vision-exp'));
check('bridge.js 可执行代码无 router-standard 残留', !bridgeCode.includes('router-standard'));
// 安装脚本一度漏改，还写着已下线的 preset 名
const setupCode = stripComments(fs.readFileSync(path.join(ROOT, 'scripts/setup-dsh.mjs'), 'utf8'));
check('setup-dsh.mjs 可执行代码无 router-standard 残留', !setupCode.includes('router-standard'));
check('setup-dsh.mjs 新装默认 closedAgentPreset 留空（交给 DSH 默认 preset）', /closedAgentPreset:\s*''/.test(setupCode));
check('bridge.js 默认模型为 deepseek-flash', /model:\s*'deepseek-flash'/.test(bridgeCode));
check('bridge.js 不再有「无参创建会话」兜底', !/sessions\.create\(\{\}\)/.test(bridgeCode));
check('bridge.js 含 preset 清单/默认 preset 解析', bridgeSrc.includes('resolvePresetName') && bridgeSrc.includes('refreshPresetList'));

// 安全防线：群聊和仿真会话在 preset 缺失时必须拒绝
// 旧实现会悄悄退回 DSH 默认 preset（带本地工具）
// 那等于把本地工具暴露给 QQ 群
check('preset 解析带 strict 开关', /resolvePresetName\(name, \{ strict = false \} = \{\}\)/.test(bridgeCode));
check('非 closed-agent 模式以 strict 解析 preset', /resolvePresetName\(wanted, \{ strict: true \}\)/.test(bridgeCode));
check('群聊模式缺少 preset 时拒绝建会话（fail-closed）', /strictPreset && !preset/.test(bridgeCode));
check('群聊模式不再重试「无 preset」建会话', /strictPreset \? \[true\] : \[true, false\]/.test(bridgeCode));

// ── 3b. 版本身份要一致 ──
// 曾出现过 package.json 和锁文件版本号对不上
// 三个 MCP server 的版本号也停在旧值
// 所以这里钉住：对外自称的版本必须等于 package.json
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pluginPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/qq-mode-console/package.json'), 'utf8'));
const presetsPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/qq-agent-presets/package.json'), 'utf8'));
check('package-lock.json 顶层 version 与 package.json 一致', lockJson.version === pkgJson.version, `lock=${lockJson.version} pkg=${pkgJson.version}`);
check('package-lock.json packages[""] version 与 package.json 一致', lockJson.packages?.['']?.version === pkgJson.version, `lock=${lockJson.packages?.['']?.version}`);
check('qq-mode-console 插件版本与主包一致', pluginPkg.version === pkgJson.version, `plugin=${pluginPkg.version}`);
check('qq-agent-presets 插件版本与主包一致', presetsPkg.version === pkgJson.version, `plugin=${presetsPkg.version}`);
for (const f of ['src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js']) {
  const m = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check(`${f} 的 MCP serverInfo.version 与主包一致`, m?.[1] === pkgJson.version, `声明=${m?.[1]} 主包=${pkgJson.version}`);
}

// ── 4. 语法检查 ──
// 受限环境里起子进程会失败，那是环境限制不是语法错
// 这种情况明确记跳过，免得假失败淹掉真失败
const SYNTAX_FILES = ['src/bridge.js', 'src/app.js', 'src/dsh-client.js', 'src/mcp-snowluma-safe.js', 'src/mcp-host-server.js', 'src/mcp-web-search-safe.js', 'src/slang-learner.js', 'src/self-test.js', 'scripts/setup-dsh.mjs'];
{
  const probe = spawnSync(process.execPath, ['--check', path.join(ROOT, 'src/dsh-client.js')], { encoding: 'utf8' });
  if (probe.error?.code === 'EPERM') {
    skip(`${SYNTAX_FILES.length} 个文件的语法检查`, '本环境不允许 spawn 子进程（EPERM）；请在普通终端重跑');
  } else {
    for (const f of SYNTAX_FILES) {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
      check(`${f} 语法正确`, r.status === 0, (r.stderr || '').split('\n')[0]);
    }
  }
}

// ── 5. 运行中的 DSH 0.2.2 ──
console.warn('活体验证会创建并归档探测会话、写回 qq-mode，消耗一次模型回合，'
  + '并将 DSH 全局默认模型改为 deepseek-official/deepseek-flash/max；不会自动恢复默认模型。');
// 鉴权和桥接走同一条路：用本机密钥离线签发 Cookie
// 旧的抓启动令牌办法在 0.1.7 已经不能用了
// 启动令牌只存在内存里，不存到硬盘
// guard 退役后也没人再把输出重定向到那个日志目录
// 日志里是上一个进程的旧令牌，用了只会 401
const cookie = discoverDshSessionCookie(BASE);
check('本机签名密钥 → 铸造会话 Cookie 成功', Boolean(cookie), cookie ? `${cookie.length} 字节` : '读不到 browser-session 密钥');
// 调一次 DSH 接口
async function rpc(e, a) {
  const r = await fetch(`${BASE}/api/${e}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'v' + Math.random().toString(36).slice(2, 8), method: e, payload: { args: a } }) });
  return (await r.json()).result;
}
const st = await rpc('settings/describe', {});
check('settings/describe 可用', st.ok === true);
const dm = st.value?.namespaces?.find((n) => n.ns === 'agent-default-model');
check('DSH 全局默认模型 = deepseek-flash', dm?.value?.model === 'deepseek-flash', `当前 ${dm?.value?.model}`);
const ap = await rpc('agentPresets/list', {});
const presetIds = ap.value?.presets?.map((p) => p.id) ?? [];
check('agentPresets/list 含 qq-chat 与 qq-chat-v2', presetIds.includes('qq-chat') && presetIds.includes('qq-chat-v2'), presetIds.join(', '));
// 0.1.7 起设置命名空间改名，用户默认值也不在 describe 里
// 部署默认由注册表行的 config.default 决定
// 桥接留空时用的正是它，所以要确认注册表已装载
// 并且 standard 预设存在
const registryNs = st.value?.namespaces?.find((n) => n.ns === 'agent-preset-registry');
check('preset 注册表命名空间已装载', registryNs !== undefined, st.value?.namespaces?.map((n) => n.ns).filter((n) => n.includes('preset')).join(', '));
check('closed-agent 兜底所需的 standard 预设可用', presetIds.includes('standard'), presetIds.join(', '));

// ── 5a. qq-mode 设置命名空间 ──
// 0.2.0 起命名空间不用注册，由 loader 行推导
// 这条断言钉住模式能写进 DSH 设置
const qqMode = st.value?.namespaces?.find((n) => n.ns === 'qq-mode');
check('settings/describe 列出 qq-mode 命名空间', qqMode !== undefined, st.value?.namespaces?.map((n) => n.ns).length + ' 个命名空间');
if (qqMode) {
  // 用户层可能已更新而运行时值还没热更新，别写回旧模式
  const currentMode = Object.hasOwn(qqMode.user ?? {}, 'mode') ? qqMode.user.mode : qqMode.value?.mode;
  check('qq-mode 带 mode 字段', typeof currentMode === 'string', JSON.stringify({ mode: currentMode }));
  check('qq-mode 带 revision（写入所需）', Number.isInteger(qqMode.revision), String(qqMode.revision));
  // 这个接口的参数是平铺的 { ns, patch, expectedRevision }
  // 不是包在 request 里，传错会被网关拒绝
  const writeBack = await rpc('settings/update', {
    ns: 'qq-mode', patch: { mode: currentMode }, expectedRevision: qqMode.revision,
  });
  check(
    'settings/update 可写 qq-mode（参数为平铺多参数，非 request 包装）',
    writeBack.ok === true,
    writeBack.ok ? `mode=${writeBack.value?.value?.mode}` : `${writeBack.error?.code}: ${writeBack.error?.message}`,
  );
}

// ── 5b. session/projections：读队列的主路径 ──
const probeDir = createProbeDirectory();
const api = new NodeApiClient(BASE, undefined, {});

let probeSessionId = null;
try {
  await api.ensureAuth();
  const created = unwrap(await api.sessions.create({ cwd: probeDir, agentPreset: 'qq-chat-v2' }), 'session.create');
  probeSessionId = created.sessionId;
  check('session/create 挂 qq-chat-v2 preset 成功', typeof probeSessionId === 'string' && probeSessionId.length > 0, probeSessionId);
  unwrap(await api.sessions.selectModel({
    sessionId: probeSessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max'
  }), 'session.selectModel');
  check('session/selectModel(deepseek-flash) 被接受', true);

  const projections = await api.callUnary('session/projections', { sessionId: probeSessionId });
  check('session/projections 一元 RPC 可用', projections.result?.ok === true,
    projections.result?.ok ? '' : `${projections.result?.error?.code}: ${projections.result?.error?.message}`);
  const values = projections.result?.value?.values;
  check('session/projections 返回 values.inbox（next-turn / next-step）',
    values?.inbox !== undefined && Array.isArray(values.inbox['next-turn']) && Array.isArray(values.inbox['next-step']),
    Object.keys(values ?? {}).slice(0, 6).join(','));

  // ── 5c. control baseline 的形状 ──
  const url = new URL('/api/remote.mux', BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const baseline = await probeMux({
    url, cookie: api.cookie, endpoint: 'session/control', args: {}, timeoutMs: 15_000,
    onItem: (value) => value?.type === 'baseline' ? value : undefined,
  }).catch((error) => { check('session/control 开场 baseline 形状', false, error.message); return null; });
  if (baseline) {
    const bv = baseline.value;
    check('control baseline 是 value.projections（0.2.0 形状）',
      bv !== null && typeof bv?.projections === 'object' && bv.projections !== null);
    check('control baseline 不再有 value.queues（0.1.7 形状已废弃）',
      bv !== null && !Object.hasOwn(bv ?? {}, 'queues'));
    const sample = bv?.projections?.[probeSessionId]?.values;
    check('baseline 里探测会话的投影带 inbox', sample?.inbox !== undefined,
      Object.keys(sample ?? {}).slice(0, 6).join(','));
  }

  // ── 5d. 核心回归：退役会话不再报结构错 ──
  // 旧代码读 value.queues，形状一变每次退役都抛错
  // 队列清不掉、旧任务继续跑，日志里只有一行警告
  let retireError = null;
  let retired = null;
  try { retired = await api.stopSessionWork(probeSessionId); }
  catch (error) { retireError = error; }
  check('stopSessionWork 在真实会话上成功返回（不再抛 baseline 结构错）',
    retireError === null, retireError?.message ?? `removed=${retired?.removed}`);

  // ── 5e. $events ready 帧 ──
  const readyFrame = await probeMux({
    url, cookie: api.cookie, endpoint: '$events', args: {}, timeoutMs: 10_000,
    onItem: (value) => value?.type === 'ready' ? value : undefined,
  }).catch(() => null);
  check('$events 下发 ready 帧并带 clientId',
    typeof readyFrame?.clientId === 'string' && readyFrame.clientId.length > 0,
    readyFrame ? `${String(readyFrame.clientId).slice(0, 8)}…` : '未收到 ready 帧');

  // ── 5f. session/modelCatalog 形状 ──
  const catalog = await api.callUnary('session/modelCatalog', {});
  check('session/modelCatalog 可用且给出模型分组', catalog.result?.ok === true && Array.isArray(catalog.result?.value?.groups),
    catalog.result?.ok ? `${catalog.result.value.groups.length} 组` : `${catalog.result?.error?.code}`);

  // ── 5g. 真跑一个回合，看提示词变量认不认得 ──
  // 0.2.1 把 cwd 从提示词变量里删掉了，只剩两个
  // 变量不认识会直接报错，回合开局就失败
  // QQ 上表现就是完全不回
  let turnSessionId = null;
  try {
    const turnSession = unwrap(await api.sessions.create({ cwd: probeDir, agentPreset: 'qq-chat-v2' }), 'session.create(turn)');
    turnSessionId = turnSession.sessionId;
    unwrap(await api.sessions.selectModel({ sessionId: turnSessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }), 'session.selectModel(turn)');
    const turn = await probeTurn(api, turnSessionId, { url, cookie: api.cookie, timeoutMs: 90_000 });
    const kind = typeof turn.reason === 'string' ? turn.reason : turn.reason?.kind;
    const why = turn.reason?.error?.message;
    check('preset 真跑一回合：提示词变量可解析且正常结束',
      kind === 'completed' && turn.text.length > 0,
      kind === 'completed' ? `text=${JSON.stringify(turn.text.slice(0, 24))}` : `${kind ?? 'no turn/end'}${why ? `: ${why}` : ''}`);
  } catch (error) {
    check('preset 真跑一回合：提示词变量可解析且正常结束', false, error?.message ?? String(error));
  } finally {
    if (turnSessionId) {
      const errors = await cleanupProbeSession(api, turnSessionId);
      check('真实回合探测会话已停止并归档', errors.length === 0, errors.join('; '));
    }
  }
} catch (error) {
  check('DSH 实测段无未捕获异常', false, error?.message ?? String(error));
} finally {
  if (probeSessionId) {
    const errors = await cleanupProbeSession(api, probeSessionId);
    check('协议探测会话已停止并归档', errors.length === 0, errors.join('; '));
  }
  try { fs.rmSync(probeDir, { recursive: true, force: true }); }
  catch (error) { check('临时探测目录已删除', false, error?.message ?? String(error)); }
}

// 旧式点号地址应返回纯文本 404，证明协议是斜杠式
const dotRes = await fetch(`${BASE}/api/session.list`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'v-dot', method: 'session.list', payload: { args: { _request: {} } } }),
});
const dotBody = await dotRes.text();
check('点号 endpoint /api/session.list 不可用（旧协议已废弃）', dotRes.status === 404 && /not found/i.test(dotBody), `HTTP ${dotRes.status}`);

// ── 汇总 ──
console.log(results.join('\n'));
console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
// 用 exitCode 而不是 exit()，否则 socket 还在关就被强拆
// Windows 上会触发 libuv 断言，退出码非 0
// 结果是「断言全过但退出码非 0」，CI 会误判失败
process.exitCode = fail === 0 ? 0 : 1;
