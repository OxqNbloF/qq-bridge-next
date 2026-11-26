# QQ Bridge v3

全新架构的模块化多 CLI QQ 连接层（Node.js 22+ ESM），聚焦：

- **拟人群聊与私聊分模式调度**：支持为每个群或私聊单独设置 `human` / `chat` / `listen` / `off` / `admin`；`human` 模式下群闲聊本地静默缓冲，仅在被 @、回复、命中关键词、累计达到未读批量且过冷却期或定时唤醒时才惊动 Agent。
- **多 CLI 后端热切换 + 模型选择 + 共享全部其他设置**：统一 `BackendRegistry` 支持 **DSH**、**Antigravity (`agy`)**、**Gemini CLI** 及任意**自定义 CLI (`cliProfiles`)**，运行期可全局或按单个聊天随时热切换后端和模型；切换后端自动交接上下文摘要，访问控制、唤醒策略、人设、记忆、脚本模块白名单与出站审计对所有后端完全一致。
- **外部“家长控制”控制台**：独立回环 Web 工作台（`web/`），`x-console-token` + `Host` 白名单 + 严格 CSP；Agent 与本地脚本无法访问 `/api/console/*`、`config.json` 或 `data/`。
- **薄壳 5 工具 MCP Broker + Per-Session Unix Socket + 零 Shell 本地脚本**：仅向模型暴露 `qq_send`、`qq_wait`、`qq_done`、`qq_manual`、`qq_call`，会话权限与 `convKey` 由每会话 Unix Socket 强制锁定，无任何令牌或跨群参数暴露在上下文里。
- **低冗余防注入增量提示词与自动压缩**：静态精简 System Prompt + 随机 Nonce `<untrusted_qq_events>` Delta Prompt + 达阈值自动提炼 `<=400` 字摘要并重置后端续聊。

## 快速开始

```bash
npm start
# 向本机 agy / gemini / 通用 MCP 注册 qq-broker（可先加 --dry-run 预览）
npm run setup:broker -- --dry-run
npm test
npm run privacy-scan
```
