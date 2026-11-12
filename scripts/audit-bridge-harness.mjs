import { resolveInstalledPreset, synchronizePreset } from '../src/preset-sync.js';
import { renderPatch } from '../src/preset-patch.js';
import * as policyMode from '../src/policy/mode.js';
import * as policyAccess from '../src/policy/access.js';
import * as policyAudit from '../src/policy/audit.js';
import * as storeFsAtomic from '../src/store/fs-atomic.js';
import * as storeSchema from '../src/store/schema.js';
import * as storeArchive from '../src/store/archive.js';
import * as storeArchiveRetention from '../src/store/archive-retention.js';
import * as policyToolDefaults from '../src/policy/tool-defaults.js';
import * as appContext from '../src/app-context.js';
import * as infraAsync from '../src/infra/async.js';
import * as infraLog from '../src/infra/log.js';
import * as infraLock from '../src/infra/lock.js';
import * as infraStateAcl from '../src/infra/state-acl.js';
import * as infraConfig from '../src/infra/config.js';
import * as gatewayOneBotHttp from '../src/gateway/onebot-http.js';
import * as gatewayTokenHeal from '../src/gateway/token-heal.js';
import * as gatewayUpstreamHealth from '../src/gateway/upstream-health.js';
import * as gatewaySnowlumaWs from '../src/gateway/snowluma-ws.js';
import * as inboundNormalize from '../src/inbound/normalize.js';
import * as inboundMedia from '../src/inbound/media.js';
import * as inboundContext from '../src/inbound/context.js';
import * as inboundForward from '../src/inbound/forward.js';
import * as inboundRecall from '../src/inbound/recall.js';
import * as inboundFilter from '../src/inbound/filter.js';
import * as inboundPoke from '../src/inbound/poke.js';
import * as conversationsPolicy from '../src/conversations/policy.js';
import * as conversationsPending from '../src/conversations/pending.js';
import * as conversationsOutbox from '../src/conversations/outbox.js';
import * as conversationsTurns from '../src/conversations/turns.js';
import * as dshModel from '../src/dsh/model.js';
import * as dshWatch from '../src/dsh/watch.js';
import * as dshSession from '../src/dsh/session.js';
import * as dshDeliver from '../src/dsh/deliver.js';
import * as dshEvents from '../src/dsh/events.js';
import * as routeNext from '../src/infra/http/route-next.js';
import * as httpServer from '../src/infra/http/server.js';
import * as httpAuthConsole from '../src/infra/http/auth-console.js';
import * as httpAuthAgent from '../src/infra/http/auth-agent.js';
import * as consoleServer from '../src/http-server.js';
import * as consoleToken from '../src/features/console/token.js';
import * as consoleActivity from '../src/features/console/activity.js';
import * as toolGate from '../src/features/tools/gate.js';
import * as rolesCard from '../src/features/roles/card.js';
import * as rolesState from '../src/features/roles/state.js';
import * as rolesInject from '../src/features/roles/inject.js';
import * as presetsPrompt from '../src/features/presets/prompt.js';
import * as storeRoleInject from '../src/store/role-inject.js';
import * as sv2WakeConfig from '../src/features/social-v2/wake-config.js';
import * as sv2Participation from '../src/features/social-v2/participation.js';
import * as sv2Triggers from '../src/features/social-v2/triggers.js';
import * as sv2TimeSense from '../src/features/social-v2/time-sense.js';
import * as sv2Prompt from '../src/features/social-v2/prompt.js';
import * as sv2Scheduler from '../src/features/social-v2/scheduler.js';
import * as sv1StateMachine from '../src/features/simulation-v1/state-machine.js';
import * as sv1Prompts from '../src/features/simulation-v1/prompts.js';
import * as sv1Loop from '../src/features/simulation-v1/loop.js';
import * as sendQueue from '../src/features/send/queue.js';
import * as sendSender from '../src/features/send/sender.js';
import * as sendSplit from '../src/features/send/split.js';
import * as sendTimeline from '../src/features/send/timeline.js';
import * as sendV2 from '../src/features/send/v2.js';
import * as policySendGuard from '../src/policy/send-guard.js';
import * as voiceConfig from '../src/features/voice/config.js';
import * as voiceBudget from '../src/features/voice/budget.js';
import * as voiceSend from '../src/features/voice/send.js';
import * as stickerStore from '../src/features/sticker/store.js';
import * as stickerSend from '../src/features/sticker/send.js';
import * as slangLearning from '../src/features/slang/learning.js';
import * as slangWindow from '../src/features/slang/window.js';
import * as slangInject from '../src/features/slang/inject.js';
import * as usageRecord from '../src/features/usage/record.js';
import * as storeArchiveWiring from '../src/store/archive-wiring.js';
import * as storeDeliveryCursors from '../src/store/delivery-cursors.js';
import * as storeSocialV2 from '../src/store/social-v2.js';
import * as storeInitialPrompts from '../src/store/initial-prompts.js';
import * as storeConversations from '../src/store/conversations.js';
import * as storePool from '../src/store/pool.js';
import * as storeViews from '../src/store/views.js';
import * as memoryCursor from '../src/memory/cursor.js';
import * as memoryCompress from '../src/memory/compress.js';
import * as memoryIndexModule from '../src/memory/index.js';
import * as slangPool from '../src/features/slang/pool.js';
import * as storeFeedback from '../src/store/feedback.js';
import * as storeSessions from '../src/store/sessions.js';
import * as policySelfKey from '../src/policy/self-key.js';
import * as modelView from '../src/qq-model-view.js';
import * as consoleRoleRoutes from '../src/features/console/routes/roles.js';
import * as consoleSlangRoutes from '../src/features/console/routes/slang.js';
import * as consoleSessionRoutes from '../src/features/console/routes/sessions.js';
import * as consoleSettingsRoutes from '../src/features/console/routes/settings.js';
import * as consoleSocialRoutes from '../src/features/console/routes/social.js';
import * as consoleCoreRoutes from '../src/features/console/routes/core.js';
import * as consoleMaintenanceRoutes from '../src/features/console/routes/maintenance.js';
import * as toolSocialV2Routes from '../src/features/tools/http-face/social-v2.js';
import * as toolMediaRoutes from '../src/features/tools/http-face/media.js';
import * as toolContextRoutes from '../src/features/tools/http-face/context.js';
import * as toolSendRoutes from '../src/features/tools/http-face/send.js';
import * as usageDashboardRoutes from '../src/features/usage/dashboard.js';
// 用临时文件和假对端跑真的桥接初始化和函数
// 不读真实配置、不连 QQ/DSH，也不写本机目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as roleCard from '../src/role-card.js';
import * as stateAcl from '../src/state-acl.mjs';
import { persistSnowLumaEndpoint, persistToken } from '../src/snowluma-conn.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// 搭一个测试用桥接环境：临时文件、假对端
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-')));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外的状态文件，用来测启动时读到坏文件的情况
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], forgotten: [], cancelled: [], images: [], faces: [], http: [], responded: [], workspaces: [], renames: [] };
  // 语音发送在桥接里直接请求网关，和文本共用发送链
  // 所以给它一个会记下来的 fetch：不真发，还能看发了什么
  const fakeFetch = async (url, init = {}) => {
    // 把请求体读成对象，读不开就原样返回
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // 同步收藏表情的 HTTP 退路要拿到数组
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // 语音检查用：回一条带语音段的消息，模拟真网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  // 包一层成功返回
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id), forget: (id) => calls.forgotten.push(id) },
    // 默认桩：没有 qq-mode 设置，模式回退到本地文件
    // 测试可以覆盖它来验证设置的优先级
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      // 和真 DSH 一致：同一路径第二次不再新建
      create: async ({ path: wsPath } = {}) => {
        const created = !calls.workspaces.includes(wsPath);
        if (created) calls.workspaces.push(wsPath);
        return success({ created, workspace: { workspaceId: `fixture-workspace-${calls.workspaces.indexOf(wsPath)}` } });
      },
      rename: async (params) => { calls.renames.push(params); return success({}); },
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      // 真 DSH 会用调用方给的会话 id
    // 夹具也要照做，否则测试看不到绑定形态的 id
    create: async (params) => { calls.created.push(params); return success({ sessionId: params?.sessionId ?? `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async (params) => { calls.responded.push(params); return success({}); },
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // 内存里现造的一张 1×1 PNG，由假网关提供
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表，v2 的读工具和 HTTP 退路会用到
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  // 去掉顶层 import，VM 里由外面传进来这些名字
  // 必须按行处理：这些 import 有多行写法
  // 单行正则会停在第一个分号，误删正常代码
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf('\nexport { main,'));
  source = source.replace('  startSnowlumaClient(bot);', `
  // 换一份表情清单
  const setStickerEntries = (next) => { stickerEntries = Array.isArray(next) ? next : []; };
  // 取当前表情清单
  const getStickerEntries = () => stickerEntries;
  return {
    syncInstalledPreset, installedPresetYaml, ensureSession, ensureSlangLearnerSession: app.ensureSlangLearnerSession, runSlangResearch: app.runSlangResearch, resolvePresetName: app.resolvePresetName, deliverPrompt, drainPromptQueue,
    applyHealedTokens, reportTurnFailure: app.reportTurnFailure, recordVoiceSentV2: app.recordVoiceSentV2, rediscoverDshBase: app.rediscoverDshBase,
    getSlangEntries: () => slangEntries,
    completeLearnerTurn(sessionId, output) {
      const waiters = app.learnerWaiters.get(sessionId) ?? [];
      const waiter = waiters.shift();
      if (!waiter) return false;
      if (!waiters.length) app.learnerWaiters.delete(sessionId);
      clearTimeout(waiter.timer);
      waiter.resolve(output);
      return true;
    },
    sendToQQ, sendBurstToQQ: app.sendBurstToQQ, sendMessagesV2: app.sendMessagesV2, sendStickerV2: app.sendStickerV2, handleIncoming: app.handleIncoming, handleRecallNotice: app.handleRecallNotice, handlePokeNotice: app.handlePokeNotice, handlePendingAnswer: app.handlePendingAnswer, pending, startConsoleServer: app.startConsoleServer, cfg, state, api, promptQueues, forwardMediaRefs, rememberForwardMedia, forwardMediaKey, setStickerEntries, getStickerEntries,
    getSocialV2State: app.getSocialV2State, appendSocialV2Message: app.appendSocialV2Message, recordSentMessagesV2: app.recordSentMessagesV2, compressConversation: app.compressConversation, memoryTick: app.memoryTick, getMemoryContext: app.getMemoryContext, forgetConversationMemory: app.forgetConversationMemory, memoryPool, compressCursor: app.compressCursor, memoryIndex: app.memoryIndex, flushSocialV2State: app.flushSocialV2State, saveSocialV2State: app.saveSocialV2State,
    ctx, messageArchive,
    buildWakePromptV2: app.buildWakePromptV2, buildWakeSnapshotV2: app.buildWakeSnapshotV2, sendWakePromptV2: app.sendWakePromptV2, socialV2,
    syncStickerLibrary: app.syncStickerLibrary, listStickersForV2: app.listStickersForV2, getStickerImageData: app.getStickerImageData,
    refreshMode: app.refreshMode, sessionEvents, pumpMux, dispatchStats: app.dispatchStats, checkStalledTurns: app.checkStalledTurns, pendingWakeKeys: app.pendingWakeKeys, modeAllowed: app.modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2: app.replayPendingWakeReasonsV2,
    collectors, reverse, setupSleepTimerV2: app.setupSleepTimerV2,
    handleSessionSnapshot, replayDeferredDeliveries, deliveryCursors, sessionPolicy: app.sessionPolicy,
    getInitialPrompt: app.getInitialPrompt, setInitialPrompt: app.setInitialPrompt, loadInitialPrompts: app.loadInitialPrompts, formatInitialPromptV2: app.formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars: app.initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2: app.isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2: app.selfIdentityTextV2, buildWakeReminderPromptV2: app.buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue: app.flushQueue, retireSession: app.retireSession,
    // 一代仿真引擎（features/simulation-v1）：心跳被夹具的 setInterval 桩掉，测试直接驱动这几个入口。
    social, socialLoopTick: app.socialLoopTick, flushSummaries: app.flushSummaries, socialState: app.socialState,
    voiceCfg: app.voiceCfg, voiceLibrary: app.voiceLibrary, resolveVoicePathForV2: app.resolveVoicePathForV2, resolveVoicePathForOperator: app.resolveVoicePathForOperator,
    voiceBudgetCheck: app.voiceBudgetCheck, sendVoiceV2: app.sendVoiceV2, sendVoiceForV2: app.sendVoiceForV2, assertOutboundAuditOk: app.assertOutboundAuditOk,
    setMode(value) { currentMode = value; modeKnown = true; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  startSnowlumaClient(bot);`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用，桥接启动时会查端口占用
    // 固定成假的：测试不该真去查本机端口
    execFileSync: () => '',
    // process 桩要带 env：桥接会读 FFMPEG_PATH 等
    // 之前没给 env，导致一读进程变量就报错
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    // DSH 端点自愈只在探活失败时调用，这里给个桩
    // 要验自愈逻辑的用例可以用 globals 覆盖它
    discoverDshBaseUrl: async () => null,
    resolveInstalledPreset, synchronizePreset, renderPatch, persistSnowLumaEndpoint, persistToken,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt, ...roleCard,
    // policy/ 纯函数模块，VM 里由外面传进来同名函数
    ...policyMode, ...policyAccess, ...policyAudit,
    // store/ 的基础操作（一次写完、版本号）
    ...storeFsAtomic, ...storeSchema, ...storeArchive, ...storeArchiveRetention, ...appContext,
    ...policyToolDefaults,
    // infra/ 模块：进程、控制台、定时器按名字传进来
    // 所以 VM 里的桩仍然生效
    ...infraAsync, ...infraLog, ...infraLock, ...infraStateAcl, ...infraConfig,
    ...gatewayOneBotHttp, ...gatewayTokenHeal, ...gatewayUpstreamHealth, ...gatewaySnowlumaWs,
    ...inboundNormalize, ...inboundMedia, ...inboundContext, ...inboundForward, ...inboundRecall, ...inboundPoke, ...inboundFilter,
    ...conversationsPolicy, ...conversationsPending, ...conversationsOutbox, ...conversationsTurns,
    ...dshModel, ...dshWatch, ...dshSession, ...dshDeliver, ...dshEvents,
    // 控制台路由分组，必须和模块用同一个 Symbol
    ...routeNext, ...httpServer, ...httpAuthConsole, ...httpAuthAgent, ...consoleServer, ...consoleToken, ...consoleActivity, ...toolGate,
    // 人格卡和仿真预设的提示词
    ...rolesCard, ...rolesState, ...rolesInject, ...presetsPrompt, ...storeRoleInject,
    ...sv2WakeConfig, ...sv2Participation, ...sv2Triggers, ...sv2TimeSense, ...sv2Prompt, ...sv2Scheduler,
    ...sv1StateMachine, ...sv1Prompts, ...sv1Loop,
    // 发送链和出站守卫
    ...sendQueue, ...sendSender, ...sendSplit, ...sendTimeline, ...sendV2, ...policySendGuard,
    // 语音、表情、黑话、用量
    ...voiceConfig, ...voiceBudget, ...voiceSend, ...stickerStore, ...stickerSend, ...slangLearning, ...slangWindow, ...slangInject, ...usageRecord,
    // 各状态文件的存储
    ...storeArchiveWiring, ...storeDeliveryCursors, ...storeSocialV2, ...storeInitialPrompts, ...storeConversations, ...storePool, ...storeViews, ...memoryCursor, ...memoryCompress, ...memoryIndexModule, ...slangPool, ...storeFeedback, ...storeSessions,
    ...policySelfKey,
    ...consoleRoleRoutes, ...consoleSlangRoutes, ...consoleSessionRoutes, ...consoleSettingsRoutes, ...consoleSocialRoutes, ...consoleCoreRoutes, ...consoleMaintenanceRoutes,
    ...toolSocialV2Routes, ...toolMediaRoutes, ...toolContextRoutes, ...toolSendRoutes, ...usageDashboardRoutes,
    // 出图前会统一处理（体积、动图抽帧），要能拿到
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // 权限收紧会改真实文件系统，测试不该做这件事
    // 所以桩成成功，让这段逻辑走正常分支
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg，测试环境不该真跑 ffmpeg
    // 默认桩成记账但不转码，用例可覆盖来验真实行为
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // 模型视图用主 realm 那一份，判断用的是同一个 Object
  // 消息现在由主 realm 的模块创建，所以不再放进 VM
  // 生产是单 realm，这里才有区分
  Object.assign(context, { compactModelMessage: modelView.compactModelMessage, compactModelData: modelView.compactModelData,
    serializeModelData: modelView.serializeModelData, describeAge: modelView.describeAge, sanitizeUntrustedText: modelView.sanitizeUntrustedText });
  // 严格模式：生产是 ESM（严格），vm 默认是宽松的
  // 宽松模式会把赋值未声明变量变成隐式全局
  // 曾因此漏过一个真实崩溃：测试全绿、生产必炸
  vm.runInContext('"use strict";\n' + source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
