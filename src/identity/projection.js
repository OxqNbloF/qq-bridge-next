import { impressionRef } from '../memory/light.js';
import { projectModelTree } from './project-core.js';

// QQ 只在管理员显式开启时进入模型视图；控制台保留原始对象。
export function createIdentityProjection(b) {
  function projectForModel(value, surface = 'tool') {
    if (surface === 'console' || b.cfg.identity?.exposeQqInPrompt === true) return value;
    const knownQqs = typeof b.identityKnownQqs === 'function'
      ? b.identityKnownQqs()
      : Object.keys(b.identitySnapshot?.().people ?? {});
    return projectModelTree(value, {
      collectRoots: [value],
      seedIds: [String(b.cfg.ownerQQ ?? ''), ...knownQqs],
      keyFields: ['memberImpressions'],
      displayName: (id) => b.identityDisplayName?.(id),
      transformFieldValue: (name, child, project) => (
        name === 'memberImpressions' && child && typeof child === 'object'
          ? Object.fromEntries(Object.entries(child).map(([id, item]) => [impressionRef(id), project(item)]))
          : project(child, name)
      ),
    });
  }
  return { projectForModel };
}
