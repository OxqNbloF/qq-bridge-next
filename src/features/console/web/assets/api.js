// 工作台统一 API 客户端、401 单例重登、全局状态缓存与通知

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

let noticeTimer = null;
export function notify(message, isError = false) {
  const el = document.getElementById('notice');
  if (!el) return;
  clearTimeout(noticeTimer);
  el.textContent = String(message ?? '');
  el.className = isError ? 'error' : '';
  noticeTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, isError ? 5200 : 3200);
}

let reauthPromise = null;
function promptReauth() {
  if (!reauthPromise) {
    reauthPromise = Promise.resolve().then(() => {
      localStorage.removeItem('consoleToken');
      const entered = window.prompt('控制台令牌已失效，请输入新的访问令牌（位于 state/console-token）：');
      if (entered && entered.trim()) {
        localStorage.setItem('consoleToken', entered.trim());
        const u = new URL(location.href);
        u.searchParams.set('token', entered.trim());
        location.href = u.pathname + u.search + u.hash;
      }
    }).finally(() => { reauthPromise = null; });
  }
  return reauthPromise;
}

export async function api(path, { method, body, rawText = false } = {}) {
  const normalized = path.startsWith('/api/') ? path : `/api/console/${path.replace(/^\/+/, '')}`;
  const httpMethod = method || (body !== undefined ? 'POST' : 'GET');
  const headers = {};
  const storedToken = localStorage.getItem('consoleToken');
  if (storedToken) headers['x-console-token'] = storedToken;
  if (httpMethod !== 'GET') headers['content-type'] = 'application/json';

  const res = await fetch(normalized, {
    method: httpMethod,
    credentials: 'same-origin',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    void promptReauth();
    throw new Error('令牌已失效，请重新输入访问令牌');
  }
  if (rawText) {
    const text = await res.text();
    if (!res.ok) throw new Error(text || `请求失败 (${res.status})`);
    return text;
  }
  const data = await res.json().catch(() => ({ ok: false, error: `响应非 JSON (${res.status})` }));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

export const store = {
  status: null,
  modulesCatalog: null, // { revision, modules, pendingRestartCount }
  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) { try { fn(this); } catch {} } },
  async refreshStatus() {
    this.status = await api('/api/console/status');
    this.emit();
    return this.status;
  },
  async refreshModules() {
    this.modulesCatalog = await api('/api/console/modules');
    this.emit();
    return this.modulesCatalog;
  },
  getModule(id) {
    return this.modulesCatalog?.modules?.find((m) => m.id === id) ?? null;
  },
};
