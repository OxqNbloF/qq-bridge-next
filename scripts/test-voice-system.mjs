// 语音系统整体检查：把入口、需要的东西、开关、文档列全
// 这是自动检查版，免得只靠人翻文件漏项
import fs from 'node:fs';
import { readBridgeSource } from './bridge-source.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 独立发语音工具在仓库上一级，找不到就跳过
import { hasVoiceTool, skipVoiceTool, voiceToolDir, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 独立工具入口在上一级 voice-tool/，共用内核在本仓库 src/
let pass = 0;
let fail = 0;
// 检查一项，通过就打勾，失败就记一笔
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
// 读仓库里的一个文件
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// 检查仓库里有没有这个文件
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
// 工具不在本仓库时这两个函数返回 null，调用前要先判断
// 免得文件不存在被当成检查失败，那其实是跳过
const readTool = (rel) => (hasVoiceTool() ? fs.readFileSync(voiceToolPath(rel), 'utf8') : null);
// 检查独立工具目录里有没有这个文件
const existsTool = (rel) => (hasVoiceTool() ? fs.existsSync(voiceToolPath(rel)) : null);

console.log('## 文件清单（独立工具 = 上一级 voice-tool/，共享内核 = 本仓库 src/）');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-tool/ 的文件清单（voice-gui.mjs / voice-cli.mjs / public/voice.html / 发语音.cmd / config.example.json / config.json / README.md）');
} else {
  for (const rel of ['voice-gui.mjs', 'voice-cli.mjs', 'public/voice.html', '发语音.cmd',
    'config.example.json', 'config.json', 'README.md']) {
    ok(existsTool(rel), `voice-tool/${rel}`);
  }
}
// 这个启动器在仓库上一级，和 voice-tool/ 并排
{
  const rel = path.join('..', '发语音-图形界面.cmd');
  if (fs.existsSync(path.join(ROOT, rel))) ok(true, rel);
  else skipVoiceTool(`上级启动器 ${rel}`);
}
// 这两条和上面重复，但换个角度再确认一次
for (const [rel, toolRel] of [['..\\voice-tool\\voice-gui.mjs', 'voice-gui.mjs'],
  ['..\\voice-tool\\voice-cli.mjs', 'voice-cli.mjs']]) {
  if (hasVoiceTool()) ok(fs.existsSync(voiceToolPath(toolRel)), rel);
  else skipVoiceTool(`入口 ${rel}`);
}
for (const rel of ['src/voice-core.js', 'src/send-voice-lib.js',
  'scripts/send-voice.mjs', 'scripts/test-voice.mjs', 'scripts/test-voice-gui.mjs',
  'scripts/test-encoding.mjs', 'scripts/test-console-static.mjs']) {
  ok(exists(rel), rel);
}

console.log('## 模块依赖解析');
{
  // 每个入口都能单独加载，路径和引用都在
  const checks = [
    ['src/voice-core.js', 'voice-core'],
    ['src/send-voice-lib.js', 'send-voice-lib（薄转发）'],
  ];
  for (const [rel, label] of checks) {
    try {
      const m = await import(pathToFileURL(path.join(ROOT, rel)).href);
      ok(Object.keys(m).length > 5, `${label} 可 import`, `${Object.keys(m).length} 个导出`);
    } catch (e) { ok(false, `${label} 可 import`, e.message); }
  }
  const core = await import(pathToFileURL(path.join(ROOT, 'src/voice-core.js')).href);
  const shim = await import(pathToFileURL(path.join(ROOT, 'src/send-voice-lib.js')).href);
  const coreKeys = Object.keys(core).sort();
  const shimKeys = Object.keys(shim).sort();
  ok(coreKeys.every((k) => shimKeys.includes(k)), 'shim 覆盖 voice-core 全部导出',
    shimKeys.length >= coreKeys.length ? `${shimKeys.length} 个` : `core=${coreKeys.length} shim=${shimKeys.length}`);
  // 转发文件只能转发，不能自己实现一份
  const shimSrc = read('src/send-voice-lib.js');
  ok(/export\s*\{[\s\S]*\}\s*from\s*'\.\/voice-core\.js'/.test(shimSrc), 'send-voice-lib.js 是纯转发（无独立实现）');
  ok(!/function\s+\w+\s*\(/.test(shimSrc), 'send-voice-lib.js 里没有函数实现');
}

console.log('## 独立工具：交互菜单不许自我递归（P1，曾让工具完全不可用）');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-cli.mjs 的交互菜单断言（q() 是否自我递归、ask() 形参名）');
} else {
  // 由来：一次批量替换把调用改成了包装函数自己
  // 结果双击启动的第一个提示就崩了
  // 这种自己调用自己的笔误，静态查最省事
  const cli = readTool('voice-cli.mjs');
  ok(/const a = await ask\(rl, prompt\)/.test(cli), 'q() 内部调用 ask(rl, …) 而不是自己');
  ok(!/await q\(prompt\)/.test(cli.replace(/^.*早先.*$/m, '')), '没有残留的 await q(prompt) 自我调用');
  // 包装函数的参数也不能叫 q，免得再被替换错
  ok(/function ask\(rl, question\)/.test(cli), 'ask() 的形参不叫 q');
}

console.log('## 各入口 import 的符号都真实存在');
{
  const core = await import(pathToFileURL(path.join(ROOT, 'src/voice-core.js')).href);
  // 桥接侧入口用仓库相对路径，独立工具入口在 voice-tool/
  const entries = [
    { base: voiceToolDir(), rel: 'voice-gui.mjs', tool: true },
    { base: voiceToolDir(), rel: 'voice-cli.mjs', tool: true },
    { base: ROOT, rel: 'scripts/send-voice.mjs', tool: false },
    { base: ROOT, rel: 'src/app.js', tool: false }
  ];
  for (const { base, rel, tool } of entries) {
    const file = path.join(base, rel);
    // 工具不在本仓库时这些入口本来就不存在，跳过
    if (!fs.existsSync(file)) { skipVoiceTool(`入口 ${rel}（在仓库上一级的 voice-tool/ 里）`); continue; }
    const src = fs.readFileSync(file, 'utf8');
    const blocks = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']*(?:voice-core|send-voice-lib)[^']*)'/g)];
    if (!blocks.length) { ok(true, `${rel} 不直接依赖语音共享库`); continue; }
    // 独立工具必须用 qq-bridge 的共享内核，不能自己复制
    if (tool) {
      ok(blocks.every((m) => m[2].includes('qq-bridge/src/')), `${rel} 从 qq-bridge/src/ 引共享内核（不复制实现）`);
    }
    const names = blocks.flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
    const missing = names.filter((n) => !(n in core));
    ok(missing.length === 0, `${rel} 的共享库符号都存在`, missing.length ? `缺：${missing.join(', ')}` : `${names.length} 个`);
  }
}

console.log('## qq-bridge 语音系统：路由与开关');
{
  const bridge = readBridgeSource();
  for (const route of ["'/api/voice/send'", "'/api/send/voice'", "'/api/socialV2/send-voice'", "'/api/voice/list'", "'/api/socialV2/voices'"]) {
    ok(bridge.includes(route), `路由 ${route}`);
  }
  ok(/v2ToolEnabled\('sendVoice'\)/.test(bridge), 'AI 路由受 tools.sendVoice 开关控制');
  ok(/voiceBudgetCheck/.test(bridge) && /voiceBudgetCommit/.test(bridge), '语音额度：检查与记账分离');
  ok(/assertOutboundAuditOk/.test(bridge), '语音文件名审计存在');
  ok(/verifyVoiceMessageSent/.test(bridge), '发送后回读校验存在');
  ok(/shouldBlockSilentReply\(key\)/.test(bridge), 'AI 语音尊重静默模式');
  ok(/allowAbsolutePath/.test(bridge), 'AI 绝对路径受配置约束');
  // 手动入口不该被 AI 开关挡住，不然自己也发不了
  const opSection = bridge.slice(bridge.indexOf("url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice'"), bridge.indexOf("'/api/socialV2/send-voice'"));
  ok(!/if \(!voice\.enabled\)/.test(opSection), '操作者通道不被 voice.enabled 挡住（默认关闭时仍可手动试发）');
  const agentStart = bridge.indexOf("url.pathname === '/api/socialV2/send-voice'");
  // 先找后面的路由，免得更早的白名单把路径切空
  const agentSection = bridge.slice(agentStart, bridge.indexOf("url.pathname === '/api/socialV2/send-sticker'", agentStart));
  ok(/if \(!voice\.enabled\)/.test(agentSection), 'AI 通道受 voice.enabled 挡住');
}

console.log('## qq-bridge 语音系统：MCP 工具与开关映射');
{
  const mcp = read('src/mcp-snowluma-safe.js');
  ok(mcp.includes("'qq_send_voice'"), '注册 qq_send_voice');
  ok(mcp.includes("'qq_list_voices'"), '注册 qq_list_voices');
  ok(/qq_send_voice: 'sendVoice'/.test(mcp) && /qq_list_voices: 'sendVoice'/.test(mcp), '两个工具都受 sendVoice 开关控制');
  ok(/voice\?\.enabled !== false/.test(mcp), '注册期也检查 voice.enabled（关闭时不注册，省 token）');
  const bridge = readBridgeSource();
  ok(/sendVoice: 'qq_send_voice \/ qq_list_voices'/.test(bridge), 'qq_get_prompt 的 toolMap 含语音工具');
  ok(/'sendVoice'\]/.test(bridge), 'config API 的 toolFlags 含 sendVoice');
  const ex = JSON.parse(read('config.example.json'));
  // 这一段查「出厂默认就该关」的约定
  // 依据是仓库里的 config.example.json，不看用户配置
  // 一、用户配置不入库，全新下载里没有，读了会崩
  // 二、AI 发语音是正常功能，用户开了测试不该变红
  // 测试不该因为用户正常用了功能而失败
  // 三、用户的配置文件带 BOM 时，直接读也会崩
  // 桥接自己有去 BOM 的读法，所以线上不受影响
  // 用户当前的值只提示，不判定对错
  ok(ex.socialV2?.tools?.sendVoice === false, 'config.example.json: tools.sendVoice=false（出厂默认关）');
  ok(ex.socialV2?.voice?.enabled === false, 'config.example.json: voice.enabled=false（出厂默认关）');
  try {
    const local = JSON.parse(read('config.json').replace(/^\uFEFF/, ''));
    console.log(`  ℹ  你本机的值（仅供参考，不参与判定）：tools.sendVoice=${local.socialV2?.tools?.sendVoice} / voice.enabled=${local.socialV2?.voice?.enabled}`);
  } catch {
    console.log('  ℹ  本机没有 config.json（不入库）—— 本段只查随仓库发布的出厂默认');
  }
}

console.log('## qq-bridge 语音系统：控制台与 preset');
{
  const html = read('src/features/console/web/console.html');
  ok(html.includes('data-v2-tool="sendVoice"'), '控制台有 sendVoice 工具开关');
  ok(html.includes('id="voiceList"') && html.includes('id="voiceSendBtn"'), '控制台有语音库调试面板');
  ok(/api\/voice\/list/.test(html) && /api\/voice\/send/.test(html), '面板调用操作者端点');
  const preset = read(path.join('dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'));
  ok(preset.includes('qq_send_voice') && preset.includes('qq_list_voices'), 'qq-chat-v2 人设描述语音能力');
  ok(/语音\*\*默认是关闭的\*\*/.test(preset), '人设说明默认关闭');
  // 守卫的正确实现只有一份，在 qq-agent-presets 包里
  // dsh 里那个文件只是转发一下
  ok(read(path.join('plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs')).includes("'mcp__snowluma__'"),
    'preset 白名单前缀放行语音工具');
}

console.log('## 文档');
{
  // docs/guides/VOICE.md 不入库，干净下载里没有
  // 缺文件就跳过，不能让整条检查崩掉
  const voiceDoc = path.join('docs', 'guides', 'VOICE.md');
  if (exists(voiceDoc)) {
    const voice = read(voiceDoc);
    for (const needle of ['图形界面', 'voice-gui.mjs', 'voice-cli.mjs', '默认是关的', '发语音-图形界面.cmd']) {
      ok(voice.includes(needle), 'docs/guides/VOICE.md 提到「' + needle + '」');
    }
  } else {
    console.log('  ⏭  docs/guides/VOICE.md 未入库（本地专属文档），跳过该文件的断言');
  }
}

console.log('## 独立工具的配置解析（env → voice-tool/config.json → ../qq-bridge/config.json → 默认值）');
if (!hasVoiceTool()) {
  skipVoiceTool('voice-cli.mjs / voice-gui.mjs 的配置解析断言（5 个环境变量、两个 config.json 的读取顺序、SnowLuma 默认路径、共享内核指向）及其 config.json/config.example.json 一致性');
} else {
  const cli = readTool('voice-cli.mjs');
  const gui = readTool('voice-gui.mjs');
  for (const [label, src] of [['voice-cli.mjs', cli], ['voice-gui.mjs', gui]]) {
    ok(/SNOWLUMA_HTTP_URL/.test(src) && /SNOWLUMA_TOKEN/.test(src) && /SNOWLUMA_HOME/.test(src)
      && /VOICE_DIR/.test(src) && /FFMPEG_PATH/.test(src), `${label} 认全部 5 个环境变量`);
    ok(/voice-tool|__dirname, 'config\.json'/.test(src) || /LOCAL_CONFIG_PATH/.test(src), `${label} 读自己的 config.json`);
    ok(/LEGACY_CONFIG_PATH|'\.\.', 'qq-bridge'/.test(src), `${label} 兼容读 ../qq-bridge/config.json`);
    ok(/DEFAULT_SNOWLUMA_HOME/.test(src), `${label} 带内置 SnowLuma 默认路径`);
    ok(/qq-bridge\/src\/voice-core\.js/.test(src), `${label} 共享内核指向 qq-bridge（单一实现）`);
  }
  const cfg = JSON.parse(readTool('config.json'));
  const ex = JSON.parse(readTool('config.example.json'));
  // config.example.json 里的注释键只给人看，不参与比较
  const keys = (o) => Object.keys(o).filter((k) => !k.startsWith('_')).sort();
  ok(JSON.stringify(keys(cfg)) === JSON.stringify(keys(ex)),
    'config.json 与 config.example.json 顶层键一致', keys(cfg).join(', '));
  ok(String(cfg.voice?.voiceDir ?? '').includes('qq-bridge/audio'),
    'config.json 默认仍用 qq-bridge/audio（用户已有音频继续可见）', String(cfg.voice?.voiceDir));
  ok(!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(String(cfg.voice?.voiceDir)),
    'voiceDir 是相对路径（不写死本机绝对路径，便于拷贝）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
