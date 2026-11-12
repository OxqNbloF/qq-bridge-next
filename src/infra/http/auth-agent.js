// 智能体调用隔离关卡；reject* 返回 true 表示已拒绝并应答
// 检查顺序：先查调用方，再查请求，最后查只读库

// 带令牌必须命中活跃会话；无令牌智能体调用不得进 /api/socialV2/
// （否则不传令牌就能拿到控制台的全部权限）
export function rejectAgentCall({ req, url, sendJson, isLiveAgentToken }) {
  if (req.headers['x-agent-call'] !== undefined) {
    const agentToken = req.headers['x-agent-token'];
    const hasToken = typeof agentToken === 'string' && agentToken !== '';
    if (hasToken && !isLiveAgentToken(agentToken)) {
      sendJson({ ok: false, error: '未授权：智能体调用携带的会话令牌无效' }, 403);
      return true;
    }
    if (!hasToken) {
      const tokenlessAgentAllowed = url.pathname === '/api/status'
        || url.pathname.startsWith('/api/send/')
        || url.pathname.startsWith('/api/images/');
      if (!tokenlessAgentAllowed) {
        sendJson({ ok: false, error: '未授权：该接口的智能体调用必须携带有效的会话令牌' }, 403);
        return true;
      }
    }
  }
  return false;
}

/** closed-agent 模式下可带令牌用的媒体端点，豁免前三道关卡 */
export function closedAgentMediaExempt(currentMode, pathname) {
  return currentMode === 'closed-agent' && [
    '/api/socialV2/sticker-list', '/api/socialV2/sticker-image',
    '/api/socialV2/send-sticker', '/api/socialV2/self-image'
  ].includes(pathname);
}

/**
 * 按顺序检查智能体的请求：令牌/暂停/开关/模式/白名单
 * @param {object} o
 * @param {boolean} o.closedAgentMedia 是否豁免媒体接口
 * @param {string} o.currentMode
 * @param {boolean} o.paused 二代是否暂停
 * @param {boolean|undefined} o.v2Enabled 二代总开关
 */
export function rejectAgentRequest({ req, url, sendJson, closedAgentMedia, currentMode, paused, v2Enabled }) {
  // 空 agent token 一律拒绝，不能当成无令牌绕过
  if (req.headers['x-agent-token'] === '') {
    sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
    return true;
  }
  // 暂停二代时拒绝所有带令牌的 v2 调用
  if (!closedAgentMedia && paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
    sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
    return true;
  }
  // 二代总开关关闭时拒绝带令牌的 v2 调用
  if (!closedAgentMedia && v2Enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
    sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
    return true;
  }
  // 带令牌的 v2 接口只在 reserved2 模式可用
  if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2' && !closedAgentMedia) {
    sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
    return true;
  }
  // 管理端专用 v2 接口（含 initial-prompt）拒绝带令牌请求
  const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake', '/api/socialV2/initial-prompt'];
  if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  // 表情库管理仅限控制台；与下方白名单重合，是纵深防御，勿删
  if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  // 带令牌请求默认拒绝，只放行白名单路径（新增管理端点自动受保护）
  if (req.headers['x-agent-token']) {
    const agentAllowed = url.pathname === '/api/status'
      || url.pathname.startsWith('/api/socialV2/')
      || url.pathname.startsWith('/api/send/')
      || url.pathname.startsWith('/api/images/')
      || url.pathname === '/api/authorize/read';
    if (!agentAllowed) {
      sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
      return true;
    }
  }
  return false;
}

// 库只能读时，就拒绝写请求
export function rejectReadonlyStore({ req, url, sendJson, slangStoreWritable, stickerStoreWritable }) {
  // 只能读的库，写接口必须直接报错，不能假装存好了
  if (req.method !== 'GET') {
    const readonlyStore = (!slangStoreWritable && (url.pathname === '/api/slang'
      || url.pathname === '/api/slang/clear'
      || url.pathname === '/api/slang/extract'
      || url.pathname === '/api/slang/research'
      || url.pathname.startsWith('/api/slang/batch-')
      || url.pathname === '/api/socialV2/slang/submit')) ? '黑话库'
      : (!stickerStoreWritable && (url.pathname === '/api/stickers/sync'
        || url.pathname === '/api/stickers/note'
        || url.pathname === '/api/stickers/remark'
        || url.pathname === '/api/socialV2/sticker-note'
        || url.pathname === '/api/socialV2/sticker-remark'
        || url.pathname === '/api/socialV2/collect-sticker')) ? '表情库'
        : '';
    if (readonlyStore) {
      sendJson({ ok: false, error: `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接` }, 503, { safeError: true });
      return true;
    }
  }
  return false;
}
