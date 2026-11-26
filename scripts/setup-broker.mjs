#!/usr/bin/env node
// 一键写入 qq-broker MCP 注册与权限配置（支持 agy / gemini / mcp_config，支持 --dry-run）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson, readJsonSafe } from '../src/store/fs-atomic.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function buildBrokerServerEntry(rootDir) {
  return {
    command: 'node',
    args: [path.resolve(rootDir, 'src/broker/mcp-broker.js')],
  };
}

function mergeMcpServerConfig(existing, rootDir) {
  const next = isPlainObject(existing) ? structuredClone(existing) : {};
  const servers = isPlainObject(next.mcpServers) ? { ...next.mcpServers } : {};
  servers['qq-broker'] = buildBrokerServerEntry(rootDir);
  next.mcpServers = servers;
  return next;
}

function mergeAgySettings(existing) {
  const next = isPlainObject(existing) ? structuredClone(existing) : {};
  const perms = isPlainObject(next.permissions) ? { ...next.permissions } : {};
  const allow = Array.isArray(perms.allow) ? perms.allow.map(String) : [];
  if (!allow.includes('mcp(qq-broker/*)')) allow.push('mcp(qq-broker/*)');
  perms.allow = allow;
  next.permissions = perms;
  return next;
}

/** 根据目标写入或预览配置 */
export function applyBrokerSetup({
  rootDir = DEFAULT_ROOT_DIR,
  geminiHome = process.env.AGY_GEMINI_HOME || path.join(os.homedir(), '.gemini'),
  target = 'all',
  dryRun = false,
} = {}) {
  const normalizedTarget = String(target || 'all').toLowerCase();
  if (!['all', 'agy', 'gemini', 'mcp'].includes(normalizedTarget)) {
    throw new Error(`不支持的 --target 值：${target}（仅支持 all / agy / gemini / mcp）`);
  }

  const plans = [];
  if (normalizedTarget === 'all' || normalizedTarget === 'mcp' || normalizedTarget === 'agy') {
    const mcpConfigPath = path.join(geminiHome, 'config', 'mcp_config.json');
    const current = readJsonSafe(mcpConfigPath, {});
    plans.push({
      label: 'mcp_config',
      filePath: mcpConfigPath,
      next: mergeMcpServerConfig(current, rootDir),
    });
  }
  if (normalizedTarget === 'all' || normalizedTarget === 'agy') {
    const agySettingsPath = path.join(geminiHome, 'antigravity-cli', 'settings.json');
    const current = readJsonSafe(agySettingsPath, {});
    plans.push({
      label: 'agy_settings',
      filePath: agySettingsPath,
      next: mergeAgySettings(current),
    });
  }
  if (normalizedTarget === 'all' || normalizedTarget === 'gemini') {
    const geminiSettingsPath = path.join(geminiHome, 'settings.json');
    const current = readJsonSafe(geminiSettingsPath, {});
    plans.push({
      label: 'gemini_settings',
      filePath: geminiSettingsPath,
      next: mergeMcpServerConfig(current, rootDir),
    });
  }

  if (!dryRun) {
    for (const plan of plans) {
      fs.mkdirSync(path.dirname(plan.filePath), { recursive: true });
      atomicWriteJson(plan.filePath, plan.next);
    }
  }

  return {
    dryRun: Boolean(dryRun),
    geminiHome,
    target: normalizedTarget,
    files: plans.map((p) => ({
      label: p.label,
      filePath: p.filePath,
      written: !dryRun,
      config: p.next,
    })),
  };
}

function parseCliArgs(argv) {
  const opts = { dryRun: false, target: 'all', geminiHome: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--target' && argv[i + 1]) { opts.target = argv[++i]; }
    else if (arg.startsWith('--target=')) { opts.target = arg.slice('--target='.length); }
    else if (arg === '--gemini-home' && argv[i + 1]) { opts.geminiHome = argv[++i]; }
    else if (arg.startsWith('--gemini-home=')) { opts.geminiHome = arg.slice('--gemini-home='.length); }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法: node scripts/setup-broker.mjs [--dry-run] [--target all|agy|gemini|mcp] [--gemini-home <dir>]');
    process.exit(0);
  }
  const result = applyBrokerSetup({
    geminiHome: opts.geminiHome || undefined,
    target: opts.target,
    dryRun: opts.dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}
