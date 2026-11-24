// 通用模块参数表单引擎：按后端 module-registry Schema 渲染任意模块的全部内部参数
import { api, esc, notify, store } from './api.js';

function formatForInput(field, value) {
  if (field.sensitivity === 'secret') return '';
  if (field.type === 'stringArray' || field.type === 'qqList') {
    return Array.isArray(value) ? value.join('\n') : '';
  }
  if (field.type === 'json') {
    return value == null ? 'null' : JSON.stringify(value, null, 2);
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function readInputValue(field, inputEl) {
  if (field.type === 'boolean') return inputEl.checked;
  if (field.type === 'integer' || field.type === 'number') {
    const raw = inputEl.value.trim();
    if (raw === '') throw new Error(`${field.label} 不能为空`);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${field.label} 必须是数字`);
    return n;
  }
  if (field.type === 'stringArray' || field.type === 'qqList') {
    return inputEl.value.split(/[\r\n,，]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (field.type === 'nullableQq') {
    const s = inputEl.value.trim();
    return s === '' ? null : s;
  }
  if (field.type === 'json') {
    const s = inputEl.value.trim();
    if (!s || s === 'null') return null;
    return JSON.parse(s);
  }
  return inputEl.value;
}

function fieldControlHtml(field, idPrefix) {
  const val = field.configured;
  const disabled = field.sensitivity === 'localOnly' ? 'disabled' : '';
  const domId = `${idPrefix}-${field.path.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const pathAttr = `data-path="${esc(field.path)}"`;

  if (field.sensitivity === 'secret') {
    const stateText = val?.configured ? '已配置（输入新值覆盖，留空不变）' : '未配置（输入以写入）';
    return `<div class="sf-secret-row">
      <input id="${domId}" type="password" ${pathAttr} placeholder="${esc(stateText)}" autocomplete="new-password" />
      <button type="button" class="btn-sm" data-clear-secret="${esc(field.path)}">清空</button>
    </div>`;
  }
  if (field.type === 'boolean') {
    return `<label class="sf-toggle" for="${domId}">
      <input id="${domId}" type="checkbox" ${pathAttr} ${val ? 'checked' : ''} ${disabled} />
      <span>${val ? '已开启' : '已关闭'}</span>
    </label>`;
  }
  if (field.type === 'enum' || field.type === 'optionalEnum') {
    const opts = (field.options || []).map((opt) => {
      const text = opt === '' ? '（跟随全局默认）' : opt;
      const sel = String(val ?? '') === String(opt) ? 'selected' : '';
      return `<option value="${esc(opt)}" ${sel}>${esc(text)}</option>`;
    }).join('');
    return `<select id="${domId}" ${pathAttr} ${disabled}>${opts}</select>`;
  }
  if (field.type === 'textarea' || field.type === 'stringArray' || field.type === 'qqList' || field.type === 'json') {
    const rows = field.type === 'json' ? 5 : 3;
    return `<textarea id="${domId}" rows="${rows}" ${pathAttr} ${disabled}>${esc(formatForInput(field, val))}</textarea>`;
  }
  if (field.type === 'integer' || field.type === 'number') {
    const step = field.step ?? (field.type === 'integer' ? '1' : 'any');
    const min = field.min !== undefined ? `min="${field.min}"` : '';
    const max = field.max !== undefined ? `max="${field.max}"` : '';
    return `<input id="${domId}" type="number" step="${step}" ${min} ${max} ${pathAttr} value="${esc(formatForInput(field, val))}" ${disabled} />`;
  }
  return `<input id="${domId}" type="text" ${pathAttr} value="${esc(formatForInput(field, val))}" ${disabled} />`;
}

/**
 * 在指定容器内渲染单个模块的完整参数编辑器
 * @param {HTMLElement} container
 * @param {object} mod module-registry 返回的模块对象
 * @param {object} [opts] { filterText?: string, formId?: string, onSaved?: Function }
 */
export function renderModuleForm(container, mod, opts = {}) {
  const filter = String(opts.filterText ?? '').trim().toLowerCase();
  const idPrefix = opts.idPrefix || `sf-${mod.id}`;
  const formId = opts.formId || `form-${mod.id}`;
  const sections = new Map();
  for (const field of mod.fields) {
    if (filter) {
      const hay = `${field.label} ${field.path} ${field.description || ''} ${field.section || ''}`.toLowerCase();
      if (!hay.includes(filter)) continue;
    }
    const sec = field.section || '基础参数';
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(field);
  }

  if (!sections.size) {
    container.innerHTML = '<div class="empty">当前模块没有匹配筛选条件的参数。</div>';
    return;
  }

  const sectionsHtml = [...sections.entries()].map(([secName, fields]) => {
    const cards = fields.map((field) => {
      const full = ['textarea', 'json', 'stringArray', 'qqList'].includes(field.type) ? ' full' : '';
      const badges = [
        field.sensitivity === 'localOnly'
          ? '<span class="pill local">仅本机 config.json</span>'
          : field.applyMode === 'restart'
            ? '<span class="pill restart">需重启生效</span>'
            : '<span class="pill hot">热更新</span>',
        field.sensitivity === 'secret' ? '<span class="pill secret">密文不回显</span>' : '',
        field.pendingRestart ? '<span class="pill pending">已落盘待重启</span>' : '',
      ].filter(Boolean).join('');
      const meta = [field.path, field.unit ? `单位：${field.unit}` : '', field.min !== undefined || field.max !== undefined ? `范围：${field.min ?? '-∞'} ~ ${field.max ?? '+∞'}` : ''].filter(Boolean).join(' · ');
      return `<div class="sf-field${full}" data-field-wrap="${esc(field.path)}">
        <div class="sf-head">
          <span class="sf-label">${esc(field.label)}</span>
          <span class="sf-badges">${badges}</span>
        </div>
        ${fieldControlHtml(field, idPrefix)}
        <div class="sf-path">${esc(meta)}</div>
        ${field.description ? `<div class="sf-desc">${esc(field.description)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="sf-section"><h4 class="sf-section-title">${esc(secName)}</h4><div class="sf-grid">${cards}</div></div>`;
  }).join('');

  container.innerHTML = `<form id="${esc(formId)}" data-module-form="${esc(mod.id)}">
    ${sectionsHtml}
    <div class="sf-savebar">
      <span class="sf-desc" data-dirty-summary>未修改（共 ${mod.fields.length} 项内部参数）</span>
      <div class="toolbar">
        <button type="button" class="btn-sm" data-action="preview">预览变更</button>
        <button type="button" class="btn-sm" data-action="reset">恢复本模块默认</button>
        <button type="submit" class="primary">保存「${esc(mod.title)}」参数</button>
      </div>
    </div>
  </form>`;

  const form = container.querySelector('form');
  const dirtyPaths = new Set();
  const clearSecrets = new Set();
  const fieldMap = new Map(mod.fields.map((f) => [f.path, f]));
  const summaryEl = form.querySelector('[data-dirty-summary]');

  const updateSummary = () => {
    summaryEl.textContent = dirtyPaths.size > 0
      ? `已修改 ${dirtyPaths.size} 项参数（点击保存立即校验并备份写盘）`
      : `未修改（共 ${mod.fields.length} 项内部参数）`;
  };

  form.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-path]');
    if (!el) return;
    const p = el.dataset.path;
    dirtyPaths.add(p);
    clearSecrets.delete(p);
    form.querySelector(`[data-field-wrap="${CSS.escape(p)}"]`)?.classList.add('dirty');
    if (el.type === 'checkbox') {
      const span = el.parentElement?.querySelector('span');
      if (span) span.textContent = el.checked ? '已开启' : '已关闭';
    }
    updateSummary();
  });

  form.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-path]');
    if (!el) return;
    const p = el.dataset.path;
    dirtyPaths.add(p);
    form.querySelector(`[data-field-wrap="${CSS.escape(p)}"]`)?.classList.add('dirty');
    updateSummary();
  });

  form.querySelectorAll('[data-clear-secret]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.clearSecret;
      const input = form.querySelector(`[data-path="${CSS.escape(p)}"]`);
      if (input) { input.value = ''; input.placeholder = '保存后将清空该密钥'; }
      clearSecrets.add(p);
      dirtyPaths.add(p);
      form.querySelector(`[data-field-wrap="${CSS.escape(p)}"]`)?.classList.add('dirty');
      updateSummary();
    });
  });

  const collectValues = () => {
    const values = {};
    const targetPaths = dirtyPaths.size > 0
      ? [...dirtyPaths]
      : mod.fields.filter((f) => f.sensitivity !== 'localOnly' && f.sensitivity !== 'secret').map((f) => f.path);
    for (const p of targetPaths) {
      const field = fieldMap.get(p);
      if (!field || field.sensitivity === 'localOnly') continue;
      if (field.sensitivity === 'secret') {
        if (clearSecrets.has(p)) values[p] = null;
        else {
          const el = form.querySelector(`[data-path="${CSS.escape(p)}"]`);
          if (el && el.value.trim()) values[p] = el.value.trim();
        }
        continue;
      }
      const el = form.querySelector(`[data-path="${CSS.escape(p)}"]`);
      if (!el) continue;
      values[p] = readInputValue(field, el);
    }
    return values;
  };

  form.querySelector('[data-action="preview"]').addEventListener('click', async () => {
    try {
      const values = collectValues();
      const res = await api(`/api/console/modules/${mod.id}`, {
        body: { revision: store.modulesCatalog?.revision, values, dryRun: true },
      });
      notify(`预检通过：将更新 ${res.changedPaths.length} 项（热更新 ${res.hotPaths.length} 项${res.requiresRestart ? '，含重启生效项' : ''}）`);
    } catch (error) {
      notify(error.message, true);
    }
  });

  form.querySelector('[data-action="reset"]').addEventListener('click', async () => {
    try {
      const res = await api(`/api/console/modules/${mod.id}`, {
        body: { revision: store.modulesCatalog?.revision, resetDefaults: true },
      });
      await store.refreshModules();
      notify(`模块「${mod.title}」已恢复默认参数${res.requiresRestart ? '（部分需重启生效）' : '并热更新'}`);
      opts.onSaved?.(res);
    } catch (error) {
      notify(error.message, true);
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    try {
      const values = collectValues();
      const res = await api(`/api/console/modules/${mod.id}`, {
        body: { revision: store.modulesCatalog?.revision, values },
      });
      await store.refreshModules();
      notify(`模块「${mod.title}」已保存（${res.changedPaths.length} 项${res.requiresRestart ? '，部分需重启生效' : '，已热更新'}）`);
      opts.onSaved?.(res);
    } catch (error) {
      notify(error.message, true);
    } finally {
      submitBtn.disabled = false;
    }
  });
}

/** 便捷组件：在任意业务面板内嵌入对应模块的折叠参数调节卡片 */
export function renderEmbeddedModulePanel(container, moduleId, { title, open = false } = {}) {
  const mod = store.getModule(moduleId);
  if (!mod) {
    container.innerHTML = '<div class="empty">模块参数尚未加载。</div>';
    return;
  }
  container.innerHTML = `<details class="panel" ${open ? 'open' : ''}>
    <summary style="cursor:pointer;font-weight:600;display:flex;justify-content:space-between;align-items:center;">
      <span>⚙ ${esc(title || `${mod.title} · 内部参数调节`)}</span>
      <span class="mod-tag">${mod.fields.length} 项参数</span>
    </summary>
    <div style="margin-top:14px;" data-embedded-body></div>
  </details>`;
  const body = container.querySelector('[data-embedded-body]');
  renderModuleForm(body, mod, {
    idPrefix: `emb-${moduleId}`,
    formId: `emb-form-${moduleId}`,
    onSaved: () => renderEmbeddedModulePanel(container, moduleId, { title, open: true }),
  });
}
