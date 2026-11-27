// 主应用组装器：连接传输层、访问边界、节奏调度、Unix Socket 能力中心、多执行引擎与外部控制面
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSettingsStore } from './config/schema.js';
import { createControlServer } from './control/server.js';
import { createContextCompactor } from './core/compactor.js';
import { composeDeltaPrompt, composeSystemPrompt } from './core/prompt.js';
import { createEngineRegistry } from './engines/registry.js';
import { createAudioVault } from './features/audio.js';
import { flattenBundleNodes } from './features/bundle.js';
import { createMemberDirectory } from './features/directory.js';
import { createEmoticonVault } from './features/emoticons.js';
import { createGlossaryVault } from './features/glossary.js';
import { createPersonaVault } from './features/personas.js';
import { createOneBotTransport } from './gateway/transport.js';
import { loadCapabilityManifests } from './hub/manifest.js';
import { createSocketHub } from './hub/socket-hub.js';
import { createPacingScheduler } from './scheduler/pacing.js';
import { createTurnQueue } from './scheduler/turn-queue.js';
import { createEgressGuard } from './security/egress-guard.js';
import { createMemberGuard } from './security/member-guard.js';
import { isRoomPermitted, parseRoomId, resolveRoomExecution } from './security/perimeter.js';
import { createNotesStore } from './storage/notes-store.js';
import { createRoomStore } from './storage/room-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');

export function createRelayApp({
  rootDir = DEFAULT_ROOT_DIR,
  configPath = path.join(DEFAULT_ROOT_DIR, 'config.json'),
  dataDir = path.join(DEFAULT_ROOT_DIR, 'data'),
  modulesDir = path.join(DEFAULT_ROOT_DIR, 'modules'),
  webDir = path.join(DEFAULT_ROOT_DIR, 'web'),
  initialConfig = null,
  spawnFn,
  detectCapsFn,
  dshClientFactory,
  transportClientFactory,
  log = (msg) => process.stdout.write(`[chat-relay] ${msg}\n`),
} = {}) {
  const settingsStore = createSettingsStore({ configPath: initialConfig ? '' : configPath, initialConfig });
  const getConfig = () => settingsStore.get();

  const roomStore = createRoomStore({ dataDir });
  const notesStore = createNotesStore({ dataDir });
  const personaVault = createPersonaVault({ dataDir, getConfig });
  const memberGuard = createMemberGuard({ dataDir, getConfig });
  const glossaryVault = createGlossaryVault({ dataDir, getConfig });
  const directory = createMemberDirectory({ dataDir, getConfig });
  const emoticonVault = createEmoticonVault({ dataDir, getConfig });
  const audioVault = createAudioVault({ rootDir, getConfig });
  const egressGuard = createEgressGuard({ getConfig, getSecrets: () => settingsStore.listSecrets() });
  const manifests = loadCapabilityManifests(modulesDir, {
    onError: (dirName, err) => log(`⚠️ 加载能力清单 ${dirName} 失败: ${err?.message ?? err}`),
  });

  const activity = [];
  function pushActivity(entry) {
    activity.unshift({ ts: Date.now(), ...entry });
    if (activity.length > 100) activity.length = 100;
  }

  let transport;
  let engineRegistry;
  let compactor;
  let turnQueue;
  let pacing;
  let socketHub;

  const handlers = {
    'chat.say': async ({ roomId, args }) => {
      const checked = egressGuard.inspectAndFormat(roomId, args.messages);
      if (!checked.ok) return checked;
      for (let i = 0; i < checked.messages.length; i += 1) {
        await transport.sendText(roomId, checked.messages[i], {
          replyToMessageId: i === 0 ? (args.replyToMessageId || '') : '',
          mentionUserId: i === 0 ? (args.mentionUserId || '') : '',
        });
      }
      roomStore.recordOutbound(roomId, checked.messages, { senderName: getConfig().character.displayName });
      pushActivity({ type: 'outbound', roomId, count: checked.messages.length });
      return { ok: true, sentCount: checked.messages.length, messages: checked.messages };
    },
    'chat.unread': async ({ roomId, args }) => {
      const res = roomStore.readUnread(roomId, { afterSeq: args.afterSeq, limit: args.limit, modelOnly: true });
      return { ok: true, ...directory.sanitizeForModel(roomId, res) };
    },
    'chat.history': async ({ roomId, args }) => {
      const items = roomStore.readRecent(roomId, { limit: args.limit, offset: args.offset, modelOnly: true });
      return { ok: true, messages: directory.sanitizeForModel(roomId, items) };
    },
    'chat.linger': async ({ roomId, args }) => {
      const res = await pacing.waitForMessages(roomId, { timeoutMs: args.timeoutMs, quietMs: args.quietMs });
      return { ok: true, ...directory.sanitizeForModel(roomId, res) };
    },
    'chat.finish': async ({ roomId, args }) => {
      const res = roomStore.markReadThrough(roomId, args.throughSeq);
      const rhythm = args.pacing ? pacing.applyRhythm(roomId, args.pacing) : (roomStore.get(roomId)?.rhythm ?? null);
      return { ok: true, ...res, rhythm };
    },
    'notes.list': async ({ roomId, args }) => ({ ok: true, items: notesStore.list(roomId, args) }),
    'notes.put': async ({ roomId, args }) => ({ ok: true, item: notesStore.put(roomId, args) }),
    'notes.remove': async ({ roomId, args }) => ({ ok: true, deleted: notesStore.remove(roomId, args.id) }),
    'notes.find': async ({ roomId, args }) => ({ ok: true, items: notesStore.find(roomId, args.query, args) }),
    'notes.glossary_list': async ({ roomId, args }) => ({ ok: true, items: glossaryVault.list(roomId, args) }),
    'notes.glossary_find': async ({ roomId, args }) => ({ ok: true, items: glossaryVault.find(roomId, args.query, args) }),
    'pacing.status': async ({ roomId }) => {
      const st = roomStore.ensure(roomId);
      return {
        ok: true,
        roomId,
        seq: st.seq,
        readCursor: st.readCursor,
        unreadCount: st.unread.length,
        rhythm: st.rhythm,
        lastTriggerAt: st.lastTriggerAt,
        lastReplyAt: st.lastReplyAt,
      };
    },
    'pacing.tune': async ({ roomId, args }) => ({ ok: true, rhythm: pacing.applyRhythm(roomId, args) }),
    'attach.list_media': async ({ roomId, args }) => {
      const lim = Math.min(60, Math.max(1, Number(args.limit) || 20));
      const recent = roomStore.readRecent(roomId, { limit: 60, modelOnly: true });
      const items = [];
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const m = recent[i];
        if (args.messageId && String(m.messageId) !== String(args.messageId)) continue;
        if (m.attachments?.length || m.bundleIds?.length) {
          items.push({
            seq: m.seq,
            messageId: m.messageId,
            senderName: m.senderName,
            attachments: m.attachments,
            bundleIds: m.bundleIds,
          });
          if (items.length >= lim) break;
        }
      }
      return { ok: true, items: directory.sanitizeForModel(roomId, items) };
    },
    'attach.unpack_bundle': async ({ roomId, args }) => {
      const maxDepth = getConfig()?.attachments?.maxForwardDepth ?? 3;
      const nodes = await transport.fetchBundle(args.bundleId);
      const flattened = flattenBundleNodes(nodes, { maxDepth });
      return { ok: true, bundleId: args.bundleId, ...directory.sanitizeForModel(roomId, flattened) };
    },
    'people.roster': async ({ roomId, args }) => ({
      ok: true,
      rosterText: directory.formatRoster(roomId, {
        revealRawId: getConfig().directory.revealRawId,
        maxEntries: args.limit || 20,
      }),
    }),
    'people.recent_speakers': async ({ roomId, args }) => {
      const lim = Math.min(30, Math.max(1, Number(args.limit) || 10));
      const recent = roomStore.readRecent(roomId, { limit: 60, modelOnly: true });
      const seen = new Set();
      const speakers = [];
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const m = recent[i];
        if (!m.senderId || m.fromSelf || seen.has(m.senderId)) continue;
        seen.add(m.senderId);
        speakers.push({ senderId: m.senderId, senderName: m.senderName, seq: m.seq });
        if (speakers.length >= lim) break;
      }
      return { ok: true, speakers: directory.sanitizeForModel(roomId, speakers) };
    },
    'people.nudge': async ({ roomId, args }) => {
      const gate = egressGuard.inspectAndFormat(roomId, '[轻拍]');
      if (!gate.ok) return gate;
      await transport.sendNudge(roomId, args.userId);
      return { ok: true };
    },
    'emoticon.list': async ({ roomId, args }) => ({ ok: true, items: emoticonVault.list(roomId, args) }),
    'emoticon.send': async ({ roomId, args }) => emoticonVault.dispatchEmoticon(roomId, args.ref, { transport, egressGuard }),
    'emoticon.annotate': async ({ roomId, args }) => ({ ok: true, item: emoticonVault.annotate(args.id, roomId, args.note) }),
    'audio.list': async ({ args }) => ({ ok: true, files: audioVault.listAudio(args) }),
    'audio.send': async ({ roomId, args }) => audioVault.dispatchAudio(roomId, args.file, { transport, egressGuard }),
  };

  socketHub = createSocketHub({ getConfig, dataDir, handlers, log });

  transport = createOneBotTransport({
    getConfig,
    clientFactory: transportClientFactory,
    log,
    onInbound: (msg) => {
      const res = pacing.onInbound(msg);
      if (res.accepted) pushActivity({ type: 'inbound', roomId: msg.roomId, woken: res.woken, reason: res.reason });
    },
    onRecall: (ev) => pacing.onRecall(ev),
    onNudge: (ev) => pacing.onNudge(ev),
  });

  turnQueue = createTurnQueue({
    getMaxConcurrency: () => getConfig()?.engine?.maxConcurrency ?? 4,
    getTurnTimeoutMs: () => getConfig()?.engine?.turnTimeoutMs ?? 300000,
    log,
  });

  engineRegistry = createEngineRegistry({
    settingsStore,
    roomStore,
    spawnFn,
    detectCapsFn,
    dshClientFactory,
    rootDir,
    log,
    onUsage: (roomId, engineId, usage) => compactor.observeUsage(roomId, engineId, usage),
  });

  compactor = createContextCompactor({ getConfig, roomStore, engineRegistry, log });

  async function runRoomTurn({ roomId, reason, signal }) {
    const cfg = getConfig();
    const exec = resolveRoomExecution(cfg, roomId);
    const parsed = parseRoomId(roomId);
    if (!parsed || !isRoomPermitted(cfg, roomId) || exec.paused || exec.mode === 'muted' || exec.mode === 'observer') {
      return { ok: true, skipped: true };
    }

    const { socketPath, scope } = await socketHub.ensureSocket(roomId);
    const unread = roomStore.readUnread(roomId, { limit: cfg.context.maxInlineUnread, modelOnly: true });
    const hasSession = Boolean(roomStore.getEngineSession(roomId, exec.engineId));
    const card = personaVault.resolvePromptCard(roomId, { forceFull: !hasSession });

    const systemPrompt = composeSystemPrompt({
      character: cfg.character,
      roomPolicy: exec,
      handoffSummary: roomStore.get(roomId)?.handoffSummary || '',
      personaName: card.personaName,
      cardText: card.cardText,
      intro: card.intro,
      glossarySection: glossaryVault.formatPromptSection(roomId),
      rosterSection: directory.formatRoster(roomId, { revealRawId: cfg.directory.revealRawId }),
    });

    const deltaPrompt = composeDeltaPrompt({
      reason,
      roomId,
      roomKind: parsed.kind,
      unread: directory.sanitizeForModel(roomId, unread.messages),
      readCursor: unread.readCursor,
      partial: unread.partial,
      mode: exec.mode,
    });

    pushActivity({ type: 'turn_start', roomId, engineId: exec.engineId, model: exec.model, reason });
    const res = await engineRegistry.executeTurn({
      roomId,
      systemPrompt,
      deltaPrompt,
      socketPath,
      scope,
      signal,
    });
    pushActivity({ type: 'turn_end', roomId, engineId: exec.engineId, ok: res.ok, error: res.error || '' });
    return res;
  }

  pacing = createPacingScheduler({
    getConfig,
    roomStore,
    turnQueue,
    runRoomTurn,
    memberGuard,
    directory,
    log,
  });

  settingsStore.onChange((nextCfg) => {
    for (const room of roomStore.list()) {
      const exec = resolveRoomExecution(nextCfg, room.roomId);
      if (!isRoomPermitted(nextCfg, room.roomId) || exec.paused || exec.mode === 'muted' || exec.mode === 'observer') {
        pacing.cancelRoomTimers(room.roomId);
        turnQueue.cancelRoom(room.roomId);
        socketHub.revokeSocket(room.roomId);
      }
    }
  });

  const controlServer = createControlServer({
    settingsStore,
    roomStore,
    engineRegistry,
    pacing,
    transport,
    dataDir,
    webDir,
    manifests,
    personaVault,
    memberGuard,
    glossaryVault,
    directory,
    emoticonVault,
    audioVault,
    activityFeed: () => [...activity],
    log,
  });

  async function start({ startTransport = true } = {}) {
    const controlInfo = await controlServer.start();
    if (startTransport) {
      await transport.start().catch((err) => {
        log(`⚠️ 传输层启动暂未连上（将继续运行控制面板）: ${err?.message ?? err}`);
      });
    }
    return { control: controlInfo };
  }

  async function stop() {
    pacing.close();
    turnQueue.close();
    socketHub.closeAll();
    await transport.stop();
    await controlServer.stop();
    roomStore.flush();
  }

  return {
    settingsStore,
    roomStore,
    notesStore,
    personaVault,
    memberGuard,
    glossaryVault,
    directory,
    emoticonVault,
    audioVault,
    egressGuard,
    manifests,
    transport,
    engineRegistry,
    compactor,
    turnQueue,
    pacing,
    socketHub,
    controlServer,
    runRoomTurn,
    start,
    stop,
  };
}
