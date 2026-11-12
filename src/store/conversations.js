// 每会话策略覆盖表（state/conversations.json），只存显式覆盖项
import fs from 'node:fs';
import { SessionRouter, createInitialConversationState } from '../core/session-router.mjs';
import { atomicWriteJson } from './fs-atomic.js';
import { migrateDocument, stampSchema } from './schema.js';

// 创建会话覆盖表存储
export function createConversationStore(b) {
  let overrides = {}; // 标准聊天编号 -> 这个聊天的设置
  let writable = true;

  /** 实际装上的预设名，给路由判断预设属不属于这个模式 */
  function modePresets() {
    const v1 = b.cfg.agentPreset || 'qq-chat';
    const v2 = b.cfg.socialV2?.agentPreset || b.cfg.agentPreset || 'qq-chat-v2';
    const closed = b.resolvePresetName(b.closedAgentPreset) || 'standard';
    return { chat: [v1], reserved: [v1], reserved2: [v2], simulation: [v2], 'closed-agent': [closed] };
  }

  // 用给定覆盖表建一个会话路由器
  function routerWith(conversations) {
    const presets = modePresets();
    const state = createInitialConversationState(b.cfg.ownerQQ, { closedAgentEnabled: false, modePresets: presets });
    return new SessionRouter({ ownerQQ: b.cfg.ownerQQ, state: { ...state, conversations }, modePresets: presets });
  }

  // 改成只读，覆盖表当成空的
  function degrade(reason) {
    writable = false;
    b.log(`⚠️ conversations.json ${reason}，已降级为「只读不写」（不会覆盖原文件；覆盖表按空处理）`);
  }

  // 从文件加载覆盖表
  function loadConversationOverrides() {
    let raw;
    try { raw = fs.readFileSync(b.CONVERSATIONS_FILE, 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT') degrade(`读取失败：${error?.message ?? error}`); return; }
    try {
      const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      migrateDocument('conversations', doc);
      // 有一条不合法就整表拒收，不挑着用
      overrides = routerWith(doc.conversations ?? {}).snapshot().conversations;
    } catch (error) { degrade(`内容无效：${error?.message ?? error}`); return; }
    const n = Object.keys(overrides).length;
    if (n) b.log(`已加载 ${n} 条会话策略覆盖项（目前只记录，不参与模式判定）`);
  }

  // 列出当前所有覆盖项
  function listConversationOverrides() {
    return { writable, conversations: structuredClone(overrides) };
  }

  /** 执行一次修改；检查不过就抛错，写文件失败也抛错且内存不变 */
  function apply(change) {
    if (!writable) throw new Error('conversations.json 处于只读降级状态，不能修改');
    const router = routerWith(overrides);
    const result = change(router);
    const next = router.snapshot().conversations;
    atomicWriteJson(b.CONVERSATIONS_FILE, stampSchema('conversations', { conversations: next }));
    overrides = next;
    const e = result.auditEvent;
    b.appendActivity(`会话策略 ${e.type} ${e.key}（${e.updatedBy}）：${e.before.mode}/${e.before.preset} → ${e.after.mode}/${e.after.preset}`);
    return result;
  }

  // 设置一个会话的覆盖项
  function setConversationOverride(key, { mode, preset, model, reasoningEffort } = {}, updatedBy) {
    return apply((router) => {
      const record = { mode, preset: preset ?? router.modePresets[String(mode ?? '').trim()]?.[0], updatedBy };
      if (model != null) record.model = model;
      if (reasoningEffort != null) record.reasoningEffort = reasoningEffort;
      return router.setConversation(key, record);
    });
  }

  // 删除一个会话的覆盖项
  function deleteConversationOverride(key, updatedBy) {
    return apply((router) => router.deleteConversation(key, { updatedBy }));
  }

  return { loadConversationOverrides, listConversationOverrides, setConversationOverride, deleteConversationOverride };
}
