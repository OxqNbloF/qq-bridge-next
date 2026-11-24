// 角色卡、预设提示词、记忆与身份面板（含内嵌 role / memory-identity 模块参数）
import { api, esc, notify, store } from '../api.js';
import { renderEmbeddedModulePanel } from '../schema-form.js';

export async function mountPersona(root) {
  const [rolesData, identityData, termsData] = await Promise.all([
    api('/api/console/roles').catch(() => ({ roles: [], summaries: [], current: null, mode: 'active' })),
    api('/api/console/identity').catch(() => ({ people: {} })),
    api('/api/console/terms').catch(() => ({ items: [] })),
  ]);

  const roles = rolesData.roles || [];
  const people = Object.entries(identityData.people || {});

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>角色、预设与记忆身份</h1>
        <p>管理角色卡与静默状态、浏览群友身份称呼与词汇表，并直接调节角色注入与记忆/身份模块内部参数。</p>
      </div>
    </div>
    <div class="stack">
      <div class="grid-2">
        <div class="panel stack">
          <h3>当前角色与静默控制</h3>
          <div class="toolbar">
            <select id="roleSelect" style="max-width:220px;">
              <option value="">（不使用角色卡）</option>
              ${roles.map((r) => `<option value="${esc(r)}" ${rolesData.current === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            </select>
            <button type="button" id="roleApplyBtn" class="primary btn-sm">应用角色</button>
            <button type="button" id="roleSilentBtn" class="btn-sm">${rolesData.mode === 'silent' ? '退出静默' : '进入静默'}</button>
          </div>
          <form id="roleCreateForm" class="stack">
            <input id="roleNewName" placeholder="新建角色卡名称（如：小鲸鱼）" required />
            <textarea id="roleNewContent" rows="4" placeholder="输入 Markdown 角色卡内容…" required></textarea>
            <button type="submit" class="btn-sm">创建新角色卡</button>
          </form>
        </div>

        <div class="panel stack">
          <h3>身份表与词汇快照</h3>
          <div class="toolbar">
            <span class="badge">已登记身份：${people.length} 人</span>
            <span class="badge">词汇条数：${(termsData.items || []).length} 条</span>
          </div>
          <div class="table-wrap" style="max-height:240px;">
            <table>
              <thead><tr><th>QQ</th><th>称呼</th><th>别名</th></tr></thead>
              <tbody>
                ${people.slice(0, 30).map(([qq, p]) => `<tr>
                  <td class="sf-path">${esc(qq)}</td>
                  <td>${esc(p.displayName || '')}</td>
                  <td>${esc((p.aliases || []).map((a) => a.name || a).join('、'))}</td>
                </tr>`).join('') || '<tr><td colspan="3" class="empty">暂无身份记录</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div id="personaParamRole"></div>
      <div id="personaParamMemId"></div>
    </div>
  `;

  renderEmbeddedModulePanel(root.querySelector('#personaParamRole'), 'role', { open: true });
  renderEmbeddedModulePanel(root.querySelector('#personaParamMemId'), 'memory-identity');

  root.querySelector('#roleApplyBtn').addEventListener('click', async () => {
    const val = root.querySelector('#roleSelect').value;
    try {
      await api('/api/console/role', { body: { role: val || null } });
      await store.refreshStatus();
      notify(val ? `角色已切换为 ${val}` : '已清除当前角色卡');
      await mountPersona(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#roleSilentBtn').addEventListener('click', async () => {
    const nextMode = rolesData.mode === 'silent' ? 'active' : 'silent';
    try {
      await api('/api/console/role-mode', { body: { mode: nextMode } });
      await store.refreshStatus();
      notify(nextMode === 'silent' ? '已进入静默模式' : '已退出静默模式');
      await mountPersona(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#roleCreateForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/console/roles/create', {
        body: { name: root.querySelector('#roleNewName').value.trim(), content: root.querySelector('#roleNewContent').value },
      });
      notify('角色卡已创建');
      await mountPersona(root);
    } catch (error) { notify(error.message, true); }
  });
}
