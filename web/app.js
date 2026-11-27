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
    const [ov, bk, cfgRes, chRes, modRes, actRes, rolesRes, gateRes, termsRes, idRes, stRes, vcRes] = await Promise.all([
      api('/api/console/overview'),
      api('/api/console/backends'),
      api('/api/console/config'),
      api('/api/console/chats'),
      api('/api/console/modules'),
      api('/api/console/activity'),
      api('/api/console/roles'),
      api('/api/console/gate/members'),
      api('/api/console/terms'),
      api('/api/console/identity'),
      api('/api/console/stickers'),
      api('/api/console/voices'),
    ]);

    state.backends = bk.backends;
    state.config = cfgRes.config;

    qs('#statusSummary').textContent = `后端: ${ov.runtime.activeBackend} / ${ov.runtime.activeModel || '默认'}\nOneBot: ${ov.onebot.connected ? '在线' : '离线'}\n活跃会话: ${ov.chatsCount} | 开放模块: ${ov.enabledModules.length}`;

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
    renderGate(gateRes);
    renderRolesAndTerms(rolesRes, termsRes, idRes);
    renderMedia(stRes, vcRes);
    renderModules(modRes.modules);
    fillSettings(cfgRes.config);
    qs('#activityLog').textContent = (actRes.items || []).join('\n');
  } catch (err) {
    qs('#statusSummary').textContent = `连接失败: ${err.message}`;
  }
}

function renderChats(chats) {
  const wrap = qs('#chatsTable');
  if (!chats.length) { wrap.textContent = '暂无已记录会话。'; return; }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>会话</th><th>模式</th><th>覆盖后端</th><th>未读/Tokens</th><th>操作</th></tr></thead><tbody></tbody>';
  const tbody = table.querySelector('tbody');
  for (const c of chats) {
    const tr = document.createElement('tr');
    const modeSel = document.createElement('select');
    for (const m of ['human', 'chat', 'listen', 'off', 'admin']) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (c.mode === m) o.selected = true;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener('change', async () => {
      await api(`/api/console/chats/${encodeURIComponent(c.convKey)}`, { method: 'PATCH', body: { mode: modeSel.value } });
      await refreshAll();
    });

    const bkSel = document.createElement('select');
    const inheritOpt = document.createElement('option');
    inheritOpt.value = ''; inheritOpt.textContent = '跟随全局';
    bkSel.appendChild(inheritOpt);
    for (const b of state.backends) {
      const o = document.createElement('option');
      o.value = b.id; o.textContent = b.id;
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

    const tdKey = document.createElement('td'); tdKey.textContent = c.convKey;
    const tdMode = document.createElement('td'); tdMode.appendChild(modeSel);
    const tdBk = document.createElement('td'); tdBk.appendChild(bkSel);
    const tdStat = document.createElement('td'); tdStat.textContent = `未读 ${c.unreadCount} · ${c.usage?.inputTokens || 0}t`;
    const tdOps = document.createElement('td'); tdOps.append(wakeBtn, ' ', resetBtn);
    tr.append(tdKey, tdMode, tdBk, tdStat, tdOps);
    tbody.appendChild(tr);
  }
  wrap.replaceChildren(table);
}

function renderGate(gateRes) {
  qs('#gateEnabledToggle').checked = gateRes.enabled === true;
  const view = qs('#gateGroupsView');
  if (!gateRes.groups?.length) { view.textContent = '暂未设置群成员门禁覆盖。'; return; }
  const cards = [];
  for (const g of gateRes.groups) {
    const div = document.createElement('div');
    div.className = 'mini-card';
    const members = Object.entries(g.members || {}).map(([qq, f]) => `${qq}(r:${f.respond},c:${f.converse},ctx:${f.context},mem:${f.memory})`).join(', ') || '无成员规则';
    div.innerHTML = `<strong>群 ${g.groupId} [${g.mode}]</strong><div class="hint">${members}</div>`;
    cards.push(div);
  }
  view.replaceChildren(...cards);
}

function renderRolesAndTerms(rolesRes, termsRes, idRes) {
  const sel = qs('#activeRoleSelect');
  sel.replaceChildren();
  const noneOpt = document.createElement('option');
  noneOpt.value = ''; noneOpt.textContent = '(不启用角色卡，使用兜底提示词)';
  sel.appendChild(noneOpt);
  for (const r of rolesRes.roles || []) {
    const o = document.createElement('option');
    o.value = r.name; o.textContent = `${r.name} (${r.chars}字)`;
    if (r.active) o.selected = true;
    sel.appendChild(o);
  }

  const tWrap = qs('#termsList');
  tWrap.replaceChildren();
  for (const it of termsRes.items || []) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = `[${it.scope}] ${it.term} → ${it.meaning} `;
    const del = document.createElement('button');
    del.textContent = '删除'; del.className = 'secondary';
    del.addEventListener('click', async () => {
      await api(`/api/console/terms/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
      await refreshAll();
    });
    row.appendChild(del);
    tWrap.appendChild(row);
  }

  const idWrap = qs('#identityList');
  idWrap.replaceChildren();
  for (const p of (idRes.profiles || []).slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = `QQ ${p.userId} (${p.ref}) · 昵称: ${(p.globalNames || []).join('/')} · 别名: ${JSON.stringify(p.aliases || {})}`;
    idWrap.appendChild(row);
  }
}

function renderMedia(stRes, vcRes) {
  const sWrap = qs('#stickersList');
  sWrap.replaceChildren();
  for (const s of stRes.stickers || []) {
    const div = document.createElement('div');
    div.className = 'mini-card';
    div.textContent = `${s.id} ${s.remark ? `(${s.remark})` : ''} · 已用 ${s.usedCount}`;
    sWrap.appendChild(div);
  }
  const vWrap = qs('#voicesList');
  vWrap.replaceChildren();
  for (const v of vcRes.voices || []) {
    const div = document.createElement('div');
    div.className = 'mini-card';
    div.textContent = `${v.path} (${Math.round((v.bytes || 0) / 1024)} KB)`;
    vWrap.appendChild(div);
  }
}

function renderModules(modules) {
  const grid = qs('#modulesGrid');
  grid.replaceChildren();
  for (const mod of modules) {
    const label = document.createElement('label');
    label.className = 'mini-card';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = mod.name; cb.checked = mod.enabled;
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
  qs('#cfgVoiceEnabled').checked = cfg.voice?.enabled === true;
  qs('#cfgExposeQq').checked = cfg.identity?.exposeQqInPrompt === true;
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
  } catch (err) { qs('#runtimeMsg').textContent = err.message; }
});

qs('#checkHealthBtn').addEventListener('click', async () => {
  try {
    const id = qs('#backendSelect').value;
    const res = await api(`/api/console/backends/${encodeURIComponent(id)}/health`, { method: 'POST' });
    qs('#runtimeMsg').textContent = `${id}: ${res.ok ? '正常' : '异常'} — ${res.detail}`;
  } catch (err) { qs('#runtimeMsg').textContent = err.message; }
});

qs('#saveGateToggleBtn').addEventListener('click', async () => {
  await api('/api/console/config', { method: 'PATCH', body: { gate: { enabled: qs('#gateEnabledToggle').checked } } });
  qs('#gateMsg').textContent = '已更新 gateV2 总开关';
  await refreshAll();
});

qs('#saveGateGroupBtn').addEventListener('click', async () => {
  const gid = qs('#gateGroupId').value.trim();
  await api(`/api/console/gate/members/${encodeURIComponent(gid)}`, {
    method: 'PUT',
    body: { mode: qs('#gateGroupMode').value },
  });
  qs('#gateMsg').textContent = `已更新群 ${gid} 门禁模式`;
  await refreshAll();
});

qs('#saveGateMemberBtn').addEventListener('click', async () => {
  const gid = qs('#gateGroupId').value.trim();
  const qq = qs('#gateMemberQq').value.trim();
  const preset = qs('#gatePresetFlags').value;
  const flags = preset === 'allow'
    ? { respond: true, converse: true, context: true, memory: true }
    : (preset === 'lurk'
      ? { respond: false, converse: false, context: true, memory: true }
      : { respond: false, converse: false, context: false, memory: false });
  await api(`/api/console/gate/members/${encodeURIComponent(gid)}/${encodeURIComponent(qq)}`, { method: 'PATCH', body: flags });
  qs('#gateMsg').textContent = `已保存成员 ${qq} 策略`;
  await refreshAll();
});

qs('#saveRoleBtn').addEventListener('click', async () => {
  const name = qs('#roleNameInput').value.trim();
  await api(`/api/console/roles/${encodeURIComponent(name)}`, { method: 'PUT', body: { content: qs('#roleContentInput').value } });
  qs('#roleMsg').textContent = `已保存角色卡: ${name}`;
  await refreshAll();
});

qs('#activateRoleBtn').addEventListener('click', async () => {
  const name = qs('#activeRoleSelect').value;
  await api('/api/console/roles/active', { method: 'POST', body: { name } });
  qs('#roleMsg').textContent = name ? `已激活角色卡: ${name}` : '已关闭全局角色卡';
  await refreshAll();
});

qs('#addTermBtn').addEventListener('click', async () => {
  await api('/api/console/terms', {
    method: 'POST',
    body: {
      term: qs('#termNameInput').value.trim(),
      meaning: qs('#termMeaningInput').value.trim(),
      convKey: qs('#termScopeInput').value.trim() || 'global',
    },
  });
  await refreshAll();
});

qs('#addAliasBtn').addEventListener('click', async () => {
  await api('/api/console/identity/alias', {
    method: 'POST',
    body: { userId: qs('#aliasQqInput').value.trim(), alias: qs('#aliasNameInput').value.trim(), convKey: 'global' },
  });
  await refreshAll();
});

qs('#syncStickersBtn').addEventListener('click', async () => {
  const res = await api('/api/console/stickers/sync', { method: 'POST' });
  qs('#mediaMsg').textContent = `同步完成：共 ${res.count} 个（新增 ${res.added || 0}）`;
  await refreshAll();
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
      persona: { name: qs('#cfgPersonaName').value.trim() || '群友', prompt: qs('#cfgPersonaPrompt').value },
      access: { allowGroups: splitIds(qs('#cfgAllowGroups').value), allowPrivate: splitIds(qs('#cfgAllowPrivate').value) },
      modes: { defaultGroup: qs('#cfgDefaultGroup').value, defaultPrivate: qs('#cfgDefaultPrivate').value },
      wake: { cooldownMs: Number(qs('#cfgCooldownMs').value) || 45000, minUnreadBatch: Number(qs('#cfgMinBatch').value) || 6 },
      prompt: { compactThresholdTokens: Number(qs('#cfgCompactTokens').value) || 48000 },
      security: { rateLimitPerMinute: Number(qs('#cfgRateLimit').value) || 20 },
      voice: { enabled: qs('#cfgVoiceEnabled').checked },
      identity: { exposeQqInPrompt: qs('#cfgExposeQq').checked },
    },
  });
  qs('#settingsMsg').textContent = '已保存并热生效（对所有后端通用）';
  await refreshAll();
});

if (state.token) {
  qs('#tokenInput').value = state.token;
  void refreshAll();
}
