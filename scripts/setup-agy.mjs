#!/usr/bin/env node
// setup-agy.mjs — 为 Antigravity CLI (agy) 注册 qq-bridge-next 的安全 MCP 服务与权限规则
//
// 它做三件事：
// 1. 在 ~/.gemini/config/mcp_config.json 注册 snowluma / snowluma-host / web-search-safe 三个 stdio MCP 服务
// 2. 在 ~/.gemini/antigravity-cli/settings.json 的 permissions.allow 加入带斜杠的预放行规则（mcp(<server>/*)）并清理旧版无斜杠规则
// 3. 调用一次只读 MCP 工具做自检（可通过 --skip-check 跳过）
//
// 用法：
//   node scripts/setup-agy.mjs [--dry-run] [--skip-check]
// 可通过 AGY_GEMINI_HOME 覆盖默认的 ~/.gemini 目录（方便测试或隔离环境）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const GEMINI_HOME = process.env.AGY_GEMINI_HOME || path.join(os.homedir(), '.gemini');
const MCP_CONFIG_PATH = path.join(GEMINI_HOME, 'config', 'mcp_config.json');
const SETTINGS_PATH = path.join(GEMINI_HOME, 'antigravity-cli', 'settings.json');

const args = new Set(process.argv.slice(2));
if (args.has('-h') || args.has('--help')) {
  console.log('用法：node scripts/setup-agy.mjs [--dry-run] [--skip-check]\n默认写入 ~/.gemini 下的 mcp_config.json 与 antigravity-cli/settings.json（可用 AGY_GEMINI_HOME 覆盖）。');
  process.exit(0);
}
const DRY_RUN = args.has('--dry-run');
const SKIP_CHECK = args.has('--skip-check');

function log(msg) {
  console.log(`[setup-agy] ${msg}`);
}

function readJsonOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} 不是有效的 JSON 对象`);
  }
  return parsed;
}

function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${filePath}.bak-${stamp}`;
  fs.copyFileSync(filePath, dest);
  return dest;
}

function writeJsonSafe(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bak = backupIfExists(filePath);
  if (bak) log(`已备份 ${filePath} -> ${bak}`);
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

export function buildAgyMcpEntries(repoRoot = REPO_ROOT, nodeBin = process.execPath) {
  return {
    snowluma: {
      command: nodeBin,
      args: [path.join(repoRoot, 'src', 'mcp-snowluma-safe.js')],
    },
    'snowluma-host': {
      command: nodeBin,
      args: [path.join(repoRoot, 'src', 'mcp-host-server.js')],
    },
    'web-search-safe': {
      command: nodeBin,
      args: [path.join(repoRoot, 'src', 'mcp-web-search-safe.js')],
    },
  };
}

// agy 1.5.x 权限引擎只认 mcp(<server>/<tool>) 或 mcp(<server>/*)，缺斜杠不会命中
export const AGY_SAFE_MCP_ALLOW_RULES = Object.freeze([
  'mcp(snowluma/*)',
  'mcp(snowluma-host/*)',
  'mcp(web-search-safe/*)',
]);

// 旧版 setup-agy 写入过的无效无斜杠规则，迁移时自动清理
export const LEGACY_SLASHLESS_MCP_RULES = Object.freeze([
  'mcp(snowluma)',
  'mcp(snowluma-host)',
  'mcp(web-search-safe)',
]);

/** 从 agy --output-format json 输出中解析末条 JSON 结果对象 */
function parseAgyJsonOutput(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { return JSON.parse(lines[i]); } catch {}
    }
    return null;
  }
}

/** 写入后调用只读 MCP 工具验证权限规则是否生效 */
export function runSelfCheck({ command = 'agy', spawnSyncFn = spawnSync } = {}) {
  const res = spawnSyncFn(command, [
    '--output-format', 'json',
    '-p', '请调用 snowluma-host 的 snowluma_status 工具并返回结果（只读探活）',
  ], {
    encoding: 'utf8',
    timeout: 20000,
  });

  if (res.error) {
    if (res.error.code === 'ENOENT') {
      return { ok: false, skipped: true, reason: `未找到 ${command} 命令，已跳过在线 MCP 权限自检` };
    }
    return { ok: false, skipped: false, reason: `执行 ${command} 自检失败：${res.error.message}` };
  }

  const parsed = parseAgyJsonOutput(res.stdout);
  const denied = Array.isArray(parsed?.denied_actions)
    ? parsed.denied_actions
    : (Array.isArray(parsed?.result?.denied_actions) ? parsed.result.denied_actions : []);

  if (denied.length > 0) {
    return {
      ok: false,
      skipped: false,
      denied,
      reason: `自检检测到 denied_actions（${JSON.stringify(denied)}），MCP 权限未生效；请确认 settings.json 或 config.json 中的规则为 mcp(<server>/*) 或 mcp(<server>/<tool>)`,
    };
  }

  if (res.status !== 0) {
    const stderrTail = String(res.stderr ?? '').trim().slice(-300);
    return {
      ok: false,
      skipped: false,
      reason: `${command} 自检非 0 退出（code=${res.status}）${stderrTail ? `：${stderrTail}` : ''}`,
    };
  }

  return { ok: true, skipped: false };
}

function main() {
  const mcpDoc = readJsonOrEmpty(MCP_CONFIG_PATH);
  const nextMcp = {
    ...mcpDoc,
    mcpServers: {
      ...(mcpDoc.mcpServers && typeof mcpDoc.mcpServers === 'object' ? mcpDoc.mcpServers : {}),
      ...buildAgyMcpEntries(REPO_ROOT),
    },
  };

  const settingsDoc = readJsonOrEmpty(SETTINGS_PATH);
  const existingPerms = settingsDoc.permissions && typeof settingsDoc.permissions === 'object'
    ? settingsDoc.permissions
    : {};
  const legacySet = new Set(LEGACY_SLASHLESS_MCP_RULES);
  const existingAllow = (Array.isArray(existingPerms.allow) ? existingPerms.allow.map(String) : [])
    .filter((rule) => !legacySet.has(rule));
  const mergedAllow = [...new Set([...existingAllow, ...AGY_SAFE_MCP_ALLOW_RULES])];
  const nextSettings = {
    ...settingsDoc,
    permissions: {
      ...existingPerms,
      allow: mergedAllow,
    },
  };

  if (DRY_RUN) {
    log('DRY RUN — 将写入以下配置（未实际落盘）：');
    log(`1) ${MCP_CONFIG_PATH}:\n${JSON.stringify(nextMcp, null, 2)}`);
    log(`2) ${SETTINGS_PATH}:\n${JSON.stringify(nextSettings, null, 2)}`);
    return;
  }

  writeJsonSafe(MCP_CONFIG_PATH, nextMcp);
  log(`已更新 MCP 配置：${MCP_CONFIG_PATH}`);
  writeJsonSafe(SETTINGS_PATH, nextSettings);
  log(`已更新权限白名单：${SETTINGS_PATH}`);

  if (!SKIP_CHECK) {
    log('正在执行只读 MCP 权限自检（snowluma_status）…');
    const check = runSelfCheck();
    if (check.ok) {
      log('✅ 自检通过：agy 已可免审批调用安全 MCP 工具。');
    } else if (check.skipped) {
      log(`ℹ️ ${check.reason}`);
    } else {
      console.error(`[setup-agy] ❌ ${check.reason}`);
      process.exitCode = 1;
      return;
    }
  }

  log('完成！现在可以在 config.json 中将 backend.type 设为 "agy"，然后运行 ./start.sh 启动。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
