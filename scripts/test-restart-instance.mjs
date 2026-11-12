// 检查怎么认出本程序：只认入口在本仓库的 node 进程
// 别的仓库的同名启动器和桥接进程都不能被结束
//
// 平台：macOS 或 Linux（靠 restart.sh 和 shell 守护）
// 各跑一组，不属于当前平台的组不跑
import assert from 'node:assert/strict';
import {
  isBridgeCommandLine,
  isBridgeProcess,
  isGuardProcess,
  planStop,
  parseLsofPids,
  parsePsTable,
  parseSsListenerPid
} from './stop-bridge-instance.mjs';

let failures = 0;
// 跑一个测试用例，失败就记下来
function test(name, run) {
  try {
    run();
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

// 造一个进程信息对象
const proc = (pid, name, commandLine, parentPid = 4) => ({ pid, parentPid, name, commandLine });

{
  const ROOT = '/repo';

  test('识别 bridge.js 入口，不把参数中的同名文本当成入口（POSIX）', () => {
    assert.equal(isBridgeCommandLine('node /repo/src/bridge.js'), true);
    assert.equal(isBridgeCommandLine('/usr/local/bin/node /repo/src/bridge.js'), true);
    assert.equal(isBridgeCommandLine('node other.js --config bridge.js'), false);
    assert.equal(isBridgeCommandLine('node /repo/my-bridge.js'), false);
  });

  test('bridge 进程必须是 node 且使用可证明归属的绝对入口（POSIX）', () => {
    assert.equal(isBridgeProcess(proc(10, 'node', 'node src/bridge.js'), ROOT), false);
    assert.equal(isBridgeProcess(proc(10, 'node', 'node /repo/src/bridge.js'), ROOT), true);
    assert.equal(isBridgeProcess(proc(10, 'node', 'node /other/src/bridge.js'), ROOT), false);
    assert.equal(isBridgeProcess(proc(10, 'python3', 'python3 /repo/src/bridge.js'), ROOT), false);
    assert.equal(isBridgeProcess(null), false);
  });

  test('守护进程只认 start.sh，归属校验时要求绝对路径（POSIX）', () => {
    assert.equal(isGuardProcess(proc(20, 'bash', 'bash /repo/start.sh')), true);
    assert.equal(isGuardProcess(proc(20, 'zsh', '/bin/zsh /repo/start.sh')), true);
    assert.equal(isGuardProcess(proc(20, 'bash', 'bash /repo/start.sh'), ROOT), true);
    assert.equal(isGuardProcess(proc(20, 'bash', 'bash start.sh'), ROOT), false, '相对入口无法证明归属');
    assert.equal(isGuardProcess(proc(20, 'bash', 'bash /repo/restart.sh')), false);
    assert.equal(isGuardProcess(proc(20, 'node', 'node /repo/start.sh')), false);
  });

  test('锁 PID 验证通过 + 端口属于同一 PID → 连守护循环一起停（POSIX）', () => {
    const plan = planStop({
      root: ROOT,
      port: 3100,
      lockPid: 100,
      listenerPid: 100,
      processes: [
        proc(50, 'bash', 'bash /repo/start.sh'),
        proc(100, 'node', 'node /repo/src/bridge.js', 50)
      ]
    });
    assert.equal(plan.action, 'stop');
    assert.equal(plan.bridgePid, 100);
    assert.equal(plan.guardPid, 50);
    assert.equal(plan.killPid, 50, '先停守护循环，否则它 5 秒后会把旧实例拉回来');
  });

  test('父进程不是 start.sh → 只停止 node 本身（POSIX）', () => {
    const plan = planStop({
      root: ROOT, port: 3100, lockPid: 100, listenerPid: 100,
      processes: [proc(100, 'node', 'node /repo/src/bridge.js', 1)]
    });
    assert.equal(plan.action, 'stop');
    assert.equal(plan.guardPid, null);
    assert.equal(plan.killPid, 100);
  });

  test('其他仓库的 bridge.js / start.sh → 拒绝或只停自己的（POSIX）', () => {
    const other = planStop({
      root: ROOT, port: 3100, lockPid: 100, listenerPid: 100,
      processes: [
        proc(50, 'bash', 'bash /other/start.sh'),
        proc(100, 'node', 'node /repo/src/bridge.js', 50)
      ]
    });
    assert.equal(other.action, 'stop');
    assert.equal(other.guardPid, null, '别的仓库的守护不算本实例的进程树');

    const abort = planStop({
      root: ROOT, port: 3100, lockPid: 100, listenerPid: 100,
      processes: [proc(100, 'node', 'node /other/src/bridge.js')]
    });
    assert.equal(abort.action, 'abort');
  });

  test('相对入口即使锁与端口一致也拒绝停止（POSIX）', () => {
    const plan = planStop({
      root: ROOT, port: 3100, lockPid: 100, listenerPid: 100,
      processes: [proc(100, 'node', 'node src/bridge.js')]
    });
    assert.equal(plan.action, 'abort');
  });

  test('锁已失效但仍检测到 start.sh 守护循环 → 中止（防双实例，POSIX）', () => {
    const plan = planStop({
      port: 3100, lockPid: 100, listenerPid: null,
      processes: [proc(50, 'bash', 'bash /repo/start.sh')]
    });
    assert.equal(plan.action, 'abort');
    assert.match(plan.reason, /守护循环/);
  });

  test('端口被非锁 PID 监听 → 拒绝（POSIX）', () => {
    const plan = planStop({
      port: 3100, lockPid: 100, listenerPid: 200,
      processes: [proc(100, 'node', 'node /repo/src/bridge.js'), proc(200, 'node', 'node /other/src/bridge.js')]
    });
    assert.equal(plan.action, 'abort');
  });

  test('无锁、无端口、无进程 → 什么都不做（POSIX）', () => {
    assert.equal(planStop({ port: 3100 }).action, 'none');
  });

  test('解析 ps -axo 输出（comm 取 basename，args 允许空格）', () => {
    const out = [
      '  100     1 /usr/local/bin/node node /repo/src/bridge.js',
      '   50     1 /bin/bash bash /repo/start.sh',
      '  300    50 /usr/bin/ssh ssh host "bash /repo/start.sh"'
    ].join('\n');
    const processes = parsePsTable(out);
    assert.deepEqual(processes.map((p) => [p.pid, p.parentPid, p.name]), [
      [100, 1, 'node'],
      [50, 1, 'bash'],
      [300, 50, 'ssh']
    ]);
    assert.equal(processes[0].commandLine, 'node /repo/src/bridge.js');
    assert.equal(isBridgeProcess(processes[0], ROOT), true);
    assert.equal(isGuardProcess(processes[1], ROOT), true);
  });

  test('解析 lsof / ss 的监听 PID（POSIX）', () => {
    assert.equal(parseLsofPids('2222\n'), 2222);
    assert.equal(parseLsofPids(''), null);
    const ss = [
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
      'LISTEN 0      4096   127.0.0.1:3100      0.0.0.0:*     users:(("node",pid=2222,fd=20))',
      'LISTEN 0      4096   127.0.0.1:3000      0.0.0.0:*     users:(("node",pid=1111,fd=18))'
    ].join('\n');
    assert.equal(parseSsListenerPid(ss, 3100), 2222);
    assert.equal(parseSsListenerPid(ss, 3101), null);
  });
}

console.log(failures === 0
  ? '\n✅ 本实例识别回归通过'
  : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
