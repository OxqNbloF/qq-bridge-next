import { canonicalV2Key } from '../policy/access.js';

const validQq = value => /^[1-9]\d{0,15}$/.test(String(value ?? ''));

// DSH 上下文比 recent/unread 活得更久；只累计来源身份，不复制消息正文。
// 在向模型暴露前落盘，宁可保守多记，不能在崩溃/窗口淘汰后忘记来源。
export function rememberModelSources(b, key, messages = [], sourceQqs = []) {
  key = canonicalV2Key(key);
  if (!key || !b.getSocialV2State) return;
  const st = b.getSocialV2State(key);
  const selfQq = validQq(b.selfUserId) ? String(b.selfUserId) : '';
  const actors = new Set((st.modelSourceQqs ?? []).map(String).filter(qq => qq && qq !== selfQq));
  const add = qq => { if (validQq(qq) && String(qq) !== selfQq) actors.add(String(qq)); };
  for (const qq of sourceQqs) add(qq);
  function collect(value, fieldName = '') {
    if (!value || typeof value !== 'object' || fieldName === 'self') return;
    if (!value.isSelf) {
      add(value.userId ?? value.user_id ?? value.sender?.qq ?? value.sender?.user_id);
    }
    for (const qq of Array.isArray(value.sourceQqs) ? value.sourceQqs : []) add(qq);
    add(value.quote?.senderQq);
    for (const [childKey, child] of Object.entries(value)) {
      if (child && typeof child === 'object') collect(child, childKey);
    }
  }
  collect(messages);
  if (key.startsWith('private:')) add(key.slice(8));
  const next = [...actors].sort();
  if (!st.modelSourcesDirty && JSON.stringify(next) === JSON.stringify(st.modelSourceQqs ?? [])) return;
  st.modelSourceQqs = next;
  st.modelSourcesDirty = true;
  const saved = b.saveSocialV2State?.();
  if (saved === false && b.cfg.architecture?.gateV2) {
    throw Object.assign(new Error('模型来源保存失败，拒绝暴露未跟踪上下文'), { statusCode: 503 });
  }
  if (saved !== false) st.modelSourcesDirty = false;
}
