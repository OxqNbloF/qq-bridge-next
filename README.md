# qq-bridge-next

**qq-bridge-next 基于 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 重构而来**，许可证与上游 qq-bridge 相同。

它是一个本地消息桥：一端连 SnowLuma 提供的 OneBot v11 接口，另一端连 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)，把 QQ 群聊和私聊交给 DSH 里的 AI 处理，再把回复发回 QQ。

```text
QQ ↔ SnowLuma ↔ qq-bridge-next ↔ DeepSeek Harness ↔ 模型服务
         OneBot v11
```

> [!IMPORTANT]
> 本项目与 SnowLuma、DeepSeek、腾讯 / QQ 没有隶属、合作或背书关系，也不是上游 qq-bridge 的官方版本。它只通过公开的 OneBot v11 协议通信，不向 QQ 或 SnowLuma 注入、挂钩，也不安装、打包或启停 SnowLuma。

## 相比 qq-bridge 改了什么

功能和对外接口（QQ 工具、HTTP 路由、配置格式）与 qq-bridge 保持兼容，变化在内部：

- **模块化**：原来上万行的 `bridge.js` 拆成按职责分层的模块，入口 `src/bridge.js` 只剩几十行，组装在 `src/app.js`。
- **会话隔离**：每个群 / 私聊有独立的 DSH 工作目录；一个群发送卡住不再拖慢其他群；回合卡死时只中断那一个会话。
- **写盘合批**：聊天热路径不再每条消息都整文件写盘。
- **长期记忆（可选，默认关）**：把聊天压缩成长期记忆，按当前话题用本机 SQLite 全文索引检索，注入二代仿真的提示词。
- **只支持 macOS / Linux**：Windows 启动脚本和 ACL 相关代码已删除。

每项都有回退开关，写在 `config.example.json` 里。

## 快速开始

需要 macOS 或 Linux、Node.js ≥ 22.13（与 DSH 0.2.2 同机部署需 ≥ 24.9），并自行运行：

- **DSH Web**，已验证 `0.2.2-rc.1`；
- **SnowLuma**，按[上游文档](https://github.com/SnowLuma/SnowLuma)安装并登录，开启 OneBot 的 WebSocket 服务端和 HTTP API。

```bash
npm install
cp config.example.json config.json
```

`npm install` 会自动修补本机 `@snowluma/sdk` 的 ESM 导入，不要加 `--ignore-scripts`。

编辑 `config.json`，至少填写：

| 字段 | 内容 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `snowluma.wsUrl` / `httpUrl` | OneBot WebSocket / HTTP 地址，例如 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` |
| `snowluma.accessToken` / `homeDir` | OneBot 令牌与 SnowLuma 安装目录 |
| `ownerQQ` | 管理员 QQ 号 |
| `allow.private` / `allow.groups` | 允许接入的 QQ 号 / 群号；留空则不响应任何会话 |

把聊天 preset 和 MCP 工具装进 DSH（首次必做，装完重启 DSH）：

```bash
node scripts/setup-dsh.mjs
```

启动：

```bash
./start.sh
```

崩溃后 5 秒自动重启；`./restart.sh` 重启，`./stop.sh` 停止。打开控制台 <http://127.0.0.1:3100>，令牌在 `state/console-token`。默认模式是二代仿真（`reserved2`，选择性发言）；想先测通收发，在控制台切到 `chat`。

## 模式与安全边界

| 模式 | 谁能用 | 说明 |
| --- | --- | --- |
| `chat` | 白名单群与私聊 | 普通聊天，回复自动发回 QQ |
| `reserved` / `reserved2` | 白名单群与私聊 | 一代 / 二代群友仿真；二代由 AI 用工具自己决定看什么、说什么 |
| `closed-agent` | 仅管理员私聊 | 可用 DSH 的完整本地工具，请谨慎开启 |

- 群聊里的 AI 没有任何本地工具（不能执行命令、读写文件），只能用 QQ、受限联网搜索两类工具；发送目标必须在白名单内。
- 群聊会话需要的安全 preset 缺失时，桥接拒绝建会话，不会退回带本地工具的默认 preset。
- 管理员可在 QQ 里用 `/role`、`/silent`、`/active`、`/status`、`/reset` 管理，这些命令由桥接直接执行，不经过模型。

## 数据去向

聊天内容会经 DSH 发给你配置的模型服务。联网搜索工具和默认开启的黑话自动研究会把关键词发给搜索服务；网页抓取会访问模型给出的公网地址（内网和保留地址一律拦截）。开启长期记忆或消息池后，聊天原文会保存在本机 `state/` 下。本项目没有遥测。

请保护好 `config.json`、`state/` 和控制台令牌，所有端口只在本机监听。

## 开发

```bash
npm run test:audit     # 离线回归，不连真实 QQ / DSH
npm run privacy-scan   # 扫描入库文件里的令牌、本机路径、真实 QQ 号
```

## 许可

本项目沿用上游 qq-bridge 的 [PolyForm Noncommercial 1.0.0](LICENSE)，**仅限非商业用途**；再分发时须随附许可全文和 `LICENSE` 中的 `Required Notice` 行。

运行时依赖的 SnowLuma 及 `@snowluma/*` 包另有其非商业许可，本项目的许可不对它们授予任何权利。使用非官方 QQ 后端可能导致账号受限，风险由使用者承担。
