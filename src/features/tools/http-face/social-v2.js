// 二代仿真内部 Agent API：配置、状态、未读、唤醒、发送
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import path from 'node:path';
import { canonicalV2Key } from '../../../policy/access.js';
import { SENSITIVE_RE } from '../../../sensitive.js';
import { buildSlangContext } from '../../../slang-learner.js';
import { buildStickerContext, buildStickerStrategyHint } from '../../../sticker-lib.js';
import { readConfigObject, atomicWriteJson } from '../../../store/fs-atomic.js';

// 注册二代仿真 Agent API 路由
export function createToolSocialV2Routes(b) {
  return async function toolSocialV2Routes(rq) {
    // 二代仿真内部 Agent API
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/config') {
      rq.sendJson({ ok: true, config: b.cfg.socialV2 ?? {} });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/config') {
      const body = await rq.readBody();
      const configFile = path.join(b.ROOT, 'config.json');
      const file = readConfigObject(configFile);
      // 没有保存过就用现在生效的配置打底，否则会把默认关的工具打开
      const fileV2 = (file.socialV2 && typeof file.socialV2 === 'object' && !Array.isArray(file.socialV2))
        ? file.socialV2
        : null;
      const current = fileV2 ?? ((b.cfg.socialV2 && typeof b.cfg.socialV2 === 'object') ? b.cfg.socialV2 : {});
      const merged = { ...current, ...body };
      // 子对象须为非 null 对象，否则保留当前值，防绕过工具开关
      for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'voice']) {
        if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
          merged[sub] = current[sub] ?? {};
        }
      }
      // HTTP 接口不能更换可执行文件路径
      if (body.voice && typeof body.voice === 'object' && !Array.isArray(body.voice)) {
        if (Object.prototype.hasOwnProperty.call(body.voice, 'ffmpegPath')) {
          rq.sendJson({ ok: false, error: 'ffmpegPath 只能在本机 config.json 或 FFMPEG_PATH 中配置' }, 400);
          return;
        }
        const currentVoice = b.cfg.socialV2?.voice ?? {};
        merged.voice = { ...currentVoice, ...body.voice, ffmpegPath: currentVoice.ffmpegPath ?? '' };
      }
      if (merged.autoReplyCheckMs !== undefined) {
        const n = Number(merged.autoReplyCheckMs);
        merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
      }
      // tools：只接受布尔开关
      const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice'];
      if (body.tools && typeof body.tools === 'object') {
        merged.tools = { ...(current.tools ?? {}), ...body.tools };
        for (const k of toolFlags) {
          if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
        }
      }
      // wake：把数字和文字列表统一成一样的格式
      if (body.wake && typeof body.wake === 'object') {
        merged.wake = { ...(current.wake ?? {}), ...body.wake };
        for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
          if (merged.wake[k] !== undefined) {
            const n = Number(merged.wake[k]);
            merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
            // 毫秒/次数非负取整，概率单独 clamp
            if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
          }
        }
        if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
        if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
        if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
        if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
        if (merged.wake.recommendedKeywords !== undefined) {
          merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
        }
        if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
        if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
      }
      // send：把数字统一成正常数值
      if (body.send && typeof body.send === 'object') {
        merged.send = { ...(current.send ?? {}), ...body.send };
        for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
          if (merged.send[k] !== undefined) {
            const n = Number(merged.send[k]);
            merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
            // 次数/毫秒/字符数非负取整，概率单独 clamp
            if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
          }
        }
        if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
        if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
        if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
      }
      // wait：把数字统一成正常数值
      if (body.wait && typeof body.wait === 'object') {
        merged.wait = { ...(current.wait ?? {}), ...body.wait };
        for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
          if (merged.wait[k] !== undefined) {
            const n = Number(merged.wait[k]);
            merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
          }
        }
      }
      // proactive：主动机会参数
      if (body.proactive && typeof body.proactive === 'object') {
        merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
        for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
          if (merged.proactive[k] !== undefined) {
            const n = Number(merged.proactive[k]);
            merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
            // 毫秒非负取整，概率单独 clamp
            if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
          }
        }
        if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
        if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
      }
      // sticker：把表情参数统一成一样的格式
      if (body.sticker && typeof body.sticker === 'object') {
        merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
        if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
        for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
          if (merged.sticker[k] !== undefined) {
            const n = Number(merged.sticker[k]);
            merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
          }
        }
        if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
        if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
        if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
        if (body.sticker.collect && typeof body.sticker.collect === 'object') {
          merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
          if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
          for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
            if (merged.sticker.collect[k] !== undefined) {
              const n = Number(merged.sticker.collect[k]);
              merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
            }
          }
        }
      }
      // feedback：把数字和开关统一成正常值
      if (body.feedback && typeof body.feedback === 'object') {
        merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
        if (merged.feedback.maxLength !== undefined) {
          const n = Number(merged.feedback.maxLength);
          merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
        }
        if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
      }
      // context：把数字统一成正常数值
      if (body.context && typeof body.context === 'object') {
        merged.context = { ...(current.context ?? {}), ...body.context };
        for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
          if (merged.context[k] !== undefined) {
            const n = Number(merged.context[k]);
            merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
          }
        }
        for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
          const n = Number(merged.context[name] ?? fallback);
          merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
        }
        if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
      }
      if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
      if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
      if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
      file.socialV2 = merged;
      atomicWriteJson(configFile, file);
      b.cfg.socialV2 = { ...(b.cfg.socialV2 ?? {}), ...merged };
      // 只有影响默认唤醒的字段变了才同步到使用默认配置的会话
      const WAKE_DEFAULT_KEYS = [
        'defaultMode', 'recommendedDefaultInfinite',
        'recommendedSleepMinMs', 'recommendedSleepMaxMs',
        'recommendedProbability', 'recommendedKeywords',
        'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
        'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
      ];
      const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
        WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
      if (wakeDefaultChanged) b.refreshAllDefaultWakeConfigsV2();
      b.log('控制台：二代仿真配置已更新');
      rq.sendJson({ ok: true, config: b.cfg.socialV2 });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/activity') {
      rq.sendJson({ ok: true, paused: b.socialV2.paused });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/activity') {
      const body = await rq.readBody();
      const paused = body.paused === true;
      b.socialV2.paused = paused;
      if (paused) {
        b.clearAllSocialV2Timers();
        b.log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
      } else {
        b.log('控制台：二代 AI 已恢复');
        for (const key of b.socialV2.conversations.keys()) {
        b.setupSleepTimerV2(key);
        b.scheduleProactiveCheckV2(key);
      }
      }
      b.saveSocialV2State();
      rq.sendJson({ ok: true, paused: b.socialV2.paused });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/reset') {
      b.sessionEpoch++;
      b.sessionPromises.clear();
      b.clearAllSocialV2Timers();
      b.drainAllPromptQueues('二代状态已重置');
      b.forgetConversationMemory(); // 先清全部会话记忆，再删会话状态
      for (const key of [...b.socialV2.conversations.keys()]) {
        const sid = b.state.sessions[key];
        if (sid) {
          delete b.state.sessions[key];
          // 先让 DSH 停下该会话的工作，否则输出被丢、token 白烧
          b.stopRetiredSessionWork(sid, key);
          b.sessionModels.delete(sid);
          b.modelAppliedSessions.delete(sid);
          b.reverse.delete(sid);
          b.forgetDeliveryCursor(sid);
          b.collectors.delete(sid);
          b.v2TurnStartAt.delete(sid);
          b.turnLeaseNoted.delete(sid);
          b.toolCallNames.delete(sid);
          b.pendingSendToolCalls.delete(sid);
          b.sendToolSucceededSessions.delete(sid);
          // 退订事件，否则重连时会重新 follow
          b.api.events.forget?.(sid);
        }
        delete b.state.sessionPolicies[key];
        b.forgetAgentToken(key);
        b.socialV2.conversations.delete(key);
        b.seenForwardIds.delete(key);
      }
      b.saveState();
      b.pendingWakeKeys.clear();
      b.clearAllPendingWakeLeases();
      b.wakeConfigUpdatedKeys.clear();
      b.markReadCalledKeys.clear();
      b.wakeConfigMissCount.clear();
      b.socialV2.paused = false;
      // 统一走存储写入；只读模式下不会覆盖文件
      b.saveSocialV2State();
      b.log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
      rq.sendJson({ ok: true });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/state') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('socialState')) { rq.sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
      const st = b.getSocialV2State(key);
      rq.sendJson({
        ok: true,
        key,
        wakeConfig: st.wakeConfig,
        wakeSafety: b.computeWakeSafetyV2(st.wakeConfig),
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt
      });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/prompt') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getPrompt')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
      const st = b.getSocialV2State(key);
      // 按 TTL 同步收藏表情，失败不阻塞
      if (b.cfg.socialV2?.sticker?.enabled !== false) {
        try { await b.syncStickerLibrary(false); } catch {}
      }
      const roleState = b.readRoleState();
      const toolMap = {
        getPrompt: 'qq_get_prompt',
        getUnread: 'qq_get_unread_messages',
        getRecent: 'qq_get_recent_messages',
        socialState: 'qq_social_state',
        sendGroup: 'qq_send_group_message',
        sendPrivate: 'qq_send_private_message',
        reply: 'qq_reply',
        sendBurst: 'qq_send_burst',
        sendMessage: 'qq_send_message',
        waitMessages: 'qq_wait_for_messages',
        feedback: 'qq_report_feedback',
        getMyRecent: 'qq_get_my_recent_messages',
        getMessageDetail: 'qq_get_message_detail',
        getActiveMembers: 'qq_get_active_members',
        setWakeConfig: 'qq_set_wake_config',
        markRead: 'qq_mark_read',
        memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
        slangQuery: 'qq_slang_query',
        slangSubmit: 'qq_slang_submit',
        getImages: 'qq_get_message_images',
        getForwardMsg: 'qq_get_forward_msg',
        sendPoke: 'qq_send_poke',
        listStickers: 'qq_list_stickers',
        getStickerImage: 'qq_get_sticker_image',
        sendSticker: 'qq_send_sticker',
        setStickerRemark: 'qq_set_sticker_remark',
        stickerNote: 'qq_sticker_note',
        collectSticker: 'qq_collect_sticker',
        getSelfImage: 'qq_get_self_image',
        sendVoice: 'qq_send_voice / qq_list_voices'
      };
      const tools = b.cfg.socialV2?.tools ?? {};
      const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
      const enabledTools = [];
      for (const [flag, name] of Object.entries(toolMap)) {
        if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !b.stickerEnabled())) enabledTools.push(name);
      }
      rq.sendJson({
        ok: true,
        key,
        time: new Date().toISOString(),
        // 机器人自身身份，供 agent 识别 @自己
        self: {
          nickname: b.selfDisplayName || null,
          userId: b.selfUserId || null,
          line: b.selfIdentityTextV2().trim() || null
        },
        role: { name: roleState.role ?? null, hint: b.modeForKey(key) === 'reserved2' ? b.currentRoleHintV2() : b.currentRoleHint() },
        recommended: b.cfg.socialV2?.provideRecommendations === false ? null : {
          wake: b.cfg.socialV2?.wake ?? {},
          send: b.cfg.socialV2?.send ?? {},
          wait: b.cfg.socialV2?.wait ?? {},
          proactive: b.cfg.socialV2?.proactive ?? {}
        },
        enabledTools,
        replyTiming: b.replyTimingV2(st),
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        currentWakeConfig: st.wakeConfig,
        wakeSafety: b.computeWakeSafetyV2(st.wakeConfig),
        memory: b.formatMemoryV2(st),
        participation: b.formatParticipationV2(st),
        slang: {
          enabled: b.cfg.slang?.enabled !== false,
          entries: b.confirmedSlangListV2(key),
          block: buildSlangContext(b.slangEntries, b.cfg.slang?.injectMax ?? 8, key)
        },
        stickers: {
          enabled: b.cfg.socialV2?.sticker?.enabled !== false,
          total: b.stickerEntries.length,
          context: b.cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(b.stickerEntries, b.cfg.socialV2?.sticker?.promptMaxStickers ?? 8, key) : '',
          strategy: b.cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
        },
        // 语音库摘要
        voices: b.cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
          enabled: true,
          total: b.voiceLibrary().length,
          names: b.voiceLibrary().slice(0, 12).map((v) => v.name),
          maxSeconds: b.voiceCfg().maxSeconds,
          hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
        }
      });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/unread') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(rq.url.searchParams.get('limit')) || 30));
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getUnread')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
      const afterRaw = rq.url.searchParams.get('afterSeq');
      const afterSeq = afterRaw === null ? null : Number(afterRaw);
      if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
        rq.sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
        return;
      }
      const st = b.getSocialV2State(key);
      // 默认给最后几条未读；带上位置就能继续读完更多的
      const messages = afterSeq === null ? st.unread.slice(-limit)
        : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
      const readThroughSeq = rq.req.headers['x-agent-token'] ? b.noteModelMessagesV2(st, messages) : b.readThroughSeqV2(st);
      rq.sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/recent') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(rq.url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(rq.url.searchParams.get('offset')) || 0);
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getRecent')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
      const st = b.getSocialV2State(key);
      const start = Math.max(0, st.recentMessages.length - offset - limit);
      const end = Math.max(0, st.recentMessages.length - offset);
      const messages = st.recentMessages.slice(start, end);
      const readThroughSeq = rq.req.headers['x-agent-token'] ? b.noteModelMessagesV2(st, messages) : b.readThroughSeqV2(st);
      rq.sendJson({ ok: true, key, messages, readThroughSeq });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/mark-read') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('markRead')) { rq.sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
      const st = b.getSocialV2State(key);
      // 不带位置就会清空全部未读，这是故意保留的老规矩
      const throughSeq = b.requestedReadThroughSeqV2(st, body, !!rq.req.headers['x-agent-token']);
      // 潜水配置下未满观察窗口时不允许 mark_read 回潜水
      if (b.isSleepingConfigV2(st.wakeConfig) && b.preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(b.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
        const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        rq.sendJson({
          ok: false,
          error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
          preSleepWaitMs: preSleepMs,
          preSleepWaitRemainingMs: remaining
        }, 400);
        return;
      }
      const markedCount = b.acknowledgeMessagesV2(st, throughSeq);
      st.lastActionAt = Date.now();
      st.wakeConfig.noActionCount = 0;
      // 防有限潜水无定时器无触发条件的静默态
      if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
        st.wakeConfig.infinite = true;
      }
      b.ensureWakeableV2(st, { key });
      st.wakeConfig.confirmedAt = Date.now();
      st.wakeConfig.confirmedBy = 'mark_read';
      b.markReadCalledKeys.add(key);
      b.saveSocialV2State();
      b.log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
      rq.sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: b.readThroughSeqV2(st), wakeGuaranteed: b.computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: b.computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/wake-config') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('setWakeConfig')) { rq.sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
      const st = b.getSocialV2State(key);
      const throughSeq = b.requestedReadThroughSeqV2(st, body, !!rq.req.headers['x-agent-token']);
      // markRead 关闭时只更新唤醒配置
      const acknowledgeOnClose = throughSeq !== null && b.v2ToolEnabled('markRead');
      const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
      const current = st.wakeConfig;
      const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
      const configFields = ['mode', 'infinite', 'sleepUntil', 'sleepMs', 'triggers', 'batchWindowMs'];
      const unknownFields = [
        ...Object.keys(input).filter((name) => !configFields.includes(name)).map((name) => `config.${name}`),
        ...Object.keys(inputTriggers).filter((name) => !b.WAKE_TRIGGER_KEYS.includes(name)).map((name) => `triggers.${name}`)
      ];
      if (unknownFields.length) { rq.sendJson({ ok: false, error: `未知唤醒配置字段：${unknownFields.join('、')}` }, 400); return; }
      if (input.mode !== undefined && !['diving', 'active'].includes(input.mode)) {
        rq.sendJson({ ok: false, error: 'mode 必须是 diving（潜水）或 active（活跃）' }, 400); return;
      }
      if (input.triggers !== undefined && (!input.triggers || typeof input.triggers !== 'object' || Array.isArray(input.triggers))) {
        rq.sendJson({ ok: false, error: 'triggers 必须是对象' }, 400); return;
      }
      if (inputTriggers.keywords !== undefined && typeof inputTriggers.keywords !== 'string' && !Array.isArray(inputTriggers.keywords)) {
        rq.sendJson({ ok: false, error: 'keywords 必须是字符串或关键词数组，未修改原配置' }, 400); return;
      }
      // 读布尔触发项，未提供时用默认值
      const normalizeTriggerBool = (name, fallback) => {
        if (name in inputTriggers) return inputTriggers[name] === true;
        return fallback;
      };
      const rawKeywords = inputTriggers.keywords;
      const nextKeywords = rawKeywords !== undefined
        ? (typeof rawKeywords === 'string' ? rawKeywords.split(/[,，、\s]+/) : rawKeywords)
            .map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
        : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
      const next = {
        ...current,
        mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
        infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
        sleepUntil: current.sleepUntil,
        triggers: {
          // 只保留已知触发字段
          ...b.pickWakeTriggersV2(inputTriggers, current.triggers),
          atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
          nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
          question: normalizeTriggerBool('question', current.triggers.question === true),
          anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
          poke: normalizeTriggerBool('poke', current.triggers.poke === true),
          keywords: nextKeywords
        },
        // batchWindowMs 以全局为准，未显式传时跟随全局
        batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
          ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
          : (Number(b.cfg.socialV2?.wake?.batchWindowMs) >= 1000
            ? Math.min(3600000, Math.round(Number(b.cfg.socialV2.wake.batchWindowMs)))
            : current.batchWindowMs)
      };
      // 切回 diving 且未显式保留 anyMessage 时清除它
      if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
        next.triggers.anyMessage = false;
      }
      if (next.mode === 'active') {
        next.infinite = true;
        next.sleepUntil = null;
        next.triggers.anyMessage = true;
      }
      if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
      if (next.infinite) {
        next.sleepUntil = null;
      } else if (input.sleepUntil) {
        const d = new Date(String(input.sleepUntil));
        if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
      } else if (Number.isFinite(Number(input.sleepMs))) {
        let ms = Math.max(0, Math.round(Number(input.sleepMs)));
        const minMs = Math.max(0, Number(b.cfg.socialV2?.wake?.sleepMinMs) || 0);
        const maxMs = Number(b.cfg.socialV2?.wake?.sleepMaxMs) || 0;
        if (ms < minMs) ms = minMs;
        if (maxMs > 0 && ms > maxMs) ms = maxMs;
        next.sleepUntil = new Date(Date.now() + ms).toISOString();
      } else if (!next.sleepUntil && !next.infinite) {
        // 既无无限也无时间：用推荐默认时长
        const recMin = Number(b.cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
        const recMax = Number(b.cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
        const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
        next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
      }
      // 有限 sleepUntil 也 clamp，防绕过 sleepMaxMs
      if (!next.infinite && next.sleepUntil) {
        const maxMs = Number(b.cfg.socialV2?.wake?.sleepMaxMs) || 0;
        const minMs = Math.max(0, Number(b.cfg.socialV2?.wake?.sleepMinMs) || 0);
        let until = Date.parse(next.sleepUntil);
        if (Number.isFinite(until)) {
          if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
          if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
          next.sleepUntil = new Date(until).toISOString();
        }
      }
      // 把概率限制在 0 到 1 之间
      if (next.triggers.probability !== undefined) {
        next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
      }
      // 拍一拍触发只接受布尔
      if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
        next.triggers.poke = input.triggers.poke === true;
      }
      // 指定成员只留正整数 QQ 号，非法值清空，防绕过防永眠
      next.triggers.speakerIds = b.normalizeSpeakerIdsV2(next.triggers.speakerIds);
      // 私聊不适用指定成员触发，清除
      if (key.startsWith('private:')) {
        next.triggers.speakerIds = [];
      }
      // 防永眠：无限期潜水须至少有一个触发条件
      if (next.infinite) {
        const tr = next.triggers ?? {};
        const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
        if (!hasTrigger) {
          rq.sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
          return;
        }
      }
      // 未满沉睡前观察窗口时不允许设置潜水
      if (b.isSleepingConfigV2(next) && b.preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(b.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
        const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        rq.sendJson({
          ok: false,
          error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
          preSleepWaitMs: preSleepMs,
          preSleepWaitRemainingMs: remaining
        }, 400);
        return;
      }
      const markedCount = acknowledgeOnClose ? b.acknowledgeMessagesV2(st, throughSeq) : 0;
      st.wakeConfig = next;
      st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
      st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
      st.wakeConfig.noActionCount = 0;
      st.wakeConfig.confirmedAt = Date.now();
      st.wakeConfig.confirmedBy = 'set_wake_config';
      st.lastActionAt = Date.now();
      // 已设置下次唤醒，观察标记作废
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      b.saveSocialV2State();
      b.wakeConfigUpdatedKeys.add(key);
      b.wakeConfigMissCount.delete(key);
      if (st.pendingWakeTimer) {
        b.clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      b.cancelReplyCheckV2(key); // AI 已设置新唤醒配置，取消回复检查
      b.setupSleepTimerV2(key);
      b.log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
      rq.sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: b.readThroughSeqV2(st), wakeConfig: next, wakeSafety: b.computeWakeSafetyV2(next) });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/states') {
      const list = [];
      for (const [key, st] of b.socialV2.conversations) {
        list.push({
          key,
          wakeConfig: st.wakeConfig,
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          noActionCount: st.wakeConfig.noActionCount || 0
        });
      }
      rq.sendJson({ ok: true, conversations: list });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/wake') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const reason = String(body.reason ?? 'admin').trim() || 'admin';
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (b.currentMode !== 'reserved2') { rq.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      const st = b.getSocialV2State(key);
      if (st.pendingWakeTimer) {
        b.clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      // 首次唤醒必须走 bootstrap，否则会话永远拿不到引导
      const firstWake = !st.bootstrapSent;
      if (firstWake) st.bootstrapSent = true;
      const effectiveReason = firstWake ? 'bootstrap' : reason;
      b.saveSocialV2State();
      // 不 await，但必须挂 catch 防 unhandledRejection
      void b.sendWakePromptV2(key, effectiveReason).catch((error) => b.log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
      b.log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
      rq.sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
      return;
    }
    // 每个聊天的初始提示词：只有控制台能改，第一次叫醒时写进去
    if (rq.url.pathname === '/api/socialV2/initial-prompt' && (rq.req.method === 'GET' || rq.req.method === 'POST')) {
      if (rq.req.method === 'GET') {
        const key = String(rq.url.searchParams.get('key') ?? '').trim();
        if (!key) {
          const entries = [...b.initialPrompts.entries()]
            .map(([entryKey, entry]) => ({
              key: entryKey,
              chars: entry.text.length,
              createdAt: entry.createdAt || 0,
              updatedAt: entry.updatedAt || 0,
              preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
            }))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          rq.sendJson({ ok: true, entries, maxChars: b.initialPromptMaxChars(), writable: b.initialPromptsWritable });
          return;
        }
        const canonical = canonicalV2Key(key);
        if (!canonical) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
        const entry = b.initialPrompts.get(canonical) ?? null;
        rq.sendJson({
          ok: true,
          key: canonical,
          exists: !!entry,
          text: entry?.text ?? '',
          createdAt: entry?.createdAt || 0,
          updatedAt: entry?.updatedAt || 0,
          maxChars: b.initialPromptMaxChars(),
          writable: b.initialPromptsWritable
        });
        return;
      }
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const explicitDelete = body.delete === true;
      // 缺 text 不当作清空，防误删
      if (!explicitDelete && typeof body.text !== 'string') {
        rq.sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
        return;
      }
      const result = b.setInitialPrompt(key, explicitDelete ? '' : body.text);
      if (!result.ok) { rq.sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
      b.log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
      rq.sendJson({
        ok: true,
        key: result.key,
        deleted: result.deleted,
        chars: result.chars,
        exists: !!result.entry,
        updatedAt: result.entry?.updatedAt || 0,
        maxChars: b.initialPromptMaxChars()
      });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/send-burst') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容单条消息被存成 JSON 字符串的情况
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        }
      }
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
      const replyToMessageId = body.replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        rq.sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
        return;
      }
      if (!key || !messages.length) {
        rq.sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return;
      }
      const sendCfgBurst = b.cfg.socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        rq.sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return;
      }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('sendBurst')) { rq.sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
      if (b.currentMode !== 'reserved2') {
        rq.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
        return;
      }
      if (!rq.req.headers['x-agent-token']) { rq.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (b.shouldBlockSilentReply(key)) {
        rq.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return;
      }
      const sendCfg = b.cfg.socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        rq.sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return;
      }
      for (const msg of messages) {
        if (msg.length > maxChars) {
          rq.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return;
        }
        if (SENSITIVE_RE.test(msg)) {
          rq.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
          return;
        }
      }
      const st = b.getSocialV2State(key);
      const now = Date.now();
      try {
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
          rq.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return;
        }
        // 先把发送次数占上，免得同时发好几条绕过限制
        for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        const delays = b.computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
        const sentMessages = await b.sendMessagesV2(key, messages, delays);
        b.recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        b.saveSocialV2State();
        b.log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
        b.appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
        if (sentMessages.length > 0) b.scheduleReplyCheckV2(key);
        const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
        const spaceWarn = b.findCjkSpaceWarning(messages);
        const splitWarn = b.findSplitBoundaryWarning(messages);
        rq.sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
      } catch (error) {
        if (error?.sent?.length) {
          b.recordSentMessagesV2(key, error.sent);
          b.log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        // 回滚未发出消息的预占额度，防假 429
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, messages.length - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        b.saveSocialV2State();
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/send-message') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        // 兼容数组被存成 JSON 字符串的情况
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容单条消息被存成 JSON 字符串的情况
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        }
      }
      const isRawString = typeof rawMessages === 'string';
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      // 字符串即一条消息，数组用调用方给的间隔
      const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
      const gapMs = Number(body.gapMs);
      const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
      if (!key || !messages.length) {
        rq.sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return;
      }
      const sendCfgBurst = b.cfg.socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        rq.sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return;
      }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('sendMessage')) { rq.sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
      if (b.currentMode !== 'reserved2') { rq.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
      if (!rq.req.headers['x-agent-token']) { rq.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (kind === 'private' && atUserId) {
        rq.sendJson({ ok: false, error: '私聊不需要 @' }, 400);
        return;
      }
      if (b.shouldBlockSilentReply(key)) {
        rq.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return;
      }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        rq.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return;
      }
      const sendCfg = b.cfg.socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        rq.sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return;
      }
      for (const msg of messages) {
        if (msg.length > maxChars) {
          rq.sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return;
        }
        if (SENSITIVE_RE.test(msg)) {
          rq.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
          return;
        }
      }
      const delays = b.computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
      // 先查频率并占额度，再去找引用的消息，免得把网关打爆
      const st = b.getSocialV2State(key);
      const now = Date.now();
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
        rq.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return;
      }
      // 先把发送次数占上，免得同时发好几条绕过限制
      for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const resolved = await b.resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          // 找不到引用的消息：把占的次数退回去
          for (let i = 0; i < messages.length; i++) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
          }
          b.saveSocialV2State();
          rq.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
          return;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      try {
        const sentMessages = await b.sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
        b.recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        b.saveSocialV2State();
        b.log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
        b.appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
        if (sentMessages.length > 0) b.scheduleReplyCheckV2(key);
        const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
        const spaceWarn = b.findCjkSpaceWarning(messages);
        const splitWarn = b.findSplitBoundaryWarning(messages);
        rq.sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
      } catch (error) {
        if (error?.sent?.length) {
          b.recordSentMessagesV2(key, error.sent);
          b.log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        // 回滚未发出消息的预占额度，防假 429
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, messages.length - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        b.saveSocialV2State();
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/send-poke') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (b.currentMode !== 'reserved2') { rq.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
      if (!rq.req.headers['x-agent-token']) { rq.sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
      if (!b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (!b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (!b.v2ToolEnabled('sendPoke')) { rq.sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
      if (b.socialV2.paused) { rq.sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
        return;
      }
      if (b.shouldBlockSilentReply(key)) { rq.sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
      if (kind === 'group' && !targetUserId) {
        rq.sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
        return;
      }
      if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
        rq.sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
        return;
      }
      const sendGuard = b.captureSendGuard(key, { ai: true });
      // 群聊须确认目标是本群成员
      if (kind === 'group') {
        const memberError = await b.assertGroupMember(id, targetUserId);
        if (memberError) { rq.sendJson({ ok: false, error: memberError }, 403); return; }
      }
      const st = b.getSocialV2State(key);
      const sendCfg = b.cfg.socialV2?.send ?? {};
      const now = Date.now();
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        rq.sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return;
      }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      // 检查成员期间状态可能变，发之前再查一次能不能发
      try {
        sendGuard();
        if (b.shouldBlockSilentReply(key)) {
          const blocked = new Error('静默模式已开启，当前不允许拍一拍');
          blocked.statusCode = 403;
          throw blocked;
        }
        if (kind === 'group') {
          await b.bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
        } else {
          // 私聊拍一拍自动发给当前对象
          await b.bot.raw('send_poke', { user_id: id });
        }
        st.lastActionAt = now;
        st.lastAiReplyAt = now;
        st.wakeConfig.noActionCount = 0;
        const pokeText = kind === 'group'
          ? `[拍一拍] 我拍了拍 ${targetUserId}`
          : '[拍一拍] 我拍了拍你';
        b.archiveOutgoing(key, pokeText, null, { media: [{ kind: 'poke', summary: String(targetUserId || id) }] });
        st.recentMessages.push({
          messageId: null,
          sender: '我',
          text: pokeText,
          plain: pokeText,
          tail: pokeText,
          kind: 'poke',
          quoteTargetIsSelf: false,
          isOwner: false,
          ownerLabel: '',
          isSelf: true,
          media: [],
          hasMedia: false,
          forwardIds: [],
          hasForward: false,
          poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
          time: Date.now()
        });
        const recentLimit = Number(b.cfg.socialV2?.context?.recentLimit) || 100;
        if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        b.saveSocialV2State();
        b.log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        b.appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        rq.sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
      } catch (error) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        b.log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
        rq.sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
      }
      return;
    }
    return ROUTE_NEXT;
  };
}
