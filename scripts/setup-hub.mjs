// 一键向 agy / gemini CLI 注册 chat-relay MCP 能力中心（relay-hub）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJsonSafe } from '../src/storage/fs-atomic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_HUB_PATH = path.join(REPO_ROOT, 'src', 'hub', 'mcp-server.js');

function updateJsonSettings(settingsPath, { hubPath, addPermissionAllow = false, dryRun = false }) {
  const existed = fs.existsSync(settingsPath);
  const current = existed ? readJsonSafe(settingsPath, {}) : {};
  const next = current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current) : {};

  if (!next.mcpServers || typeof next.mcpServers !== 'object' || Array.isArray(next.mcpServers)) {
    next.mcpServers = {};
  }
  next.mcpServers['relay-hub'] = {
    command: 'node',
    args: [hubPath],
  };

  if (addPermissionAllow) {
    if (!next.permissions || typeof next.permissions !== 'object' || Array.isArray(next.permissions)) {
      next.permissions = {};
    }
    const existingAllow = Array.isArray(next.permissions.allow) ? next.permissions.allow.map(String) : [];
    if (!existingAllow.includes('mcp(relay-hub/*)')) {
      existingAllow.push('mcp(relay-hub/*)');
    }
    next.permissions.allow = existingAllow;
  }

  if (!dryRun) {
    atomicWriteJson(settingsPath, next);
  }
  return { path: settingsPath, existed, written: !dryRun, config: next };
}

export function applyHubSetup({
  hubPath = DEFAULT_HUB_PATH,
  agySettingsPath = path.join(os.homedir(), '.agy', 'settings.json'),
  geminiSettingsPath = path.join(os.homedir(), '.gemini', 'settings.json'),
  dryRun = false,
} = {}) {
  const results = [];
  if (agySettingsPath) {
    results.push({
      cli: 'agy',
      ...updateJsonSettings(agySettingsPath, { hubPath, addPermissionAllow: true, dryRun }),
    });
  }
  if (geminiSettingsPath) {
    results.push({
      cli: 'gemini',
      ...updateJsonSettings(geminiSettingsPath, { hubPath, addPermissionAllow: false, dryRun }),
    });
  }
  return { ok: true, hubPath, dryRun, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const out = applyHubSetup({ dryRun });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
