// 工作台主入口：视图路由、状态同步、全局参数搜索与可见性感知轮询
import { notify, store } from './api.js';
import { mountOverview } from './panels/overview.js';
import { mountModules, focusModuleSearch } from './panels/modules.js';
import { mountSessions } from './panels/sessions.js';
import { mountGate } from './panels/gate.js';
import { mountPersona } from './panels/persona.js';
import { mountMediaTools } from './panels/media-tools.js';
import { mountSystem } from './panels/system.js';

const VIEW_TITLES = {
  desk: '工作台总览',
  parameters: '全模块参数中心',
  sessions: '会话与模式',
  gate: '门禁与成员策略',
  persona: '角色、预设与记忆',
  media: '媒体、工具与用量',
  settings: '系统诊断与维护',
};

const PANELS = {
  desk: mountOverview,
  parameters: mountModules,
  sessions: mountSessions,
  gate: mountGate,
  persona: mountPersona,
  media: mountMediaTools,
  settings: mountSystem,
};

let currentView = 'desk';
let pollingInFlight = false;

function updateChrome() {
  const st = store.status;
  const dot = document.getElementById('railDot');
  const sub = document.getElementById('railSub');
  const badge = document.getElementById('connectionBadge');
  if (st) {
    const ok = st.dshReady && st.snowluma?.connected !== false;
    dot.className = `dot ${ok ? 'ok' : 'err'}`;
    sub.textContent = `模式 ${st.mode || '—'} · DSH ${st.dshReady ? '在线' : '离线'}`;
    badge.className = `badge ${ok ? 'ok' : 'warn'}`;
    badge.innerHTML = `<span class="dot ${ok ? 'ok' : 'err'}"></span>${ok ? 'DSH & QQ 正常' : '连接待检查'}`;
  }
  const pending = store.modulesCatalog?.pendingRestartCount ?? 0;
  const pendingBadge = document.getElementById('pendingRestartBadge');
  const pendingCount = document.getElementById('pendingRestartCount');
  pendingCount.textContent = String(pending);
  pendingBadge.classList.toggle('hidden', pending <= 0);
  const modCount = store.modulesCatalog?.modules?.length ?? 12;
  document.getElementById('navModCount').textContent = String(modCount);
}

export async function switchView(view) {
  if (!PANELS[view]) view = 'desk';
  currentView = view;
  document.querySelectorAll('.nav button[data-view]').forEach((btn) => {
    if (btn.dataset.view === view) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  document.querySelectorAll('section.view[data-page]').forEach((sec) => {
    sec.classList.toggle('hidden', sec.dataset.page !== view);
  });
  document.getElementById('breadcrumb').textContent = VIEW_TITLES[view] || view;
  const host = document.getElementById(`page-${view}`);
  try {
    await PANELS[view](host);
  } catch (error) {
    notify(error?.message || '页面加载失败', true);
  }
}

document.querySelectorAll('.nav button[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => { void switchView(btn.dataset.view); });
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  try {
    await Promise.all([store.refreshStatus(), store.refreshModules()]);
    await switchView(currentView);
    notify('状态与模块参数已刷新');
  } catch (error) {
    notify(error.message, true);
  }
});

const searchInput = document.getElementById('globalParamSearch');
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = searchInput.value.trim();
    if (!q) return;
    if (currentView !== 'parameters') void switchView('parameters');
    focusModuleSearch(q);
  }, 180);
});

store.subscribe(updateChrome);

async function bootstrap() {
  try {
    await Promise.all([store.refreshStatus(), store.refreshModules()]);
  } catch (error) {
    notify(error.message, true);
  }
  await switchView('desk');
  // 可见性感知轮询：后台标签页不发请求，且单飞防重叠
  setInterval(async () => {
    if (document.hidden || pollingInFlight) return;
    pollingInFlight = true;
    try {
      await store.refreshStatus();
      if (currentView === 'desk') await PANELS.desk(document.getElementById('page-desk'));
    } catch {}
    finally { pollingInFlight = false; }
  }, 5000);
}

void bootstrap();
