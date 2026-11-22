// 模型工具传入的不透明成员引用（member-*）或唯一称呼解析为当前会话真实 QQ 号
import { MEMBER_REF_RE, memberRef } from './project-core.js';
import { modelMemberVisible, modelMessageVisible } from '../gate/model-visibility.js';
import { canonicalV2Key } from '../policy/access.js';

const QQ_RE = /^[1-9]\d*$/;
const NON_NAME_PLACEHOLDERS = new Set(['群友', '未知', '我']);

function targetError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function unwrapGroupMemberList(res) {
  const payload = res && typeof res === 'object' && res.data !== undefined ? res.data : res;
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : null);
}

/** 按既有通道读取群成员列表：优先 getGroupMemberList，其次 request，最后 HTTP 回退 */
export async function fetchGroupMemberList(b, groupId) {
  const gid = Number(groupId);
  if (!Number.isFinite(gid) || gid <= 0) return null;
  if (typeof b?.bot?.getGroupMemberList === 'function') {
    try {
      const list = unwrapGroupMemberList(await b.bot.getGroupMemberList(gid));
      if (list) return list;
    } catch {}
  }
  if (typeof b?.bot?.request === 'function') {
    try {
      const list = unwrapGroupMemberList(await b.bot.request('get_group_member_list', { group_id: gid }));
      if (list) return list;
    } catch {}
  }
  if (typeof b?.onebotHttpAction === 'function') {
    try {
      const list = unwrapGroupMemberList(await b.onebotHttpAction('get_group_member_list', { group_id: gid }));
      if (list) return list;
    } catch {}
  }
  return null;
}

/** 将正整数 QQ 号、member-* 不透明标识或无歧义群称呼解析为真实 QQ 号（fail-closed） */
export async function resolveMemberTarget(b, key, rawTarget, { fieldName = 'targetUserId', state = null, allowDisplayName = true, checkVisibility = true } = {}) {
  const target = String(rawTarget ?? '').trim();
  if (!target) return '';
  if (/^all$/i.test(target)) throw targetError(`${fieldName} 必须是正整数 QQ 号或有效的 member-* 成员标识，且不能为 all`);
  const canonical = canonicalV2Key(key) ?? String(key ?? '').trim();
  const [kind, convId] = canonical.split(':');
  const isGroup = kind === 'group' && QQ_RE.test(convId ?? '');
  const isPrivate = kind === 'private' && QQ_RE.test(convId ?? '');
  const st = state ?? b?.socialV2?.conversations?.get?.(canonical) ?? null;
  const visible = (qq) => !checkVisibility || !b?.cfg?.architecture?.gateV2 || !b?.gateDecide || modelMemberVisible(b, canonical, qq);

  if (QQ_RE.test(target)) {
    if (isPrivate && target !== convId) throw targetError(`${fieldName} 与当前私聊对象不一致`, 403);
    if (!visible(target)) throw targetError(`${fieldName} 目标成员受策略限制，当前不可访问`, 403);
    return target;
  }
  if (/^-?\d+$/.test(target)) throw targetError(`${fieldName} 必须是正整数 QQ 号或有效的 member-* 成员标识`);

  const localCandidates = new Set();
  const localMessages = [...(st?.recentMessages ?? []), ...(st?.unread ?? [])];
  if (isPrivate && visible(convId)) {
    localCandidates.add(convId);
  } else if (isGroup) {
    for (const msg of localMessages) {
      if (!msg || msg.isSelf) continue;
      if (checkVisibility && !modelMessageVisible(b, canonical, msg)) continue;
      const uid = String(msg.userId ?? msg.user_id ?? '').trim();
      if (QQ_RE.test(uid) && visible(uid)) localCandidates.add(uid);
    }
    for (const uid of Object.keys(st?.memberImpressions ?? {})) {
      if (QQ_RE.test(uid) && visible(uid)) localCandidates.add(uid);
    }
    for (const uid of st?.modelSourceQqs ?? []) {
      const s = String(uid ?? '').trim();
      if (QQ_RE.test(s) && visible(s)) localCandidates.add(s);
    }
    const groupMembers = typeof b?.identityGroupMembers === 'function'
      ? b.identityGroupMembers(convId)
      : Object.entries(b?.identitySnapshot?.()?.people ?? {})
          .filter(([, person]) => person?.groups?.[convId])
          .map(([uid]) => uid);
    for (const uid of groupMembers) {
      if (QQ_RE.test(uid) && visible(uid)) localCandidates.add(uid);
    }
  }

  let fetchedMembers = null;
  const ensureMembers = async () => {
    if (fetchedMembers !== null || !isGroup) return fetchedMembers;
    fetchedMembers = (await fetchGroupMemberList(b, convId)) ?? [];
    return fetchedMembers;
  };

  if (MEMBER_REF_RE.test(target)) {
    for (const uid of localCandidates) {
      if (memberRef(uid) === target) return uid;
    }
    for (const m of (await ensureMembers()) ?? []) {
      const uid = String(m?.user_id ?? m?.userId ?? '').trim();
      if (QQ_RE.test(uid) && visible(uid) && memberRef(uid) === target) return uid;
    }
    throw targetError(`${fieldName} 找不到与 ${target} 匹配的当前会话成员，请先调用 qq_get_group_members / qq_get_active_members / qq_get_message_detail 获取有效 memberRef`);
  }

  if (!allowDisplayName || NON_NAME_PLACEHOLDERS.has(target)) {
    throw targetError(`${fieldName} 无法按“${target}”唯一定位成员，请使用 qq_get_group_members / qq_get_active_members / qq_get_message_detail 返回的 memberRef`);
  }

  const nameHits = new Set();
  if (typeof b?.resolveIdentityAlias === 'function' && (isGroup || isPrivate)) {
    const resolved = b.resolveIdentityAlias({ conv: canonical, group: isGroup ? convId : null, text: target });
    if (resolved?.ambiguous) {
      throw targetError(`${fieldName} “${target}” 对应多个成员，请改用 memberRef（member-* 标识）或正整数 QQ 号`);
    }
    if (resolved?.qq && visible(String(resolved.qq)) && (!isPrivate || String(resolved.qq) === convId)) {
      nameHits.add(String(resolved.qq));
    }
  }
  if (isPrivate && visible(convId) && b?.identityDisplayName?.(convId) === target) {
    nameHits.add(convId);
  } else if (isGroup) {
    for (const msg of localMessages) {
      if (!msg || msg.isSelf) continue;
      if (checkVisibility && !modelMessageVisible(b, canonical, msg)) continue;
      const uid = String(msg.userId ?? msg.user_id ?? '').trim();
      if (QQ_RE.test(uid) && visible(uid) && String(msg.sender ?? '').trim() === target) nameHits.add(uid);
    }
    for (const [uid, item] of Object.entries(st?.memberImpressions ?? {})) {
      if (QQ_RE.test(uid) && visible(uid) && String(item?.displayName ?? '').trim() === target) nameHits.add(uid);
    }
    for (const m of (await ensureMembers()) ?? []) {
      const uid = String(m?.user_id ?? m?.userId ?? '').trim();
      if (!QQ_RE.test(uid) || !visible(uid)) continue;
      if (String(m?.card ?? '').trim() === target || String(m?.nickname ?? '').trim() === target) nameHits.add(uid);
    }
  }

  if (nameHits.size === 1) return [...nameHits][0];
  if (nameHits.size > 1) {
    throw targetError(`${fieldName} “${target}” 对应多个成员，请改用 memberRef（member-* 标识）或正整数 QQ 号`);
  }
  throw targetError(`${fieldName} 找不到成员“${target}”，请使用 memberRef（member-* 标识）或正整数 QQ 号`);
}
