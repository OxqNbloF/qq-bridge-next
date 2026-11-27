# chat-relay

拟人化群聊与私聊 Agent 桥接器：
- **多执行引擎热切换**：支持 `dsh`（DeepSeek Harness）、`agy`（Antigravity CLI）、`gemini`（Gemini CLI）与任意自定义 CLI，支持全局或单房间切换后端与模型并自动生成交接摘要。
- **拟人低频节奏调度**：支持 `muted` / `observer` / `direct` / `ambient` / `operator` 五种房间模式，群消息先攒批缓冲，由 `@` / 回复 / 关键词 / 批量阈值或静默巡检按需唤醒，不频繁打断会话。
- **家长控制与物理能力隔离**：Agent 仅看到外部控制面板（`/api/control/*`）实时授予的能力；每次唤醒分配专属 `RELAY_ROOM_SOCK` Unix Domain Socket，无 Token 可偷、无跨房间参数可伪造。
- **独立模块化能力包**：`modules/` 下拆分为 `chat`、`notes`、`pacing`、`attach`、`people`、`browse`、`emoticon`、`audio` 8 个独立子进程能力模块。

## 快速开始

```bash
npm install
cp config.example.json config.json
# 向 agy / gemini CLI 注册 relay-hub MCP 服务：
npm run setup:hub
# 启动服务：
npm start
```

## 测试与隐私检查

```bash
npm test
npm run privacy-scan
```
