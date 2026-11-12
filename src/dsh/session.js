// 为 QQ 会话确保一个 DSH 会话
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../dsh-client.js';

// 创建 DSH 会话管理器
export function createDshSession(b) {
  // 本模块持有的内存状态
  const sessionPromises = new Map(); // 每个聊天一个创建任务，防止同时建两遍
  // 确保 key 对应的 DSH 会话存在并返回 id
  async function ensureSession(key) {
    const epoch = b.sessionEpoch;
    const policy = b.sessionPolicy(key);
    if (!b.isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    let existing = b.state.sessions[key];
    // 旧版会话 id 解不出 key，退役后重建
    if (existing && !b.BOUND_SESSION_ID_RE.test(String(existing))) {
      b.log(`会话 ${key} 的 id 不是执行期绑定形态（${existing}），退役并按新规则重建`);
      b.retireSession(key);
      existing = b.state.sessions[key];
    }
    if (existing) {
      // 代际不匹配必须丢弃旧会话，防止复活
      if (!b.isCurrentSession(key, existing)) {
        b.retireSession(key);
      } else {
        const applied = await b.ensureChatModel(existing);
        // DSH 侧会话已不存在：退役并重建
        if (applied === 'not-found') {
          b.log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          b.retireSession(key);
        } else {
          if (epoch !== b.sessionEpoch || !b.isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    // 真正去创建会话的活儿放在这里做
    const promise = (async () => {
      // sessionCwd 优先于 sessionWorkspace
      const perConversation = !b.cfg.sessionCwd && b.cfg.sessionWorkspace !== 'shared';
      const dir = b.cfg.sessionCwd ? String(b.cfg.sessionCwd)
        : perConversation ? path.join(b.STATE_DIR, 'agents', String(key).replace(/[^A-Za-z0-9._-]/g, '-'))
        : path.join(b.STATE_DIR, 'agents');
      const workspaceTitle = b.cfg.workspaceTitle && perConversation ? `${b.cfg.workspaceTitle} · ${key}` : b.cfg.workspaceTitle;
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = b.modePreset(key, b.currentMode, b.cfg);
      // 非 closed-agent 拿不到 qq-chat* 必须拒绝建会话，
      // 不能回退默认 preset，否则暴露本地工具
      const strictPreset = b.currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = b.currentMode === 'reserved2' ? (b.cfg.socialV2?.agentPreset || b.cfg.agentPreset) : b.cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${b.currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${b.dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 顺序有安全考虑：群聊模式不能退到没有预设的会话
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await b.api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && workspaceTitle) {
            await b.api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          // 预分配带会话身份的 sessionId，模型不可见
          const boundSessionId = b.encodeSelfKey(key);
          if (boundSessionId) params.sessionId = boundSessionId;
          const value = unwrap(await b.api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            b.log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            b.log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${b.currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 需显式 follow 会话才收得到事件
      b.api.events.follow(sessionId);
      // reset 期间创建完成：丢弃，防止旧会话复活
      if (epoch !== b.sessionEpoch || policy !== b.sessionPolicy(key) || !b.isSessionAllowedInCurrentMode(key)) {
        b.log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await b.withTimeout(b.api.workspace.archiveSession({ sessionId }), b.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      b.state.sessions[key] = sessionId;
      b.state.sessionPolicies[key] = policy;
      b.reverse.set(sessionId, key);
      b.saveState();
      await b.ensureChatModel(sessionId);
      if (epoch !== b.sessionEpoch || !b.isCurrentSession(key, sessionId)) {
        if (b.state.sessions[key] === sessionId) b.retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      b.log(`新会话 ${key} -> ${sessionId}（模式 ${b.currentMode}，preset: ${b.modePreset(key, b.currentMode, b.cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只删仍属于本 promise 的条目
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  return {
    sessionPromises, ensureSession };
}
