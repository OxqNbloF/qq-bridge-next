// DSH 模型目录、名义模型与每会话 selectModel
import { unwrap } from '../dsh-client.js';
import { REASONING_EFFORT_DEFAULT, REASONING_EFFORT_NONE } from '../policy/mode.js';

// 创建 DSH 模型选择模块
export function createDshModel(b) {
  // 本模块持有的内存状态，其它模块经 b 读取
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 名义模型取配置值；实际模型以会话事件为准
  const nominalModel = () => b.cfg.dsh?.model || 'deepseek-flash';
  // 直接调接口：旧版客户端没有这个方法
  const modelCatalogErrorLogged = new Set();
  // 拉模型目录，失败回落 session/models
  async function fetchModelCatalog() {
    try {
      return await b.api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return b.api.callUnary('session.models', {});
    }
  }

  // 返回成功/会话不存在/失败；不存在时要重建会话
  async function ensureChatModel(sessionId) {
    const selectionEpoch = b.modelSelectionEpoch;
    if (modelAppliedSessions.get(sessionId) === selectionEpoch) return 'applied';
    const provider = String(b.cfg.dsh?.provider || 'deepseek-official');
    const model = String(b.cfg.dsh?.model || 'deepseek-flash');
    const configuredEffort = String(b.cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    const effort = configuredEffort === REASONING_EFFORT_NONE ? '' : configuredEffort;
    let lastError = null;
    // 先带 reasoningEffort 选模型，被拒再去掉 effort 重试
    const attemptPlans = effort
      ? [{ effort, label: `reasoningEffort=${effort}` }, { effort: '', label: '不带 reasoningEffort' }]
      : [{ effort: '', label: '不带 reasoningEffort' }];
    modelPlans:
    for (const plan of attemptPlans) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const payload = { sessionId, provider, model };
          if (plan.effort) payload.reasoningEffort = plan.effort;
          const result = unwrap(await b.api.sessions.selectModel(payload), 'session.selectModel');
          // 等待期间配置可能变了，只按发起时的版号记
          modelAppliedSessions.set(sessionId, selectionEpoch);
          b.log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
          return 'applied';
        } catch (error) {
          lastError = error;
          const reason = String(error?.message ?? error);
          b.log(`设置会话模型失败 ${sessionId}（${plan.label}，第 ${attempt}/2 次）: ${reason}`);
          // 会话已不存在，交给外层重建
          if (/not[- ]?found/i.test(reason)) break modelPlans;
          // 模型不支持 effort：不再同参数重试，换无 effort 档
          if (plan.effort && /does not support reasoning effort/i.test(reason)) break;
          if (attempt < 2) await b.sleep(1000);
        }
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 彻底失败也记版号，避免反复重试刷屏
      modelAppliedSessions.set(sessionId, selectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  return {
    modelAppliedSessions, nominalModel, fetchModelCatalog, ensureChatModel, modelCatalogErrorLogged };
}
