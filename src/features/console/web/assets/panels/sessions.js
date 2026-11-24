// 会话与模式管理面板（含全局模式、单会话覆盖、开场说明与内嵌调度/仿真参数）
import { api, esc, notify, store } from '../api.js';
import { renderEmbeddedModulePanel } from '../schema-form.js';

export async function mountSessions(root) {
  const [st, sys, overrides, prompts] = await Promise.all([
    store.status ? Promise.resolve(store.status) : store.refreshStatus(),
    api('/api/console/system'),
    api('/api/console/conversations').catch(() => ({ conversations: {} })),
    api('/api/console/initial-prompts').catch(() => ({ prompts: {} })),
  ]);

  const convs = sys.conversations || [];
  const modes = ['chat', 'reserved', 'reserved2', 'closed-agent'];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>会话与模式管理</h1>
        <p>切换全局运行模式、为单个群聊/私聊设置独立模式与预设、编辑开场说明并控制会话生命周期。</p>
      </div>
    </div>

    <div class="stack">
      <div class="panel">
        <h3>全局默认运行模式</h3>
        <div class="toolbar">
          ${modes.map((m) => `<button type="button" data-set-mode="${m}" class="${st.mode === m ? 'primary' : ''}">${m}</button>`).join('')}
        </div>
      </div>

      <div class="grid-2">
        <form id="overrideForm" class="panel stack">
          <h3>单会话模式 / 预设覆写</h3>
          <div class="sf-field">
            <label class="sf-label" for="overrideKey">会话 Key</label>
            <input id="overrideKey" placeholder="group:123456 或 private:10001" required />
          </div>
          <div class="sf-grid">
            <div class="sf-field">
              <label class="sf-label" for="overrideMode">独立模式</label>
              <select id="overrideMode">
                <option value="reserved2">reserved2（二代仿真）</option>
                <option value="chat">chat（普通聊天）</option>
                <option value="reserved">reserved（一代仿真）</option>
                <option value="closed-agent">closed-agent（管理员代理）</option>
              </select>
            </div>
            <div class="sf-field">
              <label class="sf-label" for="overridePreset">自定义 Preset（可选）</label>
              <input id="overridePreset" placeholder="留空按模式默认" />
            </div>
          </div>
          <div class="toolbar">
            <button type="submit" class="primary">保存会话覆写</button>
            <button type="button" id="removeOverrideBtn">恢复全局模式</button>
          </div>
        </form>

        <form id="initPromptForm" class="panel stack">
          <h3>会话开场说明（首次唤醒注入）</h3>
          <div class="sf-field">
            <label class="sf-label" for="ipKey">会话 Key</label>
            <input id="ipKey" placeholder="group:123456" required />
          </div>
          <div class="sf-field">
            <label class="sf-label" for="ipText">开场说明文本（留空保存即删除）</label>
            <textarea id="ipText" rows="4" placeholder="介绍该群背景、禁忌或说话习惯…"></textarea>
          </div>
          <div class="toolbar">
            <button type="submit" class="primary">保存开场说明</button>
          </div>
        </form>
      </div>

      <div class="panel">
        <h3>活跃会话清单（共 ${convs.length} 个）</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>会话</th><th>模式</th><th>状态</th><th>DSH Session</th><th>操作</th></tr></thead>
            <tbody>
              ${convs.length ? convs.map((c) => `<tr>
                <td><b>${esc(c.key)}</b>${overrides.conversations?.[c.key] ? ' <span class="pill hot">已覆写</span>' : ''}${prompts.prompts?.[c.key] ? ' <span class="pill secret">有开场说明</span>' : ''}</td>
                <td>${esc(c.mode || '—')}</td>
                <td>${c.busy ? '<span class="pill pending">运行中</span>' : '空闲'}</td>
                <td class="sf-path">${esc(c.sessionId || '未创建')}</td>
                <td>
                  <div class="toolbar">
                    <button type="button" class="btn-sm" data-wake="${esc(c.key)}">强制唤醒</button>
                    <button type="button" class="btn-sm" data-stop="${esc(c.key)}">停止任务</button>
                    <button type="button" class="btn-sm danger" data-reset="${esc(c.key)}">重置上下文</button>
                  </div>
                </td>
              </tr>`).join('') : '<tr><td colspan="5" class="empty">暂无会话记录</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div id="sessParamScheduler"></div>
      <div id="sessParamReserved2"></div>
      <div id="sessParamReserved1"></div>
    </div>
  `;

  renderEmbeddedModulePanel(root.querySelector('#sessParamScheduler'), 'scheduler');
  renderEmbeddedModulePanel(root.querySelector('#sessParamReserved2'), 'reserved2');
  renderEmbeddedModulePanel(root.querySelector('#sessParamReserved1'), 'reserved1');

  root.querySelectorAll('[data-set-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/console/mode', { body: { mode: btn.dataset.setMode } });
        await store.refreshStatus();
        notify(`全局模式已切换为 ${btn.dataset.setMode}`);
        await mountSessions(root);
      } catch (error) { notify(error.message, true); }
    });
  });

  root.querySelector('#overrideForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/console/conversations/set', {
        body: {
          key: root.querySelector('#overrideKey').value.trim(),
          mode: root.querySelector('#overrideMode').value,
          preset: root.querySelector('#overridePreset').value.trim(),
        },
      });
      notify('会话覆写已保存');
      await mountSessions(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#removeOverrideBtn').addEventListener('click', async () => {
    const key = root.querySelector('#overrideKey').value.trim();
    if (!key) { notify('请填写会话 Key', true); return; }
    try {
      await api('/api/console/conversations/delete', { body: { key } });
      notify('已恢复全局默认策略');
      await mountSessions(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#initPromptForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/console/initial-prompt', {
        body: { key: root.querySelector('#ipKey').value.trim(), text: root.querySelector('#ipText').value },
      });
      notify('会话开场说明已保存');
      await mountSessions(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelectorAll('[data-wake]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api('/api/console/scheduler/wake', { body: { key: btn.dataset.wake } }); notify(`已触发唤醒 ${btn.dataset.wake}`); }
    catch (error) { notify(error.message, true); }
  }));
  root.querySelectorAll('[data-stop]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api('/api/console/session/stop', { body: { key: btn.dataset.stop } }); notify(`已停止 ${btn.dataset.stop} 任务`); }
    catch (error) { notify(error.message, true); }
  }));
  root.querySelectorAll('[data-reset]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api('/api/console/session/reset', { body: { key: btn.dataset.reset } }); notify(`已重置 ${btn.dataset.reset}`); await mountSessions(root); }
    catch (error) { notify(error.message, true); }
  }));
}
