#!/usr/bin/env node
// 只停本仓库这一个桥接进程，给 restart.sh 用
// 旧启动器按进程名全机匹配，会误杀别的项目
// 所以这里先验证进程真的是本项目的，再停
// 证据只有两种：锁文件里的 PID、控制台端口监听者
// 两种必须对得上；对不上就拒绝结束，不猜
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONSOLE_PORT = 3100;
const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.dirname(path.dirname(THIS_FILE));
// macOS/Linux 上启动器是 shell 脚本 start.sh
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);

// 粗拆命令行，只用来找 node 的脚本入口
function commandTokens(commandLine) {
  return (String(commandLine ?? '').match(/"[^"]*"|\S+/g) ?? [])
    .map((token) => token.replace(/^"|"$/g, ''));
}

// 从命令行里取出 node 跑的脚本路径
function nodeScript(commandLine) {
  const tokens = commandTokens(commandLine);
  // 第一段是 node，选项之后第一个非选项才是脚本
  return tokens.slice(1).find((token) => !token.startsWith('-')) ?? '';
}

// 判断两个路径是不是同一个文件
function samePath(left, right) {
  // 把路径写法统一一下再比较
  const normalize = (p) => {
    const resolved = path.resolve(p);
    // macOS 默认不区分大小写，Linux 要逐字比
    return process.platform === 'linux' ? resolved : resolved.toLowerCase();
  };
  return normalize(left) === normalize(right);
}

// 看命令行是不是真拿 bridge.js 当脚本入口
export function isBridgeCommandLine(commandLine) {
  return /(^|[\\/])bridge\.js$/i.test(nodeScript(commandLine));
}

// 判断这个进程是不是本仓库的桥接
export function isBridgeProcess(proc, root = DEFAULT_ROOT) {
  if (!proc) return false;
  const name = String(proc.name ?? '').toLowerCase();
  if (name !== 'node.exe' && name !== 'node') return false;
  const script = nodeScript(proc.commandLine);
  if (!/(^|[\\/])bridge\.js$/i.test(script) || !path.isAbsolute(script)) return false;
  return samePath(script, path.join(root, 'src', 'bridge.js'));
}

// 守护进程：shell 在跑 start.sh，有 root 时还要对路径
export function isGuardProcess(proc, root) {
  if (!proc) return false;
  const name = String(proc.name ?? '').toLowerCase();
  const cmd = String(proc.commandLine ?? '');
  if (/restart\.(bat|sh)/i.test(cmd)) return false;
  if (POSIX_SHELLS.has(name)) {
    const script = commandTokens(cmd).find((token) => /(^|[\\/])start\.sh$/.test(token));
    if (!script || (root && !path.isAbsolute(script))) return false;
    return !root || samePath(script, path.join(root, 'start.sh'));
  }
  return false;
}

// 纯决策：只给出要做什么，不真的动手
export function planStop({ port, root = DEFAULT_ROOT, lockPid = null, processes = [], listenerPid = null }) {
  const lockProcess = lockPid == null ? null : processes.find((p) => p && p.pid === lockPid) ?? null;
  const verified = isBridgeProcess(lockProcess, root);

  // 端口是最有力的证据，不是锁里那个 PID 就不能杀
  // 要么锁丢了没法证明归属，要么端口被别人占了
  if (listenerPid != null && (!verified || listenerPid !== lockPid)) {
    return {
      action: 'abort',
      reason: `控制台端口 ${port} 被 PID ${listenerPid} 监听，但它不是锁文件里已验证的 qq-bridge 进程`,
      port, lockPid, listenerPid
    };
  }

  if (verified) {
    const parent = processes.find((p) => p && p.pid === lockProcess.parentPid) ?? null;
    const guard = isGuardProcess(parent, root) ? parent : null;
    return {
      action: 'stop',
      reason: guard
        ? `已验证 PID ${lockPid} 是本项目 bridge.js；连同其守护窗口 PID ${guard.pid} 的进程树一起停止`
        : `已验证 PID ${lockPid} 是本项目 bridge.js；只停止该进程`,
      port, lockPid, listenerPid,
      bridgePid: lockPid,
      guardPid: guard ? guard.pid : null,
      killPid: guard ? guard.pid : lockPid
    };
  }

  if (lockPid != null) {
    const detail = !lockProcess
      ? `PID ${lockPid} 已不存在`
      : `PID ${lockPid} 是 ${lockProcess.name || '未知进程'}，不是本项目的 bridge.js`;
    // 锁没了但还有 start.sh 在跑：没法证明是本仓库的
    // 这时删锁起新守护，可能和旧的抢同一个进程
    // 宁可中止让用户重试，也不按名字猜着杀
    const guard = processes.find((p) => isGuardProcess(p));
    if (guard) {
      return {
        action: 'abort',
        reason: `锁文件已过期（${detail}），但仍检测到 start.sh 守护循环 PID ${guard.pid}，无法证明归属；请等它把实例拉起来后重试，或手动关闭旧窗口`,
        port, lockPid, listenerPid
      };
    }
    return {
      action: 'cleanup',
      reason: `锁文件已过期（${detail}）；不能也不会按这个 PID 杀进程，只清理失效锁`,
      port, lockPid, listenerPid
    };
  }

  return { action: 'none', reason: '未发现本项目的运行实例与锁文件', port, lockPid, listenerPid };
}

// 跑一个命令并收集输出
function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024
  });
}

// 看懂 ps 输出：前三个字段加剩下整段命令
export function parsePsTable(stdout) {
  const processes = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const matched = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!matched) continue;
    const pid = Number(matched[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    processes.push({
      pid,
      parentPid: Number(matched[2]) || 0,
      name: path.basename(matched[3]),
      commandLine: matched[4]
    });
  }
  return processes;
}

// macOS 和 Linux 的 ps 都支持这套参数
export function listProcessesPosix() {
  return parsePsTable(run('ps', ['-axo', 'pid=,ppid=,comm=,args=']));
}

// 列出全机进程
export function listProcesses() {
  return listProcessesPosix();
}

// 从 lsof 输出里取出 PID
export function parseLsofPids(stdout) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

// Linux ss 输出里找端口和 pid
export function parseSsListenerPid(stdout, port) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim() || !/^LISTEN\b/i.test(line.trim())) continue;
    const columns = line.trim().split(/\s+/);
    const local = columns[3] ?? '';
    if (!new RegExp(`:${port}(\\s|$)`).test(local)) continue;
    const matched = /pid=(\d+)/.exec(line);
    if (matched) return Number(matched[1]);
  }
  return null;
}

// 找监听端口的进程：先试 lsof，再试 ss
export function getListenerPidPosix(port) {
  let probed = false;
  try {
    const pid = parseLsofPids(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
    probed = true;
    if (pid) return pid;
  } catch (error) {
    if (error?.status === 1) probed = true; // lsof 正常退出但没有匹配的行
  }
  try {
    const pid = parseSsListenerPid(run('ss', ['-ltnp']), port);
    return pid;
  } catch (error) {
    if (error?.status === 1) return null;
  }
  if (probed) return null;
  throw new Error('无法探测控制台端口的监听进程（本机没有可用的 lsof/ss）');
}

// 找监听这个端口的进程
export function getListenerPid(port) {
  return getListenerPidPosix(port);
}

// 从配置里读控制台端口
export function readConsolePort(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const port = Number(cfg?.consolePort);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return DEFAULT_CONSOLE_PORT;
}

// 从锁文件里读出 PID
export function readLockPid(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// 看这个进程还活着吗
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// 先好好请它退出，8 秒没退再强杀
async function stopPosix(plan) {
  const targets = [plan.guardPid, plan.bridgePid].filter((pid) => Number.isInteger(pid));
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 进程已退出 */ }
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!targets.some((pid) => pidAlive(pid))) return;
    await sleep(250);
  }
  for (const pid of targets) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 进程已退出 */ }
  }
  await sleep(250);
}

// 只有锁里还是这个 PID 才删，免得删掉新进程的锁
function removeLockIfOwner(lockFile, pid) {
  if (readLockPid(lockFile) !== pid) return false;
  try { fs.unlinkSync(lockFile); return true; } catch { return false; }
}

// 等一会儿再继续
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 等进程和端口都停掉
async function waitUntilStopped(pid, port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive = false;
    try { alive = pidAlive(pid); } catch {}
    let busy = null;
    try { busy = getListenerPid(port); } catch { busy = 'unknown'; }
    if (!alive && busy === null) return { ok: true };
    if (Date.now() >= deadline) return { ok: false, alive, busy };
    await sleep(250);
  }
}

// 把准备做什么打印出来
function printPlan(plan) {
  console.log(`[stop-bridge] ${plan.reason}`);
  console.log(JSON.stringify(plan, null, 2));
}

// 主流程：先判断，再确认，最后动手
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/stop-bridge-instance.mjs [--dry-run] [--root <仓库目录>]');
    return 0;
  }
  const dryRun = argv.includes('--dry-run');
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(
    rootIndex >= 0 && argv[rootIndex + 1]
      ? argv[rootIndex + 1].replace(/[\\/]+$/, '')
      : path.dirname(path.dirname(THIS_FILE))
  );
  const lockFile = path.join(root, 'state', 'bridge.lock');
  const port = readConsolePort(root);
  const lockPid = readLockPid(lockFile);

  let processes;
  let listenerPid;
  try {
    processes = listProcesses();
    listenerPid = getListenerPid(port);
  } catch (error) {
    console.error(`[stop-bridge] 无法枚举进程/端口，拒绝在信息不完整时结束任何进程：${error?.message ?? error}`);
    console.error(`[stop-bridge] 请在普通终端（非受限沙箱）重跑 restart.sh。`);
    return 1;
  }

  const plan = planStop({ port, root, lockPid, processes, listenerPid });
  printPlan(plan);

  if (dryRun) {
    console.log('[stop-bridge] --dry-run：未执行任何停止/删除操作。');
    return 0;
  }

  if (plan.action === 'abort') {
    console.error('[stop-bridge] 已中止：不结束未经验证的进程。');
    return 1;
  }

  if (plan.action === 'stop') {
    await stopPosix(plan);
    const stopped = await waitUntilStopped(plan.bridgePid, port);
    if (!stopped.ok) {
      console.error(`[stop-bridge] 停止失败：PID ${plan.bridgePid} 仍然存活或端口 ${port} 仍被监听（alive=${stopped.alive}, listener=${stopped.busy}）。`);
      return 1;
    }
    // 旧进程刚停时别的守护可能已拉起新进程，不能再起
    const replacementPid = readLockPid(lockFile);
    if (replacementPid != null && replacementPid !== plan.bridgePid) {
      console.error(`[stop-bridge] 旧实例已停止，但锁文件已被新实例 PID ${replacementPid} 接管；为避免双实例，已中止本次重启。`);
      return 1;
    }
    removeLockIfOwner(lockFile, plan.bridgePid);
    console.log(`[stop-bridge] 已停止本项目的 bridge（PID ${plan.bridgePid}${plan.guardPid ? `，守护窗口 PID ${plan.guardPid}` : ''}）。`);
    return 0;
  }

  // 没有可确认的活进程：端口空闲了，删失效锁是安全的
  if (lockPid != null && removeLockIfOwner(lockFile, lockPid)) {
    console.log(`[stop-bridge] 已清理失效锁（PID ${lockPid}）。`);
  }
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(THIS_FILE)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[stop-bridge] 未预期错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
