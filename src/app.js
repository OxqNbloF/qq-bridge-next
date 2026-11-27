// QQ Bridge v3 主装配器：连接配置、存储、安全守卫、拟人调度、多 CLI 后端、Unix Socket Broker 与外部控制台
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from './config/schema.js';
import { createChatStore } from './storage/chat-store.js';
import { createMemoryStore } from './storage/memory-store.js';
import { parseConvKey, resolveChatRuntime } from './security/access.js';
import { createOutboundGuard } from './security/outbound-guard.js';
import { createMemberGate } from './security/member-gate.js';
import { createRoleStore } from './features/roles.js';
import { createTermsStore } from './features/terms.js';
import { createIdentityStore } from './features/identity.js';
import { createStickerStore } from './features/stickers.js';
import { createVoiceService } from './features/voice.js';
import { inspectImageUrl } from './features/media.js';
import { formatForwardNodes } from './features/forward.js';
import { buildDeltaPrompt, buildSystemPrompt } from './core/prompt.js';
import { createContextCompactor } from './core/compactor.js';
import { createOneBotGateway } from './gateway/onebot.js';
import { createTurnQueue } from './scheduler/turn-queue.js';
import { createHumanScheduler } from './scheduler/human-wake.js';
import { createBackendRegistry } from './backends/registry.js';
import { createSocketHub } from './broker/socket-hub.js';
import { createConsoleServer } from './console/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');

export function createBridgeApp({
  rootDir = DEFAULT_ROOT,
  configPath = '',
  initialConfig = null,
  dataDir = '',
  onebotClientFactory,
  spawnFn,
  detectCapsFn,
  dshClientFactory,
  logger = () => {},
} = {}) {
  const activity = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    activity.push(line);
    if (activity.length > 200) activity.shift();
    logger(line);
  };

  const resolvedDataDir = dataDir || path.join(rootDir, 'data');
  const configStore = createConfigStore({ configPath, initialConfig });
  const chatStore = createChatStore({ dataDir: resolvedDataDir });
  const memoryStore = createMemoryStore({ dataDir: resolvedDataDir });
  const roleStore = createRoleStore({ dataDir: resolvedDataDir, getConfig: () => configStore.get() });
  const memberGate = createMemberGate({ dataDir: resolvedDataDir, getConfig: () => configStore.get() });
  const termsStore = createTermsStore({ dataDir: resolvedDataDir, getConfig: () => configStore.get() });
  const identityStore = createIdentityStore({ dataDir: resolvedDataDir, getConfig: () => configStore.get() });
  const stickerStore = createStickerStore({ dataDir: resolvedDataDir, getConfig: () => configStore.get() });
  const voiceService = createVoiceService({ rootDir, getConfig: () => configStore.get() });
  let consoleServer = null;
  const outboundGuard = createOutboundGuard({
    getConfig: () => configStore.get(),
    getSecrets: () => [
      ...configStore.listSecrets(),
      consoleServer?.getToken?.() || '',
    ].filter(Boolean),
  });

  let scheduler = null;
  const onebot = createOneBotGateway({
    getConfig: () => configStore.get(),
    clientFactory: onebotClientFactory,
    log,
    onMessage: (msg) => scheduler?.onIncomingMessage(msg),
    onRecall: (ev) => scheduler?.onRecall?.(ev),
    onPoke: (ev) => scheduler?.onPoke?.(ev),
  });

  let compactor = null;
  const backendRegistry = createBackendRegistry({
    configStore,
    chatStore,
    spawnFn,
    detectCapsFn,
    dshClientFactory,
    rootDir,
    log,
    onUsage: (convKey, backendId, usage) => compactor?.observeUsage(convKey, backendId, usage),
  });

  compactor = createContextCompactor({
    getConfig: () => configStore.get(),
    chatStore,
    backendRegistry,
    log,
  });

  const turnQueue = createTurnQueue({
    getMaxConcurrent: () => configStore.get().runtime.maxConcurrent,
    getTurnTimeoutMs: () => configStore.get().runtime.turnTimeoutMs,
    log,
  });

  const socketHandlers = {
    'msg.send': async ({ convKey, args }) => {
      const check = outboundGuard.auditAndPrepare(convKey, args.messages);
      if (!check.ok) return check;
      const sent = [];
      for (let i = 0; i < check.messages.length; i += 1) {
        const txt = check.messages[i];
        await onebot.sendMessage(convKey, txt, i === 0 ? {
          replyToMessageId: args.replyToMessageId,
          atUserId: args.atUserId,
        } : {});
        sent.push(txt);
      }
      chatStore.recordSent(convKey, sent, { senderName: configStore.get().persona.name });
      log(`💬 [${convKey}] 已发送 ${sent.length} 条消息`);
      return { ok: true, sentCount: sent.length };
    },
    'msg.read_unread': async ({ convKey, args }) => {
      const res = chatStore.getUnread(convKey, { afterSeq: args.afterSeq, limit: args.limit, forModel: true });
      return {
        ok: true,
        ...res,
        messages: identityStore.projectForModel(convKey, res.messages),
      };
    },
    'msg.read_recent': async ({ convKey, args }) => {
      const messages = chatStore.getRecent(convKey, { limit: args.limit, offset: args.offset, forModel: true });
      return { ok: true, messages: identityStore.projectForModel(convKey, messages) };
    },
    'msg.wait': async ({ convKey, args }) => {
      const waitRes = await scheduler.waitForNewMessages(convKey, { timeoutMs: args.timeoutMs, quietMs: args.quietMs });
      return {
        ...waitRes,
        messages: identityStore.projectForModel(convKey, waitRes.messages ?? []),
      };
    },
    'msg.done': async ({ convKey, args }) => {
      const ack = chatStore.acknowledgeThrough(convKey, args.throughSeq ?? null);
      let wakeConfig = chatStore.get(convKey)?.wakeConfig;
      if (args.wakeConfig && typeof args.wakeConfig === 'object') {
        wakeConfig = scheduler.applyWakeConfig(convKey, args.wakeConfig);
      }
      return { ok: true, ...ack, wakeConfig };
    },
    'memory.list': async ({ convKey, args }) => ({
      ok: true,
      items: identityStore.projectForModel(
        convKey,
        memoryStore.list(convKey, { includeGlobal: args.includeGlobal !== false, limit: args.limit }),
      ),
    }),
    'memory.save': async ({ convKey, scope, args }) => {
      const targetScope = args.scope === 'global' && scope === 'admin' ? 'global' : 'chat';
      const item = memoryStore.save(convKey, { content: args.content, tags: args.tags, scope: targetScope });
      return { ok: true, item };
    },
    'memory.delete': async ({ convKey, args }) => ({
      ok: true,
      removed: memoryStore.remove(convKey, args.id),
    }),
    'memory.search': async ({ convKey, args }) => ({
      ok: true,
      items: identityStore.projectForModel(
        convKey,
        memoryStore.search(convKey, args.query, { limit: args.limit }),
      ),
    }),
    'memory.terms_list': async ({ convKey, args }) => ({
      ok: true,
      items: termsStore.list(convKey, { includeGlobal: true, limit: args.limit }),
    }),
    'memory.terms_search': async ({ convKey, args }) => ({
      ok: true,
      items: termsStore.search(convKey, args.query, { limit: args.limit }),
    }),
    'wake.get_state': async ({ convKey }) => {
      const st = chatStore.ensure(convKey);
      return { ok: true, unreadCount: st.unread.length, readThroughSeq: st.readThroughSeq, wakeConfig: st.wakeConfig };
    },
    'wake.set_config': async ({ convKey, args }) => ({
      ok: true,
      wakeConfig: scheduler.applyWakeConfig(convKey, args),
    }),
    'media.get_images': async ({ convKey, args }) => {
      const recent = chatStore.getRecent(convKey, { limit: 60, forModel: true });
      const items = [];
      for (const m of recent) {
        if (args.messageId && m.messageId !== String(args.messageId)) continue;
        if (Array.isArray(m.media) && m.media.length) items.push({ seq: m.seq, messageId: m.messageId, media: m.media });
      }
      return { ok: true, items: items.slice(-(Number(args.limit) || 10)) };
    },
    'media.get_forward': async ({ convKey, args }) => {
      const cfg = configStore.get();
      const rawNodes = await onebot.getForwardMsg(args.forwardId);
      const formatted = formatForwardNodes(rawNodes, { maxDepth: cfg.media.maxForwardDepth });
      return {
        ok: true,
        forwardId: args.forwardId,
        lines: identityStore.projectForModel(convKey, formatted.lines),
        media: formatted.media,
        truncated: formatted.truncated,
      };
    },
    'media.inspect_image': async ({ args }) => {
      const cfg = configStore.get();
      return inspectImageUrl(args.url, { maxBytes: cfg.media.maxBytes, maxPixels: cfg.media.maxPixels });
    },
    'sticker.list': async ({ convKey, args }) => ({
      ok: true,
      stickers: stickerStore.list(convKey, { query: args.query, limit: args.limit }),
    }),
    'sticker.send': async ({ convKey, args }) => stickerStore.sendSticker(convKey, args.ref, { onebot, outboundGuard }),
    'sticker.note': async ({ convKey, args }) => ({
      ok: true,
      sticker: stickerStore.setNote(args.id, convKey, args.note),
    }),
    'voice.list': async ({ args }) => ({
      ok: true,
      voices: voiceService.listVoices({ limit: args.limit }),
    }),
    'voice.send': async ({ convKey, args }) => voiceService.sendVoice(convKey, args.file, { onebot, outboundGuard }),
    'social.group_members': async ({ convKey, args }) => {
      const parsed = parseConvKey(convKey);
      if (parsed?.chatType !== 'group') return { ok: false, error: '仅群聊可查群成员' };
      const members = await onebot.getGroupMembers(parsed.targetId);
      const lim = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const raw = members.slice(0, lim).map((m) => ({
        userId: String(m.user_id ?? ''),
        nickname: String(m.card || m.nickname || ''),
        role: m.role || 'member',
      }));
      return {
        ok: true,
        members: identityStore.projectForModel(convKey, raw),
      };
    },
    'social.active_members': async ({ convKey, args }) => {
      const recent = chatStore.getRecent(convKey, { limit: 80, forModel: true });
      const byUser = new Map();
      for (const m of recent) {
        if (m.fromSelf || !m.userId) continue;
        byUser.set(m.userId, { userId: m.userId, name: m.senderName, lastTs: m.ts });
      }
      const list = [...byUser.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Number(args.limit) || 15);
      return { ok: true, members: identityStore.projectForModel(convKey, list) };
    },
    'social.poke': async ({ convKey, args }) => {
      await onebot.sendPoke(convKey, args.userId);
      return { ok: true };
    },
  };

  const socketHub = createSocketHub({
    getConfig: () => configStore.get(),
    dataDir: resolvedDataDir,
    handlers: socketHandlers,
    log,
  });

  async function runChatTurn({ convKey, reason, signal }) {
    const cfg = configStore.get();
    const runtime = resolveChatRuntime(cfg, convKey);
    const parsed = parseConvKey(convKey);
    const { unreadCount, messages, partial, readThroughSeq } = chatStore.getUnread(convKey, {
      limit: cfg.prompt.maxUnreadInline,
      forModel: true,
    });
    const sock = await socketHub.ensureSocket(convKey);
    const roleInj = roleStore.resolvePromptInjection(convKey);
    const termsBlock = termsStore.buildPromptBlock(convKey);
    const rosterBlock = parsed?.chatType === 'group'
      ? identityStore.renderRoster(convKey, { exposeQq: cfg.identity.exposeQqInPrompt === true })
      : '';
    const systemPrompt = buildSystemPrompt({
      persona: cfg.persona,
      chatPolicy: runtime,
      roleName: roleInj.roleName,
      roleCardText: roleInj.roleCardText,
      initialPrompt: roleInj.initialPrompt,
      termsBlock,
      rosterBlock,
    });
    const projectedMessages = identityStore.projectForModel(convKey, messages);
    const deltaPrompt = buildDeltaPrompt({
      reason,
      convKey,
      chatType: parsed?.chatType || 'group',
      unread: projectedMessages,
      readThroughSeq,
      partial,
      mode: runtime.mode,
    });

    log(`⚡ [${convKey}] 唤醒 (${reason}, 未读=${unreadCount}, backend=${runtime.backendId})`);
    return backendRegistry.runTurn({
      convKey,
      systemPrompt,
      deltaPrompt,
      socketPath: sock.socketPath,
      scope: sock.scope,
      signal,
    });
  }

  scheduler = createHumanScheduler({
    getConfig: () => configStore.get(),
    chatStore,
    turnQueue,
    runChatTurn,
    memberGate,
    identityStore,
    log,
  });

  consoleServer = createConsoleServer({
    configStore,
    chatStore,
    roleStore,
    memberGate,
    termsStore,
    identityStore,
    stickerStore,
    voiceService,
    backendRegistry,
    scheduler,
    turnQueue,
    socketHub,
    onebot,
    modulesDir: path.join(rootDir, 'modules'),
    webDir: path.join(rootDir, 'web'),
    dataDir: resolvedDataDir,
    getActivity: () => [...activity],
    log,
  });

  async function start({ connectOneBot = true } = {}) {
    const consoleInfo = await consoleServer.start();
    if (connectOneBot) await onebot.start();
    return { console: consoleInfo };
  }

  async function stop() {
    scheduler.close();
    turnQueue.close();
    socketHub.closeAll();
    await onebot.stop();
    await consoleServer.stop();
    chatStore.flush();
  }

  return {
    configStore,
    chatStore,
    memoryStore,
    roleStore,
    memberGate,
    termsStore,
    identityStore,
    stickerStore,
    voiceService,
    outboundGuard,
    onebot,
    backendRegistry,
    compactor,
    turnQueue,
    scheduler,
    socketHub,
    consoleServer,
    start,
    stop,
    getActivity: () => [...activity],
  };
}
