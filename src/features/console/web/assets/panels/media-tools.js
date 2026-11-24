// 媒体、表情、语音、工具与用量面板（含内嵌 media / sticker-voice / search-pricing-security 参数）
import { api, esc, notify } from '../api.js';
import { renderEmbeddedModulePanel } from '../schema-form.js';

export async function mountMediaTools(root) {
  const [usage, stickers, voices] = await Promise.all([
    api('/api/console/tokens/summary?limit=50').catch(() => null),
    api('/api/console/stickers?count=24').catch(() => ({ items: [], total: 0 })),
    api('/api/console/voice/list').catch(() => ({ files: [] })),
  ]);

  const totals = usage?.total || {};
  const sym = usage?.symbol || '¥';
  const costText = `${sym}${Number(totals.cost || 0).toFixed(4)}`;

  root.innerHTML = `
    <div class="page-head">
      <div>
        <h1>媒体、工具与用量</h1>
        <p>查看 Token 账本与费用估算、同步表情库、试发语音，并直接调节媒体归一化、表情/语音、29 项工具开关与搜索/价目参数。</p>
      </div>
      <div class="toolbar">
        <button type="button" id="syncStickersBtn" class="btn-sm">同步 QQ 表情库</button>
      </div>
    </div>

    <div class="stack">
      <div class="grid-4">
        <div class="metric"><span>累计估算花费</span><strong>${esc(costText)}</strong><small>账本记录</small></div>
        <div class="metric"><span>累计会话数</span><strong>${esc(usage?.conversations?.length ?? 0)}</strong><small>按会话统计</small></div>
        <div class="metric"><span>收藏表情数</span><strong>${esc(stickers.total ?? stickers.items?.length ?? 0)}</strong><small>本地表情库</small></div>
        <div class="metric"><span>本地语音文件</span><strong>${esc(voices.files?.length ?? 0)}</strong><small>语音库</small></div>
      </div>

      <div class="panel stack">
        <h3>快速试发本地语音条</h3>
        <form id="voiceQuickForm" class="toolbar">
          <input id="vqTarget" style="max-width:220px;" placeholder="目标会话 group:群号 / private:QQ" required />
          <select id="vqFile" style="max-width:260px;">
            ${(voices.files || []).map((f) => `<option value="${esc(f.name)}">${esc(f.name)}</option>`).join('') || '<option value="">（语音库为空）</option>'}
          </select>
          <label class="sf-toggle"><input type="checkbox" id="vqDryRun" checked />仅预检 (dryRun)</label>
          <button type="submit" class="primary btn-sm">执行发送</button>
        </form>
      </div>

      <div id="mtParamMedia"></div>
      <div id="mtParamStickerVoice"></div>
      <div id="mtParamSearchPricing"></div>
    </div>
  `;

  renderEmbeddedModulePanel(root.querySelector('#mtParamMedia'), 'media');
  renderEmbeddedModulePanel(root.querySelector('#mtParamStickerVoice'), 'sticker-voice');
  renderEmbeddedModulePanel(root.querySelector('#mtParamSearchPricing'), 'search-pricing-security');

  root.querySelector('#syncStickersBtn').addEventListener('click', async () => {
    try {
      const res = await api('/api/console/stickers/sync', { body: {} });
      notify(`表情库同步完成，共 ${res.total ?? 0} 条`);
      await mountMediaTools(root);
    } catch (error) { notify(error.message, true); }
  });

  root.querySelector('#voiceQuickForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const target = root.querySelector('#vqTarget').value.trim();
    const file = root.querySelector('#vqFile').value;
    if (!file) { notify('语音库暂无可用文件', true); return; }
    try {
      await api('/api/console/voice/send', {
        body: { target, file, dryRun: root.querySelector('#vqDryRun').checked },
      });
      notify(root.querySelector('#vqDryRun').checked ? '语音预检通过' : '语音发送成功');
    } catch (error) { notify(error.message, true); }
  });
}
