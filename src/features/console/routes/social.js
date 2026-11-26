import { adaptLegacyConfig, syncConfigAliases } from '../../../infra/legacy-config.js';
import { withConfigWriteLock } from '../../../infra/config.js';
// 控制台测试发送、一代社交引擎配置、引导 AI 的路由；鉴权在分发前完成
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import path from 'node:path';
import { SENSITIVE_RE } from '../../../sensitive.js';
import { readConfigObject, atomicWriteJson } from '../../../store/fs-atomic.js';

const SOCIAL_ALLOWED_KEYS = new Set([
  'enabled', 'triggerProbability', 'contextWindow',
  'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs',
  'activeDurationEnabled', 'activeDurationMinMs', 'activeDurationMaxMs',
  'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs',
  'proactiveEnabled', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability',
  'skipProbability', 'surrenderProbability', 'maxReplyChars', 'mustReplyKeywords',
  'burstEnabled', 'burstIntervalMinMs', 'burstIntervalMaxMs',
  'longGapProbability', 'longGapMinMs', 'longGapMaxMs',
]);

// 创建控制台社交相关路由
export function createConsoleSocialRoutes(b) {
  return async function consoleSocialRoutes(rq) {
    // 测试发送消息（必须过白名单检查）
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/test-send') {
      const body = await rq.readBody();
      const kind = body.kind === 'private' ? 'private' : 'group';
      const id = Number(body.id);
      const message = String(body.message ?? '').trim();
      if (!Number.isFinite(id) || id <= 0) { rq.sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
      if (!message) { rq.sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
      if (SENSITIVE_RE.test(message)) { rq.sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
      if (!b.modeAllowed(`${kind}:${id}`, kind, id, b.cfg, b.currentMode, { listed: true })) { rq.sendJson({ ok: false, error: `当前模式（${b.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
      try {
        const result = await b.enqueueOutbound(`${kind}:${id}`, { text: b.redactKnownTokensOnly(message), channel: 'console', explicitAllow: true });
        b.log(`控制台：测试发送 ${kind}:${id} 成功`);
        rq.sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
      } catch (error) {
        rq.sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/social/state') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      const phase = body.phase;
      if (phase === 'active') {
        // 手动进入活跃，之后按正常活跃流程跑
        b.enterActive(key);
        b.log(`控制台：手动将 ${key} 设为活跃`);
        rq.sendJson({ ok: true, key, phase: 'active' });
      } else if (phase === 'idle') {
        b.leaveActive(key);
        b.log(`控制台：手动将 ${key} 设为观望`);
        rq.sendJson({ ok: true, key, phase: 'idle' });
      } else {
        rq.sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
      }
      return;
    }
    // 一代社交引擎配置读写
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/console/social') {
      const stats = {};
      for (const [k, e] of b.social.pendingSummaries.entries()) stats[k] = e.items.length;
      const states = {};
      const keys = new Set([...b.social.states.keys(), ...b.social.recentMessages.keys()]);
      for (const k of keys) {
        const st = b.social.states.get(k);
        states[k] = { phase: st?.phase ?? 'idle' };
      }
      rq.sendJson({ config: b.cfg.social, pendingSummaries: stats, states });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/social') {
      const body = await rq.readBody();
      const configFile = path.join(b.ROOT, 'config.json');
      await withConfigWriteLock(async () => {
        // 配置文件损坏直接 500，绝不回写
        const file = adaptLegacyConfig(readConfigObject(configFile));
        const patch = {};
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          for (const [k, v] of Object.entries(body)) {
            if (SOCIAL_ALLOWED_KEYS.has(k)) patch[k] = v;
          }
        }
        const merged = { ...(file.social ?? {}), ...patch };
        // 保存时清掉已废弃的旧字段
        for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
          delete merged[k];
        }
        for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
          if (merged[k] !== undefined) {
            const n = Number(merged[k]);
            if (Number.isFinite(n) && n >= 0) merged[k] = n;
            else if (file.social?.[k] !== undefined) merged[k] = file.social[k];
            else delete merged[k];
          }
        }
        // 分条间隔 clamp 到非负
        for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
          if (merged[k] !== undefined) {
            const n = Number(merged[k]);
            merged[k] = Number.isFinite(n) ? Math.max(0, n) : 0;
          }
        }
        // 概率字段 clamp 到 0~1（非数字拒绝覆盖为 NaN/null）
        for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
          if (merged[k] !== undefined) {
            const n = Number(merged[k]);
            if (Number.isFinite(n)) merged[k] = Math.min(1, Math.max(0, n));
            else if (file.social?.[k] !== undefined) merged[k] = file.social[k];
            else delete merged[k];
          }
        }
        // contextWindow 限制 1~100
        if (merged.contextWindow !== undefined) {
          const n = Number(merged.contextWindow);
          if (Number.isFinite(n)) merged.contextWindow = Math.min(100, Math.max(1, Math.round(n)));
          else if (file.social?.contextWindow !== undefined) merged.contextWindow = file.social.contextWindow;
          else delete merged.contextWindow;
        }
        // 布尔字段
        for (const k of ['enabled', 'activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
          if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
        }
        // 范围字段保证 min <= max
        for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
          if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
            [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
          }
        }
        if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
        if (file.modes && typeof file.modes === 'object' && file.modes.reserved !== undefined) {
          file.modes.reserved = merged;
          delete file.social;
        } else {
          file.social = merged;
        }
        atomicWriteJson(configFile, syncConfigAliases(file));
        b.cfg.social = { ...b.cfg.social, ...merged };
        b.log('控制台：社交配置已更新');
        rq.sendJson({ ok: true, config: b.cfg.social });
      });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/social/flush') {
      const body = await rq.readBody();
      await b.flushSummaries(body.key || null);
      rq.sendJson({ ok: true });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/social/wake-reset') {
      const body = await rq.readBody();
      const rawKey = body && typeof body === 'object' && !Array.isArray(body) ? String(body.key ?? '').trim() : '';
      if (rawKey && !/^(group|private):\d+$/.test(rawKey)) {
        rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const targetKeys = rawKey
        ? (b.socialV2.conversations.has(rawKey) ? [rawKey] : [])
        : [...b.socialV2.conversations.keys()];
      for (const k of targetKeys) {
        const st = b.socialV2.conversations.get(k);
        if (!st) continue;
        st.wakeTimes = [];
        const runtime = b.schedulerRuntime?.(k, st) ?? st;
        if (runtime.rateLimitRetryTimer) {
          (b.clearSchedulerTimer ?? b.clearTimeout ?? clearTimeout)(runtime.rateLimitRetryTimer);
          runtime.rateLimitRetryTimer = null;
        }
        runtime.rateLimitRetryReason = null;
      }
      b.saveSocialV2State?.();
      b.log(`控制台：已重置唤醒计数（${rawKey || `全部 ${targetKeys.length} 个会话`}）`);
      b.appendActivity?.(`控制台重置唤醒计数：${rawKey || '全部会话'}`);
      rq.sendJson({ ok: true, resetKeys: targetKeys });
      return;
    }
    // 向指定会话的 DSH agent 投递控制端提醒
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/notify-ai') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const message = String(body.message ?? '').trim();
      if (!key || !message) {
        rq.sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0) {
        rq.sendJson({ ok: false, error: 'id 无效' }, 400);
        return;
      }
      if (!b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: `该会话不在当前模式（${b.currentMode}）允许范围内` }, 403);
        return;
      }
      if (!b.state.sessions[key] && !b.modeAllowed(key, kind, id, b.cfg, b.currentMode, { listed: true })) {
        rq.sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
        return;
      }
      if (!b.dshReady) {
        rq.sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503, { safeError: true });
        return;
      }
      const isV2 = b.modeForKey(key) === 'reserved2';
      const roleState = b.readRoleState();
      // 按 injectEveryNWakes 写角色卡：首次/换卡全量，其余一行提醒
      const rolePick = b.roleForWake(key);
      if (roleState.role) b.log(`[role] 操作者提示词：${rolePick.full ? `全量角色卡（${rolePick.text.length} 字符）` : '一行提醒'}「${roleState.role}」`);
      const roleLine = roleState.role
        ? (rolePick.full
          ? `【当前角色】${roleState.role}\n【角色卡 —— 以下是你的设定，必须按它说话，不要复述这份卡】\n${rolePick.text || '（角色卡为空，按仿真提示词行动）'}\n【角色卡结束】\n\n`
          : `${rolePick.text}\n\n`)
        : '';
      // 二代必须带会话令牌，否则 MCP 工具调用会被拒
      let tokenLine = '';
      if (isV2) {
        const stV2 = b.getSocialV2State(key);
        tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
      }
      const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
      try {
        const result = await b.deliverPrompt(key, promptText, { silent: true });
        if (result.ok) {
          b.log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
          b.appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
          rq.sendJson({ ok: true, key, sessionId: result.sessionId ?? b.state.sessions[key] ?? null });
        } else {
          rq.sendJson({ ok: false, error: result.error || '投递失败' }, 500);
        }
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return;
    }
    return ROUTE_NEXT;
  };
}
