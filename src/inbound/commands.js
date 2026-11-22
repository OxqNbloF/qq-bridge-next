import fs from 'node:fs';
import path from 'node:path';

// 归档后的控制阶段：管理员审批优先，其后才判断静默、角色控制语和斜杠命令。
export function createInboundControls(b, allowIncomingRuntime) {
  async function consumeIncomingControl(input) {
    const { key, plainContent, isOwner, flags } = input;
    const roleState = b.readRoleState();
    const pending = b.pending.get(key);
    if (pending && isOwner) {
      await b.handlePendingAnswer(pending, plainContent, key, isOwner);
      return { consumed: true, roleState };
    }
    if (!allowIncomingRuntime({ ...input, roleState })) return { consumed: true, roleState };
    // 仅背景记忆的成员到归档为止，不执行控制命令，也不进入会话。
    if (flags.converse === false) return { consumed: true, roleState };
    if (flags.respond && !isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await b.sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return { consumed: true, roleState };
    }
    const consumed = plainContent.startsWith('/') && await b.handleInboundCommand({ ...input, roleState });
    return { consumed, roleState };
  }
  return { consumeIncomingControl };
}

export function createInboundCommands(b) {
  async function handleInboundCommand({ key, kind, id, cfg, plainContent, isOwner, roleState }) {
      if (!isOwner) {
        b.log(`忽略非管理员斜杠命令 ${key}`);
        return true;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = b.state.sessions[key];
        // 先清记忆再 retireSession，避免会话状态先被删导致清理遗漏
        b.forgetConversationMemory(key);
        b.retireSession(key);
        b.social.recentMessages.delete(key);
        b.messageMediaStore.delete(key);
        b.social.pendingSummaries.delete(key);
        b.seenForwardIds.delete(key);
        b.forgetAgentToken(key);
        b.socialV2.conversations.delete(key);
        if (old) {
          b.sessionEpoch++;
          b.saveSocialV2State();
          b.saveState();
          // 先停 DSH 侧排队工作，再归档
          try { await b.withTimeout(b.api.stopSessionWork(old), b.DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { b.log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await b.withTimeout(b.api.workspace.archiveSession({ sessionId: old }), b.DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        } else {
          b.saveSocialV2State();
        }
        await b.sendToQQ(key, '已重置会话，下次消息将开新上下文');
        return true;
      }
      if (plainContent === '/status') {
        const rs = b.readRoleState();
        await b.sendToQQ(key, `会话 ${b.state.sessions[key] ?? '未创建'}；白名单 ${b.modeAllowed(key, kind, id, cfg, b.currentMode, { listed: true }) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return true;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = b.sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          b.writeRoleState(null, roleState.mode);
          await b.sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(b.ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await b.sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            b.writeRoleState(name, roleState.mode);
            await b.sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return true;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        b.writeRoleState(roleState.role, 'silent');
        await b.sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return true;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        b.writeRoleState(roleState.role, 'active');
        await b.sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return true;
      }
      // 其余斜杠内容原样发给 DSH
      return false;
  }
  return { handleInboundCommand };
}
