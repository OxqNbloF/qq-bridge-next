// OneBot v11 WebSocket / HTTP 传输适配层（使用纯 segment 对象构筑器）
import { SnowLumaWebSocketClient, message } from '@snowluma/sdk';
import { parseRoomId } from '../security/perimeter.js';
import { extractBundleIds } from '../features/bundle.js';

function normalizeSegments(rawMessage, selfId) {
  const segs = Array.isArray(rawMessage) ? rawMessage : [];
  const texts = [];
  const attachments = [];
  let mentionedBot = false;
  let replyToId = '';
  const bundleIds = extractBundleIds(segs);

  if (typeof rawMessage === 'string') {
    return { text: rawMessage, attachments, bundleIds, mentionedBot, replyToId };
  }
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') {
      texts.push(String(seg.data?.text ?? ''));
    } else if (seg.type === 'at') {
      const target = String(seg.data?.qq ?? '');
      if (selfId && target === String(selfId)) mentionedBot = true;
      texts.push(`@${target}`);
    } else if (seg.type === 'reply' && seg.data?.id) {
      replyToId = String(seg.data.id);
    } else if (seg.type === 'forward') {
      texts.push(`[合并转发#${seg.data?.id ?? ''}]`);
    } else if (seg.type === 'image' || seg.type === 'record' || seg.type === 'video' || seg.type === 'file') {
      attachments.push({ type: seg.type, url: String(seg.data?.url ?? ''), file: String(seg.data?.file ?? '') });
      texts.push(`[${seg.type === 'image' ? '图片' : seg.type}]`);
    }
  }
  return { text: texts.join('').trim(), attachments, bundleIds, mentionedBot, replyToId };
}

export function createOneBotTransport({ getConfig, clientFactory, log = () => {}, onInbound, onRecall, onNudge }) {
  let client = null;
  let connected = false;
  let selfUserId = '';
  let selfNickname = '';
  let lastError = '';

  async function callHttp(action, params = {}) {
    const cfg = getConfig()?.transport ?? {};
    const base = String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json' };
    if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
    const res = await fetch(`${base}/${action}`, { method: 'POST', headers, body: JSON.stringify(params) });
    if (!res.ok) throw new Error(`OneBot HTTP ${action} failed: ${res.status}`);
    return res.json().catch(() => ({}));
  }

  function dispatchInbound(kind, event) {
    const selfId = String(event?.self_id ?? selfUserId ?? '');
    const senderId = String(event?.sender?.user_id ?? event?.user_id ?? '');
    if (selfId && senderId === selfId) return;
    const peerId = kind === 'group' ? String(event?.group_id ?? '') : senderId;
    if (!peerId) return;
    const parsed = normalizeSegments(event?.message ?? event?.raw_message ?? '', selfId);
    const senderName = String(event?.sender?.card || event?.sender?.nickname || senderId || '成员').trim();
    onInbound?.({
      roomId: `${kind}:${peerId}`,
      kind,
      peerId,
      messageId: String(event?.message_id ?? ''),
      senderId,
      senderName,
      card: String(event?.sender?.card ?? ''),
      nickname: String(event?.sender?.nickname ?? ''),
      text: parsed.text || String(event?.raw_message ?? ''),
      mentionedBot: parsed.mentionedBot,
      repliedBot: false,
      replyToId: parsed.replyToId,
      attachments: parsed.attachments,
      bundleIds: parsed.bundleIds,
      ts: event?.time ? Number(event.time) * 1000 : Date.now(),
      fromSelf: false,
    });
  }

  async function start() {
    if (client) return;
    const cfg = getConfig()?.transport ?? {};
    client = clientFactory
      ? clientFactory(cfg)
      : new SnowLumaWebSocketClient({
        url: cfg.wsUrl || 'ws://127.0.0.1:3001',
        accessToken: cfg.token || undefined,
        reconnect: true,
      });

    client.onPrivateMessage?.((ev) => dispatchInbound('direct', ev));
    client.onGroupMessage?.((ev) => dispatchInbound('group', ev));
    client.onNotice?.('group_recall', (ev) => {
      if (ev?.group_id && ev?.message_id) {
        onRecall?.({ roomId: `group:${ev.group_id}`, messageId: String(ev.message_id), senderId: String(ev.user_id ?? '') });
      }
    });
    client.onNotice?.('friend_recall', (ev) => {
      if (ev?.user_id && ev?.message_id) {
        onRecall?.({ roomId: `direct:${ev.user_id}`, messageId: String(ev.message_id), senderId: String(ev.user_id) });
      }
    });
    client.onNotice?.('notify', (ev) => {
      if (ev?.sub_type !== 'poke') return;
      const roomId = ev.group_id ? `group:${ev.group_id}` : (ev.user_id ? `direct:${ev.user_id}` : '');
      if (!roomId) return;
      const selfId = String(ev?.self_id ?? selfUserId ?? '');
      onNudge?.({
        roomId,
        senderId: String(ev.user_id ?? ''),
        targetId: String(ev.target_id ?? ''),
        isTargetSelf: Boolean(selfId && String(ev.target_id ?? '') === selfId),
      });
    });

    client.on?.('open', () => {
      connected = true;
      lastError = '';
      log(`OneBot WS 已连接: ${cfg.wsUrl}`);
      client.getLoginInfo?.().then((info) => {
        if (info?.user_id != null) selfUserId = String(info.user_id);
        if (info?.nickname) selfNickname = String(info.nickname);
      }).catch(() => {});
    });
    client.on?.('close', (info) => { connected = false; log(`OneBot WS 断开 (code=${info?.code ?? '?'})`); });
    client.on?.('error', (err) => { lastError = err?.message ?? String(err ?? 'ws error'); });

    await client.connect?.();
  }

  async function stop() {
    if (!client) return;
    try { client.close?.(); } catch {}
    client = null;
    connected = false;
  }

  async function sendSegments(roomId, segs) {
    const parsed = parseRoomId(roomId);
    if (!parsed) throw new Error(`非法房间 ID: ${roomId}`);
    if (client?.isConnected) {
      if (parsed.kind === 'group') return client.sendGroupMessage(Number(parsed.peerId), segs);
      return client.sendPrivateMessage(Number(parsed.peerId), segs);
    }
    const action = parsed.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    const idField = parsed.kind === 'group' ? { group_id: Number(parsed.peerId) } : { user_id: Number(parsed.peerId) };
    return callHttp(action, { ...idField, message: segs });
  }

  async function sendText(roomId, msgText, { replyToMessageId = '', mentionUserId = '' } = {}) {
    const parsed = parseRoomId(roomId);
    if (!parsed) throw new Error(`非法房间 ID: ${roomId}`);
    const segs = [];
    if (replyToMessageId) segs.push(message.reply(String(replyToMessageId)));
    if (mentionUserId && parsed.kind === 'group') segs.push(message.at(String(mentionUserId)), message.text(' '));
    segs.push(message.text(String(msgText)));
    return sendSegments(roomId, segs);
  }

  async function sendImage(roomId, fileOrUrl) {
    return sendSegments(roomId, [message.image(String(fileOrUrl))]);
  }

  async function sendAudio(roomId, absFilePath) {
    return sendSegments(roomId, [message.record(String(absFilePath))]);
  }

  async function sendNudge(roomId, userId) {
    const parsed = parseRoomId(roomId);
    if (!parsed) throw new Error(`非法房间 ID: ${roomId}`);
    const params = parsed.kind === 'group'
      ? { group_id: Number(parsed.peerId), user_id: Number(userId) }
      : { user_id: Number(userId) };
    if (client?.isConnected && typeof client.request === 'function') return client.request('send_poke', params);
    return callHttp('send_poke', params);
  }

  async function listGroupMembers(groupId) {
    if (client?.isConnected && typeof client.getGroupMemberList === 'function') {
      return client.getGroupMemberList(Number(groupId));
    }
    const res = await callHttp('get_group_member_list', { group_id: Number(groupId) });
    return Array.isArray(res?.data) ? res.data : [];
  }

  async function fetchBundle(bundleId) {
    if (client?.isConnected && typeof client.request === 'function') {
      const res = await client.request('get_forward_msg', { id: String(bundleId) });
      return res?.data?.messages ?? res?.data ?? [];
    }
    const res = await callHttp('get_forward_msg', { id: String(bundleId) });
    return res?.data?.messages ?? res?.data ?? [];
  }

  async function fetchCustomFaces() {
    if (client?.isConnected && typeof client.request === 'function') {
      const res = await client.request('fetch_custom_face', {});
      return Array.isArray(res?.data) ? res.data : [];
    }
    const res = await callHttp('fetch_custom_face', {});
    return Array.isArray(res?.data) ? res.data : [];
  }

  function getStatus() {
    return { connected, selfUserId, selfNickname, lastError, wsUrl: getConfig()?.transport?.wsUrl || '' };
  }

  return {
    start, stop, sendText, sendImage, sendAudio, sendNudge,
    listGroupMembers, fetchBundle, fetchCustomFaces, getStatus,
  };
}
