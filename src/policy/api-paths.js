// 控制台与工具共用业务处理器；只接受新的公开命名空间。
export function resolveApiPath(path) {
  if (path === '/api/health') return { namespace: 'health', path: '/api/agent/status' };
  if (path.startsWith('/api/agent/')) return { namespace: 'agent', path };
  if (path.startsWith('/api/console/')) {
    const dispatch = path.replace('/api/console/scheduler/', '/api/agent/')
      .replace(/^\/api\/console\/memory(?:\/(append|update|remove|clear))?$/, (_, action) => `/api/agent/memory${action ? '-' + action : ''}`)
      .replace(/^\/api\/console\/(status$|send\/|images\/|authorize\/)/, '/api/agent/$1');
    return { namespace: 'console', path: dispatch };
  }
  return { namespace: path === '/' || path === '/favicon.ico' ? 'web' : 'removed', path };
}
