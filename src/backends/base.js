// 多 CLI 后端共享进程执行、stream-json 行解析、能力探测与提示词拼装底座
import { spawn, spawnSync } from 'node:child_process';

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const inputTokens = Number(raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens ?? raw.total_input_tokens ?? 0);
  const outputTokens = Number(raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokens ?? (inputTokens + outputTokens));
  if (!inputTokens && !outputTokens && !totalTokens) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens || (inputTokens + outputTokens),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
}

export function buildCombinedPrompt({ systemPrompt = '', deltaPrompt = '', includeSystem = false } = {}) {
  if (!includeSystem || !systemPrompt) return String(deltaPrompt ?? '');
  return `<system>\n${String(systemPrompt).trim()}\n</system>\n\n---\n\n${String(deltaPrompt ?? '')}`;
}

export function probeHelpCapabilities(command, parser, cacheMap, detectCapsFn) {
  const key = String(command || '').trim();
  if (cacheMap.has(key)) return cacheMap.get(key);
  let caps;
  let shouldCache = true;
  if (typeof detectCapsFn === 'function') {
    caps = parser(detectCapsFn(key) || '');
    if (typeof caps === 'object' && typeof detectCapsFn(key) === 'object') {
      caps = detectCapsFn(key);
    }
  } else {
    try {
      const res = spawnSync(key, ['--help'], { encoding: 'utf8', timeout: 5000 });
      if (res.error) shouldCache = false;
      caps = parser(`${res.stdout || ''}\n${res.stderr || ''}`);
    } catch {
      shouldCache = false;
      caps = parser('');
    }
  }
  if (shouldCache) cacheMap.set(key, caps);
  return caps;
}

export async function runSpawnedCli({
  command,
  args,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 300000,
  signal = null,
  spawnFn = spawn,
  onStdoutLine,
}) {
  let stdoutBuf = '';
  let lineRemainder = '';
  let stderrBuf = '';
  let timedOut = false;
  let aborted = false;
  let spawnError = null;
  let exitCode = null;

  await new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timeoutTimer = null;
    let forceKillTimer = null;

    const killChild = () => {
      if (!child) return;
      try { child.kill('SIGTERM'); } catch {}
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 2500);
      forceKillTimer.unref?.();
    };

    const onAbort = () => {
      aborted = true;
      killChild();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    };

    if (signal?.aborted) {
      aborted = true;
      finish();
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      child = spawnFn(command, args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error?.message ?? String(error);
      finish();
      return;
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, Math.max(1000, Number(timeoutMs) || 300000));
    timeoutTimer.unref?.();

    child.stdout?.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (stdoutBuf.length < 4 * 1024 * 1024) stdoutBuf += str;
      lineRemainder += str;
      const lines = lineRemainder.split(/\r?\n/);
      lineRemainder = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) onStdoutLine?.(line);
      }
    });

    child.stderr?.on('data', (chunk) => {
      if (stderrBuf.length < 256 * 1024) stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      spawnError = error?.message ?? String(error);
      finish();
    });

    child.on('close', (code) => {
      exitCode = code;
      if (lineRemainder.trim()) onStdoutLine?.(lineRemainder);
      finish();
    });
  });

  return { stdout: stdoutBuf, stderr: stderrBuf, timedOut, aborted, spawnError, exitCode };
}
