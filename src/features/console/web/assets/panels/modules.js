// 全模块参数中心：12 大模块分类切换、全局参数搜索与 Schema 表单编辑
import { esc, store } from '../api.js';
import { renderModuleForm } from '../schema-form.js';

let activeModuleId = 'reserved2';
let activeFilter = '';
let lastHost = null;

export function focusModuleSearch(query) {
  activeFilter = String(query ?? '').trim();
  if (lastHost) void renderModulesView(lastHost);
}

async function renderModulesView(root) {
  if (!store.modulesCatalog) await store.refreshModules();
  const modules = store.modulesCatalog?.modules ?? [];
  if (!modules.length) {
    root.innerHTML = '<div class="empty">未能加载模块参数目录。</div>';
    return;
  }

  // 搜索时自动定位到首个命中的模块
  const q = activeFilter.toLowerCase();
  const matchedCounts = new Map();
  for (const mod of modules) {
    const count = q
      ? mod.fields.filter((f) => `${mod.title} ${f.label} ${f.path} ${f.description || ''} ${f.section || ''}`.toLowerCase().includes(q)).length
      : mod.fields.length;
    matchedCounts.set(mod.id, count);
  }
  if (!modules.some((m) => m.id === activeModuleId) || (q && matchedCounts.get(activeModuleId) === 0)) {
    const firstHit = modules.find((m) => matchedCounts.get(m.id) > 0);
    if (firstHit) activeModuleId = firstHit.id;
  }

  const byCat = new Map();
  for (const mod of modules) {
    if (!byCat.has(mod.category)) byCat.set(mod.category, []);
    byCat.get(mod.category).push(mod);
  }

  const sidebarHtml = [...byCat.entries()].map(([cat, list]) => {
    const btns = list.map((mod) => {
      const cnt = matchedCounts.get(mod.id) ?? 0;
      const cls = mod.id === activeModuleId ? 'mod-btn active' : 'mod-btn';
      const tag = mod.pendingRestartCount > 0
        ? `<span class="mod-tag warn" title="含待重启生效项">${cnt} · 待重启</span>`
        : `<span class="mod-tag">${cnt}</span>`;
      return `<button type="button" class="${cls}" data-group="${esc(mod.id)}"><span>${esc(mod.title)}</span>${tag}</button>`;
    }).join('');
    return `<div class="mod-cat">${esc(cat)}</div>${btns}`;
  }).join('');

  const current = modules.find((m) => m.id === activeModuleId) || modules[0];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>全模块参数中心</h1>
        <p>全项目 ${modules.length} 大功能模块的内部参数统一在此调节；热更新项保存即刻生效，重启项自动备份并标明差异。</p>
      </div>
      <div class="toolbar">
        <input id="modLocalFilter" type="search" class="search-input" placeholder="过滤当前/全部参数…" value="${esc(activeFilter)}" />
        ${activeFilter ? '<button type="button" id="modClearFilter" class="btn-sm">清除筛选</button>' : ''}
      </div>
    </div>
    <div class="mod-layout">
      <aside class="mod-sidebar" aria-label="模块清单">${sidebarHtml}</aside>
      <div class="panel">
        <div class="page-head" style="margin-bottom:12px;">
          <div>
            <h2 style="margin:0;">${esc(current.title)}</h2>
            <p>${esc(current.description)}</p>
          </div>
          <span class="badge">${esc(current.category)} · ${current.fields.length} 项</span>
        </div>
        <div id="modFormHost"></div>
      </div>
    </div>
  `;

  renderModuleForm(root.querySelector('#modFormHost'), current, {
    filterText: activeFilter,
    formId: 'parametersForm',
    onSaved: () => renderModulesView(root),
  });

  root.querySelectorAll('.mod-btn[data-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeModuleId = btn.dataset.group;
      void renderModulesView(root);
    });
  });

  const filterInput = root.querySelector('#modLocalFilter');
  filterInput.addEventListener('input', () => {
    activeFilter = filterInput.value.trim();
    void renderModulesView(root);
  });
  root.querySelector('#modClearFilter')?.addEventListener('click', () => {
    activeFilter = '';
    const globalSearch = document.getElementById('globalParamSearch');
    if (globalSearch) globalSearch.value = '';
    void renderModulesView(root);
  });
}

export async function mountModules(root) {
  lastHost = root;
  await renderModulesView(root);
}
