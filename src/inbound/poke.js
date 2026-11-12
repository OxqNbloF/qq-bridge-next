// 处理拍一拍事件：记下来，需要时把 AI 叫醒
import { ignoredSender } from '../policy/access.js';

// 创建拍一拍处理器
export function createPokeHandler(b) {
  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    if (ignoredSender(senderId, b.cfg)) return;
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = b.convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = b.convKey('private', id);
    }
    if (!b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) return;
    if (b.modeForKey(key) !== 'reserved2') {
      b.appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await b.resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(b.cfg.ownerQQ ?? '');
    const msg = b.appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    b.appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (b.modeForKey(key) !== 'reserved2') return;
    if (b.socialV2.paused) return;
    const st = b.getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      b.saveSocialV2State();
      b.scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      b.scheduleWakeV2(key, 'poke');
    }
  }

  return { handlePokeNotice };
}
