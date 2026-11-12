// 只跑模拟数据的安全回归，不碰真实的 QQ 和 DSH
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  // 网络、DSH 探测、跨会话资料和发送队列的边界
  'test-audit-network-boundaries.mjs', 'test-audit-dsh-endpoints.mjs',
  'test-audit-runtime-boundaries.mjs', 'test-audit-session-boundaries.mjs',
  'test-code-scanning-boundaries.mjs',
  // 已确认修好的 GitHub issue 回归检查
  'test-issue-followup-bridge.mjs', 'test-issue-followup-mcp.mjs', 'test-issue-followup-runtime.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列的读法：0.2 版换了存放位置
  'test-dsh-inbox-projection.mjs',
  // 活体验证的离线回归：端点不能假通过，超时要停
  'test-adaptation-probes.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  // 重启脚本只停本进程，不能按进程名误杀别的项目
  'test-restart-instance.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-installed-preset-sync.mjs', 'test-role-card.mjs',
  // 角色卡写进去的节奏：首次、换卡、新会话要全量
  'test-role-injection-cadence.mjs',
  // 体检修复回归：权限、回滚、限频重试、定时器补发等
  'test-audit-regressions.mjs',
  // 交付流程：同一会话按顺序发；断线后补发不重复
  'test-delivery-regressions.mjs',
  // 会话隔离：一个群卡住不影响别的群，同群仍排队
  'test-session-isolation.mjs',
  // 记忆系统：轻量记忆、旧字段导入、坏文件只读不写
  'test-memory.mjs',
  // 记忆检索：每会话索引、两字词保底、排序和隔离
  'test-memory-index.mjs',
  // 图片表情和联网搜索流程，缓存提示不能漏
  'test-media-search.mjs',
  // GitHub issue 回归：模式优先层、忙线租约、机器人身份
  'test-issue-regressions.mjs',
  // 初始提示词只在第一次唤醒时发，控制台不能顶掉
  'test-v2-initial-prompt.mjs',
  // 令牌账本、价目表和体检修复回归（纯函数）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送：纯函数和端点存在性，真发在 --live 里
  'test-voice.mjs',
  // 音量：参数检查、真调 ffmpeg、自己算音量验证
  'test-voice-volume.mjs',
  // 边界：同时操作、坏输入、上传限额、越权
  'test-voice-edge.mjs',
  // 语音图形界面：参数、鉴权、路径穿越、文件名清洗
  'test-voice-gui.mjs',
  // 控制台静态约定（跑不了浏览器时的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构：入口、要用到的包、接口、开关、文档
  'test-voice-system.mjs',
  // SnowLuma 账号和令牌自发现（换号后令牌会变）
  'test-snowluma-conn.mjs',
  // 启动器编码（.cmd 里的中文会被按 ANSI 解成乱码）
  'test-encoding.mjs',
  // 控制台乱码（UTF-8 被当成 GBK 解码）和修复
  // 铁律 L7：模拟会话不能有本地执行能力
  'test-preset-local-tools.mjs',
  // 控制台的设置约定：0.2 版删掉了注册的接口
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康：心跳取错字段会悄悄失效
  'test-snowluma-upstream-health.mjs',
  // 已有离线安全测试也要常跑，别等手工才发现退化
  'test-agent-preset-patches.mjs', 'test-tool-restrict-guard.mjs', 'test-tool-surface.mjs',
  'test-media-normalize.mjs', 'test-stickers.mjs', 'test-forward.mjs',
  'test-v2-wait.mjs', 'test-time-awareness.mjs', 'test-wait-backlog.mjs',
  '../src/core/session-router.test.mjs',
  // 工具面和 HTTP 面约定快照（三种启动方式）
  'test-tool-surface-contract.mjs',
  // src/policy/ 纯函数单测
  'test-policy.mjs',
  // 消息池 archive：重复写、崩溃、撤回、隐私删除
  'test-archive.mjs',
  // 基础设施模块、开关默认值、保留期、删除命令行
  'test-infra.mjs',
  // 搬迁清单：已搬走的函数不能在 bridge.js 里留着
  'test-bridge-function-migration.mjs',
  // 控制台路由分组：搬走的路由不能落到 404
  'test-console-route-groups.mjs',
  // HTTP 面鉴权行为矩阵（身份、运行状态、路径）
  'test-http-auth-matrix.mjs',
  // 表情同步的 HTTP 退路回归（纯模拟数据）
  'test-sticker-http-fallback.mjs',
];

// 要真实环境、不进主回归的测试，必须写明理由
const environmentTests = {
  'test-audit.mjs': '本套件执行器自身',
  'test-console-ui.mjs': '真浏览器（Playwright）+ 离线 fixture 服务',
  'test-console.mjs': '需要运行中的桥接控制台',
  'test-dsh-auth.mjs': '需要活 DSH 的鉴权适配',
  'test-dsh-session-retire.mjs': '实时端到端：需要 DSH 在运行',
  'test-dsh-v2-wait.mjs': '实时端到端：真建 qq-chat-v2 会话',
  'test-mcp-exec.mjs': '模拟 DSH MCP 客户端完整握手，依赖本机 SnowLuma/桥接配置',
  'test-mcp-host.mjs': 'stdio 拉起 host server 并真实查询网关',
  'test-mcp-safe.mjs': '逐项调用 QQ 工具，依赖本机桥接配置',
  'test-mcp-servers-stdio.mjs': '读取本机 config.json/state（结果随本机模式漂移）；离线全集断言见 test-tool-surface-contract',
  'test-mcp-web-search.mjs': '打真实网络搜索/抓取',
  'test-onebot-connection.mjs': '一次性连接真 SnowLuma 网关',
  'test-setup-dsh-idempotent.mjs': '需要本机 DSH 安装目录的 node_modules（DSH_INSTALL_MODULES）',
  'test-vision-media.mjs': '视觉链路自检，需运行中的桥接/配置',
  'test-voice-preview.mjs': 'live：需语音 GUI 在 3215 运行',
};
{
  const fs = await import('node:fs');
  const listed = new Set(tests.map((t) => path.basename(t)));
  const unregistered = fs.readdirSync(path.join(root, 'scripts'))
    .filter((f) => /^test-.*\.mjs$/.test(f) && !listed.has(f) && !(f in environmentTests));
  const stale = Object.keys(environmentTests).filter((f) => !fs.existsSync(path.join(root, 'scripts', f)) || listed.has(f));
  if (unregistered.length || stale.length) {
    console.error(`test-audit 清单不一致：未登记 [${unregistered.join(', ')}]；环境登记失效/重复 [${stale.join(', ')}]`);
    process.exit(1);
  }
}
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
