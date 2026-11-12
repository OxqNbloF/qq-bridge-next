// 检查搬走的函数：bridge.js 里没了、新文件里有
// 也检查谁引用谁：底层模块不能反过来引用上层
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// 读一个文件的内容，并统一换行符
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

// 已经搬走的函数：函数名对应新文件
const MIGRATED = {
  // P4 第一批：infra/
  'src/infra/log.js': ['createCappedLogger', 'localClock', 'log', 'appendActivity'],
  'src/infra/lock.js': ['consolePortInUse', 'acquireLock', 'tryCreate', 'releaseLock'],
  'src/infra/async.js': ['boundedTimerDelay', 'withTimeout'],
  'src/infra/state-acl.js': ['hardenStateDirAcl'],
  'src/infra/config.js': ['loadConfig'],
  // P4 第二批：gateway/
  'src/gateway/onebot-http.js': ['onebotHttpAction', 'onebotSend'],
  'src/gateway/token-heal.js': ['applyHealedTokens', 'syncTokenToFile', 'healTokenIfStale'],
  'src/gateway/snowluma-ws.js': ['startSnowlumaClient'],
  'src/gateway/upstream-health.js': ['noteUpstreamPacket', 'noteReceiveHealth', 'snowlumaHealthSnapshot', 'reportSnowlumaHealth', 'pollSnowlumaStatus', 'startSnowlumaWatch'],
  // P4 第三批：收到的消息处理
  'src/inbound/normalize.js': ['segmentsToText', 'sanitizeMediaSummary', 'extractMediaFromSegments'],
  'src/inbound/media.js': ['mimeFromBuffer', 'mimeFromUrl', 'getImageDimensions', 'base64FromMaybe', 'maxMediaBytesLimit',
    'MAX_MEDIA_COUNT', 'MAX_MEDIA_PIXELS', 'modelMediaLimits', 'toModelMedia', 'isSafeLocalMediaPath', 'isProbablySafeImageFileRef',
    'emojiCdnCandidates', 'emojiIdFromFileName', 'acceptImageBuffer', 'fetchOneBotImage', 'fetchFaceMedia', 'resolveMediaList',
    'fetchMediaData', 'mediaHintFor', 'findMessageMedia'],
  'src/inbound/context.js': ['pruneGroupMemberNameCache', 'assertGroupMember', 'resolveGroupMemberName', 'pruneReplyInfoCache',
    'resolveReplyInfo', 'resolveReplyTargetV2', 'isQuoteTargetSelf'],
  'src/inbound/forward.js': ['forwardMediaKey', 'rememberForwardMedia'],
  'src/inbound/recall.js': ['handleRecallNotice'],
  'src/inbound/filter.js': ['handleIncoming'],
  'src/inbound/poke.js': ['handlePokeNotice'],
  // P4 第四批：conversations/
  'src/conversations/policy.js': ['refreshMode', 'refreshPresetList', 'modeAllowed', 'resolvePresetName', 'modePreset',
    'isSessionAllowedInCurrentMode', 'sessionPolicy', 'isCurrentSession', 'stopRetiredSessionWork', 'forgetConversationCaches',
    'retireSession', 'reconcileSessionPolicies'],
  'src/conversations/turns.js': ['armPendingWakeLease', 'disarmPendingWakeLease', 'clearAllPendingWakeLeases'],
  'src/conversations/pending.js': ['cancelPendingEntry', 'handlePendingAnswer', 'registerPending'],
  'src/conversations/outbox.js': ['sendQueueHintOnce', 'enqueueForRetry', 'flushQueue'],
  // P4 第五批：dsh（巡检函数落在 watch.js）
  'src/dsh/model.js': ['fetchModelCatalog', 'nominalModel', 'ensureChatModel'],
  'src/dsh/watch.js': ['rediscoverDshBase', 'checkDsh', 'startDshWatch'],
  'src/dsh/session.js': ['ensureSession'],
  'src/dsh/deliver.js': ['deliverPromptNow', 'deliverPrompt', 'processPromptQueue', 'drainPromptQueue', 'drainAllPromptQueues'],
  'src/dsh/events.js': ['rebuildInFlightCollector', 'trackTurnEvent', 'pumpMux'],
  // P5：控制台服务和工具开关
  'src/http-server.js': ['startConsoleServer'],
  'src/features/console/token.js': ['loadOrCreateConsoleToken'],
  'src/features/console/activity.js': ['readActivityTail'],
  'src/features/tools/gate.js': ['v2ToolEnabled'],
  // P6 第一批：人格卡和预设提示词
  'src/features/presets/prompt.js': ['knownPresetName', 'presetSourceYaml', 'dshHomeDir', 'installedPresetYaml', 'syncInstalledPreset',
    'readPresetPromptText', 'presetBackupPrefix', 'backupPresetFile', 'listPresetBackups', 'presetStatus'],
  'src/features/roles/card.js': ['applyRoleInjectLimit', 'roleFilePath', 'firstMeaningfulLine', 'roleWarnings', 'roleSummaries',
    'validateRoleName', 'validateRoleContent', 'readRoleContent', 'writeRoleContent'],
  'src/features/roles/state.js': ['listRoles', 'readRoleState', 'writeRoleState', 'sanitizeRoleName'],
  'src/features/roles/inject.js': ['roleRawContent', 'roleHintForMode', 'currentRoleHint', 'isCjkLikeChar', 'convertExampleSpacesToComma',
    'findCjkSpaceWarning', 'findSplitBoundaryWarning', 'roleForWake', 'currentRoleHintV2'],
  'src/store/role-inject.js': ['roleCardSignature', 'roleInjectStore', 'saveRoleInjectStore'],
  // P6 第二批：二代仿真
  'src/features/social-v2/wake-config.js': ['normalizeSpeakerIdsV2', 'pickWakeTriggersV2', 'defaultWakeConfigV2', 'refreshDefaultWakeConfigV2',
    'refreshAllDefaultWakeConfigsV2', 'hasExplicitEndV2', 'isSleepingConfigV2', 'preSleepWaitBlockedV2', 'computeWakeSafetyV2', 'ensureWakeableV2'],
  'src/features/social-v2/participation.js': ['formatParticipationV2', 'suggestQuietMsV2', 'formatMemoryV2', 'appendMemoryV2'],
  'src/features/social-v2/triggers.js': ['evaluateWakeTriggerV2', 'readThroughSeqV2', 'noteModelMessagesV2', 'requestedReadThroughSeqV2', 'acknowledgeMessagesV2'],
  'src/features/social-v2/time-sense.js': ['pad2', 'localClockText', 'timeSenseCfg', 'wakeReasonSeq', 'findV2MessageBySeq', 'buildTimeSenseLine',
    'buildWakeSnapshotV2', 'replyTimingV2', 'selfIdentityTextV2'],
  'src/features/social-v2/prompt.js': ['formatInitialPromptV2', 'buildWakePromptV2', 'buildWakeReminderPromptV2', 'sendWakePromptV2'],
  'src/features/social-v2/scheduler.js': ['cancelReplyCheckV2', 'scheduleReplyCheckV2', 'busyReasonV2', 'isConversationBusyV2', 'wakePriorityV2',
    'isDirectedWakeReason', 'isTimerWakeReason', 'scheduleWakeV2', 'replayPendingWakeReasonsV2', 'setupSleepTimerV2', 'cancelProactiveCheckV2',
    'scheduleProactiveCheckV2', 'clearSocialV2Timers', 'clearAllSocialV2Timers'],
  // P6 第三批：一代仿真
  'src/features/simulation-v1/state-machine.js': ['isSocialEnabled', 'socialState', 'isDirectAddress', 'isDirectedAtAi', 'isMustReplyText',
    'appendRecentMessage', 'appendSummary', 'buildContextBlock', 'enterActive', 'cancelSocialTimers', 'cancelAllSocialTimers',
    'cleanupSocialForModeChange', 'leaveActive'],
  'src/features/simulation-v1/prompts.js': ['buildBatchPrompt', 'buildProbePrompt', 'buildActiveExitPrompt', 'triggerActiveDurationExit', 'buildProactivePrompt'],
  'src/features/simulation-v1/loop.js': ['randInt', 'scheduleSocialReply', 'socialLoopTick', 'startSocialLoop', 'flushSummaries'],
  // P7 第一批：发送链和出站守卫
  'src/features/send/queue.js': ['sendChainKey', 'sendChainFor', 'rememberSendChain', 'lastSendSucceeded'],
  'src/features/send/sender.js': ['sendToQQ'],
  'src/features/send/split.js': ['singleLineForQQ', 'splitLongSegment', 'isCjkChar', 'splitByCjkSpaces'],
  'src/features/send/timeline.js': ['planSocialTimeline', 'sendBurstToQQ', 'clampGapV2', 'computeGapsV2'],
  'src/features/send/v2.js': ['sendMessagesV2', 'reportTurnFailure', 'auditAndSend'],
  'src/policy/send-guard.js': ['shouldAuditKey', 'captureSendGuard', 'shouldBlockSilentReply', 'assertOutboundAuditOk'],
  // P7 第二批：语音、表情、黑话、用量
  'src/features/voice/config.js': ['voiceCfg', 'voiceLibrary', 'voicePathInsideLibrary', 'resolveVoicePathForV2', 'resolveVoicePathForOperator'],
  'src/features/voice/budget.js': ['voiceBudgetCheck', 'voiceBudgetCommit', 'recordVoiceSentV2'],
  'src/features/voice/send.js': ['sendVoiceV2', 'verifyVoiceMessageSent', 'sendVoiceForV2'],
  'src/features/sticker/store.js': ['stickerEnabled', 'saveStickerStoreSafe', 'syncStickerLibrary', 'listStickersForV2', 'getStickerImageData'],
  'src/features/sticker/send.js': ['sendStickerV2', 'applyStickerNoteV2', 'setStickerRemarkV2', 'collectStickerV2'],
  'src/features/slang/learning.js': ['saveSlangStore', 'queueSlangTask', 'ensureSlangLearnerSession', 'invalidateSlangLearnerSession', 'waitLearnerTurn', 'runSlangExtraction', 'runSlangResearch'],
  'src/features/slang/window.js': ['maybeQueueSlangExtraction', 'feedSlangWindow', 'allowSlangSubmit'],
  'src/features/slang/inject.js': ['publicSlangEntry', 'confirmedSlangListV2', 'withSlangContext'],
  'src/features/usage/record.js': ['rememberModel', 'recordSessionUsage', 'recordSessionSnapshot'],
  // P7 第三批：各状态文件的存储
  'src/store/sessions.js': ['loadState', 'saveState'],
  'src/store/social-v2.js': ['getSocialV2State', 'loadSocialV2State', 'saveSocialV2State', 'appendSocialV2Message', 'appendSocialV2Poke', 'recordSentMessagesV2'],
  'src/store/delivery-cursors.js': ['runWithDeliveryLock', 'loadDeliveryCursors', 'saveDeliveryCursors', 'markTurnStarted', 'markTurnDelivered', 'forgetDeliveryCursor', 'completedTurnsFromRecords', 'replayCompletedTurns', 'handleSessionSnapshot', 'replayDeferredDeliveries'],
  'src/store/initial-prompts.js': ['initialPromptMaxChars', 'normalizeInitialPromptText', 'loadInitialPrompts', 'saveInitialPrompts', 'getInitialPrompt', 'setInitialPrompt'],
  'src/store/feedback.js': ['readFeedbackEntries', 'appendFeedbackEntry', 'readToolLog', 'appendToolLog', 'redactSensitive', 'sanitizeToolArgs'],
  'src/store/archive-wiring.js': ['archiveSafely', 'archiveIncoming', 'archiveOutgoing'],
  // P7 收尾：策略层的桥接包装
  'src/policy/audit.js': ['rememberAgentToken', 'forgetAgentToken', 'hasKnownTokenFragment', 'redactSensitiveText', 'redactKnownTokensOnly'],
  'src/policy/self-key.js': ['encodeSelfKey'],
};

// 把特殊符号转义，方便拼进正则
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 检查某个函数有没有定义在源码里
const definedIn = (source, name, { anyIndent = false } = {}) => {
  const indent = anyIndent ? '\\s*' : '(?:|  )';
  return new RegExp(`^${indent}(?:export |return )?(?:async )?function ${esc(name)}\\(|^${indent}const ${esc(name)} = (?:async )?\\(`, 'm').test(source);
};

let failures = 0;
// 跑一项检查，失败就记一次
const check = (label, fn) => {
  try { fn(); console.log('PASS', label); }
  catch (error) { failures += 1; console.error('FAIL', label, '—', error.message); }
};

// 组装层搬到了 app.js，两处都不该再有旧函数
const bridge = read('src/bridge.js') + '\n' + read('src/app.js');
for (const [target, names] of Object.entries(MIGRATED)) {
  const source = read(target);
  for (const name of names) {
    check(`${name} → ${target}`, () => {
      assert.equal(definedIn(bridge, name), false, `src/bridge.js / src/app.js 仍定义了 ${name}`);
      assert.equal(definedIn(source, name, { anyIndent: true }), true, `${target} 没有 ${name} 的定义`);
    });
  }
}

const srcFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel);
    else if (/\.(m?js)$/.test(entry.name)) srcFiles.push(rel);
  }
})('src');
// 找出源码里 import 了哪些模块
const importsOf = (source) => [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);

check('依赖方向：src/ 不 import scripts/，无模块 import bridge.js', () => {
  for (const file of srcFiles) {
    for (const spec of importsOf(read(file))) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      assert.ok(!resolved.startsWith('scripts/'), `${file} → ${spec}`);
      assert.notEqual(resolved, 'src/bridge.js', `${file} 反向 import bridge.js`);
      if (file !== 'src/bridge.js') assert.notEqual(resolved, 'src/app.js', `${file} 反向 import app.js`);
    }
  }
});

check('bridge.js 只剩进程入口（< 300 行，不含 main 定义）', () => {
  const entry = read('src/bridge.js');
  assert.ok(entry.split('\n').length < 300);
  assert.equal(/function main\b/.test(entry), false);
  assert.ok(/async function main\b/.test(read('src/app.js')));
});

check('依赖方向：infra/ 与 policy/ 只依赖 infra/policy/store 原语或 node 内置', () => {
  for (const file of srcFiles.filter((f) => f.startsWith('src/infra/') || f.startsWith('src/policy/'))) {
    for (const spec of importsOf(read(file))) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      assert.ok(/^src\/(infra|policy|store)\/|^src\/sensitive\.js$/.test(resolved), `${file} → ${resolved}`);
    }
  }
  // gateway 是 QQ 通道底座，不能引用功能代码
  for (const file of srcFiles.filter((f) => f.startsWith('src/gateway/'))) {
    for (const spec of importsOf(read(file))) {
      if (!spec.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      assert.ok(/^src\/(infra|policy|store|gateway)\/|^src\/snowluma-conn\.js$/.test(resolved), `${file} → ${resolved}`);
    }
  }
});

check('状态唯一写入口：只有 store/social-v2.js 写 social-v2.json', () => {
  // 只有 store/social-v2.js 能写这个状态文件
  for (const file of srcFiles.filter((f) => f !== 'src/store/social-v2.js')) {
    assert.ok(!/(atomicWriteJson|writeFileSync|renameSync|unlinkSync|rmSync)\([^)]*SOCIAL_V2_FILE/.test(read(file)), `${file} 直接写 SOCIAL_V2_FILE`);
  }
});

const total = Object.values(MIGRATED).flat().length;
console.log(failures ? `\n${failures} 项失败` : `\nALL PASS（已搬 ${total} 个函数）`);
process.exit(failures ? 1 : 0);
