import { createConsoleSystemRoutes } from './features/console/routes/system.js';
import { resolveApiPath } from './policy/api-paths.js';
import { createToolGateway, TOOL_ROUTES } from './features/tools/gateway.js';
import { rememberModelSources } from './memory/model-sources.js';
import { modelMessageVisible } from './gate/model-visibility.js';
import { captureToolMemberGuard, projectToolMemberResult } from './gate/tool.js';
import { isImageBase64Field } from './identity/project-core.js';
// 本地 HTTP server 装配：控制台令牌、路由分组、按序过关卡后分发
import { createConsoleCoreRoutes } from './features/console/routes/core.js';
import { createConsoleGateRoutes } from './features/console/routes/gate.js';
import { createConsoleMaintenanceRoutes } from './features/console/routes/maintenance.js';
import { createConsoleRoleRoutes } from './features/console/routes/roles.js';
import { createConsoleSessionRoutes } from './features/console/routes/sessions.js';
import { createConsoleSettingsRoutes } from './features/console/routes/settings.js';
import { createConsoleTermsRoutes } from './features/console/routes/terms.js';
import { createConsoleSocialRoutes } from './features/console/routes/social.js';
import { createToolContextRoutes } from './features/tools/http-face/context.js';
import { createToolMediaRoutes } from './features/tools/http-face/media.js';
import { createToolSendRoutes } from './features/tools/http-face/send.js';
import { createToolSocialV2Routes } from './features/tools/http-face/social-v2.js';
import { createUsageDashboardRoutes } from './features/usage/dashboard.js';
import { rejectReadonlyStore } from './infra/http/auth-agent.js';
import { tokenEq, rejectBadHost, rejectBadConsoleToken, rejectCsrf } from './infra/http/auth-console.js';
import { ROUTE_NEXT } from './infra/http/route-next.js';
import { parseRequestUrl, createSendJson, createReadBody, handleFavicon, SECURITY_HEADERS } from './infra/http/server.js';
import { canonicalV2Key } from './policy/access.js';

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
    // 二代会话须仍在当前模式白名单内，否则旧令牌不能再读状态
    const v2SessionAllowed = (key) => {
      const match = /^(group|private):(\d+)$/.exec(String(key));
      return !!match && b.modeAllowed(key, match[1], Number(match[2]), b.cfg, b.currentMode, { listed: true });
    };

    const agentMemberView = (value, agentCall, opts) => agentCall ? b.projectForModel(value, 'tool', opts) : value;

    // 路由作用域：先查这几个局部量，其余沿原型落到 b
    const routeScope = Object.create(b, Object.getOwnPropertyDescriptors({
      get consoleToken() { return consoleToken; }, set consoleToken(v) { consoleToken = v; },
      get agentTokenOk() { return agentTokenOk; },
      get v2SessionAllowed() { return v2SessionAllowed; },
      get agentMemberView() { return agentMemberView; },
    }));
    const consoleSystemRoutes = createConsoleSystemRoutes(routeScope);
    const consoleRoleRoutes = createConsoleRoleRoutes(routeScope);
    const consoleTermsRoutes = createConsoleTermsRoutes(routeScope);
    const consoleSessionRoutes = createConsoleSessionRoutes(routeScope);
    const consoleSettingsRoutes = createConsoleSettingsRoutes(routeScope);
    const consoleSocialRoutes = createConsoleSocialRoutes(routeScope);
    const toolSocialV2Routes = createToolSocialV2Routes(routeScope);
    const toolMediaRoutes = createToolMediaRoutes(routeScope);
    const usageDashboardRoutes = createUsageDashboardRoutes(routeScope);
    const toolContextRoutes = createToolContextRoutes(routeScope);
    const toolSendRoutes = createToolSendRoutes(routeScope);
    const consoleCoreRoutes = createConsoleCoreRoutes(routeScope);
    const consoleGateRoutes = createConsoleGateRoutes(routeScope);
    const consoleMaintenanceRoutes = createConsoleMaintenanceRoutes(routeScope);
    const sanitizeToolResult = (value, parent = null, field = '') => {
      if (isImageBase64Field(parent, field, value)) return value;
      if (typeof value === 'string') return b.redactSensitiveText(b.redactKnownTokensOnly(value));
      if (Array.isArray(value)) return value.map((child) => sanitizeToolResult(child));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeToolResult(child, value, key)]));
    };
    const toolGateway = createToolGateway(b);
    const server = b.http.createServer(async (req, res) => {
      const url = parseRequestUrl(req, res, port);
      if (!url) return;
      const route = resolveApiPath(url.pathname);
      url.pathname = route.path;
      const rawSendJson = createSendJson({ req, res, url, log: b.log });
      let toolPolicy = false;
      let modelSourceKey;
      let modelSourceEpoch;
      let modelSourceMode;
      let modelToolFlag;
      let modelMemberGuard;
      const sendJson = (value, ...args) => {
        if (toolPolicy && modelSourceKey && value?.ok !== false && (args[0] ?? 200) < 400) {
          // 路由可能跨过异步 I/O；曝光和来源登记前重新检查原请求的权限。
          // status 的无会话调用不绑定 modelSourceKey，控制台响应也不走此守卫。
          const rule = TOOL_ROUTES[`${req.method} ${url.pathname}`];
          const policy = b.modeAdapterForKey(modelSourceKey)?.toolPolicy;
          if (!agentTokenOk(modelSourceKey, req.headers['x-agent-token']) ||
              modelSourceEpoch !== b.conversationEpoch?.(modelSourceKey) ||
              modelSourceMode !== b.modeForKey(modelSourceKey) ||
              !b.isSessionAllowedInCurrentMode(modelSourceKey) || !policy?.groups.includes(rule?.[0]) ||
              policy.deny.includes(modelToolFlag) || (modelToolFlag && !b.v2ToolEnabled(modelToolFlag)) ||
              (b.modeForKey(modelSourceKey) === 'reserved2' && (b.socialV2.paused || b.cfg.socialV2?.enabled === false))) {
            return rawSendJson({ ok: false, error: '等待期间会话或工具权限已变化，请重新读取会话' }, 403);
          }
          try { modelMemberGuard?.(); }
          catch (error) { return rawSendJson({ ok: false, error: error.message }, 403); }
          const rawValueBeforeFilter = value;
          value = projectToolMemberResult(b, modelSourceKey, rule, value);
          const st = b.socialV2.conversations.get(modelSourceKey);
          const payloadForSources = rule?.[2] === 'content' && value && typeof value === 'object'
            ? { ...value, self: undefined }
            : [];
          // 在身份脱敏前记录详情/转发返回的来源，同时仅登记工具实际可读的可见窗口消息。
          const visibleWindow = [...(st?.recentMessages ?? []), ...(st?.unread ?? [])].filter((m) => modelMessageVisible(b, modelSourceKey, m));
          rememberModelSources(b, modelSourceKey, [payloadForSources, ...visibleWindow]);
          const policyRules = modelSourceKey.startsWith('group:')
            ? Object.keys(b.memberPolicySnapshot?.()?.policy?.groups?.[modelSourceKey]?.rules ?? {})
            : [];
          return rawSendJson(agentMemberView(sanitizeToolResult(value), true, {
            groupKey: modelSourceKey,
            collectRoots: rawValueBeforeFilter === value ? [value] : [rawValueBeforeFilter, value],
            extraSeedIds: policyRules,
          }), ...args);
        }
        return rawSendJson(toolPolicy ? agentMemberView(sanitizeToolResult(value), true, { groupKey: modelSourceKey }) : value, ...args);
      };
      const read = createReadBody(req, { setTimeout: b.setTimeout, clearTimeout: b.clearTimeout });
      let bodyPromise;
      const readBody = () => bodyPromise ??= read();
      // 先检查本机来源与管理员凭据，再按公开命名空间鉴权。
      if (handleFavicon({ req, res, url })) return;
      // 用实际绑定端口，测试用 port 0 时配置值不对
      const boundPort = server.address()?.port ?? port;
      if (rejectBadHost({ req, sendJson, boundPort })) return;
      if (rejectBadConsoleToken({ req, res, url, sendJson, consoleToken })) return;
      if (rejectCsrf({ req, sendJson, boundPort })) return;
      try {
        const tokenState = req.headers['x-agent-token'] ? [...b.socialV2.conversations.entries()].find(([, st]) => st?.agentToken && tokenEq(req.headers['x-agent-token'], st.agentToken)) : null;
        const requestEpoch = tokenState ? b.conversationEpoch?.(tokenState[0]) : undefined;
        const requestMode = tokenState ? b.modeForKey(tokenState[0]) : undefined;
        toolPolicy = route.namespace === 'agent';
        if (route.namespace === 'removed') { sendJson({ ok: false, error: 'not found' }, 404); return; }
        if (route.namespace !== 'agent' && (req.headers['x-agent-call'] !== undefined || req.headers['x-agent-token'] !== undefined)) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
        if (toolPolicy && !await toolGateway.authorizeToolRequest({ req, url, readBody, sendJson, tokenState })) return;
        if (toolPolicy) {
          modelSourceKey = tokenState?.[0];
          modelSourceEpoch = requestEpoch;
          modelSourceMode = requestMode;
          modelToolFlag = url.pathname === '/api/agent/check-send' ? (await readBody()).tool : TOOL_ROUTES[`${req.method} ${url.pathname}`]?.[1];
          if (modelSourceKey) modelMemberGuard = captureToolMemberGuard(b, modelSourceKey, TOOL_ROUTES[`${req.method} ${url.pathname}`]);
        }
        if (rejectReadonlyStore({ req, url, sendJson, stickerStoreWritable: b.stickerStoreWritable })) return;
        if (await consoleSystemRoutes({ readBody, req, res, sendJson, url }) !== ROUTE_NEXT) return;
        // 控制台页面 / 状态 / preset 清单 / 模式 / 角色
        if (await consoleCoreRoutes({ SECURITY_HEADERS, readBody, req, res, sendJson, url }) !== ROUTE_NEXT) return;
        // 门禁成员策略管理（console token only）
        if (await consoleGateRoutes({ readBody, req, res, sendJson, url }) !== ROUTE_NEXT) return;
        // 人格卡与仿真提示词管理
        if (await consoleRoleRoutes({ readBody, req, sendJson, url, toolPolicy }) !== ROUTE_NEXT) return;
        // 词汇记忆管理
        if (await consoleTermsRoutes({ readBody, req, sendJson, url, toolPolicy }) !== ROUTE_NEXT) return;
        // 会话查看与挂起审批/提问
        if (await consoleSessionRoutes({ readBody, req, sendJson, url, toolPolicy }) !== ROUTE_NEXT) return;
        // 白名单 / 模型与思考强度 / 安全拦截 / 控制台令牌
        if (await consoleSettingsRoutes({ readBody, req, sendJson, url, toolPolicy }) !== ROUTE_NEXT) return;
        // 测试发送 / 一代社交引擎配置 / 控制端引导
        if (await consoleSocialRoutes({ readBody, req, sendJson, url, toolPolicy }) !== ROUTE_NEXT) return;
        // 二代仿真内部 Agent API
        if (await toolSocialV2Routes({ readBody, req, sendJson, url, toolPolicy, namespace: route.namespace }) !== ROUTE_NEXT) return;
        // 表情 / 语音 / 长轮询等待 / 发送检查
        if (await toolMediaRoutes({ readBody, req, res, sendJson, url, toolPolicy, namespace: route.namespace }) !== ROUTE_NEXT) return;
        // Token 用量与花费
        if (await usageDashboardRoutes({ req, sendJson, url }) !== ROUTE_NEXT) return;
        // 工具日志 / 反馈 / 消息详情 / 转发 / 群成员 / 记忆 / 词汇
        if (await toolContextRoutes({ readBody, req, sendJson, url, toolPolicy, namespace: route.namespace }) !== ROUTE_NEXT) return;
        // 看图与统一发送端点
        if (await toolSendRoutes({ readBody, req, sendJson, url, toolPolicy, namespace: route.namespace }) !== ROUTE_NEXT) return;
        // 清对话记录 / 清空工作区 / 重启桥接
        if (await consoleMaintenanceRoutes({ readBody, req, sendJson, url, toolPolicy }) !== ROUTE_NEXT) return;
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
        b.skipFlushOnExit = true;
        b.console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        b.process.exit(2);
      }
      b.process.exit(1);
    });
    return server;
  }

  return { startConsoleServer };
}
