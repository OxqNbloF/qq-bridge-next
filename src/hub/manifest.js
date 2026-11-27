// 扫描与严格校验 modules/*/manifest.json
import fs from 'node:fs';
import path from 'node:path';

const SAFE_NAME_RE = /^[a-z0-9_-]{1,32}$/;
const SAFE_ACTION_RE = /^[a-z0-9_]{1,48}$/;
const ALLOWED_RUNTIMES = new Set(['node']);
const ALLOWED_SCOPES = new Set(['standard', 'admin']);
const ALLOWED_PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'string_or_array']);

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }

export function parseCapabilityManifest(modDir) {
  const absDir = path.resolve(modDir);
  const manifestPath = path.join(absDir, 'manifest.json');
  const rawText = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
  const manifest = JSON.parse(rawText);
  if (!isPlainObject(manifest)) throw new Error(`${manifestPath}: 必须是 JSON 对象`);

  const name = String(manifest.name ?? '').trim();
  if (!SAFE_NAME_RE.test(name)) throw new Error(`${manifestPath}: 非法能力名 ${JSON.stringify(manifest.name)}`);

  const scope = String(manifest.scope ?? 'standard').trim();
  if (!ALLOWED_SCOPES.has(scope)) throw new Error(`${manifestPath}: scope 只允许 standard 或 admin`);

  const runtime = String(manifest.runtime ?? 'node').trim();
  if (!ALLOWED_RUNTIMES.has(runtime)) throw new Error(`${manifestPath}: 仅支持 node runtime`);

  const entryRel = String(manifest.entry ?? '').trim();
  if (!entryRel || path.isAbsolute(entryRel)) throw new Error(`${manifestPath}: entry 必须是相对路径`);
  const entryPath = path.resolve(absDir, entryRel);
  if (!entryPath.startsWith(absDir + path.sep)) throw new Error(`${manifestPath}: entry 禁止路径穿越（${entryRel}）`);
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    throw new Error(`${manifestPath}: 入口脚本不存在（${entryPath}）`);
  }

  const timeoutRaw = Number(manifest.timeoutMs ?? 20000);
  const timeoutMs = Number.isFinite(timeoutRaw) ? Math.min(120_000, Math.max(1000, Math.round(timeoutRaw))) : 20000;
  const actions = isPlainObject(manifest.actions) ? manifest.actions : {};
  for (const [actName, actSpec] of Object.entries(actions)) {
    if (!SAFE_ACTION_RE.test(actName)) throw new Error(`${manifestPath}: 非法动作名 ${actName}`);
    if (!isPlainObject(actSpec)) throw new Error(`${manifestPath}: actions.${actName} 必须是对象`);
    if (actSpec.params !== undefined && !isPlainObject(actSpec.params)) {
      throw new Error(`${manifestPath}: actions.${actName}.params 必须是对象`);
    }
    for (const [pName, pSpec] of Object.entries(actSpec.params ?? {})) {
      if (!isPlainObject(pSpec) || !ALLOWED_PARAM_TYPES.has(String(pSpec.type ?? 'string'))) {
        throw new Error(`${manifestPath}: actions.${actName}.params.${pName} 类型非法`);
      }
    }
  }

  return {
    manifest: {
      name,
      scope,
      summary: String(manifest.summary ?? '').trim() || name,
      entry: entryRel,
      runtime,
      timeoutMs,
      network: manifest.network === true,
      actions,
    },
    modDir: absDir,
    entryPath,
  };
}

export function loadCapabilityManifests(modulesDir, { onError } = {}) {
  const map = new Map();
  if (!modulesDir || !fs.existsSync(modulesDir)) return map;
  const entries = fs.readdirSync(modulesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const dirEntry of entries) {
    if (!dirEntry.isDirectory() || dirEntry.name.startsWith('_') || dirEntry.name.startsWith('.')) continue;
    const modDir = path.join(modulesDir, dirEntry.name);
    if (!fs.existsSync(path.join(modDir, 'manifest.json'))) continue;
    try {
      const loaded = parseCapabilityManifest(modDir);
      map.set(loaded.manifest.name, loaded);
    } catch (error) {
      onError?.(dirEntry.name, error);
    }
  }
  return map;
}

export function validateActionArgs(actionSpec, rawArgs) {
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (!isPlainObject(args)) throw new Error('args 必须是 JSON 对象');
  const paramsSpec = actionSpec?.params ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(paramsSpec, key)) throw new Error(`未声明的参数字段：${key}`);
  }
  const cleaned = {};
  for (const [paramName, spec] of Object.entries(paramsSpec)) {
    const val = args[paramName];
    if (val === undefined || val === null) {
      if (spec.required === true) throw new Error(`缺少必填参数：${paramName}`);
      continue;
    }
    const type = String(spec.type ?? 'string');
    if (type === 'string') {
      if (typeof val !== 'string') throw new Error(`参数 ${paramName} 必须是字符串`);
      if (spec.required === true && !val.trim()) throw new Error(`参数 ${paramName} 不能为空`);
      cleaned[paramName] = val;
    } else if (type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val)) throw new Error(`参数 ${paramName} 必须是数字`);
      cleaned[paramName] = val;
    } else if (type === 'integer') {
      if (typeof val !== 'number' || !Number.isInteger(val)) throw new Error(`参数 ${paramName} 必须是整数`);
      cleaned[paramName] = val;
    } else if (type === 'boolean') {
      if (typeof val !== 'boolean') throw new Error(`参数 ${paramName} 必须是布尔值`);
      cleaned[paramName] = val;
    } else if (type === 'array') {
      if (!Array.isArray(val)) throw new Error(`参数 ${paramName} 必须是数组`);
      cleaned[paramName] = val;
    } else if (type === 'object') {
      if (!isPlainObject(val)) throw new Error(`参数 ${paramName} 必须是对象`);
      cleaned[paramName] = val;
    } else if (type === 'string_or_array') {
      if (typeof val !== 'string' && !Array.isArray(val)) throw new Error(`参数 ${paramName} 必须是字符串或数组`);
      cleaned[paramName] = val;
    }
  }
  return cleaned;
}
