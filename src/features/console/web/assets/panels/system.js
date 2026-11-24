// 系统诊断、配置备份恢复与维护面板（含内嵌 core / dsh / snowluma 参数）
import { api, esc, notify, store } from '../api.js';
import { renderEmbeddedModulePanel } from '../schema-form.js';

export async function mountSystem(root) {
  const [sec, backups, settings] = await Promise.all([
    api('/api/console/security').catch(() => ({ stateDir: {} })),
    api('/api/console/config/backups').catch(() => ({ backups: [] })),
    api('/api/console/settings').catch(() => ({ migration: [], revision: '' })),
  ]);

  const backupList = backups.backups || [];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>系统诊断与维护</h1>
        <p>调整基础运行与上下游连接参数、管理配置备份与一键回滚、检查 state/ 目录权限并执行服务维护。</p>
      </div>
      <div class="toolbar">
        <button type="button" id="sysRehardenBtn" class="btn-sm">重试收紧 state/ ACL</button>
        <button type="button" id="sysResetWsBtn" class="danger btn-sm">清空聊天工作区</button>
        <button type="button" id="sysRestartBtn" class="danger">重启 Bridge</button>
      </div>
    </div>

    <div class="stack">
      <div class="grid-2">
        <div class="panel stack">
          <h3>state/ 目录权限与旧配置迁移</h3>
          <div class="toolbar">
            <span class="badge ${sec.stateDir?.hardened ? 'ok' : 'warn'}">ACL 状态：${sec.stateDir?.hardened ? '已收紧 (0700)' : '未确认/需检查'}</span>
            <span class="badge">旧配置待迁移项：${(settings.migration || []).length}</span>
          </div>
          ${(settings.migration || []).length ? '<button type="button" id="sysMigrateBtn" class="primary btn-sm">立即迁移旧配置键</button>' : '<div class="sf-desc">当前 config.json 已采用最新规范键，无需迁移。</div>'}
        </div>

        <div class="panel stack">
          <h3>最近配置备份（state/config-backups/）</h3>
          <div class="table-wrap" style="max-height:220px;">
            <table>
              <thead><tr><th>文件名</th><th>时间</th><th>操作</th></tr></thead>
              <tbody>
                ${backupList.slice(0, 12).map((b) => `<tr>
                  <td class="sf-path">${esc(b.name)}</td>
                  <td>${esc(new Date(b.mtimeMs).toLocaleString())}</td>
                  <td><button type="button" class="btn-sm" data-restore="${esc(b.name)}">恢复</button></td>
                </tr>`).join('') || '<tr><td colspan="3" class="empty">暂无备份</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div id="sysParamCore"></div>
      <div id="sysParamDsh"></div>
      <div id="sysParamSnowluma"></div>
    </div>
  `;

  renderEmbeddedModulePanel(root.querySelector('#sysParamCore'), 'core');
  renderEmbeddedModulePanel(root.querySelector('#sysParamDsh'), 'dsh');
  renderEmbeddedModulePanel(root.querySelector('#sysParamSnowluma'), 'snowluma');

  root.querySelector('#sysRehardenBtn').addEventListener('click', async () => {
    try { await api('/api/console/security', { body: { rehardenStateDir: true } }); notify('已重新执行 state/ ACL 收紧'); await mountSystem(root); }
    catch (error) { notify(error.message, true); }
  });

  root.querySelector('#sysMigrateBtn')?.addEventListener('click', async () => {
    try {
      await api('/api/console/migration', { body: { revision: settings.revision, apply: true } });
      await store.refreshModules();
      notify('旧配置已备份并迁移至新键');
      await mountSystem(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelectorAll('[data-restore]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api('/api/console/config/restore', { body: { name: btn.dataset.restore } });
      await store.refreshModules();
      notify(`已恢复备份 ${btn.dataset.restore}（重启生效）`);
    } catch (error) { notify(error.message, true); }
  }));

  root.querySelector('#sysResetWsBtn').addEventListener('click', async () => {
    try { await api('/api/console/workspace/reset', { body: {} }); notify('工作区会话与缓存已清空'); }
    catch (error) { notify(error.message, true); }
  });

  root.querySelector('#sysRestartBtn').addEventListener('click', async () => {
    try { await api('/api/console/restart', { body: {} }); notify('Bridge 正在重启，约 5 秒后恢复'); }
    catch (error) { notify(error.message, true); }
  });
}
