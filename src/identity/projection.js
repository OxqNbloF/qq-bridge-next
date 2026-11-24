import { impressionRef } from '../memory/light.js';
import { projectModelTree } from './project-core.js';

// QQ 只在管理员显式开启时进入模型视图；控制台保留原始对象。
export function createIdentityProjection(b) {
  function projectForModel(value, surface = 'tool', opts = {}) {
    if (surface === 'console' || b.cfg.identity?.exposeQqInPrompt === true) return value;
    const knownQqs = typeof b.identityKnownQqs === 'function'
      ? b.identityKnownQqs()
      : Object.keys(b.identitySnapshot?.().people ?? {});
    const groupKey = typeof opts?.groupKey === 'string' ? opts.groupKey : '';
    const groupId = groupKey.startsWith('group:') ? groupKey.slice(6) : (typeof opts?.groupId === 'string' ? opts.groupId : undefined);
    const collectRoots = Array.isArray(opts?.collectRoots) && opts.collectRoots.length ? opts.collectRoots : [value];
    const extraSeedIds = Array.isArray(opts?.extraSeedIds) ? opts.extraSeedIds : [];
    return projectModelTree(value, {
      collectRoots,
      seedIds: [String(b.cfg.ownerQQ ?? ''), ...knownQqs, ...extraSeedIds],
      keyFields: ['memberImpressions'],
      displayName: (id) => (groupId ? b.identityDisplayName?.(id, groupId) : b.identityDisplayName?.(id)),
      transformFieldValue: (name, child, project) => (
        name === 'memberImpressions' && child && typeof child === 'object'
          ? Object.fromEntries(Object.entries(child).map(([id, item]) => [impressionRef(id), project(item)]))
          : project(child, name)
      ),
    });
  }
  return { projectForModel };
}
