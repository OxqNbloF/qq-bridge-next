const state = {
  token: sessionStorage.getItem('qqb3_token') || '',
  backends: [],
  config: null,
};

const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => [...document.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'x-console-token': state.token,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const data = await res.json();
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function showTab(tab) {
  qsa('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  qsa('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
}

qsa('.nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    showTab(btn.dataset.tab);
    void refreshAll();
  });
});

function populateModelDatalist(backendId) {
  const b = state.backends.find((x) => x.id === backendId);
  const dl = qs('#modelOptions');
  dl.replaceChildren();
  for (const m of b?.models ?? []) {
    const opt = document.createElement('option');
    opt.value = m;
    dl.appendChild(opt);
  }
}

async function refreshAll() {
  if (!state.token) return;
  try {
    const [ov, bk, cfgRes, chRes, modRes, actRes] = await Promise.all([
      api('/api/console/overview'),
      api('/api/console/backends'),
      api('/api/console/config'),
      api('/api/console/chats'),
      api('/api/console/modules'),
      api('/api/console/activity'),
    ]);

    state.backends = bk.backends;
    state.config = cfgRes.config;

    qs('#statusSummary').textContent = `后端: ${ov.runtime.activeBackend} / ${ov.runtime.activeModel || '默认'}\nOneBot: ${ov.onebot.connected ? '在线' : '离线'}\n活跃会话: ${ov.chatsCount} | Socket: ${ov.socketCount}`;

    const sel = qs('#backendSelect');
    sel.replaceChildren();
    for (const b of bk.backends) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `${b.label} (${b.id})`;
      if (b.active) opt.selected = true;
      sel.appendChild(opt);
    }
    qs('#modelInput').value = ov.runtime.activeModel || '';
    populateModelDatalist(sel.value);

    const cards = qs('#backendCards');
    cards.replaceChildren();
    for (const b of bk.backends) {
      const div = document.createElement('div');
      div.className = 'mini-card';
      div.innerHTML = `<strong>${b.label}</strong><div class="hint">ID: ${b.id} ${b.active ? '· 当前活跃' : ''}</div><div class="hint">模型: ${(b.models || []).join(', ') || 'CLI 默认'}</div>`;
      cards.appendChild(div);
    }

    renderChats(chRes.chats);
    renderModules(modRes.modules);
    fillSettings(cfgRes.config);
    qs('#activityLog').textContent = (actRes.items || []).join('\n');
  } catch (err) {
    qs('#statusSummary').textContent = `连接失败: ${err.message}`;
  }
}

function renderChats(chats) {
  const wrap = qs('#chatsTable');
  if (!chats.length) {
    wrap.textContent = '暂无已记录会话。';
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>会话</th><th>模式</th><th>覆盖后端</th><th>未读/Tokens</th><th>操作</th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  for (const c of chats) {
    const tr = document.createElement('tr');
    const modeSel = document.createElement('select');
    for (const m of ['human', 'chat', 'listen', 'off', 'admin']) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      if (c.mode === m) o.selected = true;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener('change', async () => {
      await api(`/api/console/chats/${encodeURIComponent(c.convKey)}`, { method: 'PATCH', body: { mode: modeSel.value } });
      await refreshAll();
    });

    const bkSel = document.createElement('select');
    const inheritOpt = document.createElement('option');
    inheritOpt.value = '';
    inheritOpt.textContent = '跟随全局';
    bkSel.appendChild(inheritOpt);
    for (const b of state.backends) {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.id;
      if (c.override?.backend === b.id) o.selected = true;
      bkSel.appendChild(o);
    }
    bkSel.addEventListener('change', async () => {
      await api(`/api/console/chats/${encodeURIComponent(c.convKey)}`, {
        method: 'PATCH',
        body: bkSel.value ? { backend: bkSel.value } : { clearOverride: true },
      });
      await refreshAll();
    });

    const wakeBtn = document.createElement('button');
    wakeBtn.textContent = '唤醒';
    wakeBtn.addEventListener('click', () => api(`/api/console/chats/${encodeURIComponent(c.convKey)}/wake`, { method: 'POST' }));

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '重置';
    resetBtn.className = 'danger';
    resetBtn.addEventListener('click', async () => {
      await api(`/api/console/chats/${encodeURIComponent(c.convKey)}/reset`, { method: 'POST' });
      await refreshAll();
    });

    const tdKey = document.createElement('td');
    tdKey.textContent = c.convKey;
    const tdMode = document.createElement('td');
    tdMode.appendChild(modeSel);
    const tdBk = document.createElement('td');
    tdBk.appendChild(bkSel);
    const tdStat = document.createElement('td');
    tdStat.textContent = `未读 ${c.unreadCount} · ${c.usage?.inputTokens || 0}t`;
    const tdOps = document.createElement('td');
    tdOps.append(wakeBtn, ' ', resetBtn);
    tr.append(tdKey, tdMode, tdBk, tdStat, tdOps);
    tbody.appendChild(tr);
  }
  wrap.replaceChildren(table);
}

function renderModules(modules) {
  const grid = qs('#modulesGrid');
  grid.replaceChildren();
  for (const mod of modules) {
    const label = document.createElement('label');
    label.className = 'mini-card';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = mod.name;
    cb.checked = mod.enabled;
    const title = document.createElement('strong');
    title.textContent = ` ${mod.name} (${mod.scope})`;
    const desc = document.createElement('div');
    desc.className = 'hint';
    desc.textContent = `${mod.summary} [${mod.actions.join(', ')}]`;
    const row = document.createElement('div');
    row.append(cb, title);
    label.append(row, desc);
    grid.appendChild(label);
  }
}

function fillSettings(cfg) {
  qs('#cfgOwnerQQ').value = cfg.ownerQQ || '';
  qs('#cfgPersonaName').value = cfg.persona?.name || '';
  qs('#cfgPersonaPrompt').value = cfg.persona?.prompt || '';
  qs('#cfgAllowGroups').value = (cfg.access?.allowGroups || []).join(', ');
  qs('#cfgAllowPrivate').value = (cfg.access?.allowPrivate || []).join(', ');
  qs('#cfgDefaultGroup').value = cfg.modes?.defaultGroup || 'human';
  qs('#cfgDefaultPrivate').value = cfg.modes?.defaultPrivate || 'chat';
  qs('#cfgCooldownMs').value = cfg.wake?.cooldownMs ?? 45000;
  qs('#cfgMinBatch').value = cfg.wake?.minUnreadBatch ?? 6;
  qs('#cfgCompactTokens').value = cfg.prompt?.compactThresholdTokens ?? 48000;
  qs('#cfgRateLimit').value = cfg.security?.rateLimitPerMinute ?? 20;
}

qs('#backendSelect').addEventListener('change', (e) => populateModelDatalist(e.target.value));

qs('#connectBtn').addEventListener('click', () => {
  state.token = qs('#tokenInput').value.trim();
  sessionStorage.setItem('qqb3_token', state.token);
  void refreshAll();
});

qs('#refreshBtn').addEventListener('click', () => void refreshAll());

qs('#switchRuntimeBtn').addEventListener('click', async () => {
  try {
    const backendId = qs('#backendSelect').value;
    const model = qs('#modelInput').value.trim();
    await api('/api/console/runtime', { method: 'POST', body: { backendId, model } });
    qs('#runtimeMsg').textContent = `已热切换到 ${backendId} (${model || '默认模型'})`;
    await refreshAll();
  } catch (err) {
    qs('#runtimeMsg').textContent = err.message;
  }
});

qs('#checkHealthBtn').addEventListener('click', async () => {
  try {
    const id = qs('#backendSelect').value;
    const res = await api(`/api/console/backends/${encodeURIComponent(id)}/health`, { method: 'POST' });
    qs('#runtimeMsg').textContent = `${id}: ${res.ok ? '正常' : '异常'} — ${res.detail}`;
  } catch (err) {
    qs('#runtimeMsg').textContent = err.message;
  }
});

qs('#saveModulesBtn').addEventListener('click', async () => {
  const checked = qsa('#modulesGrid input[type="checkbox"]:checked').map((x) => x.value);
  await api('/api/console/modules', { method: 'PUT', body: { enabledModules: checked } });
  qs('#modulesMsg').textContent = `已授权模块: ${checked.join(', ') || '全部禁用'}`;
  await refreshAll();
});

qs('#saveSettingsBtn').addEventListener('click', async () => {
  const splitIds = (v) => v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  await api('/api/console/config', {
    method: 'PATCH',
    body: {
      ownerQQ: qs('#cfgOwnerQQ').value.trim(),
      persona: {
        name: qs('#cfgPersonaName').value.trim() || '群友',
        prompt: qs('#cfgPersonaPrompt').value,
      },
      access: {
        allowGroups: splitIds(qs('#cfgAllowGroups').value),
        allowPrivate: splitIds(qs('#cfgAllowPrivate').value),
      },
      modes: {
        defaultGroup: qs('#cfgDefaultGroup').value,
        defaultPrivate: qs('#cfgDefaultPrivate').value,
      },
      wake: {
        cooldownMs: Number(qs('#cfgCooldownMs').value) || 45000,
        minUnreadBatch: Number(qs('#cfgMinBatch').value) || 6,
      },
      prompt: {
        compactThresholdTokens: Number(qs('#cfgCompactTokens').value) || 48000,
      },
      security: {
        rateLimitPerMinute: Number(qs('#cfgRateLimit').value) || 20,
      },
    },
  });
  qs('#settingsMsg').textContent = '已保存并热生效（对所有后端通用）';
  await refreshAll();
});

if (state.token) {
  qs('#tokenInput').value = state.token;
  void refreshAll();
}
