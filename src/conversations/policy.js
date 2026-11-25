// 决定每个聊天用哪个模式、哪个预设
// 模式和预设这些状态存在 bridge.js，这里通过 b 去读写
// 也负责作废不再需要的会话，并清掉相关记录
import { resolveMode } from './mode-router.js';
import { getModeAdapter } from '../modes/registry.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';
import { canonicalV2Key, normalizeOwnerQQ } from '../policy/access.js';
import { conversationGate } from '../gate/decide.js';
import { normalizeModeInput, settingFromDshNamespace } from '../policy/mode.js';
import { readJsonSafe } from '../store/fs-atomic.js';

// 建一个管模式、预设和会话作废的小工具组
export function createConversationPolicy(b) {
  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode({ requireOnline = false } = {}) {
    try {
      const s = unwrap(await b.api.settings.describe({}), 'settings.describe');
      // DSH 的默认预设，没指定时就用它
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        b.dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 先统一模式的写法，比如 simulation 也算一种
      // 读设置要以用户改的为准，不然切好的模式很快会被改回去
      const fromDsh = normalizeModeInput(settingFromDshNamespace(ns, 'mode'));
      if (fromDsh) {
        b.currentMode = fromDsh;
        // 设置页也能填管理员 QQ；留空表示不改原有配置
        // 留空时千万别写回空值，不然每几秒就会把管理员 QQ 清掉
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              b.cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              b.log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // 设置页里没有「预设」这一项，预设仍然从本地文件读
        // 所以这里不能直接返回，否则控制台选预设永远不生效
        const localPreset = readJsonSafe(path.join(b.STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          b.closedAgentPreset = localPreset.closedAgentPreset;
        }
        b.modeKnown = true;
        return;
      }
    } catch (error) { if (requireOnline) throw error; }
    const local = readJsonSafe(path.join(b.STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) b.currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      b.closedAgentPreset = local.closedAgentPreset;
    }
    b.modeKnown = true;
  }

  // 取 DSH 现在有哪些预设，给控制台和保底逻辑用
  async function refreshPresetList({ requireOnline = false } = {}) {
    try {
      const { presets: list } = unwrap(await b.api.agentPresets.list({}), 'agentPresets.list');
      if (requireOnline && list.length === 0) throw new Error('DSH preset 清单为空，暂不恢复会话');
      b.dshPresetIds = list.map((p) => String(p.id));
      if (!b.dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) b.dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      if (requireOnline) throw error;
      b.log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  const conversationEpochs = new Map();
  const conversationEpoch = (key) => conversationEpochs.get(key) ?? 0;
  const overridesReadonly = () => b.conversationOverridesReadonly?.() ?? b.listConversationOverrides?.().conversations;
  function resolveConversationMode(key, mode = b.currentMode, cfg = b.cfg) {
    return resolveMode(key, { globalMode: mode, defaults: cfg.modes?.defaults, overrides: overridesReadonly(), ownerQQ: cfg.ownerQQ, enabled: cfg.modes?.engine });
  }
  function modeForKey(key, mode = b.currentMode, cfg = b.cfg) { return resolveConversationMode(key, mode, cfg).mode; }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode, { listed = false } = {}) {
    // 封闭 agent 模式：仅 owner 私聊（边界由 session-router 判定）；其余模式查会话白名单
    mode = modeForKey(key, mode, cfg);
    if (!mode) return false;
    const closedAgentOk = mode === 'closed-agent';
    return conversationGate({ kind, id, cfg, mode, closedAgentOk, listed }) === null;
  }

  /**
   * 选一个可用的预设名字。
   * 严格模式下找不到就返回空，表示没有安全的预设，调用方应拒绝建会话。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (b.dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (b.dshPresetIds.length === 0) return strict ? '' : wanted;
    if (b.dshPresetIds.includes(wanted)) return wanted;
    b.log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${b.dshPresetIds.join(', ')}）中`);
    if (strict) {
      b.log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return b.dshDefaultPreset || '';
  }

  function presetForResolved(resolved, key, cfg) {
    const mode = resolved.mode;
    if (!mode) return undefined;
    const explicit = resolved.source === 'conversation' ? overridesReadonly()?.[key] : null;
    if (explicit?.preset) return resolvePresetName(explicit.preset, { strict: getModeAdapter(mode).toolPolicy.allowed !== 'full' }) || undefined;
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(b.closedAgentPreset);
      if (!chosen) b.log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代默认用 socialV2.agentPreset，没配就用默认聊天预设
    // 群聊一律不给带本地工具的预设，建不出会话也比出事强
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    return presetForResolved(resolveConversationMode(key, mode, cfg), key, cfg);
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), b.cfg, b.currentMode);
  }

  // 给这个聊天的模式、预设和主人信息算一个指纹（单次解析，零 clone）
  function sessionPolicy(key) {
    const resolved = resolveConversationMode(key);
    const mode = resolved.mode;
    const override = resolved.source === 'conversation' ? overridesReadonly()?.[key] : null;
    const base = [mode, presetForResolved(resolved, key, b.cfg) ?? '', mode === 'closed-agent' ? b.cfg.ownerQQ : null];
    return JSON.stringify(override?.model || override?.reasoningEffort ? [...base, override.model ?? '', override.reasoningEffort ?? ''] : base);
  }

  // 这个聊天还是不是当前该用的那个会话
  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && b.state.sessions[key] === sessionId
      && b.state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个不再归桥接管的聊天：先清队列，取消正在跑的活，再归档。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await b.withTimeout(b.api.stopSessionWork(sessionId), b.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { b.log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await b.withTimeout(b.api.workspace.archiveSession({ sessionId }), b.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { b.log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉这个聊天在内存里的各种记录；作废或重置会话时都要调用。
   */
  function forgetConversationCaches(key) {
    b.lastSendFailed.delete(key);
    b.activeWaits.delete(key);
    b.queuedHintAt.delete(key);
    b.feedbackTimes.delete(key);
    b.turnNoticeTimes.delete(key);
    b.wakeConfigMissCount.delete(key);
    b.wakeConfigUpdatedKeys.delete(key);
    b.markReadCalledKeys.delete(key);
  }

  // 作废一个聊天：删掉映射并清掉它的所有记录
  function retireSession(key, { preserveQueue = false, preserveMemorySources = false, deferSave = false } = {}) {
    conversationEpochs.set(key, conversationEpoch(key) + 1);
    b.resetOutbound?.(key);
    if (!preserveQueue) {
      b.cancelScheduledTurns?.(key, 'session-retired');
      b.drainPromptQueue(key, '会话策略已变化');
      b.sessionPromises?.delete(key);
      b.sessionCreationPolicies?.delete(key);
    }
    const sessionId = b.state.sessions[key];
    delete b.state.sessions[key];
    delete b.state.sessionPolicies[key];
    // 有没有建过会话都要清，否则会一直留着一堆旧记录
    forgetConversationCaches(key);
    b.cancelSocialTimers(key, { skipEngineCancel: preserveQueue });
    b.clearSocialV2Timers(key, { skipEngineCancel: preserveQueue });
    b.social.states.delete(key);
    b.social.silentContext.delete(key);
    const st = b.socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      b.rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
      // 保留队列时仍可能投递带旧历史的预构建 prompt，不能提前忘掉来源。
      if (!preserveQueue && !preserveMemorySources) {
        st.modelSourceQqs = [];
        st.modelSourcesIncomplete = false;
      }
    }
    if (!preserveQueue) {
      b.disarmPendingWakeLease(key);
      b.pendingWakeKeys.delete(key);
    }
    if (!sessionId) {
      if (!deferSave) { b.saveState(); b.saveSocialV2State(); }
      return;
    }
    b.reverse.delete(sessionId);
    b.forgetDeliveryCursor(sessionId);
    b.collectors.delete(sessionId);
    b.sessionModels.delete(sessionId);
    b.modelAppliedSessions.delete(sessionId);
    b.sendToolSucceededSessions.delete(sessionId);
    b.pendingSendToolCalls.delete(sessionId);
    b.v2TurnStartAt.delete(sessionId);
    b.turnLeaseNoted.delete(sessionId);
    b.toolCallNames.delete(sessionId);
    b.toolCallAt?.delete(sessionId);
    b.lastEventAt?.delete(sessionId);
    b.social.silentTurns.delete(sessionId);
    b.social.exitingSessions.delete(sessionId);
    // 作废的会话要退订，不然每次重连都会重新拉一遍历史，越积越慢
    b.api.events.forget?.(sessionId);
    const entry = b.pending.get(key);
    if (entry) { b.clearTimeout(entry.timer); void b.cancelPendingEntry({ ...entry, key }).catch(() => {}); }
    b.pending.delete(key);
    if (!deferSave) { b.saveState(); b.saveSocialV2State(); }
    stopRetiredSessionWork(sessionId, key);
    b.log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  // 把不再符合条件的聊天都作废掉（批量合并落盘）
  function reconcileSessionPolicies() {
    // 预设清单还没拿到时不要作废，不然一次网络抖动会把所有聊天全清掉
    if (b.dshPresetIds.length === 0) return;
    let retired = 0;
    for (const [key, policy] of b.sessionCreationPolicies ?? []) {
      if (policy !== sessionPolicy(key)) { retireSession(key, { deferSave: true }); retired += 1; }
    }
    for (const [key, sessionId] of Object.entries(b.state.sessions)) {
      if (!isCurrentSession(key, sessionId)) { retireSession(key, { deferSave: true }); retired += 1; }
    }
    if (retired > 0) { b.saveState(); b.saveSocialV2State(); }
  }

  const bumpConversationEpoch = (rawKey) => {
    const key = canonicalV2Key(rawKey) ?? String(rawKey ?? '').trim();
    if (!key) return 0;
    const next = (conversationEpochs.get(key) ?? 0) + 1;
    conversationEpochs.set(key, next);
    return next;
  };
  return { modeAdapterForKey: (key) => getModeAdapter(modeForKey(key)), resolveConversationMode, conversationEpoch, bumpConversationEpoch, refreshMode, refreshPresetList, modeForKey, modeAllowed, resolvePresetName, modePreset, isSessionAllowedInCurrentMode, sessionPolicy, isCurrentSession, stopRetiredSessionWork, forgetConversationCaches, retireSession, reconcileSessionPolicies };
}
