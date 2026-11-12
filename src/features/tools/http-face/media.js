// 表情包、语音、等消息、发送检查这些网页接口
// 请求进来先用 rq 装着，要用外面的功能就通过 b
// 没匹配到就返回 ROUTE_NEXT，交给后面的路由接着找
// 登录和权限在 bridge.js 前面都查过了，这里不重复也不绕过
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import fs from 'node:fs';
import path from 'node:path';
import { truncateText } from '../../../md-to-plain.js';
import { canonicalV2Key } from '../../../policy/access.js';
import { parseTargetKey, describeAudio, resolveAudioProcessing, listAudioFiles } from '../../../send-voice-lib.js';
import { stickerForScope, formatStickerList } from '../../../sticker-lib.js';
import { looksLikeUnfinished } from '../../../v2-wait.js';

// 做出处理表情包、语音和等消息的请求处理器
export function createToolMediaRoutes(b) {
  return async function toolMediaRoutes(rq) {
    // ── 表情包相关接口 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/sticker-image') {
      if (!b.stickerEnabled()) { rq.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const stickerId = String(rq.url.searchParams.get('stickerId') ?? '').trim();
      if (!key || !stickerId) { rq.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getStickerImage')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
      try {
        const entry = stickerForScope(await b.getStickerImageData(stickerId), key);
        const fetched = await b.safeFetchBuffer(entry.url, b.MAX_MEDIA_BYTES, { allowPorts: b.MEDIA_FETCH_ALLOW_PORTS });
        const dims = b.getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > b.MAX_MEDIA_PIXELS) {
          rq.sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
          return;
        }
        const mimeType = b.mimeFromBuffer(fetched.buffer) || b.mimeFromUrl(entry.url);
        const prep = await b.toModelMedia(fetched.buffer, mimeType, `收藏表情 ${entry.id}`);
        if (!prep.ok) {
          rq.sendJson({ ok: false, error: `表情图片无法提供给模型：${prep.error}` }, 413);
          return;
        }
        rq.sendJson({
          ok: true,
          key,
          sticker: {
            id: entry.id,
            desc: entry.desc || '',
            localNote: entry.localNote || '',
            tags: entry.tags || [],
            url: entry.url,
            md5: entry.md5
          },
          image: { mimeType: prep.mimeType, data: prep.buffer.toString('base64') },
          ...(prep.note ? { note: prep.note } : {})
        });
      } catch (error) {
        rq.sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/self-image') {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('getSelfImage')) { rq.sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
      const selfPath = path.join(b.ROOT, 'assets', 'deepseek娘.png');
      try {
        if (!fs.existsSync(selfPath)) { rq.sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
        const buf = fs.readFileSync(selfPath);
        const mimeType = b.mimeFromBuffer(buf) || 'image/png';
        rq.sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
      } catch (error) {
        rq.sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/sticker-note') {
      if (!b.stickerEnabled()) { rq.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) { rq.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('stickerNote')) { rq.sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
      const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
      const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
      const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
      const entry = b.applyStickerNoteV2(stickerId, note, tags, usage, key);
      if (!entry) { rq.sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
      b.log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
      rq.sendJson({ ok: true, key, sticker: stickerForScope(entry, key) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/sticker-remark') {
      if (!b.stickerEnabled()) { rq.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) { rq.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('setStickerRemark')) { rq.sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
      try {
        const entry = await b.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
        b.log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
        rq.sendJson({ ok: true, key, sticker: stickerForScope(entry, key) });
      } catch (error) {
        rq.sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // ── 语音发送（人在命令行或控制台里发的） ──
    // 人可能不在任何聊天里，所以不要求 key，但白名单和频率限制照旧
    if (rq.req.method === 'POST' && (rq.url.pathname === '/api/voice/send' || rq.url.pathname === '/api/send/voice')) {
      const body = await rq.readBody();
      const agentToken = String(rq.req.headers['x-agent-token'] ?? '').trim();
      const voice = b.voiceCfg();
      // 这条是给人用的：不看「AI 能否发语音」那个总开关
      // /api/send/voice 是给 AI 的入口，带了 AI 令牌就不许走这里
      if (rq.url.pathname === '/api/send/voice' && agentToken) {
        rq.sendJson({
          ok: false,
          error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）'
        }, 403);
        return;
      }
      const key = String(body.target ?? body.key ?? '').trim();
      const parsedTarget = parseTargetKey(key);
      if (!parsedTarget) { rq.sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      if (!b.modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), b.cfg, b.currentMode)) {
        const a = b.cfg.allow ?? {};
        rq.sendJson({
          ok: false,
          error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
        }, 403);
        return;
      }
      let resolved;
      try {
        resolved = b.resolveVoicePathForOperator(body.file ?? body.path ?? '');
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        return;
      }
      // 音量先检查一下，写错了马上说，别等到发的时候才报错
      try {
        resolveAudioProcessing({
          volume: body.volume ?? voice.defaultVolume,
          normalize: body.normalize === true,
          loudness: body.loudness ?? voice.loudness
        });
      } catch (error) {
        rq.sendJson({ ok: false, error: error.message }, 400);
        return;
      }
      const probe = await b.inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
      if (!probe.ok) { rq.sendJson({ ok: false, error: probe.error }, 400); return; }
      const preview = {
        key,
        file: resolved.path,
        via: resolved.via,
        bytes: probe.size,
        duration: probe.duration,
        codec: probe.codec,
        detail: describeAudio(probe),
        warnings: probe.warnings ?? [],
        limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
      };
      if (body.dryRun === true) { rq.sendJson({ ok: true, dryRun: true, ...preview }); return; }
      const now = Date.now();
      try {
        b.voiceBudgetCheck('operator:cli', voice);
        const sent = await b.sendVoiceV2(key, resolved.path, {
          guard: false,
          audit: true,
          audio: {
            volume: body.volume ?? voice.defaultVolume,
            normalize: body.normalize === true,
            loudness: body.loudness ?? voice.loudness
          }
        });
        b.voiceBudgetCommit('operator:cli', now);
        b.log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
        b.appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
      // 默认要确认真的发出去了，只有做实验时才回读文字
        const verification = body.verify === false ? null : await b.verifyVoiceMessageSent(sent.messageId);
        let readbackText = null;
        if (body.readback === true && sent.messageId) {
          try {
            const httpUrl = String(b.cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const res = await b.fetch(`${httpUrl}/fetch_ptt_text`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(b.cfg.snowluma?.accessToken ? { authorization: `Bearer ${b.cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify({ message_id: String(sent.messageId) }),
              signal: AbortSignal.timeout(30000)
            });
            const rb = await res.json().catch(() => ({}));
            if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
          } catch (error) {
            b.log(`[voice] 转写回读失败：${error?.message ?? error}`);
          }
        }
        rq.sendJson({
          ok: true,
          ...preview,
          messageId: sent.messageId,
          verified: verification?.confirmed === true,
          readback: readbackText,
          audioProcessing: sent.audioProcessing,
          volume: sent.volume,
          loudness: sent.loudness
        });
      } catch (error) {
        if (error instanceof b.VoiceRateLimitError) {
          rq.sendJson({ ok: false, error: error.message }, 429);
          return;
        }
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return;
    }

    // ── 语音发送（AI 发的，只能发自己那个聊天） ──
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/send-voice') {
      const body = await rq.readBody();
      const token = String(body.token ?? rq.req.headers['x-agent-token'] ?? '').trim();
      const key = String(body.key ?? body.target ?? '').trim();
      const voice = b.voiceCfg();
      if (!voice.enabled) { rq.sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
      if (b.currentMode !== 'reserved2') { rq.sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
      if (!token) { rq.sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
      if (!b.agentTokenOk(key, token)) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (!b.v2ToolEnabled('sendVoice')) { rq.sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
      if (!b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (b.shouldBlockSilentReply(key)) { rq.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      // 只取文件名不取内容；试发也要和真发一样检查一遍
      let resolved;
      try {
        resolved = b.resolveVoicePathForV2(body.voice ?? body.file ?? '');
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        return;
      }
      try {
        b.voiceBudgetCheck(key, voice);
        if (body.dryRun === true) {
          const probe = await b.inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { rq.sendJson({ ok: false, error: probe.error }, 400); return; }
          rq.sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
          return;
        }
        const sent = await b.sendVoiceForV2(key, body.voice ?? body.file, {
          label: body.label ? String(body.label).slice(0, 100) : '',
          verify: body.verify,
          readback: body.readback === true,
          // AI 也可以调音量（默认走 config 的 defaultVolume）
          audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
            ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
            : null
        });
        rq.sendJson({
          ok: true,
          key,
          messageId: sent.messageId,
          file: path.basename(sent.file),
          detail: sent.detail,
          audioProcessing: sent.audioProcessing,
          // verified=true 表示真的查到了这条消息，不是猜的
          verified: sent.verification?.confirmed === true,
          readback: sent.readback,
          warnings: sent.warnings
        });
      } catch (error) {
        // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
        if (error instanceof b.VoiceRateLimitError) {
          rq.sendJson({ ok: false, error: error.message }, 429);
          return;
        }
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return;
    }

    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/send-sticker') {
      if (!b.stickerEnabled()) { rq.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      const caption = String(body.message ?? body.caption ?? '').trim();
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      if (!key || !stickerId) { rq.sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
      // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
      if (caption) {
        rq.sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
        return;
      }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('sendSticker')) { rq.sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
      if (b.currentMode !== 'reserved2' && !rq.closedAgentMedia) { rq.sendJson({ ok: false, error: '该接口仅 reserved2 或管理员私聊模式可用' }, 403); return; }
      if (!rq.req.headers['x-agent-token']) { rq.sendJson({ ok: false, error: '发送表情必须携带 agent token' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !b.modeAllowed(key, kind, id, b.cfg, b.currentMode)) {
        rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (kind === 'private' && atUserId) { rq.sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
      if (b.shouldBlockSilentReply(key)) { rq.sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        rq.sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return;
      }
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const stForReply = b.getSocialV2State(key);
        const resolved = await b.resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          rq.sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
          return;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      const sendCfg = b.cfg.socialV2?.send ?? {};
      const now = Date.now();
      try {
        const st = b.getSocialV2State(key);
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
        const sent = await b.sendStickerV2(key, stickerId, {
          replyToMessageId: actualReplyToMessageId,
          atUserId
        });
        // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
        const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
        const text = `[表情包:${label}]`;
        st.recentMessages.push({
          messageId: sent.messageId ? String(sent.messageId) : null,
          sender: '我',
          text: truncateText(text, 200),
          plain: truncateText(text, 200),
          quoteTargetIsSelf: false,
          isOwner: false,
          ownerLabel: '',
          isSelf: true,
          media: [],
          hasMedia: false,
          forwardIds: [],
          hasForward: false,
          sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
          time: Date.now()
        });
        const recentLimit = Number(b.cfg.socialV2?.context?.recentLimit) || 100;
        if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        b.saveSocialV2State();
        b.scheduleReplyCheckV2(key);
        b.log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
        b.appendActivity(`${key} [sticker] 工具发送表情：${label}`);
        rq.sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
      } catch (error) {
        const st = b.getSocialV2State(key);
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        b.saveSocialV2State();
        b.log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
        rq.sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/collect-sticker') {
      if (!b.stickerEnabled()) { rq.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const messageRef = String(body.messageId ?? body.seq ?? '').trim();
      const remark = String(body.remark ?? '').trim();
      if (!key || !messageRef) { rq.sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('collectSticker')) { rq.sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { rq.sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const st = b.getSocialV2State(key);
      const collectCfg = b.cfg.socialV2?.sticker?.collect ?? {};
      if (collectCfg.enabled === false) { rq.sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
      const now = Date.now();
      const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
      const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
      const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        rq.sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
        return;
      }
      // 先把次数占上，免得同时点很多下绕过限制；失败再退回来
      st.stickerCollectTimes = st.stickerCollectTimes || [];
      st.stickerCollectTimes.push(now);
      if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
      try {
        const result = await b.collectStickerV2(key, messageRef, remark);
        b.saveSocialV2State();
        b.log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
        b.appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
        rq.sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
      } catch (error) {
        const idx = st.stickerCollectTimes.indexOf(now);
        if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
        if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
        b.saveSocialV2State();
        b.log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
        rq.sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 语音库列表：AI 调用要带 key 并检查权限，人调用不用
    // 只返回文件名、大小和时长，不暴露电脑上的完整路径
    if (rq.req.method === 'GET' && (rq.url.pathname === '/api/socialV2/voices' || rq.url.pathname === '/api/voice/list')) {
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const voice = b.voiceCfg();
      const agentCall = Boolean(rq.req.headers['x-agent-token']);
      // voice.enabled 只关 AI 这条道，控制台仍然能查看语音库
      if (agentCall && !voice.enabled) { rq.sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
      if (agentCall && !key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (agentCall && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (agentCall && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (agentCall && !b.v2ToolEnabled('sendVoice')) { rq.sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
      const wantProbe = rq.url.searchParams.get('probe') !== '0';
      try {
        const files = listAudioFiles(voice.dir);
        const items = [];
        for (const f of files.slice(0, 100)) {
          const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
          if (wantProbe) {
            const info = await b.inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
            entry.ok = info.ok;
            entry.bytes = info.size;
            entry.detail = info.ok ? describeAudio(info) : null;
            entry.seconds = info.duration ?? null;
            if (!info.ok) entry.error = info.error;
          }
          items.push(entry);
        }
        rq.sendJson({
          ok: true,
          key: key || null,
          dir: agentCall ? undefined : voice.dir,
          count: items.length,
          voices: items,
          limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
          // 提示里也别放完整路径，AI 那边要保密
          hint: items.length
            ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
            : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
        });
      } catch (error) {
        rq.sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
      }
      return;
    }

    if (rq.req.method === 'GET' && rq.url.pathname === '/api/socialV2/sticker-list') {
      if (!b.stickerEnabled()) { rq.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
      const key = String(rq.url.searchParams.get('key') ?? '').trim();
      const query = String(rq.url.searchParams.get('query') ?? '').trim();
      const maxCount = Math.max(1, Number(b.cfg.socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(rq.url.searchParams.get('count')) || 48, maxCount)));
      // 这里不支持强制刷新，因为刷新要写文件；要刷新请用 POST
      const force = false;
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('listStickers')) { rq.sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
      try {
        const synced = await b.syncStickerLibrary(force);
        const list = formatStickerList(synced?.entries ?? b.stickerEntries, query, count, key);
        rq.sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? b.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
      } catch (error) {
        rq.sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/sticker-list') {
      if (!b.stickerEnabled()) { rq.sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const query = String(body.query ?? '').trim();
      const maxCount = Math.max(1, Number(b.cfg.socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
      let force = body.refresh === true;
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('listStickers')) { rq.sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
      // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
      if (rq.req.headers['x-agent-token'] && force) {
        const now = Date.now();
        if (now - b.lastForcedAgentStickerSync < 10000) force = false;
        else b.lastForcedAgentStickerSync = now;
      }
      try {
        const synced = await b.syncStickerLibrary(force);
        const list = formatStickerList(synced?.entries ?? b.stickerEntries, query, count, key);
        rq.sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? b.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
      } catch (error) {
        rq.sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 管理端表情库接口（控制台）
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/stickers') {
      const query = String(rq.url.searchParams.get('query') ?? '').trim();
      const maxCount = Math.max(1, Number(b.cfg.socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(rq.url.searchParams.get('count')) || 48, maxCount)));
      // 读取不会顺便刷新，要刷新请用 POST /api/stickers/sync
      try {
        const synced = await b.syncStickerLibrary(false);
        const list = formatStickerList(synced?.entries ?? b.stickerEntries, query, count);
        rq.sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? b.stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: b.stickerStoreWritable });
      } catch (error) {
        rq.sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/stickers/sync') {
      try {
        const synced = await b.syncStickerLibrary(true);
        rq.sendJson({ ok: true, total: synced?.entries?.length ?? b.stickerEntries.length, syncedAt: synced?.syncedAt ?? b.stickerSyncedAt });
      } catch (error) {
        rq.sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/stickers/note') {
      const body = await rq.readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
      const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
      const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
      if (!stickerId) { rq.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
      const entry = b.applyStickerNoteV2(stickerId, note, tags, usage);
      if (!entry) { rq.sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
      rq.sendJson({ ok: true, sticker: entry });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/stickers/remark') {
      const body = await rq.readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!stickerId) { rq.sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
      try {
        const entry = await b.setStickerRemarkV2(stickerId, String(body.remark ?? ''));
        rq.sendJson({ ok: true, sticker: entry });
      } catch (error) {
        rq.sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/wait') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { rq.sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
        rq.sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
        return;
      }
      const replyWait = body.purpose === 'reply';
      if (rq.req.headers['x-agent-token'] && !b.agentTokenOk(key, rq.req.headers['x-agent-token'])) { rq.sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2SessionAllowed(key)) { rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
      if (rq.req.headers['x-agent-token'] && !b.v2ToolEnabled('waitMessages')) { rq.sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
      if (b.socialV2.paused) {
        const st = b.getSocialV2State(key);
        rq.sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: b.readThroughSeqV2(st), unreadCount: st.unread.length });
        return;
      }
      const waitCfg = b.cfg.socialV2?.wait ?? {};
      const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
      const defaultMs = Number(waitCfg.defaultMs) || 30000;
      const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
      const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
      const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
      const st = b.getSocialV2State(key);
      // 同一个聊天同时只允许一个等待，免得请求越积越多
      // 超时的旧记录算作残留，允许新等待顶替，不会一直拒绝
      const leaseKey = canonicalV2Key(key) ?? key;
      if (b.activeWaits.has(leaseKey) && Date.now() - b.activeWaits.get(leaseKey) < b.ACTIVE_WAIT_LEASE_MS) {
        // 告诉它还要等多久，否则它会马上重试、白白烧钱
        const waitUntil = b.activeWaits.get(leaseKey) + b.ACTIVE_WAIT_LEASE_MS;
        rq.sendJson({
          ok: false,
          error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束；不要立刻重试（重试只会再拿到同样的拒绝）。',
          retryAfterMs: Math.max(0, waitUntil - Date.now()),
          hint: '若你只是要完成沉睡前观察：静候即可，观察窗口会随时间自然届满，不需要再发等待。'
        }, 429);
        return;
      }
      const leaseStamp = Date.now();
      b.activeWaits.set(leaseKey, leaseStamp);
      // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
      const finishWait = () => { if (b.activeWaits.get(leaseKey) === leaseStamp) b.activeWaits.delete(leaseKey); };
      rq.req.on('close', finishWait);
      // 出错时也要清掉记录，不然会留下一条假的「正在等待」
      rq.res.on('close', finishWait);
      const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
      const suggestedQuietMs = Math.max(b.suggestQuietMsV2(st), minQuietAfterNewMs);
      const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
      // 收到新消息后至少再等 10 秒，别人才不会觉得被抢话
      // 等待时间也有上限，免得请求一直不返回
      const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
      const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
      if (st.pendingWakeTimer) {
        b.clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      b.cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
      // 回复前的等待也要算上模型刚才思考时收到的消息
      const requestSeq = st.lastUnreadSeq || 0;
      const baseline = replyWait && (b.v2ToolEnabled('getUnread') || b.v2ToolEnabled('getRecent')) ? b.readThroughSeqV2(st) : requestSeq;
      const start = Date.now();
      let arrived = false;
      let lastNewAt = 0;
      let aborted = false;
      rq.req.on('close', () => { aborted = true; });
      if (replyWait) {
        // 取最后一条消息到达的时间
        const incomingAt = () => {
          const value = Number(st.lastIncomingAt);
          return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
        };
        lastNewAt = incomingAt();
        let observedSeq = st.lastUnreadSeq || 0;
        // 新的消息会让安静重新计时，但总时长不能超过上限
        while (!aborted && Date.now() - start < timeoutMs) {
          if ((st.lastUnreadSeq || 0) !== observedSeq) {
            observedSeq = st.lastUnreadSeq || 0;
            lastNewAt = incomingAt();
          }
          const remaining = quietMs - (Date.now() - lastNewAt);
          if (remaining <= 0) break;
          await b.sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
        }
        // 最后那一下等待里也可能来消息，要重新看有没有新消息
        lastNewAt = incomingAt();
        arrived = (st.lastUnreadSeq || 0) > baseline;
      } else while (Date.now() - start < timeoutMs && !aborted) {
        let nowSeq = st.lastUnreadSeq || 0;
        if (nowSeq - baseline >= minNew) {
          arrived = true;
          lastNewAt = Date.now();
          // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
          // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
          while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
            if ((st.lastUnreadSeq || 0) > nowSeq) {
              nowSeq = st.lastUnreadSeq || 0;
              lastNewAt = Date.now();
            }
            await b.sleep(200);
          }
          break;
        }
        await b.sleep(300);
      }
      const waitedMs = Date.now() - start;
      if (b.socialV2.conversations.get(canonicalV2Key(key)) !== st ||
          (rq.req.headers['x-agent-token'] && (b.currentMode !== 'reserved2' || b.socialV2.paused || b.cfg.socialV2?.enabled === false
            || !b.agentTokenOk(key, rq.req.headers['x-agent-token']) || !b.v2SessionAllowed(key) || !b.v2ToolEnabled('waitMessages')))) {
        finishWait();
        rq.sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
        return;
      }
      const preSleepWaitMs = Math.max(0, Number(b.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      // 只判断一次能不能收尾，后面几处都用这个结果
      const preSleepBlocked = b.preSleepWaitBlockedV2(st);
      const preSleepRemainingMs = preSleepBlocked
        ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
        : 0;
      // 一次等满观察时间才算观察，所以直接告诉模型够不够
      const preSleepCountsAsObservation = !replyWait && timeoutMs >= preSleepWaitMs;
      const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
      // 这次等待是不是想完成「睡前观察」：要一次等满观察时间
      // 只有这种等待里来了新消息，才记下「已观察」，允许它直接睡
      const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
      // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
      // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
      const preSleepSatisfiedNow = !replyWait && (!arrived
        ? waitedMs >= preSleepWaitMs
        : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
      if (preSleepSatisfiedNow) {
        st.preSleepWaitSatisfiedAt = Date.now();
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
      } else if (!replyWait && !arrived) {
        // 短时间等待不算数，必须一次等满观察时间
        st.preSleepWaitAccumMs = 0;
      } else if (!replyWait) {
        // 等待期间有新消息：是一次完整的观察就记下「已观察」
        // 其他情况只把累计清零，不算完成观察
        if (preSleepAttempt) {
          st.preSleepWaitObservedAt = Date.now();
        }
        st.preSleepWaitAccumMs = 0;
      }
      if (!replyWait) b.saveSocialV2State();
      // 哪个工具被关掉，就先把对应的消息丢掉，不能从别处漏出来
      const history = replyWait
        ? [...(b.v2ToolEnabled('getUnread') ? st.unread : []),
          ...(b.v2ToolEnabled('getRecent') ? st.recentMessages : [])]
        : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
      // ── 补回之前漏掉的消息 ──
      //
      // 以前只返回请求之后才来的消息，模型思考时来的会漏掉
      // 漏掉的那些还卡住已读位置，之后怎么也读不到
      // 现在改成：凡是还没算已读的消息，这次都一起给它
      const watermarkAtRequest = b.readThroughSeqV2(st);
      const pendingFloor = Math.min(baseline, watermarkAtRequest);
      const fullPending = [...new Map(history
        .filter((m) => m && !m.isSelf && (m.seq || 0) > pendingFloor)
        .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
      // 一次给太多会把 AI 的对话空间撑爆，所以从最老的开始给
      // 被截断时告诉模型还有旧的，可以用 unread 接着读
      const waitCap = Math.min(50, Math.max(12, Number(b.cfg.socialV2?.context?.unreadLimit) || 30));
      const pending = fullPending.length > waitCap ? fullPending.slice(0, waitCap) : fullPending;
      const pendingTruncated = fullPending.length > pending.length;
      // 要不要报「有新消息」，按这次真正能交出去的内容算
      const newMessages = replyWait ? pending : (arrived ? pending : []);
      const readThroughSeq = rq.req.headers['x-agent-token'] ? b.noteModelMessagesV2(st, newMessages) : b.readThroughSeqV2(st);
      const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
        : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
      const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
      finishWait();
      rq.sendJson({
        ok: true,
        key,
        purpose: replyWait ? 'reply' : 'messages',
        arrived,
        quiet,
        quietMs,
        suggestedQuietMs,
        speakerLikelyDone: quiet,
        lastMessageUnfinished,
        timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
        waitedMs,
        preSleepWaitSatisfied: preSleepSatisfiedNow,
        preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
        // 被截断时告诉它还有旧的没给，可以去 unread 接着读
        ...(pendingTruncated ? { partial: true } : {}),
        // 回复前的等待没有睡眠倒计时，所以别显示这类提示
        ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
        // ── 直接告诉它现在能不能收尾、该怎么做 ──
        // 只给剩余秒数它会自己算错，所以把该调的参数也写清楚
        // 只有真的可以收尾时才说可以，免得它提前尝试被拒绝
        ...(!replyWait ? {
          canSleepNow: !preSleepBlocked,
          countsAsObservation: preSleepCountsAsObservation,
          hint: preSleepBlocked
            ? `还不能收尾：还需约 ${Math.ceil(preSleepRemainingMs / 1000)} 秒没有新消息。要完成沉睡前观察，请用 qq_wait_for_messages(timeoutMs=${preSleepWaitMs}) 一次等满——更短的 timeoutMs 不算观察，满足不了闸门（本次 ${Math.round(timeoutMs)}ms ${preSleepCountsAsObservation ? '达标' : '不达标'}）。`
            : '现在可以直接收尾：qq_mark_read(throughSeq=已读水位) 或 qq_set_wake_config(throughSeq=已读水位, config=…)。不用再等一轮。'
        } : {}),
        newMessages,
        readThroughSeq,
        unreadCount: st.unread.length
      });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/socialV2/check-send') {
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      const tool = String(body.tool ?? '').trim();
      const token = String(body.token ?? '').trim();
      if (!key || !tool || !token) {
        rq.sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
        return;
      }
      if (!b.agentTokenOk(key, token)) {
        rq.sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (!b.v2SessionAllowed(key)) {
        rq.sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
      const flag = flagMap[tool];
      if (!flag) {
        rq.sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
        return;
      }
      if (!b.v2ToolEnabled(flag)) {
        rq.sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
        return;
      }
      rq.sendJson({ ok: true, key, tool });
      return;
    }
    return ROUTE_NEXT;
  };
}
