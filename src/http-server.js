// 本地 HTTP server 装配：控制台令牌、路由分组、按序过关卡后分发
import { createConsoleCoreRoutes } from './features/console/routes/core.js';
import { createConsoleMaintenanceRoutes } from './features/console/routes/maintenance.js';
import { createConsoleRoleRoutes } from './features/console/routes/roles.js';
import { createConsoleSessionRoutes } from './features/console/routes/sessions.js';
import { createConsoleSettingsRoutes } from './features/console/routes/settings.js';
import { createConsoleSlangRoutes } from './features/console/routes/slang.js';
import { createConsoleSocialRoutes } from './features/console/routes/social.js';
import { createToolContextRoutes } from './features/tools/http-face/context.js';
import { createToolMediaRoutes } from './features/tools/http-face/media.js';
import { createToolSendRoutes } from './features/tools/http-face/send.js';
import { createToolSocialV2Routes } from './features/tools/http-face/social-v2.js';
import { createUsageDashboardRoutes } from './features/usage/dashboard.js';
import { rejectAgentCall, closedAgentMediaExempt, rejectAgentRequest, rejectReadonlyStore } from './infra/http/auth-agent.js';
import { tokenEq, rejectBadHost, rejectBadConsoleToken, rejectCsrf } from './infra/http/auth-console.js';
import { ROUTE_NEXT } from './infra/http/route-next.js';
import { parseRequestUrl, createSendJson, createReadBody, handleFavicon, SECURITY_HEADERS } from './infra/http/server.js';
import { canonicalV2Key, allowed } from './policy/access.js';

// 创建本地控制台与工具 HTTP server
export function createConsoleServer(b) {
  // 初始化令牌、装配路由并开始监听
  function startConsoleServer() {
    const port = b.cfg.consolePort ?? 3100;
    // 控制台令牌：配置里有就用，没有就自动生成并存到硬盘
    const configuredToken = String(b.cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    let consoleToken = tokenValid ? configuredToken : b.loadOrCreateConsoleToken();
    // 令牌为空就拒绝启动（失败关闭），不能开无鉴权管理 API
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) b.log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) b.log('控制台未配置 consoleToken，已自动生成并保存到 state/console-token');
    // 带 x-agent-token 时必须匹配该会话的 agentToken
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = b.socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    /** 令牌是否属于任一活跃二代会话；供 x-agent-call 关卡判断 */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of b.socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话须仍在当前模式白名单内，否则旧令牌不能再读状态
    const v2SessionAllowed = (key) => {
      if (!b.isSessionAllowedInCurrentMode(key)) return false;
      if (b.currentMode !== 'closed-agent') return true;
      const match = /^(group|private):(\d+)$/.exec(String(key));
      return !!match && allowed(match[1], match[2], b.cfg);
    };

    /** agent 调用默认递归剥掉 userId/isOwner；exposeUserId 可打开 */
    const agentMemberView = (value, agentCall) => {
      if (!agentCall || b.cfg.socialV2?.privacy?.exposeUserId === true) return value;
      if (Array.isArray(value)) return value.map((item) => agentMemberView(item, true));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([name]) => !['userId', 'user_id', 'isOwner'].includes(name))
          .map(([name, child]) => [name, agentMemberView(child, true)])
      );
    };

    // 路由作用域：先查这几个局部量，其余沿原型落到 b
    const routeScope = Object.create(b, Object.getOwnPropertyDescriptors({
      get consoleToken() { return consoleToken; }, set consoleToken(v) { consoleToken = v; },
      get agentTokenOk() { return agentTokenOk; },
      get v2SessionAllowed() { return v2SessionAllowed; },
      get agentMemberView() { return agentMemberView; },
    }));
    const consoleRoleRoutes = createConsoleRoleRoutes(routeScope);
    const consoleSlangRoutes = createConsoleSlangRoutes(routeScope);
    const consoleSessionRoutes = createConsoleSessionRoutes(routeScope);
    const consoleSettingsRoutes = createConsoleSettingsRoutes(routeScope);
    const consoleSocialRoutes = createConsoleSocialRoutes(routeScope);
    const toolSocialV2Routes = createToolSocialV2Routes(routeScope);
    const toolMediaRoutes = createToolMediaRoutes(routeScope);
    const usageDashboardRoutes = createUsageDashboardRoutes(routeScope);
    const toolContextRoutes = createToolContextRoutes(routeScope);
    const toolSendRoutes = createToolSendRoutes(routeScope);
    const consoleCoreRoutes = createConsoleCoreRoutes(routeScope);
    const consoleMaintenanceRoutes = createConsoleMaintenanceRoutes(routeScope);
    const server = b.http.createServer(async (req, res) => {
      const url = parseRequestUrl(req, res, port);
      if (!url) return;
      const sendJson = createSendJson({ req, res, url, log: b.log });
      const readBody = createReadBody(req, { setTimeout: b.setTimeout, clearTimeout: b.clearTimeout });
      // 关卡顺序是安全边界，不得调整（矩阵测试冻结）
      if (handleFavicon({ req, res, url })) return;
      // 用实际绑定端口，测试用 port 0 时配置值不对
      const boundPort = server.address()?.port ?? port;
      if (rejectBadHost({ req, sendJson, boundPort })) return;
      if (rejectBadConsoleToken({ req, res, url, sendJson, consoleToken })) return;
      if (rejectAgentCall({ req, url, sendJson, isLiveAgentToken })) return;
      if (rejectCsrf({ req, sendJson, boundPort })) return;
      try {
        const closedAgentMedia = closedAgentMediaExempt(b.currentMode, url.pathname);
        if (rejectAgentRequest({ req, url, sendJson, closedAgentMedia, currentMode: b.currentMode, paused: b.socialV2.paused, v2Enabled: b.cfg.socialV2?.enabled })) return;
        if (rejectReadonlyStore({ req, url, sendJson, slangStoreWritable: b.slangStoreWritable, stickerStoreWritable: b.stickerStoreWritable })) return;
        // 控制台页面 / 状态 / preset 清单 / 模式 / 角色
        if (await consoleCoreRoutes({ SECURITY_HEADERS, readBody, req, res, sendJson, url }) !== ROUTE_NEXT) return;
        // 人格卡与仿真提示词管理
        if (await consoleRoleRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 黑话库管理
        if (await consoleSlangRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 会话查看与挂起审批/提问
        if (await consoleSessionRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 白名单 / 模型与思考强度 / 安全拦截 / 控制台令牌
        if (await consoleSettingsRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 测试发送 / 一代社交引擎配置 / 控制端引导
        if (await consoleSocialRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 二代仿真内部 Agent API
        if (await toolSocialV2Routes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 表情 / 语音 / 长轮询等待 / 发送检查
        if (await toolMediaRoutes({ closedAgentMedia, readBody, req, res, sendJson, url }) !== ROUTE_NEXT) return;
        // Token 用量与花费
        if (await usageDashboardRoutes({ req, sendJson, url }) !== ROUTE_NEXT) return;
        // 工具日志 / 反馈 / 消息详情 / 转发 / 群成员 / 记忆 / 黑话
        if (await toolContextRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 看图与统一发送端点
        if (await toolSendRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        // 清对话记录 / 清空工作区 / 重启桥接
        if (await consoleMaintenanceRoutes({ readBody, req, sendJson, url }) !== ROUTE_NEXT) return;
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      b.log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已经有一份在跑：退出码 2，守护脚本不会一直重启
    server.on('error', (error) => {
      b.log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        b.console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        b.process.exit(2);
      }
      b.process.exit(1);
    });
    return server;
  }

  return { startConsoleServer };
}
