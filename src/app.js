import { resolveInstalledPreset, synchronizePreset } from './preset-sync.js';
import { renderPatch } from './preset-patch.js';
import { readJsonSafe, readConfigObject, renameWithRetry, atomicWriteJson, atomicWriteText } from './store/fs-atomic.js';
import { migrateDocument, stampSchema } from './store/schema.js';
import { createMessageArchive } from './store/archive.js';
import { startArchiveRetention, compressCursorFrom } from './store/archive-retention.js';
import { createAppContext } from './app-context.js';
import { MODE_INPUT_ALIASES, VALID_MODES, normalizeModeInput, settingFromDshNamespace, REASONING_EFFORT_OPTIONS, REASONING_EFFORT_DEFAULT, REASONING_EFFORT_NONE, normalizeReasoningEffort } from './policy/mode.js';
import { normalizeOwnerQQ, normalizeIdList, ignoredSender, allowed, canonicalV2Key, convKey } from './policy/access.js';
import { SILENT_MARKER, isSilentMarker, SEND_TOOL_RE, isSendToolName, createAgentTokenRegistry, createTokenAudit, escapeCqText, unquoteJsonString } from './policy/audit.js';
// 组装层：把各个功能模块拼成一个能运行的程序，并提供启动主流程。
// 消息走向：QQ 消息 → 本程序 → DSH 里的 AI → AI 的回复 → 发回 QQ。
// 用法：先编辑 config.json，再运行 node src/bridge.js。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { discoverDshBaseUrl } from './dsh-endpoint.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage, describeAge, sanitizeUntrustedText } from './qq-model-view.js';
import { safeFetchBuffer, looksLikeImageBuffer } from './safe-fetch.js';
import { normalizeImageForModel } from './media-normalize.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { boundedTimerDelay, createAsyncHelpers } from './infra/async.js';
import { createCappedLogger, createBridgeLog, createActivityLog } from './infra/log.js';
import { createInstanceLock } from './infra/lock.js';
import { loadConfig } from './infra/config.js';
import { createOneBotHttp } from './gateway/onebot-http.js';
import { createTokenHeal } from './gateway/token-heal.js';
import { createUpstreamHealth } from './gateway/upstream-health.js';
import { createSnowlumaWs } from './gateway/snowluma-ws.js';
import { segmentsToText, sanitizeMediaSummary, extractMediaFromSegments } from './inbound/normalize.js';
import { createInboundMedia } from './inbound/media.js';
import { createInboundContext } from './inbound/context.js';
import { createForwardMediaRegistry } from './inbound/forward.js';
import { createInboundFilter } from './inbound/filter.js';
import { createPokeHandler } from './inbound/poke.js';
import { createRecallHandler } from './inbound/recall.js';
import { createConversationPolicy } from './conversations/policy.js';
import { createPendingQuestions } from './conversations/pending.js';
import { createOutbox } from './conversations/outbox.js';
import { createWakeLeases } from './conversations/turns.js';
import { createDshEvents } from './dsh/events.js';
import { createConsoleTokenLoader } from './features/console/token.js';
import { createActivityTailReader } from './features/console/activity.js';
import { createConsoleServer } from './http-server.js';
import { createToolGate } from './features/tools/gate.js';
import { createSessionStore } from './store/sessions.js';
import { createFeedbackStore } from './store/feedback.js';
import { createInitialPromptStore } from './store/initial-prompts.js';
import { createConversationStore } from './store/conversations.js';
import { createMemoryPool } from './store/pool.js';
import { writeMemoryView, removeMemoryView } from './store/views.js';
import { createCompressCursor } from './memory/cursor.js';
import { createMemoryCompressor } from './memory/compress.js';
import { createMemoryIndex, loadSqlite } from './memory/index.js';
import { createSlangPoolStore } from './features/slang/pool.js';
import { createSocialV2Store } from './store/social-v2.js';
import { createDeliveryCursors } from './store/delivery-cursors.js';
import { createArchiveWiring } from './store/archive-wiring.js';
import { createUsageRecorder } from './features/usage/record.js';
import { createSlangInject } from './features/slang/inject.js';
import { createSlangWindow } from './features/slang/window.js';
import { createSlangLearning } from './features/slang/learning.js';
import { createStickerSender } from './features/sticker/send.js';
import { createStickerStore } from './features/sticker/store.js';
import { createVoiceSender } from './features/voice/send.js';
import { createVoiceBudget } from './features/voice/budget.js';
import { createVoiceConfig } from './features/voice/config.js';
import { createSendGuard } from './policy/send-guard.js';
import { BOUND_SESSION_ID_RE, encodeSelfKey } from './policy/self-key.js';
import { createSenderV2 } from './features/send/v2.js';
import { createSendTimeline } from './features/send/timeline.js';
import { createSplitter } from './features/send/split.js';
import { createSender } from './features/send/sender.js';
import { createSendQueue } from './features/send/queue.js';
import { createSocialLoopV1 } from './features/simulation-v1/loop.js';
import { createSocialPromptsV1 } from './features/simulation-v1/prompts.js';
import { createSocialStateMachineV1 } from './features/simulation-v1/state-machine.js';
import { createSchedulerV2 } from './features/social-v2/scheduler.js';
import { createWakePromptV2 } from './features/social-v2/prompt.js';
import { createTimeSenseV2 } from './features/social-v2/time-sense.js';
import { createTriggersV2 } from './features/social-v2/triggers.js';
import { createParticipationV2 } from './features/social-v2/participation.js';
import { createWakeConfigV2 } from './features/social-v2/wake-config.js';
import { createRoleInject } from './features/roles/inject.js';
import { createRoleInjectStore } from './store/role-inject.js';
import { createRoleState } from './features/roles/state.js';
import { createPresetPrompts } from './features/presets/prompt.js';
import { createRoleCards } from './features/roles/card.js';
import { createDshDeliver } from './dsh/deliver.js';
import { createDshSession } from './dsh/session.js';
import { createDshWatch } from './dsh/watch.js';
import { createDshModel } from './dsh/model.js';
import { hardenStateDirAcl } from './infra/state-acl.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import {
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  normalizeSlangScope,
  slangScopeVisible,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  stickerForScope,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';

// 共享工具箱：别的模块需要什么功能，都从这里取。
// 各模块提供的函数最后都挂到这个对象上。
const app = {
  get ACTIVITY_LOG() { return ACTIVITY_LOG; },
  get APPROVE_WORDS() { return APPROVE_WORDS; },
  get BOUND_SESSION_ID_RE() { return BOUND_SESSION_ID_RE; },
  get CONVERSATION_TOKENS() { return CONVERSATION_TOKENS; },
  get DIRECTION_HINT() { return DIRECTION_HINT; },
  get DSH_CONTROL_TIMEOUT_MS() { return DSH_CONTROL_TIMEOUT_MS; },
  get FEEDBACK_FILE() { return FEEDBACK_FILE; },
  get CONVERSATIONS_FILE() { return CONVERSATIONS_FILE; },
  get INITIAL_PROMPTS_FILE() { return INITIAL_PROMPTS_FILE; },
  get KNOWN_AGENT_TOKENS() { return KNOWN_AGENT_TOKENS; },
  get memoryPool() { return memoryPool; },
  get REJECT_WORDS() { return REJECT_WORDS; },
  get ROLE_INJECT_MAX_CHARS_DEFAULT() { return ROLE_INJECT_MAX_CHARS_DEFAULT; },
  get ROLE_STATE_FILE() { return ROLE_STATE_FILE; },
  get ROOT() { return ROOT; },
  get SEND_TIMEOUT_MS() { return SEND_TIMEOUT_MS; },
  get SLANG_FILE() { return SLANG_FILE; },
  get SLANG_SESSION_FILE() { return SLANG_SESSION_FILE; },
  get SOCIAL_V2_FILE() { return SOCIAL_V2_FILE; },
  get SPACE_SPLIT_HINT() { return SPACE_SPLIT_HINT; },
  get STATE_DIR() { return STATE_DIR; },
  get STATE_FILE() { return STATE_FILE; },
  get STICKER_FILE() { return STICKER_FILE; },
  get TOOL_LOG_FILE() { return TOOL_LOG_FILE; },
  get appendActivity() { return appendActivity; },
  get cleanupTemp() { return cleanupTemp; },
  get clearInterval() { return clearInterval; },
  get clearTimeout() { return clearTimeout; },
  get compactModelMessage() { return compactModelMessage; },
  get console() { return console; },
  get convKey() { return convKey; },
  get describeAge() { return describeAge; },
  get discoverDshBaseUrl() { return discoverDshBaseUrl; },
  get encodeSelfKey() { return encodeSelfKey; },
  get fetch() { return fetch; },
  get forgetAgentToken() { return forgetAgentToken; },
  get hardenDir() { return hardenDir; },
  get hasKnownTokenFragment() { return hasKnownTokenFragment; },
  get http() { return http; },
  get inspectAudio() { return inspectAudio; },
  get loadOrCreateConsoleToken() { return loadOrCreateConsoleToken; },
  get log() { return log; },
  get modelCatalogInFlight() { return modelCatalogInFlight; }, set modelCatalogInFlight(v) { modelCatalogInFlight = v; },
  get modelSelectionEpoch() { return modelSelectionEpoch; }, set modelSelectionEpoch(v) { modelSelectionEpoch = v; },
  get process() { return process; },
  get processAudioVolume() { return processAudioVolume; },
  get readActivityTail() { return readActivityTail; },
  get redactKnownTokensOnly() { return redactKnownTokensOnly; },
  get redactSensitiveText() { return redactSensitiveText; },
  get releaseLock() { return releaseLock; },
  get rememberAgentToken() { return rememberAgentToken; },
  get renderPatch() { return renderPatch; },
  get roleInjectMaxChars() { return roleInjectMaxChars; }, set roleInjectMaxChars(v) { roleInjectMaxChars = v; },
  get safeFetchBuffer() { return safeFetchBuffer; },
  get sanitizeUntrustedText() { return sanitizeUntrustedText; },
  get setInterval() { return setInterval; },
  get setTimeout() { return setTimeout; },
  get sleep() { return sleep; },
  get state() { return state; }, set state(v) { state = v; },
  get stateDirHardened() { return stateDirHardened; }, set stateDirHardened(v) { stateDirHardened = v; },
  get text() { return text; },
  get withTimeout() { return withTimeout; },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json'); // 旧版黑话库，只在第一次启动时导入
const POOL_FILE = path.join(STATE_DIR, 'pool', 'items.jsonl');
// 所有记忆共用的一个存储：黑话和聊天记忆都放这里
const memoryPool = createMemoryPool({ file: POOL_FILE });
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 操作者给每个会话写的开场说明，单独存一个文件。
// 重置聊天不会清掉它，群还没说过话时也能先写。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const CONVERSATIONS_FILE = path.join(STATE_DIR, 'conversations.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

// 统一聊天模式的写法，并从 DSH 设置里读取；代码在 mode.js

// 安全地读写 JSON 文件，以及重命名和整文件写入；代码在 fs-atomic.js

// 读取或生成控制台的访问令牌；代码在 console/token.js
const loadOrCreateConsoleToken = createConsoleTokenLoader({ stateDir: STATE_DIR, atomicWriteText });

// 收紧 state 目录的访问权限；代码在 state-acl.mjs

// 读取活动日志的最后几行；代码在 console/activity.js
const readActivityTail = createActivityTailReader(ACTIVITY_LOG);


// 角色卡一次最多塞 8000 字，防止内容太多把对话撑爆。
// 可在 config.json 改（role.maxInjectChars，1000~20000）。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 8000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;

// 人格卡文件的读写和检查；代码在 roles/card.js
const { applyRoleInjectLimit, roleFilePath, firstMeaningfulLine, roleWarnings, roleSummaries, validateRoleName, validateRoleContent, readRoleContent, writeRoleContent, ROLE_CONTENT_MAX_BYTES, ROLE_NAME_MAX, ROLES_DIR } = Object.assign(app, createRoleCards(app));

// 仿真预设提示词的读取、同步和备份；代码在 presets/prompt.js
const { knownPresetName, presetSourceYaml, dshHomeDir, installedPresetYaml, syncInstalledPreset, readPresetPromptText, presetBackupPrefix, backupPresetFile, listPresetBackups, presetStatus, PRESET_BACKUP_DIR, PRESET_NAMES } = Object.assign(app, createPresetPrompts(app));

// 识别静默标记和发送类工具；代码在 policy/audit.js

// 提示：聊天里用空格分隔多条消息，不想分条就别加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 提示：引用某人表示在回应他，别把别人的对话当成在找自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 记住 AI 用到的会话令牌，在日志和发出的话里统一打码。
// 这样即使 AI 说漏嘴，令牌也不会出现在 QQ 上。
const agentTokenRegistry = createAgentTokenRegistry({ max: 512 });
const KNOWN_AGENT_TOKENS = agentTokenRegistry.known;
const CONVERSATION_TOKENS = agentTokenRegistry.byConversation;
// 令牌的登记、检测和打码在 policy/audit.js 里
const { rememberAgentToken, forgetAgentToken, hasKnownTokenFragment, redactSensitiveText, redactKnownTokensOnly } = createTokenAudit({ registry: agentTokenRegistry, sensitiveRe: SENSITIVE_RE });

// 同一时间只发一个请求去取模型列表，避免重复请求堆积。
let modelCatalogInFlight = null;
// 记录思考强度的设置版本；改了之后，旧会话下次会重新设置。
let modelSelectionEpoch = 0;
// 思考强度的档位和统一写法；代码在 policy/mode.js

// 转义和还原 QQ 消息里的特殊字符；代码在 policy/audit.js

// QQ 活动日志：每次收发都记一行，方便网页端展示动态。
const appendActivity = createActivityLog({ file: ACTIVITY_LOG, maxLines: 500, redact: (text) => redactSensitiveText(text) });

// 角色状态和角色列表的读写；代码在 roles/state.js
const { listRoles, readRoleState, writeRoleState, sanitizeRoleName } = Object.assign(app, createRoleState(app));

// 管理员 QQ 号和白名单的检查；代码在 policy/access.js

// 读取配置文件；代码在 infra/config.js

// ── 保存数据（QQ 聊天和 DSH 会话的对应关系） ──
let state = { sessions: {} };
// 保存和读取两者的对应关系；代码在 store/sessions.js
const { loadState, saveState } = Object.assign(app, createSessionStore(app));

// ── 只允许运行一个程序 ──
// 防止同时运行两个程序，否则会抢消息、互相覆盖数据。
// 锁文件里存进程号，进程退出后自动失效。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

// 防止重复启动的实现；代码在 infra/lock.js
// 测试时可以替换进程相关功能，方便模拟各种情况。
const { acquireLock, releaseLock } = createInstanceLock({
  lockFile: LOCK_FILE,
  configFile: path.join(ROOT, 'config.json'),
  readJsonSafe,
  proc: process,
  execFileSync,
  error: (msg) => console.error(msg),
});

// ── 常用工具 ──
// 日志同时写到屏幕和 state/bridge.log，方便事后排查。

// 生成日志工具；代码在 infra/log.js
const log = createBridgeLog({ file: BRIDGE_LOG, maxLines: 2000, redact: (text) => redactSensitiveText(text), console });
// 计时、等待和超时控制；代码在 infra/async.js
// 测试时可以替换定时器，方便模拟时间流逝。
const { sleep, withTimeout } = createAsyncHelpers({ setTimeout, clearTimeout });
const SEND_TIMEOUT_MS = 15000;
// 停任务、归档这类操作最多等 15 秒，超时也不会卡死程序。
const DSH_CONTROL_TIMEOUT_MS = 15000;

// 把 QQ 消息拆成文字并清洗媒体信息；代码在 inbound/normalize.js

// 判断谁能使用以及统一会话标识；代码在 policy/access.js

// 把当前会话绑定到实际执行的会话；代码在 policy/self-key.js

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state 目录的权限是否已收紧，控制台会显示；没跑过就是 null。
let stateDirHardened = null;

// ── 主流程 ──
// ── 按功能分块装配 ──
// 每个 assembleX() 把一块功能接到程序上，调用顺序不能随便换。
// 有的模块创建时就要用前面装好的东西，换顺序前先确认谁用谁。

// ── 语音：配置、额度、发送 ──
function assembleVoice() {
  // 语音配置和语音库路径；代码在 features/voice/config.js
  Object.assign(app, createVoiceConfig(app));
  // 语音发送的额度限制和记账；代码在 features/voice/budget.js
  Object.assign(app, createVoiceBudget(app));
  // 发送语音并检查是否成功；代码在 features/voice/send.js
  Object.assign(app, createVoiceSender(app));
}

// ── 表情：本地库与发送 ──
function assembleSticker() {
  // 表情库的保存和读取；代码在 features/sticker/store.js
  Object.assign(app, createStickerStore(app));
  // 发送表情和收藏；代码在 features/sticker/send.js
  Object.assign(app, createStickerSender(app));
}

// ── 黑话：学习、窗口、写进提示词 ──
function assembleSlang() {
  // 黑话的学习会话和抽取；代码在 features/slang/learning.js
  Object.assign(app, createSlangLearning(app));
  // 收集待学习的消息并限制提交频率；代码在 features/slang/window.js
  Object.assign(app, createSlangWindow(app));
  // 把学到的黑话展示并写进提示词；代码在 features/slang/inject.js
  Object.assign(app, createSlangInject(app));
}

// ── DSH 会话策略、离线补投、探活 ──
function assembleDshLifecycle() {
  // 聊天模式和预设的处理、会话退役；代码在 conversations/policy.js
  Object.assign(app, createConversationPolicy(app));
  // DSH 离线时排队补发消息；代码在 conversations/outbox.js
  Object.assign(app, createOutbox(app));
  // 检查 DSH 是否活着、端口自愈和巡检；代码在 dsh/watch.js
  Object.assign(app, createDshWatch(app));
}

// ── 本地网页服务：控制台和工具接口 ──
function assembleHttp() {
  // ── 本地控制台（独立网页面板，不用开 DSH 网页） ──
  // 模式、角色、静默状态都存在 state 里，改了马上生效。
  // 二代工具开关的判断；代码在 features/tools/gate.js
  Object.assign(app, createToolGate(app));
  // 启动本地控制台网页服务；代码在 http-server.js
  Object.assign(app, createConsoleServer(app));
}

// ── 发送：分条时间线、二代发送、出站守卫 ──
function assembleSendV2() {
  // 分条发送的时间线；代码在 features/send/timeline.js
  Object.assign(app, createSendTimeline(app));
  // 二代发送主流程；代码在 features/send/v2.js
  Object.assign(app, createSenderV2(app));
  // 发送前的安全检查；代码在 policy/send-guard.js
  Object.assign(app, createSendGuard(app));
}

// ── 二代仿真：唤醒配置与会话状态存储 ──
function assembleSocialV2Store() {
  // 二代仿真的唤醒配置；代码在 social-v2/wake-config.js
  Object.assign(app, createWakeConfigV2(app));
  // 二代仿真的会话状态和消息记录；代码在 store/social-v2.js
  Object.assign(app, createSocialV2Store(app));
}

// ── 每个会话的设置和开场说明 ──
function assembleConversationStores() {
  // 每个会话单独的策略设置；代码在 store/conversations.js
  Object.assign(app, createConversationStore(app));
  // 操作者给每个会话写的开场说明；代码在 store/initial-prompts.js
  Object.assign(app, createInitialPromptStore(app));
}

// ── 轻量记忆、记忆压缩、只读资料 ──
function assembleMemory() {
  // 参与度提示、静默时长和轻量记忆；代码在 social-v2/participation.js
  Object.assign(app, createParticipationV2(app));
  // 把聊天记录压成长期记忆并提供只读查询；代码在 memory/compress.js
  Object.assign(app, createMemoryCompressor(app));
}

// ── 一代仿真：状态机、提示词、调度 ──
function assembleSimulationV1() {
  // 一代仿真的社交状态机；代码在 simulation-v1/state-machine.js
  Object.assign(app, createSocialStateMachineV1(app));
  // 一代仿真的提示词；代码在 simulation-v1/prompts.js
  Object.assign(app, createSocialPromptsV1(app));
  // 一代仿真的调度循环；代码在 simulation-v1/loop.js
  Object.assign(app, createSocialLoopV1(app));
}

// ── 把人格卡写进提示词 ──
function assembleRoles() {
  // 角色卡写进提示词的次数和签名；代码在 role-inject.js
  Object.assign(app, createRoleInjectStore(app));
  // 取出角色卡、截断并按时写进提示词；代码在 roles/inject.js
  Object.assign(app, createRoleInject(app));
}

// ── 二代仿真：唤醒、时间感、简报、调度 ──
function assembleWakeV2() {
  // 判断该不该唤醒并记录读到哪；代码在 social-v2/triggers.js
  Object.assign(app, createTriggersV2(app));
  // 时间感、唤醒快照和回复时机；代码在 social-v2/time-sense.js
  Object.assign(app, createTimeSenseV2(app));
  // 拼出唤醒时给 AI 看的说明；代码在 social-v2/prompt.js
  Object.assign(app, createWakePromptV2(app));
  // 安排什么时候唤醒 AI；代码在 social-v2/scheduler.js
  Object.assign(app, createSchedulerV2(app));
}

// ── 进来的消息：入口、提问、撤回、拍一拍 ──
function assembleInbound() {
  // QQ 消息进到程序的总入口；代码在 inbound/filter.js
  Object.assign(app, createInboundFilter(app));
  // 等待回答的提问和审批；代码在 conversations/pending.js
  Object.assign(app, createPendingQuestions(app));
  // 处理撤回消息；代码在 inbound/recall.js
  Object.assign(app, createRecallHandler(app));
  // 处理拍一拍；代码在 inbound/poke.js
  Object.assign(app, createPokeHandler(app));
}

// 启动主流程：按顺序装配各模块并开始工作
async function main() {
  // 主流程里用到的常量和状态，其他模块通过这里访问。
  Object.defineProperties(app, Object.getOwnPropertyDescriptors({
    get ACTIVE_WAIT_LEASE_MS() { return ACTIVE_WAIT_LEASE_MS; },
    get DELIVERY_CURSOR_FILE() { return DELIVERY_CURSOR_FILE; },
    get MAX_MEDIA_BYTES() { return MAX_MEDIA_BYTES; },
    get MAX_MEDIA_COUNT() { return MAX_MEDIA_COUNT; },
    get MAX_MEDIA_PIXELS() { return MAX_MEDIA_PIXELS; },
    get MAX_MEDIA_STORE_PER_KEY() { return MAX_MEDIA_STORE_PER_KEY; },
    get MAX_SEEN_MESSAGE_IDS() { return MAX_SEEN_MESSAGE_IDS; },
    get MEDIA_FETCH_ALLOW_PORTS() { return MEDIA_FETCH_ALLOW_PORTS; },
    get RESTORED_TURN_GRACE_MS() { return RESTORED_TURN_GRACE_MS; },
    get SILENT_TURN_TIMEOUT_MS() { return SILENT_TURN_TIMEOUT_MS; },
    get TURN_BUSY_LEASE_MS() { return TURN_BUSY_LEASE_MS; },
    get activeWaits() { return activeWaits; },
    get api() { return api; },
    get assertGroupMember() { return assertGroupMember; },
    get bot() { return bot; },
    get cfg() { return cfg; },
    get closedAgentPreset() { return closedAgentPreset; }, set closedAgentPreset(v) { closedAgentPreset = v; },
    get collectors() { return collectors; },
    get currentMode() { return currentMode; }, set currentMode(v) { currentMode = v; },
    get dshCheckStarted() { return dshCheckStarted; }, set dshCheckStarted(v) { dshCheckStarted = v; },
    get dshDefaultPreset() { return dshDefaultPreset; }, set dshDefaultPreset(v) { dshDefaultPreset = v; },
    get dshPresetIds() { return dshPresetIds; }, set dshPresetIds(v) { dshPresetIds = v; },
    get dshReady() { return dshReady; }, set dshReady(v) { dshReady = v; },
    get feedbackTimes() { return feedbackTimes; },
    get fetchFaceMedia() { return fetchFaceMedia; },
    get fetchMediaData() { return fetchMediaData; },
    get fetchOneBotImage() { return fetchOneBotImage; },
    get findMessageMedia() { return findMessageMedia; },
    get forwardMediaKey() { return forwardMediaKey; },
    get forwardMediaRefs() { return forwardMediaRefs; },
    get getImageDimensions() { return getImageDimensions; },
    get initialPrompts() { return initialPrompts; },
    get initialPromptsWritable() { return initialPromptsWritable; }, set initialPromptsWritable(v) { initialPromptsWritable = v; },
    get isQuoteTargetSelf() { return isQuoteTargetSelf; },
    get lastForcedAgentStickerSync() { return lastForcedAgentStickerSync; }, set lastForcedAgentStickerSync(v) { lastForcedAgentStickerSync = v; },
    get lastMode() { return lastMode; }, set lastMode(v) { lastMode = v; },
    get lastSendFailed() { return lastSendFailed; },
    get lastSendSucceeded() { return lastSendSucceeded; },
    get learnerSessions() { return learnerSessions; },
    get mediaHintFor() { return mediaHintFor; },
    get messageArchive() { return messageArchive; },
    get messageMediaStore() { return messageMediaStore; },
    get mimeFromBuffer() { return mimeFromBuffer; },
    get mimeFromUrl() { return mimeFromUrl; },
    get modeKnown() { return modeKnown; }, set modeKnown(v) { modeKnown = v; },
    get onebotHttpAction() { return onebotHttpAction; },
    get onebotSend() { return onebotSend; },
    get pending() { return pending; },
    get priceTable() { return priceTable; },
    get rememberForwardMedia() { return rememberForwardMedia; },
    get rememberSendChain() { return rememberSendChain; },
    get replyInfoCache() { return replyInfoCache; },
    get resolveGroupMemberName() { return resolveGroupMemberName; },
    get resolveMediaList() { return resolveMediaList; },
    get resolveReplyInfo() { return resolveReplyInfo; },
    get resolveReplyTargetV2() { return resolveReplyTargetV2; },
    get reverse() { return reverse; },
    get selfDisplayName() { return selfDisplayName; }, set selfDisplayName(v) { selfDisplayName = v; },
    get selfNickname() { return selfNickname; }, set selfNickname(v) { selfNickname = v; },
    get selfUserId() { return selfUserId; }, set selfUserId(v) { selfUserId = v; },
    get sendChainFor() { return sendChainFor; },
    get sessionEpoch() { return sessionEpoch; }, set sessionEpoch(v) { sessionEpoch = v; },
    get singleLineForQQ() { return singleLineForQQ; },
    get slangEntries() { return slangEntries; }, set slangEntries(v) { slangEntries = v; },
    get slangLearnerSessionId() { return slangLearnerSessionId; }, set slangLearnerSessionId(v) { slangLearnerSessionId = v; },
    get slangStoreWritable() { return slangStoreWritable; },
    get slangTaskChain() { return slangTaskChain; }, set slangTaskChain(v) { slangTaskChain = v; },
    get snowlumaHealthSnapshot() { return snowlumaHealthSnapshot; },
    get social() { return social; },
    get socialV2() { return socialV2; },
    get splitByCjkSpaces() { return splitByCjkSpaces; },
    get splitLongSegment() { return splitLongSegment; },
    get stickerEntries() { return stickerEntries; }, set stickerEntries(v) { stickerEntries = v; },
    get stickerStoreWritable() { return stickerStoreWritable; },
    get stickerSyncedAt() { return stickerSyncedAt; }, set stickerSyncedAt(v) { stickerSyncedAt = v; },
    get toModelMedia() { return toModelMedia; },
    get tokenLedger() { return tokenLedger; },
  }));
  const cfg = loadConfig({
    configFile: path.join(ROOT, 'config.json'),
    readJsonSafe,
    discoverDshLaunchToken,
    log,
    roleInjectMaxCharsDefault: ROLE_INJECT_MAX_CHARS_DEFAULT,
  });
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  stateDirHardened = hardenStateDirAcl({ dir: STATE_DIR, hardenDir, manualDirCommand, log });
  acquireLock();
  loadState();

  // ── 共享运行信息和消息存档 ──
  // 新模块只从这里拿需要的东西，边界更清楚。
  const ctx = createAppContext({ root: ROOT, cfg, log });
  // 存档开关只在启动时读一次，中途改了要重启才生效。
  const messageArchive = cfg.archive.enabled
    ? ctx.register('archive', createMessageArchive({
      dir: ctx.paths.archive, log, maxShardBytes: cfg.archive.maxShardMb * 1024 * 1024,
    }))
    : null;
  if (messageArchive) log(`消息池 archive 已启用：${path.relative(ROOT, ctx.paths.archive)}（全量原文，只追加）`);
  // 每天清理一次过期存档，只删已经压缩过记忆的旧文件。
  if (messageArchive) {
    startArchiveRetention({
      archive: messageArchive,
      retentionDays: cfg.archive.retentionDays,
      cursorFor: compressCursorFrom(ctx.stores),
      log,
      timers: { setTimeout, setInterval, clearTimeout, clearInterval },
    });
  }

  // 记录记忆压缩到哪；只有登记过的存档才会被清理。
  const compressCursor = ctx.register('compressCursor', createCompressCursor({ file: ctx.paths.compressCursors }));
  Object.assign(app, {
    compressCursor,
    writeMemoryView: (o) => writeMemoryView({ dir: ctx.paths.views, ...o }),
    removeMemoryView: (o) => removeMemoryView({ dir: ctx.paths.views, ...o }),
    // 每个会话一个搜索索引，没有 SQLite 时退回内存搜索。
    // 记忆功能关掉时也保留索引入口，方便重置时删旧索引。
    memoryIndex: createMemoryIndex({ dir: ctx.paths.index, DatabaseSync: cfg.memory.enabled ? await loadSqlite() : null, log }),
  });

  // 收发消息时同步存档，失败只记日志；代码在 archive-wiring.js
  const { archiveSafely, archiveIncoming, archiveOutgoing } = Object.assign(app, createArchiveWiring(app));

  // ── 学习群里的黑话和网络用语 ──
  let slangEntries = [];
  // 读文件失败时暂停写入，否则会用空数据覆盖硬盘上的词条。
  let slangStoreWritable = true;
  // 黑话保存在记忆池里；代码在 store/pool.js 和 slang/pool.js
  const { loadSlangEntries } = Object.assign(app, createSlangPoolStore({ pool: memoryPool, legacyFile: SLANG_FILE, log }));
  try {
    slangEntries = loadSlangEntries();
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const feedbackTimes = new Map();      // 每个会话的最近反馈时间，防止太频繁
  const learnerSessions = new Set();    // 正在学习的会话，不连 QQ、不发消息
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // 表情库读不出来时只读不写，避免把空库写回去清掉学到的内容。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 QQ 拉取收藏表情的时间
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最短间隔

  // ── 读取操作的备用通道：长连接断了还有 HTTP ──
  // 通过 HTTP 调 OneBot 接口；代码在 gateway/onebot-http.js
  // 发送成功后把消息存进消息池；代码在当前文件的 archiveOutgoing
  const { onebotHttpAction, onebotSend } = createOneBotHttp({
    cfg, fetch, log, hasKnownTokenFragment, escapeCqText,
    onSent: (kind, id, message, data, opts) => archiveOutgoing(convKey(kind, id), message, data, opts),
  });

  // ── 把准备好的音频作为 QQ 语音发出去 ──
  // 流程：本地音频 → QQ 网关 → 自动转成语音条。
  // 网关会自动把普通音频转成语音，所以这里不用先转码。
  // 两种调用方式，检查规则不同：
  // AI 调用：必须带令牌，且只能发自己那个会话。
  // 操作者调用：跳过会话限制，但仍要白名单、限额和敏感词检查。
  // 语音发送的时间记录，和文字发送分开计数。

  assembleVoice();

  assembleSticker();

  assembleSlang();

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 不填白名单就收不到任何消息，这里提醒操作者。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 没填管理员 QQ 时，审批和管理命令都会失效，这里提前提醒。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 这个开关以前允许发本机任意音频，现在只允许语音库里的文件。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 相关设置
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true 表示配置里明确填的，false 表示从日志里猜的。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只把启动令牌发给本机地址，远程 DSH 要显式允许。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // 模型列表和会话模型的设置；代码在 dsh/model.js
  const { nominalModel, fetchModelCatalog, ensureChatModel, modelCatalogErrorLogged } = Object.assign(app, createDshModel(app));

  const collectors = new Map(); // 正在进行的回合记录
  // 记录会话是否在等 AI 处理唤醒回合、是否已设置唤醒。
  // 正在长轮询等待的会话，记下开始时间防止重复挂起。
  // 记时间而不是只记标记，异常退出后也能自动恢复。
  const activeWaits = new Map();
  /** 单次等待最多等这么久，超过就当作上次异常退出。 */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /** 回合最多算忙 15 分钟，超过就不再算忙，避免会话永久卡住。 */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  // 断线时重建的回合只给很短宽限，避免重启后卡很久。
  const RESTORED_TURN_GRACE_MS = 45 * 1000;
  const reverse = new Map(); // DSH 会话对应的 QQ 聊天
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 旧会话要等模式和预设检查通过后再恢复。

  // ── 断线期间跑完的回复，重连后补发 ──
  // 断线时回合已跑完的话，重连后收不到结束信号，回复会丢。
  //
  // 把处理进度和没结束的回合存到硬盘，重连后接着处理。
  // 用事件编号判断哪些已经处理过，避免重复发送。
  // 进度按会话保存，会话移除时一起清掉。
  const DELIVERY_CURSOR_FILE = path.join(STATE_DIR, 'delivery-cursors.json');
  // 启动时模式可能还没读出来，先不判断补发，免得发错。

  // 保存发送进度并补发；代码在 store/delivery-cursors.js
  const { runWithDeliveryLock, loadDeliveryCursors, saveDeliveryCursors, markTurnStarted, markTurnDelivered, forgetDeliveryCursor, completedTurnsFromRecords, replayCompletedTurns, handleSessionSnapshot, replayDeferredDeliveries, deliveryCursors } = Object.assign(app, createDeliveryCursors(app));

  loadDeliveryCursors();

  // ── 记录 AI 用量和花费，控制台可查看 ──
  // 总用量取 DSH 自己统计的数，花费按价格表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 学习会话单独记账，认不出的会话算作未归属。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  // 把会话事件交给用量账本；代码在 features/usage/record.js
  const { rememberModel, recordSessionUsage, recordSessionSnapshot, sessionModels } = Object.assign(app, createUsageRecorder(app));

  // 防止唤醒后卡住的保底处理；代码在 conversations/turns.js
  const { armPendingWakeLease, disarmPendingWakeLease, clearAllPendingWakeLeases } = Object.assign(app, createWakeLeases(app));

  // 检查 DSH 是否可用；DSH 重启时先排队，恢复后再发。
  let dshReady = false;
  let dshCheckStarted = false;
  let currentMode = 'chat'; // 当前聊天模式：普通、封闭或仿真
  let lastMode = currentMode;
  // 是否已经读到真实模式，启动初期先不据此做判断。
  let modeKnown = false;
  // 封闭模式用的 DSH 预设，留空就用 DSH 自己的默认预设。
  let closedAgentPreset = '';
  // 从 DSH 取到的预设列表和默认预设。
  let dshPresetIds = [];        // 当前可用的预设列表
  let dshDefaultPreset = '';    // DSH 默认预设，取不到就用列表里的默认项
  assembleDshLifecycle();

  // 检查 SnowLuma 上游是否健康；代码在 upstream-health.js
  const {
    health: snowlumaHealth,
    noteUpstreamPacket, noteReceiveHealth, snowlumaHealthSnapshot,
    reportSnowlumaHealth, pollSnowlumaStatus, startSnowlumaWatch,
  } = createUpstreamHealth({ cfg, log, fetch, timers: { setTimeout, setInterval } });
  Object.assign(app, { snowlumaHealth, noteUpstreamPacket, noteReceiveHealth, reportSnowlumaHealth, pollSnowlumaStatus });

  assembleHttp();

  // 会话版本号，重置或清空后加一，防止旧会话复活。
  let sessionEpoch = 0;

  // 等待回答的提问和审批
  const pending = new Map(); // 具体的待办内容

  // 图片和表情的读取、限制和处理；代码在 inbound/media.js
  const {
    mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe, maxMediaBytesLimit, MAX_MEDIA_COUNT,
    MAX_MEDIA_BYTES, MEDIA_FETCH_ALLOW_PORTS, MAX_MEDIA_PIXELS, MAX_MEDIA_STORE_PER_KEY, modelMediaLimits, toModelMedia,
    isSafeLocalMediaPath, isProbablySafeImageFileRef, emojiCdnCandidates, emojiIdFromFileName, acceptImageBuffer, fetchOneBotImage,
    fetchFaceMedia, resolveMediaList, fetchMediaData, mediaHintFor, findMessageMedia,
  } = createInboundMedia({
    cfg, log,
    // 这几样在 main 里声明得更晚，用到时才去取。
    getBot: () => bot,
    getMode: () => currentMode,
    getSocialV2: () => socialV2,
    getSocialV2State: (key) => app.getSocialV2State(key),
    getMessageMediaStore: () => messageMediaStore,
    safeFetchBuffer: (...args) => safeFetchBuffer(...args),
    looksLikeImageBuffer: (...args) => looksLikeImageBuffer(...args),
    normalizeImageForModel: (...args) => normalizeImageForModel(...args),
    env: process.env,
  });

  // 按会话排队发送；代码在 features/send/queue.js
  const { sendChainKey, sendChainFor, rememberSendChain, lastSendSucceeded, lastSendFailed } = createSendQueue({

  });

  // 普通模式的发送器；代码在 features/send/sender.js
  const { sendToQQ } = Object.assign(app, createSender(app));

  // 把长消息切成多条；代码在 features/send/split.js
  const { singleLineForQQ, splitLongSegment, isCjkChar, splitByCjkSpaces } = createSplitter({

  });

  assembleSendV2();

  // 每个会话只设置一次模型；改了思考强度会让它下次重新设置。

  // 确保 DSH 会话存在；代码在 dsh/session.js
  const { ensureSession } = Object.assign(app, createDshSession(app));

  // ── 仿真群友社交引擎（内部叫 reserved） ──
  let selfNickname = 'deepseek'; // 机器人昵称，用来认出别人在叫它
  // 机器人自己的昵称和 QQ 号，必须写进提示词，否则它认不出是在叫自己。
  let selfDisplayName = '';
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 静默名额 5 分钟后作废，免得吞掉后面正常的回复
  const social = {
    states: new Map(),             // 每个会话的社交状态
    recentMessages: new Map(),     // 最近的消息，让 AI 知道刚才聊了什么
    pendingSummaries: new Map(),   // 暂时没参与的消息
    silentContext: new Map(),      // 看到了但没回的消息，下次带给 AI
    loopTimer: null,
    silentTurns: new Map(),        // 排队等待的静默摘要
    pendingTimers: new Map(),      // 还没到点的定时器
    exitingSessions: new Set()     // 正在等退场发言完成的会话
  };

  // ── 二代仿真的运行状态和唤醒设置 ──
  const socialV2 = {
    conversations: new Map(), // 每个会话的状态
    paused: false, // 控制台可以暂停二代的全部活动
    // 版本不对时只读不写，避免把新版数据写坏。
    storeReadOnlyReason: '',
  };

  // 普通模式的图片和表情信息，按消息保存。
  // 二代模式把这些直接存在会话的消息上。
  const messageMediaStore = new Map();
  // 记下见过的转发 id；同一条消息重复送来只算一次，避免重复计数。
  const MAX_SEEN_MESSAGE_IDS = 500;

  // 合并转发里的媒体记录；代码在 inbound/forward.js
  const { forwardMediaRefs, forwardMediaKey, rememberForwardMedia } = createForwardMediaRegistry();

  assembleSocialV2Store();

  // ── 操作者预写的开场说明，只在首次唤醒时用 ──
  // 让操作者提前告诉 AI 这个群是什么圈子、有什么忌讳。
  // 单独存文件：重置聊天不会清掉，群还没说过话时也能先写。
  const initialPrompts = new Map(); // 每个会话的说明内容
  let initialPromptsWritable = true;

  assembleConversationStores();

  assembleMemory();

  // DSH 消息投递队列；代码在 dsh/deliver.js
  const { deliverPromptNow, deliverPrompt, processPromptQueue, drainPromptQueue, drainAllPromptQueues, promptQueues } = Object.assign(app, createDshDeliver(app));

  assembleSimulationV1();

  assembleRoles();

  // 群名片、群成员和引用内容的缓存；代码在 inbound/context.js
  const {
    replyInfoCache,
    pruneGroupMemberNameCache, assertGroupMember, resolveGroupMemberName,
    pruneReplyInfoCache, resolveReplyInfo, resolveReplyTargetV2, isQuoteTargetSelf,
  } = createInboundContext({ getBot: () => bot, log });

  // 记录 AI 反馈和工具调用，写入前先打码；代码在 feedback.js
  const { readFeedbackEntries, appendFeedbackEntry, readToolLog, appendToolLog, redactSensitive, sanitizeToolArgs } = Object.assign(app, createFeedbackStore(app));

  assembleWakeV2();

  assembleInbound();

  // 处理 DSH 事件流；代码在 dsh/events.js
  const { trackTurnEvent, pumpMux, rebuildInFlightCollector, sessionEvents, v2TurnStartAt, turnLeaseNoted } = Object.assign(app, createDshEvents(app));

  // ── 启动流程：从这里开始才真正执行 ──
  // 启动时先加载上次的数据；这些调用要放在所有模块装好之后。
  app.loadSocialV2State();
  // 加载操作者预写的开场说明，文件损坏时只读不写。
  app.loadInitialPrompts();
  app.loadConversationOverrides();

  // 这里启动的只是一个定时心跳，是否真的参与由模式决定。
  if (cfg.social?.enabled !== false) {
    app.startSocialLoop();
  }

  // QQ 侧：连接 SnowLuma 的 OneBot 服务
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });
  const { applyHealedTokens, syncTokenToFile, healTokenIfStale } = Object.assign(app, createTokenHeal({
    cfg, bot, configFile: path.join(ROOT, 'config.json'), log,
    persistSnowLumaEndpoint, persistToken,
    // 只在需要自动恢复时才去取这个对象，测试环境不提供它。
    discoverSnowLumaConnection: (opts) => discoverSnowLumaConnection(opts),
  }));
  const { startSnowlumaClient } = Object.assign(app, createSnowlumaWs(app));

  // 订阅事件并首次连接；令牌和地址的自动修复也在这里。
  startSnowlumaClient(bot);
  log('桥接已启动。按 Ctrl+C 退出。');
  // 启动时先同步一次 QQ 收藏表情，失败也不影响启动。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    app.syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  app.startMemoryCompressor();
  app.startDshWatch();
  startSnowlumaWatch();
  app.startConsoleServer();

  await pumpMux();
}

// ── 进程入口：处理退出信号和异常，然后启动主流程 ──
export { main, app, log, saveState, releaseLock };
