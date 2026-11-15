import { DEFAULT_FLAGS } from '../gate/decide.js';

// 入站门禁与身份观察。初次准入在解析信封前，运行时静默复查在归档后。
export function createInboundAdmission(b) {
  function decideIncoming({ key, kind, id }, event, cfg, runtime) {
    return b.gateDecide({ kind, id, qq: event.user_id, cfg,
      closedAgentOk: b.modeForKey(key, b.currentMode, cfg) === 'closed-agent',
      applyMemberPolicy: cfg.architecture?.gateV2 === true,
      ...(runtime ? { runtime } : {}),
    });
  }

  function prepareIncoming(kind, id, event, cfg) {
    const key = b.convKey(kind, id);
    const decision = decideIncoming({ key, kind, id }, event, cfg);
    if (!decision.allowed) {
      b.log(`门禁拒绝 ${key}（${decision.reason}，来自 ${event.user_id}）`);
      return null;
    }
    b.observeIdentity({
      qq: String(event.user_id),
      group: kind === 'group' ? String(event.group_id) : null,
      card: event.sender?.card,
      nickname: event.sender?.nickname,
    });
    return { key, kind, id, flags: cfg.architecture?.gateV2 ? decision.flags : DEFAULT_FLAGS, decision };
  }

  function allowIncomingRuntime(input) {
    const { key, event, cfg, roleState, textContent } = input;
    const decision = decideIncoming(input, event, cfg, { silent: roleState.mode === 'silent' });
    if (decision.allowed) return true;
    b.appendActivity(`${key}（${decision.reason}）群友 ${event.user_id}：${textContent.slice(0, 80)}`, event.message_id ?? event.msg_id ?? null);
    b.log(`${decision.reason}，忽略群友消息 ${key}`);
    return false;
  }

  return { prepareIncoming, allowIncomingRuntime };
}
