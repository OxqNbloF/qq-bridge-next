// 零 Shell 本地脚本执行器（spawn shell=false + 最小环境 + 可选 Linux Bubblewrap）
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function buildBwrapArgs({ bin, binArgs, modDir, repoRoot, socketPath, allowNetwork = false }) {
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--ro-bind', modDir, modDir,
  ];
  if (repoRoot && repoRoot !== modDir) args.push('--ro-bind', repoRoot, repoRoot);
  if (socketPath) {
    const sockDir = path.dirname(socketPath);
    args.push('--bind', sockDir, sockDir);
  }
  if (!allowNetwork) args.push('--unshare-net');
  args.push('--die-with-parent', '--', bin, ...binArgs);
  return args;
}

export async function runModuleScript({
  entry,
  action,
  args = {},
  socketPath = '',
  scope = 'chat',
  repoRoot = process.cwd(),
  timeoutMs,
  useBwrap = false,
  spawnFn = spawn,
}) {
  const runtimeBin = process.execPath;
  const baseArgs = [entry.entryPath];
  const effectiveTimeout = Math.min(120_000, Math.max(1000, Number(timeoutMs ?? entry.manifest.timeoutMs) || 20000));

  const useSandbox = Boolean(useBwrap && process.platform === 'linux');
  const cmd = useSandbox ? 'bwrap' : runtimeBin;
  const cmdArgs = useSandbox
    ? buildBwrapArgs({
      bin: runtimeBin,
      binArgs: baseArgs,
      modDir: entry.modDir,
      repoRoot,
      socketPath,
      allowNetwork: entry.manifest.network === true,
    })
    : baseArgs;

  const minimalEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    QQ_SESSION_SOCK: String(socketPath || ''),
    QQ_MODULE_SCOPE: String(scope || 'chat'),
    QQ_BRIDGE_ROOT: String(repoRoot),
  };

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, cmdArgs, {
        shell: false,
        cwd: entry.modDir,
        env: minimalEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error: `启动模块 ${entry.manifest.name} 失败：${error?.message ?? error}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000).unref?.();
      finish({ ok: false, error: `模块 ${entry.manifest.name}.${action} 超时 (${effectiveTimeout}ms)` });
    }, effectiveTimeout);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish({ ok: false, error: error?.message ?? String(error) }));
    child.on('close', (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        finish({
          ok: false,
          error: stderr.trim() || `模块 ${entry.manifest.name}.${action} 未输出 JSON (exit=${code})`,
        });
        return;
      }
      const lastLine = trimmed.split(/\r?\n/).pop();
      try {
        const parsed = JSON.parse(lastLine);
        if (code && code !== 0 && parsed?.ok === undefined) {
          finish({ ok: false, ...parsed, exitCode: code });
          return;
        }
        finish(parsed);
      } catch {
        finish({ ok: false, error: `模块输出非合法 JSON: ${trimmed.slice(0, 200)}` });
      }
    });

    try {
      child.stdin?.end(JSON.stringify({ action, args }));
    } catch (error) {
      finish({ ok: false, error: `写入 stdin 失败：${error?.message ?? error}` });
    }
  });
}
