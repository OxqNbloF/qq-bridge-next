const STORAGE_KEY = 'relay_control_secret';
const ROOM_MODES = ['muted', 'observer', 'direct', 'ambient', 'operator'];

const el = (id) => document.getElementById(id);
let cachedEngines = [];

function getSecret() {
  return sessionStorage.getItem(STORAGE_KEY) || '';
}

function setSecret(val) {
  const clean = String(val || '').trim();
  if (clean) sessionStorage.setItem(STORAGE_KEY, clean);
  else sessionStorage.removeItem(STORAGE_KEY);
}

async function api(path, options = {}) {
  const secret = getSecret();
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-control-secret': secret,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function setStatus(ok, label) {
  const badge = el('statusBadge');
  badge.textContent = label;
  badge.className = `badge ${ok ? 'ok' : 'muted'}`;
}

function syncModelOptions(engineId) {
  const dl = el('modelOptions');
  dl.replaceChildren();
  const match = cachedEngines.find((e) => e.id === engineId);
  for (const m of match?.models || []) {
    const opt = document.createElement('option');
    opt.value = m;
    dl.appendChild(opt);
  }
}

function renderEngines(data) {
  cachedEngines = data.engines || [];
  const sel = el('engineSelect');
  sel.replaceChildren();
  for (const eng of cachedEngines) {
    const opt = document.createElement('option');
    opt.value = eng.id;
    opt.textContent = `${eng.id} — ${eng.label}`;
    if (eng.id === data.active) opt.selected = true;
    sel.appendChild(opt);
  }
  el('modelInput').value = data.model || '';
  syncModelOptions(data.active);
}

function renderCapabilities(data) {
  const grid = el('capabilitiesGrid');
  grid.replaceChildren();
  const enabled = new Set(data.enabledCapabilities || []);
  for (const cap of data.available || []) {
    const card = document.createElement('label');
    card.className = 'cap-card';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = cap.name;
    cb.checked = enabled.has(cap.name);
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${cap.name}${cap.network ? ' [公网]' : ''}`;
    const desc = document.createElement('div');
    desc.textContent = cap.summary || '';
    info.append(title, desc);
    card.append(cb, info);
    grid.appendChild(card);
  }
}

function renderRooms(rooms) {
  const body = el('roomsBody');
  body.replaceChildren();
  for (const r of rooms) {
    const tr = document.createElement('tr');
    const idTd = document.createElement('td');
    idTd.textContent = r.roomId;

    const modeTd = document.createElement('td');
    const modeSel = document.createElement('select');
    for (const m of ROOM_MODES) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === r.mode) opt.selected = true;
      modeSel.appendChild(opt);
    }
    modeSel.addEventListener('change', async () => {
      await api(`/api/control/rooms/${encodeURIComponent(r.roomId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ mode: modeSel.value }),
      });
      await refreshAll();
    });
    modeTd.appendChild(modeSel);

    const engTd = document.createElement('td');
    engTd.textContent = `${r.engineId}${r.model ? ` / ${r.model}` : ''}`;

    const statTd = document.createElement('td');
    statTd.textContent = `${r.unreadCount} / ${r.readCursor}`;

    const actTd = document.createElement('td');
    const trigBtn = document.createElement('button');
    trigBtn.type = 'button';
    trigBtn.textContent = '立即唤醒';
    trigBtn.addEventListener('click', () => api(`/api/control/rooms/${encodeURIComponent(r.roomId)}/trigger`, { method: 'POST', body: '{}' }).then(refreshAll));
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'secondary';
    resetBtn.textContent = '重置会话';
    resetBtn.addEventListener('click', () => api(`/api/control/rooms/${encodeURIComponent(r.roomId)}/reset`, { method: 'POST', body: '{}' }).then(refreshAll));
    actTd.append(trigBtn, document.createTextNode(' '), resetBtn);

    tr.append(idTd, modeTd, engTd, statTd, actTd);
    body.appendChild(tr);
  }
}

function renderPersonas(data) {
  const sel = el('activePersonaSelect');
  sel.replaceChildren();
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(无全局人设卡)';
  sel.appendChild(noneOpt);
  for (const item of data.items || []) {
    const opt = document.createElement('option');
    opt.value = item.name;
    opt.textContent = `${item.name} (${item.chars}字)`;
    if (item.name === data.active) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderGlossary(items) {
  const list = el('glossaryList');
  list.replaceChildren();
  for (const it of items) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `[${it.scope}] ${it.term}: ${it.meaning}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary';
    del.textContent = '删';
    del.addEventListener('click', () => api(`/api/control/glossary/${encodeURIComponent(it.id)}`, { method: 'DELETE' }).then(refreshAll));
    li.append(text, del);
    list.appendChild(li);
  }
}

function renderActivity(items) {
  const list = el('activityList');
  list.replaceChildren();
  for (const it of (items || []).slice(0, 30)) {
    const li = document.createElement('li');
    li.textContent = `${new Date(it.ts).toLocaleTimeString()} [${it.type}] ${it.roomId || ''} ${it.reason || it.engineId || ''}`.trim();
    list.appendChild(li);
  }
}

async function refreshAll() {
  try {
    const [engines, caps, rooms, personas, glossary, activity] = await Promise.all([
      api('/api/control/engines'),
      api('/api/control/capabilities'),
      api('/api/control/rooms'),
      api('/api/control/personas'),
      api('/api/control/glossary'),
      api('/api/control/activity'),
    ]);
    setStatus(true, '已连接控制面');
    renderEngines(engines);
    renderCapabilities(caps);
    renderRooms(rooms.rooms || []);
    renderPersonas(personas);
    renderGlossary(glossary.items || []);
    renderActivity(activity.items || []);
  } catch (err) {
    setStatus(false, err.message);
  }
}

el('connectBtn').addEventListener('click', () => {
  setSecret(el('secretInput').value);
  void refreshAll();
});

el('engineSelect').addEventListener('change', (ev) => syncModelOptions(ev.target.value));

el('switchEngineBtn').addEventListener('click', async () => {
  await api('/api/control/active-engine', {
    method: 'PUT',
    body: JSON.stringify({ engineId: el('engineSelect').value, model: el('modelInput').value.trim() }),
  });
  await refreshAll();
});

el('healthBtn').addEventListener('click', async () => {
  const res = await api(`/api/control/engines/${encodeURIComponent(el('engineSelect').value)}/health`);
  el('engineHealthOut').textContent = JSON.stringify(res, null, 2);
});

el('saveCapsBtn').addEventListener('click', async () => {
  const checked = [...el('capabilitiesGrid').querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
  await api('/api/control/capabilities', {
    method: 'PUT',
    body: JSON.stringify({ enabledCapabilities: checked }),
  });
  await refreshAll();
});

el('savePersonaBtn').addEventListener('click', async () => {
  await api('/api/control/personas', {
    method: 'POST',
    body: JSON.stringify({ name: el('personaNameInput').value.trim(), content: el('personaBodyInput').value }),
  });
  await refreshAll();
});

el('setActivePersonaBtn').addEventListener('click', async () => {
  await api('/api/control/personas/active', {
    method: 'PUT',
    body: JSON.stringify({ name: el('activePersonaSelect').value }),
  });
  await refreshAll();
});

el('saveGroupRuleBtn').addEventListener('click', async () => {
  const gid = el('memberGroupInput').value.trim();
  await api(`/api/control/member-rules/${encodeURIComponent(gid)}`, {
    method: 'PUT',
    body: JSON.stringify({ mode: el('memberPolicyMode').value }),
  });
  await refreshAll();
});

el('saveMemberRuleBtn').addEventListener('click', async () => {
  const gid = el('memberGroupInput').value.trim();
  const mid = el('memberIdInput').value.trim();
  await api(`/api/control/member-rules/${encodeURIComponent(gid)}/members/${encodeURIComponent(mid)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      canTrigger: el('capTrigger').checked,
      canEngage: el('capEngage').checked,
      inContext: el('capContext').checked,
      inMemory: el('capMemory').checked,
    }),
  });
  await refreshAll();
});

el('addGlossaryBtn').addEventListener('click', async () => {
  await api('/api/control/glossary', {
    method: 'POST',
    body: JSON.stringify({ term: el('termKeyInput').value, meaning: el('termDescInput').value, scope: 'global' }),
  });
  el('termKeyInput').value = '';
  el('termDescInput').value = '';
  await refreshAll();
});

const saved = getSecret();
if (saved) {
  el('secretInput').value = saved;
  void refreshAll();
}
