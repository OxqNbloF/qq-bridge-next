import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';
import { canonicalV2Key } from '../policy/access.js';
import { readJsonSafe, atomicWriteJson } from '../store/fs-atomic.js';

// 压缩任务共享串行队列，模型会话仍按会话范围隔离。
export function createMemoryLearnerSession(b) {
  const learnerCollectors = new Map();
  const learnerWaiters = new Map();
  let taskChain = Promise.resolve();
  let generation = 0;
  function queueMemoryTask(fn) {
    taskChain = taskChain.then(fn).catch((error) => b.log('记忆整理任务异常:', error?.message ?? error));
    return taskChain;
  }
  const parkedSessions = new Map(); // 范围 -> 暂存的学习会话（存到硬盘，重启后再用）
  const MAX_PARKED_SESSIONS = 8;
  let parkedLoaded = false;
  let filePreset = null; // memory-session.json 所属的 preset

  // 把学习会话写进 memory-session.json 文件
  function writeSessionFile(preset, scope) {
    filePreset = preset;
    fs.mkdirSync(b.STATE_DIR, { recursive: true });
    const doc = { preset, parked: Object.fromEntries(parkedSessions) };
    if (b.memoryLearnerSessionId) Object.assign(doc, { sessionId: b.memoryLearnerSessionId, scope });
    atomicWriteJson(b.MEMORY_SESSION_FILE, doc);
  }

  // 取或建这个范围的学习会话，预设名必须先检查
  async function ensureMemoryLearnerSession(scope = 'global') {
    const learnerScope = scope === 'global' ? 'global' : canonicalV2Key(scope);
    if (!learnerScope) throw new Error('记忆会话范围非法');
    // 失败的隐私清理可能仍留有磁盘侧车映射；冻结期间绝不复用或重建。
    if (b.socialV2?.conversations?.get(learnerScope)?.modelSourcesIncomplete) throw new Error('记忆上下文冻结（model-sources-incomplete）');
    const preset = b.resolvePresetName(b.cfg.memory?.learnerPreset || b.cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('记忆整理缺少已验证的安全 preset，拒绝创建或复用会话');
    let reuseGeneration = generation;
    const saved = readJsonSafe(b.MEMORY_SESSION_FILE, null);
    // 退役一个学习会话
    const retire = (id) => {
      if (!learnerWaiters.has(id) && !learnerCollectors.has(id)) b.api.events.forget?.(String(id));
      b.stopRetiredSessionWork(String(id), 'memory');
    };
    if (!parkedLoaded) {
      parkedLoaded = true;
      for (const [k, id] of Object.entries(saved?.parked ?? {})) if (id) parkedSessions.set(k, String(id));
    }
    if (saved?.preset !== preset) {
      // 旧记录无 preset 或 preset 已换，无法证明权限：全部作废重建
      const oldId = b.memoryLearnerSessionId || saved?.sessionId;
      for (const id of parkedSessions.values()) retire(id);
      parkedSessions.clear();
      invalidateMemoryLearnerSession();
      reuseGeneration = generation;
      if (oldId) retire(oldId);
    } else if (saved.scope !== learnerScope) {
      // 换范围时先把旧会话存起来，不同范围互不串话
      const oldId = b.memoryLearnerSessionId || saved.sessionId;
      if (oldId) {
        parkedSessions.set(saved.scope, String(oldId));
        // 停放期间不订阅事件流，复用时重新 follow
        if (!learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
          b.learnerSessions.delete(oldId);
          b.api.events.forget?.(String(oldId));
        }
      }
      if (parkedSessions.size > MAX_PARKED_SESSIONS) {
        const [oldestScope, oldestId] = parkedSessions.entries().next().value;
        parkedSessions.delete(oldestScope);
        retire(oldestId);
      }
      const reuse = parkedSessions.get(learnerScope);
      parkedSessions.delete(learnerScope);
      if (reuse) {
        const status = await b.ensureChatModel(reuse);
        if (reuseGeneration !== generation) throw new Error('学习会话已作废，丢弃在途复用');
        if (status === 'not-found') {
          b.memoryLearnerSessionId = null;
          writeSessionFile(preset, learnerScope);
          throw new Error('session_not_found');
        }
        b.memoryLearnerSessionId = reuse;
        writeSessionFile(preset, learnerScope);
      } else {
        b.memoryLearnerSessionId = null;
        writeSessionFile(preset, learnerScope);
      }
    }
    if (b.memoryLearnerSessionId) {
      b.learnerSessions.add(b.memoryLearnerSessionId);
      b.api.events.follow(b.memoryLearnerSessionId);
      return b.memoryLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset && saved.scope === learnerScope) {
      const candidateId = String(saved.sessionId);
      const status = await b.ensureChatModel(candidateId);
      if (reuseGeneration !== generation) throw new Error('学习会话已作废，丢弃在途复用');
      if (status === 'not-found') throw new Error('session_not_found');
      filePreset = preset;
      b.memoryLearnerSessionId = candidateId;
      b.learnerSessions.add(candidateId);
      b.api.events.follow(candidateId);
      return b.memoryLearnerSessionId;
    }
    const creationGeneration = generation;
    const dir = path.join(b.STATE_DIR, 'memory-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await b.api.workspace.create({ path: dir }), 'memory workspace.create');
    const workspaceTitle = b.cfg.memory?.workspaceTitle || 'QQ 记忆整理';
    if (wsValue.created && workspaceTitle) {
      try { await b.api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await b.api.sessions.create(params), 'memory session.create');
    if (creationGeneration !== generation) {
      retire(value.sessionId);
      throw new Error('学习会话已作废，丢弃在途创建');
    }
    const createdId = value.sessionId;
    if (await b.ensureChatModel(createdId) === 'not-found') {
      retire(createdId);
      throw new Error('session_not_found');
    }
    if (creationGeneration !== generation) {
      retire(createdId);
      throw new Error('学习会话已作废，丢弃在途创建');
    }
    b.memoryLearnerSessionId = createdId;
    b.learnerSessions.add(createdId);
    b.api.events.follow(createdId);
    writeSessionFile(preset, learnerScope);
    b.log(`记忆整理会话已创建：${b.memoryLearnerSessionId}`);
    return b.memoryLearnerSessionId;
  }

  // 作废当前学习会话
  function invalidateMemoryLearnerSession(all = false) {
    generation++;
    const retired = new Set([b.memoryLearnerSessionId, ...(all ? parkedSessions.values() : [])].filter(Boolean));
    for (const id of retired) {
      for (const waiter of learnerWaiters.get(id) ?? []) {
        b.clearTimeout(waiter.timer);
        waiter.reject(new Error('学习会话已作废'));
      }
      learnerWaiters.delete(id);
      learnerCollectors.delete(id);
      b.stopRetiredSessionWork(id, 'memory');
    }
    if (all) {
      for (const id of parkedSessions.values()) {
        b.learnerSessions.delete(id);
        b.api.events.forget?.(id);
        b.modelAppliedSessions.delete(id);
      }
      parkedSessions.clear();
    }
    // 旧会话还在等待/收集中时先保留，否则移除
    const oldId = b.memoryLearnerSessionId;
    b.memoryLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      b.learnerSessions.delete(oldId);
      b.api.events.forget?.(oldId);
      b.modelAppliedSessions.delete(oldId);
    }
    // 还有停放会话就保留文件，免得重启后成孤儿；否则删文件
    if (parkedSessions.size && filePreset) {
      writeSessionFile(filePreset);
    } else {
      try { fs.unlinkSync(b.MEMORY_SESSION_FILE); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      try {
        fs.lstatSync(b.MEMORY_SESSION_FILE);
        throw new Error('学习会话撤销未持久化');
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    return true;
  }

  // 会话检查、发送和结果检查由同一所有者持有，跨会话删除也不能复用旧上下文。
  async function runMemoryLearnerTurn(scope, content) {
    const sessionId = await ensureMemoryLearnerSession(scope);
    const currentGeneration = generation;
    const assertCurrent = () => {
      if (generation !== currentGeneration || b.memoryLearnerSessionId !== sessionId || !b.learnerSessions.has(sessionId)) throw new Error('学习会话已作废');
    };
    assertCurrent();
    const accepted = await b.api.sessions.prompt({ sessionId, mode: 'queue', content });
    assertCurrent();
    if (!accepted.result.ok) throw new Error(`prompt 被拒：${accepted.result.error?.code}`);
    const output = await waitLearnerTurn(sessionId);
    assertCurrent();
    return { output, assertCurrent };
  }

  // 等待学习会话的下一轮结果，超时拒绝
  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = b.setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  return { learnerCollectors, learnerWaiters, queueMemoryTask, runMemoryLearnerTurn, ensureMemoryLearnerSession, invalidateMemoryLearnerSession, waitLearnerTurn };
}
