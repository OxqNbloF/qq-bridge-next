// 总览与快捷指令台面板
import { api, esc, notify, store } from '../api.js';

export async function mountOverview(root) {
  const st = store.status || await store.refreshStatus();
  const sl = st.snowluma || {};
  const paused = st.socialV2Paused === true;
  const activityLines = Array.isArray(st.activity) ? st.activity : [];
  const targets = [
    ...(st.allowGroups || []).map((g) => `group:${g}`),
    ...(st.allowPrivate || []).map((p) => `private:${p}`),
  ];

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>工作台总览</h1>
        <p>实时掌握 DSH、SnowLuma 连接状态与调度活动，支持直接向会话下发后台指令。</p>
      </div>
      <div class="toolbar">
        <button type="button" id="ovPauseBtn" class="${paused ? 'primary' : ''}">${paused ? '恢复二代自动调度' : '暂停二代自动调度'}</button>
        <button type="button" id="ovStopBtn" class="danger">停止当前会话任务</button>
      </div>
    </div>

    <div class="grid-4">
      <div class="metric">
        <span>DSH 引擎</span>
        <strong id="dshMetric">${st.dshReady ? '已连接' : '离线'}</strong>
        <small>当前模式：${esc(st.mode || '—')}</small>
      </div>
      <div class="metric">
        <span>SnowLuma 网关</span>
        <strong>${sl.connected === false ? '已断开' : sl.confirmed ? '接收异常' : '在线'}</strong>
        <small>${esc(sl.hint || (sl.lastPacketKind ? `最近事件：${sl.lastPacketKind}` : '等待事件包'))}</small>
      </div>
      <div class="metric">
        <span>当前角色与状态</span>
        <strong>${esc(st.role || '无角色卡')}</strong>
        <small>${st.roleMode === 'silent' ? '静默模式（仅管理员）' : '活跃接话模式'}</small>
      </div>
      <div class="metric">
        <span>模块参数中心</span>
        <strong>${store.modulesCatalog?.modules?.length ?? 12} 模块</strong>
        <small>${(store.modulesCatalog?.pendingRestartCount ?? 0) > 0 ? `${store.modulesCatalog.pendingRestartCount} 项改动待重启生效` : '运行态与磁盘配置一致'}</small>
      </div>
    </div>

    <div class="grid-2">
      <form id="commandForm" class="panel stack">
        <h3>向指定会话投递 DSH 后台指令</h3>
        <div class="sf-field">
          <label class="sf-label" for="target">目标会话</label>
          <input id="target" list="ovTargets" placeholder="group:群号 或 private:QQ号" value="${esc(targets[0] || '')}" required />
          <datalist id="ovTargets">${targets.map((t) => `<option value="${esc(t)}"></option>`).join('')}</datalist>
        </div>
        <div class="sf-field">
          <label class="sf-label" for="command">指令或引导内容</label>
          <textarea id="command" rows="4" placeholder="给 AI 一条后台提醒或下一步行动指示…" required maxlength="12000"></textarea>
        </div>
        <div class="toolbar">
          <button type="submit" class="primary">投递到 DSH</button>
          <button type="button" id="ovTestSendBtn">直接测试发 QQ</button>
        </div>
      </form>

      <div class="panel">
        <h3>最近运行活动（尾部 100 条）</h3>
        <div class="log-box">${activityLines.length ? esc(activityLines.join('\n')) : '暂无活动记录'}</div>
      </div>
    </div>
  `;

  root.querySelector('#ovPauseBtn').addEventListener('click', async () => {
    try {
      const res = await api('/api/console/scheduler/activity', { body: { paused: !paused } });
      await store.refreshStatus();
      notify(res.paused ? '已暂停二代自动调度' : '已恢复二代自动调度');
      await mountOverview(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#ovStopBtn').addEventListener('click', async () => {
    const key = root.querySelector('#target').value.trim();
    if (!key) { notify('请先填写目标会话 key', true); return; }
    try {
      await api('/api/console/session/stop', { body: { key } });
      notify(`已停止 ${key} 的当前 DSH 任务`);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#commandForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const key = root.querySelector('#target').value.trim();
    const message = root.querySelector('#command').value.trim();
    try {
      await api('/api/console/notify-ai', { body: { key, message } });
      root.querySelector('#command').value = '';
      notify(`后台指令已投递至 ${key}`);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#ovTestSendBtn').addEventListener('click', async () => {
    const key = root.querySelector('#target').value.trim();
    const message = root.querySelector('#command').value.trim();
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m || !message) { notify('请填写合法的会话 key 和消息内容', true); return; }
    try {
      await api('/api/console/test-send', { body: { kind: m[1], id: m[2], message } });
      notify(`测试消息已发往 ${key}`);
    } catch (error) { notify(error.message, true); }
  });
}
