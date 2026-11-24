// 门禁与成员四开关策略面板（含内嵌 gate 模块全部参数）
import { api, esc, notify, store } from '../api.js';
import { renderEmbeddedModulePanel } from '../schema-form.js';

let currentPolicy = null;

export async function mountGate(root) {
  if (!store.modulesCatalog) await store.refreshModules();
  const groups = store.status?.allowGroups || [];
  const defaultGroup = currentPolicy?.group || (groups[0] ? `group:${groups[0]}` : '');

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>门禁与成员策略</h1>
        <p>管理白/黑名单、忽略发送者、管理员 QQ、gateV2 开关以及群内单成员四开关规则（回应 / 对话 / 上下文 / 记忆）。</p>
      </div>
    </div>
    <div class="stack">
      <div id="gateModuleParams"></div>

      <div class="panel stack">
        <h3>群成员四开关策略（gateV2）</h3>
        <div class="toolbar">
          <input id="gateGroupInput" style="max-width:260px;" placeholder="输入群号或 group:群号" value="${esc(defaultGroup)}" />
          <button type="button" id="gateLoadBtn" class="primary">加载群策略</button>
          <button type="button" id="gateExportCsvBtn" class="btn-sm">导出 CSV</button>
        </div>
        <div id="gatePolicyArea" class="empty">点击「加载群策略」查看或编辑成员规则。</div>
      </div>
    </div>
  `;

  renderEmbeddedModulePanel(root.querySelector('#gateModuleParams'), 'gate', { open: true });

  const renderPolicyArea = (data) => {
    currentPolicy = data;
    const area = root.querySelector('#gatePolicyArea');
    const entries = data.entries || [];
    area.className = 'stack';
    area.innerHTML = `
      <div class="toolbar">
        <span class="badge">${esc(data.group)}</span>
        <span class="badge ${data.gateV2 ? 'ok' : 'warn'}">${data.gateV2 ? 'gateV2 已启用' : 'gateV2 未开启，策略暂不生效'}</span>
        <select id="gateModeSel" style="max-width:180px;">
          <option value="all" ${data.mode === 'all' ? 'selected' : ''}>all（默认全放行）</option>
          <option value="blacklist" ${data.mode === 'blacklist' ? 'selected' : ''}>blacklist（黑名单模式）</option>
          <option value="whitelist" ${data.mode === 'whitelist' ? 'selected' : ''}>whitelist（白名单模式）</option>
        </select>
        <button type="button" id="gateSaveModeBtn" class="primary btn-sm">保存群模式</button>
      </div>
      <form id="gateAddMemberForm" class="toolbar">
        <input id="gateNewQq" style="max-width:160px;" placeholder="成员 QQ" required />
        <label class="sf-toggle"><input type="checkbox" id="fRespond" checked />回应</label>
        <label class="sf-toggle"><input type="checkbox" id="fConverse" checked />对话</label>
        <label class="sf-toggle"><input type="checkbox" id="fContext" checked />上下文</label>
        <label class="sf-toggle"><input type="checkbox" id="fMemory" checked />记忆</label>
        <input id="gateNewNote" style="max-width:180px;" placeholder="备注（可选）" />
        <button type="submit" class="btn-sm primary">添加/更新成员</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>QQ</th><th>回应</th><th>对话</th><th>上下文</th><th>记忆</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>
            ${entries.length ? entries.map((e) => `<tr>
              <td><b>${esc(e.qq)}</b></td>
              <td>${e.flags?.respond !== false ? '✓' : '✕'}</td>
              <td>${e.flags?.converse !== false ? '✓' : '✕'}</td>
              <td>${e.flags?.context !== false ? '✓' : '✕'}</td>
              <td>${e.flags?.memory !== false ? '✓' : '✕'}</td>
              <td>${esc(e.note || '')}</td>
              <td><button type="button" class="btn-sm danger" data-del-qq="${esc(e.qq)}">删除</button></td>
            </tr>`).join('') : '<tr><td colspan="7" class="empty">当前群暂无自定义成员规则</td></tr>'}
          </tbody>
        </table>
      </div>
    `;

    area.querySelector('#gateSaveModeBtn').addEventListener('click', async () => {
      const mode = area.querySelector('#gateModeSel').value;
      const rules = Object.fromEntries((currentPolicy.entries || []).map((e) => [e.qq, { flags: e.flags, aliases: e.aliases, note: e.note }]));
      try {
        const res = await api(`/api/console/gate/member-policy/${encodeURIComponent(currentPolicy.group.slice(6))}`, {
          method: 'PUT',
          body: { mode, rules, expectedUpdatedAt: currentPolicy.updatedAt ?? null },
        });
        notify('群门禁模式已保存');
        renderPolicyArea(res);
      } catch (error) { notify(error.message, true); }
    });

    area.querySelector('#gateAddMemberForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const qq = area.querySelector('#gateNewQq').value.trim();
      const flags = {
        respond: area.querySelector('#fRespond').checked,
        converse: area.querySelector('#fConverse').checked,
        context: area.querySelector('#fContext').checked,
        memory: area.querySelector('#fMemory').checked,
      };
      const note = area.querySelector('#gateNewNote').value.trim();
      try {
        const res = await api(`/api/console/gate/member-policy/${encodeURIComponent(currentPolicy.group.slice(6))}/members/${encodeURIComponent(qq)}`, {
          method: 'PATCH',
          body: { flags, ...(note ? { note } : {}), expectedUpdatedAt: currentPolicy.updatedAt ?? null },
        });
        notify(`已更新成员 ${qq} 策略`);
        renderPolicyArea(res);
      } catch (error) { notify(error.message, true); }
    });

    area.querySelectorAll('[data-del-qq]').forEach((btn) => btn.addEventListener('click', async () => {
      const qq = btn.dataset.delQq;
      const q = `confirm=true&expectedUpdatedAt=${encodeURIComponent(currentPolicy.updatedAt ?? '')}`;
      try {
        const res = await api(`/api/console/gate/member-policy/${encodeURIComponent(currentPolicy.group.slice(6))}/members/${encodeURIComponent(qq)}?${q}`, { method: 'DELETE' });
        notify(`已删除成员 ${qq} 规则`);
        renderPolicyArea(res);
      } catch (error) { notify(error.message, true); }
    }));
  };

  root.querySelector('#gateLoadBtn').addEventListener('click', async () => {
    const g = root.querySelector('#gateGroupInput').value.trim();
    if (!g) { notify('请输入群号', true); return; }
    try {
      const data = await api(`/api/console/gate/member-policy?group=${encodeURIComponent(g)}`);
      renderPolicyArea(data);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#gateExportCsvBtn').addEventListener('click', async () => {
    const g = root.querySelector('#gateGroupInput').value.trim();
    if (!g) { notify('请输入群号', true); return; }
    try {
      const csv = await api(`/api/console/gate/member-policy/export?group=${encodeURIComponent(g)}&format=csv`, { rawText: true });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${g.replace(':', '-')}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) { notify(error.message, true); }
  });
}
