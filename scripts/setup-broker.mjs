#!/usr/bin/env node
// 一键向 agy / gemini / 通用 MCP 配置注册 qq-broker（支持 --dry-run）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson, readJsonSafe } from '../src/storage/fs-atomic.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

function isPlain(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function mergeMcpEntry(existing, rootDir) {
  const next = isPlain(existing) ? structuredClone(existing) : {};
  const servers = isPlain(next.mcpServers) ? { ...next.mcpServers } : {};
  servers['qq-broker'] = {
    command: 'node',
    args: [path.resolve(rootDir, 'src/broker/mcp-server.js')],
  };
  next.mcpServers = servers;
  return next;
}

function mergeAgyPermissions(existing) {
  const next = isPlain(existing) ? structuredClone(existing) : {};
  const perms = isPlain(next.permissions) ? { ...next.permissions } : {};
  const allow = Array.isArray(perms.allow) ? perms.allow.map(String) : [];
  if (!allow.includes('mcp(qq-broker/*)')) allow.push('mcp(qq-broker/*)');
  perms.allow = allow;
  next.permissions = perms;
  return next;
}

export function applyBrokerSetup({
  rootDir = DEFAULT_ROOT,
  geminiHome = process.env.AGY_GEMINI_HOME || path.join(os.homedir(), '.gemini'),
  target = 'all',
  dryRun = false,
} = {}) {
  const t = String(target || 'all').toLowerCase();
  if (!['all', 'agy', 'gemini', 'mcp'].includes(t)) {
    throw new Error(`不支持的 --target 值：${target}`);
  }
  const plans = [];
  if (t === 'all' || t === 'mcp' || t === 'agy') {
    const filePath = path.join(geminiHome, 'config', 'mcp_config.json');
    plans.push({ label: 'mcp_config', filePath, next: mergeMcpEntry(readJsonSafe(filePath, {}), rootDir) });
  }
  if (t === 'all' || t === 'agy') {
    const filePath = path.join(geminiHome, 'antigravity-cli', 'settings.json');
    plans.push({ label: 'agy_settings', filePath, next: mergeAgyPermissions(readJsonSafe(filePath, {})) });
  }
  if (t === 'all' || t === 'gemini') {
    const filePath = path.join(geminiHome, 'settings.json');
    plans.push({ label: 'gemini_settings', filePath, next: mergeMcpEntry(readJsonSafe(filePath, {}), rootDir) });
  }

  if (!dryRun) {
    for (const p of plans) {
      fs.mkdirSync(path.dirname(p.filePath), { recursive: true });
      atomicWriteJson(p.filePath, p.next);
    }
  }

  return {
    dryRun: Boolean(dryRun),
    geminiHome,
    target: t,
    files: plans.map((p) => ({ label: p.label, filePath: p.filePath, written: !dryRun, config: p.next })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  let dryRun = false;
  let target = 'all';
  let geminiHome = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--target' && argv[i + 1]) target = argv[++i];
    else if (argv[i].startsWith('--target=')) target = argv[i].slice('--target='.length);
    else if (argv[i] === '--gemini-home' && argv[i + 1]) geminiHome = argv[++i];
    else if (argv[i].startsWith('--gemini-home=')) geminiHome = argv[i].slice('--gemini-home='.length);
  }
  console.log(JSON.stringify(applyBrokerSetup({ geminiHome: geminiHome || undefined, target, dryRun }), null, 2));
}
