// SnowLuma OneBot v11 WebSocket / HTTP 网关适配
import { SnowLumaWebSocketClient, at, reply, text } from '@snowluma/sdk';
import { parseConvKey } from '../security/access.js';

function normalizeSegments(rawMessage, selfId) {
  const segs = Array.isArray(rawMessage) ? rawMessage : [];
  const texts = [];
  const media = [];
  let atBot = false;
  let replyToId = '';

  if (typeof rawMessage === 'string') {
    return { text: rawMessage, media, atBot, replyToId };
  }
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') {
      texts.push(String(seg.data?.text ?? ''));
    } else if (seg.type === 'at') {
      const target = String(seg.data?.qq ?? '');
      if (selfId && target === String(selfId)) atBot = true;
      texts.push(`@${target}`);
    } else if (seg.type === 'reply' && seg.data?.id) {
      replyToId = String(seg.data.id);
    } else if (seg.type === 'image' || seg.type === 'record' || seg.type === 'video' || seg.type === 'file') {
      media.push({
        type: seg.type,
        url: String(seg.data?.url ?? ''),
        file: String(seg.data?.file ?? ''),
      });
      texts.push(`[${seg.type === 'image' ? '图片' : seg.type}]`);
    }
  }
  return { text: texts.join('').trim(), media, atBot, replyToId };
}

export function createOneBotGateway({ getConfig, clientFactory, log = () => {}, onMessage }) {
  let client = null;
  let connected = false;
  let selfUserId = '';
  let selfNickname = '';
  let lastError = '';

  async function callHttpAction(action, params = {}) {
    const cfg = getConfig()?.onebot ?? {};
    const base = String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json' };
    if (cfg.accessToken) headers.authorization = `Bearer ${cfg.accessToken}`;
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error(`OneBot HTTP ${action} failed: ${res.status}`);
    return res.json().catch(() => ({}));
  }

  function handleNormalizedEvent(chatType, event) {
    const selfId = String(event?.self_id ?? selfUserId ?? '');
    const userId = String(event?.sender?.user_id ?? event?.user_id ?? '');
    if (selfId && userId === selfId) return;
    const targetId = chatType === 'group' ? String(event?.group_id ?? '') : userId;
    if (!targetId) return;
    const parsed = normalizeSegments(event?.message ?? event?.raw_message ?? '', selfId);
    const senderName = String(event?.sender?.card || event?.sender?.nickname || userId || '成员').trim();
    onMessage?.({
      convKey: `${chatType}:${targetId}`,
      chatType,
      targetId,
      messageId: String(event?.message_id ?? ''),
      userId,
      senderName,
      text: parsed.text || String(event?.raw_message ?? ''),
      atBot: parsed.atBot,
      replyToBot: false,
      replyToId: parsed.replyToId,
      media: parsed.media,
      ts: event?.time ? Number(event.time) * 1000 : Date.now(),
      fromSelf: false,
    });
  }

  async function start() {
    if (client) return;
    const cfg = getConfig()?.onebot ?? {};
    client = clientFactory
      ? clientFactory(cfg)
      : new SnowLumaWebSocketClient({
        url: cfg.wsUrl || 'ws://127.0.0.1:3001',
        accessToken: cfg.accessToken || undefined,
        reconnect: true,
      });

    client.onPrivateMessage?.((ev) => handleNormalizedEvent('private', ev));
    client.onGroupMessage?.((ev) => handleNormalizedEvent('group', ev));
    client.on?.('open', () => {
      connected = true;
      lastError = '';
      log(`SnowLuma OneBot WS 已连接: ${cfg.wsUrl}`);
      client.getLoginInfo?.().then((info) => {
        if (info?.user_id != null) selfUserId = String(info.user_id);
        if (info?.nickname) selfNickname = String(info.nickname);
      }).catch(() => {});
    });
    client.on?.('close', (info) => {
      connected = false;
      log(`SnowLuma WS 断开 (code=${info?.code ?? '?'})`);
    });
    client.on?.('error', (err) => {
      lastError = err?.message ?? String(err ?? 'ws error');
    });

    await client.connect?.();
  }

  async function stop() {
    if (!client) return;
    try { client.close?.(); } catch {}
    client = null;
    connected = false;
  }

  async function sendMessage(convKey, msgText, { replyToMessageId = '', atUserId = '' } = {}) {
    const parsed = parseConvKey(convKey);
    if (!parsed) throw new Error(`非法目标会话: ${convKey}`);
    const segs = [];
    if (replyToMessageId) segs.push(reply(String(replyToMessageId)));
    if (atUserId && parsed.chatType === 'group') segs.push(at(String(atUserId)), text(' '));
    segs.push(text(String(msgText)));

    if (client?.isConnected) {
      if (parsed.chatType === 'group') {
        return client.sendGroupMessage(Number(parsed.targetId), segs);
      }
      return client.sendPrivateMessage(Number(parsed.targetId), segs);
    }

    const action = parsed.chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
    const idField = parsed.chatType === 'group' ? { group_id: Number(parsed.targetId) } : { user_id: Number(parsed.targetId) };
    return callHttpAction(action, { ...idField, message: segs });
  }

  async function sendPoke(convKey, userId) {
    const parsed = parseConvKey(convKey);
    if (!parsed) throw new Error(`非法目标会话: ${convKey}`);
    const params = parsed.chatType === 'group'
      ? { group_id: Number(parsed.targetId), user_id: Number(userId) }
      : { user_id: Number(userId) };
    if (client?.isConnected && typeof client.request === 'function') {
      return client.request('send_poke', params);
    }
    return callHttpAction('send_poke', params);
  }

  async function getGroupMembers(groupId) {
    if (client?.isConnected && typeof client.getGroupMemberList === 'function') {
      return client.getGroupMemberList(Number(groupId));
    }
    const res = await callHttpAction('get_group_member_list', { group_id: Number(groupId) });
    return Array.isArray(res?.data) ? res.data : [];
  }

  function getStatus() {
    return {
      connected,
      selfUserId,
      selfNickname,
      lastError,
      wsUrl: getConfig()?.onebot?.wsUrl || '',
    };
  }

  return { start, stop, sendMessage, sendPoke, getGroupMembers, getStatus };
}
