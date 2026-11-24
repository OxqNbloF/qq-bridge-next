const CONFIG_ALIASES = [['social', 'modes', 'reserved'], ['socialV2', 'modes', 'reserved2'], ['slang', 'memory', 'terms'], ['archive', 'memory', 'archive']];

// 双读不写：新键覆盖旧键，未迁移的字段继续沿用旧值。
export function adaptLegacyConfig(input) {
  for (const [key, value] of Object.entries({ social: input.social, socialV2: input.socialV2, slang: input.slang, reserved: input.modes?.reserved, reserved2: input.modes?.reserved2, terms: input.memory?.terms, archive: input.memory?.archive })) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new TypeError(`配置 ${key} 必须是对象`);
  }
  const merge = (old = {}, next = {}) => Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(next)])].map((key) => [key,
    old[key] && next[key] && typeof old[key] === 'object' && typeof next[key] === 'object' && !Array.isArray(old[key]) && !Array.isArray(next[key]) ? merge(old[key], next[key]) : Object.hasOwn(next, key) ? next[key] : old[key],
  ]));
  return { ...input, ...Object.fromEntries(CONFIG_ALIASES.filter(([legacy, parent, key]) => input[legacy] !== undefined || input[parent]?.[key] !== undefined)
    .map(([legacy, parent, key]) => [legacy, merge(input[legacy], input[parent]?.[key])])) };
}

export function migrateLegacyConfig(input) {
  for (const parent of ['modes', 'memory']) {
    if (input[parent] !== undefined && (!input[parent] || typeof input[parent] !== 'object' || Array.isArray(input[parent]))) throw new TypeError(`配置 ${parent} 必须是对象，已拒绝迁移`);
  }
  const effective = adaptLegacyConfig(input);
  const next = structuredClone(input);
  const changes = [];
  for (const [legacy, parent, key] of CONFIG_ALIASES) {
    if (input[legacy] === undefined) continue;
    next[parent] = { ...next[parent], [key]: effective[legacy] };
    delete next[legacy];
    changes.push({ from: legacy, to: `${parent}.${key}` });
  }
  if (next.memory?.terms) {
    const terms = next.memory.terms;
    if (terms.learnerPreset !== undefined) next.memory.learnerPreset ??= terms.learnerPreset;
    if (terms.workspaceTitle !== undefined) next.memory.workspaceTitle ??= terms.workspaceTitle;
    for (const key of ['autoResearch', 'extractMinMessages', 'extractCooldownMs', 'inferenceThresholds', 'learnerPreset', 'workspaceTitle']) delete terms[key];
  }
  return { config: next, changes };
}

// 保存时统一写新键；旧文件只在读取或显式迁移边界兼容。
export function syncConfigAliases(input) {
  return migrateLegacyConfig(input).config;
}
