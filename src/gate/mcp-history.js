import { decide } from './decide.js';
import { allowed } from '../policy/access.js';
import { projectModelTree } from '../identity/project-core.js';

export function groupAllowed(groupId, cfg) {
  return allowed('group', groupId, { allow: {}, deny: {}, ...cfg });
}

// Filters context=false / denied members using gate/decide and masks bare QQ numbers for model view.
export function filterAndProjectGroupHistory({ groupId, data, cfg = {}, policy = null, policyBroken = false, identityPeople = {} }) {
  const g = String(groupId);
  const safeCfg = { allow: {}, deny: {}, ignore: {}, ...cfg };
  const visibleMsg = (msg) => {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.noContext || msg.no_context) return false;
    if (safeCfg.architecture?.gateV2 !== true) return true;
    const sender = String(msg.user_id ?? msg.userId ?? msg.sender?.user_id ?? msg.sender?.qq ?? msg.sender_id ?? '');
    const isSelf = msg.isSelf === true || msg.from === 'bot' || (msg.self_id != null && sender && sender === String(msg.self_id));
    if (isSelf) return true;
    if (!/^[1-9]\d*$/.test(sender)) return false;
    if (policyBroken) return false;
    const decision = decide({ kind: 'group', id: Number(g), qq: sender, cfg: safeCfg, mode: 'chat', policy });
    return decision.allowed === true && decision.flags.context === true;
  };
  let filtered = data;
  if (Array.isArray(data)) {
    filtered = data.filter(visibleMsg);
  } else if (data && typeof data === 'object' && Array.isArray(data.messages)) {
    filtered = { ...data, messages: data.messages.filter(visibleMsg) };
  }
  if (cfg.identity?.exposeQqInPrompt === true) return filtered;

  const fallbackNames = new Map();
  const msgList = Array.isArray(filtered) ? filtered : (Array.isArray(filtered?.messages) ? filtered.messages : []);
  for (const msg of msgList) {
    const sender = String(msg?.user_id ?? msg?.userId ?? msg?.sender?.user_id ?? msg?.sender?.qq ?? '');
    const label = String(msg?.sender?.card || msg?.sender?.nickname || msg?.sender || '').trim();
    if (/^[1-9]\d*$/.test(sender) && label && !/^[1-9]\d*$/.test(label)) fallbackNames.set(sender, label);
  }
  const displayName = (id) => {
    const person = Object.prototype.hasOwnProperty.call(identityPeople, String(id)) ? identityPeople[String(id)] : null;
    if (person) {
      const scope = person.groups && Object.prototype.hasOwnProperty.call(person.groups, g) ? person.groups[g] : null;
      const active = Array.isArray(scope?.aliases) ? scope.aliases.filter((a) => a?.status === 'active') : [];
      const globalActive = Array.isArray(person.globalAliases) ? person.globalAliases.filter((a) => a?.status === 'active') : [];
      const found = active.find((a) => a.source === 'manual')?.text ?? scope?.card ?? active[0]?.text ?? globalActive.find((a) => a.source === 'manual')?.text ?? person.displayName;
      if (found) return found;
    }
    return fallbackNames.get(String(id)) || '群友';
  };
  // Collect QQs from raw data as well so filtered/hidden members mentioned in text are still masked as 群友.
  return projectModelTree(filtered, {
    collectRoots: [data],
    seedIds: [String(cfg.ownerQQ ?? ''), ...Object.keys(identityPeople), ...fallbackNames.keys()],
    displayName,
  });
}
