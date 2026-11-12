// 黑话学习会话、抽取与研究
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../../dsh-client.js';
import { canonicalV2Key } from '../../policy/access.js';
import { SLANG_MAX_ENTRIES, normalizeSlangScope, buildExtractionPrompt, parseExtractionJson, upsertSlangEntry, SLANG_STATUS, buildResearchPrompt, parseResearchJson } from '../../slang-learner.js';
import { readJsonSafe, atomicWriteJson } from '../../store/fs-atomic.js';

// 创建黑话学习模块
export function createSlangLearning(b) {
  // 本模块持有的内存状态，其它模块经 b 读取
  const slangResearchingIds = new Set(); // 研究中的候选 id，防止重复排队
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  // 保存黑话库；只能读时不写，超过上限就裁掉
  function saveSlangStore() {
    if (!b.slangStoreWritable) {
      b.log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = b.saveSlangEntries(b.slangEntries);
      if (result?.dropped > 0) {
        b.slangEntries = result.entries;
        b.log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { b.log('保存黑话库失败:', error?.message ?? error); }
  }

  // 串行执行黑话学习任务
  function queueSlangTask(fn) {
    b.slangTaskChain = b.slangTaskChain.then(fn).catch((error) => b.log('黑话学习任务异常:', error?.message ?? error));
    return b.slangTaskChain;
  }

  const parkedSessions = new Map(); // 范围 -> 暂存的学习会话（存到硬盘，重启后再用）
  const MAX_PARKED_SESSIONS = 8;
  let parkedLoaded = false;
  let filePreset = null; // slang-session.json 所属的 preset

  // 把学习会话写进 slang-session.json 文件
  function writeSessionFile(preset, scope) {
    filePreset = preset;
    fs.mkdirSync(b.STATE_DIR, { recursive: true });
    const doc = { preset, parked: Object.fromEntries(parkedSessions) };
    if (b.slangLearnerSessionId) Object.assign(doc, { sessionId: b.slangLearnerSessionId, scope });
    atomicWriteJson(b.SLANG_SESSION_FILE, doc);
  }

  // 取或建这个范围的学习会话，预设名必须先检查
  async function ensureSlangLearnerSession(scope = 'global') {
    const learnerScope = normalizeSlangScope(scope);
    const preset = b.resolvePresetName(b.cfg.slang?.learnerPreset || b.cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(b.SLANG_SESSION_FILE, null);
    // 退役一个学习会话
    const retire = (id) => {
      if (!learnerWaiters.has(id) && !learnerCollectors.has(id)) b.api.events.forget?.(String(id));
      b.stopRetiredSessionWork(String(id), 'slang');
    };
    if (!parkedLoaded) {
      parkedLoaded = true;
      for (const [k, id] of Object.entries(saved?.parked ?? {})) if (id) parkedSessions.set(k, String(id));
    }
    if (saved?.preset !== preset) {
      // 旧记录无 preset 或 preset 已换，无法证明权限：全部作废重建
      const oldId = b.slangLearnerSessionId || saved?.sessionId;
      for (const id of parkedSessions.values()) retire(id);
      parkedSessions.clear();
      invalidateSlangLearnerSession();
      if (oldId) retire(oldId);
    } else if (saved.scope !== learnerScope) {
      // 换范围时先把旧会话存起来，不同范围互不串话
      const oldId = b.slangLearnerSessionId || saved.sessionId;
      if (oldId) {
        parkedSessions.set(saved.scope, String(oldId));
        // 停放期间不订阅事件流，复用时重新 follow
        if (!learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
          b.learnerSessions.delete(oldId);
          b.api.events.forget?.(String(oldId));
        }
      }
      if (parkedSessions.size > MAX_PARKED_SESSIONS) {
        const [oldestScope, oldestId] = parkedSessions.entries().next().value;
        parkedSessions.delete(oldestScope);
        retire(oldestId);
      }
      const reuse = parkedSessions.get(learnerScope);
      parkedSessions.delete(learnerScope);
      b.slangLearnerSessionId = reuse ?? null;
      writeSessionFile(preset, learnerScope);
      if (reuse) await b.ensureChatModel(reuse);
    }
    if (b.slangLearnerSessionId) {
      b.learnerSessions.add(b.slangLearnerSessionId);
      b.api.events.follow(b.slangLearnerSessionId);
      return b.slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset && saved.scope === learnerScope) {
      filePreset = preset;
      b.slangLearnerSessionId = String(saved.sessionId);
      b.learnerSessions.add(b.slangLearnerSessionId);
      b.api.events.follow(b.slangLearnerSessionId);
      await b.ensureChatModel(b.slangLearnerSessionId);
      return b.slangLearnerSessionId;
    }
    const dir = path.join(b.STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await b.api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = b.cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await b.api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await b.api.sessions.create(params), 'slang session.create');
    b.slangLearnerSessionId = value.sessionId;
    b.learnerSessions.add(b.slangLearnerSessionId);
    b.api.events.follow(b.slangLearnerSessionId);
    await b.ensureChatModel(b.slangLearnerSessionId);
    writeSessionFile(preset, learnerScope);
    b.log(`黑话学习会话已创建：${b.slangLearnerSessionId}`);
    return b.slangLearnerSessionId;
  }

  // 作废当前学习会话
  function invalidateSlangLearnerSession() {
    // 旧会话还在等待/收集中时先保留，否则移除
    const oldId = b.slangLearnerSessionId;
    b.slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      b.learnerSessions.delete(oldId);
      b.api.events.forget?.(oldId);
      b.modelAppliedSessions.delete(oldId);
    }
    // 还有停放会话就保留文件，免得重启后成孤儿；否则删文件
    if (parkedSessions.size && filePreset) {
      try { writeSessionFile(filePreset); } catch (error) { b.log('保存学习会话停放表失败:', error?.message ?? error); }
    } else {
      try { fs.unlinkSync(b.SLANG_SESSION_FILE); } catch {}
    }
  }

  // 等待学习会话的下一轮结果，超时拒绝
  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = b.setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  // 从会话窗口抽取黑话候选
  async function runSlangExtraction(key) {
    if (b.cfg.slang?.enabled === false) return;
    if (!b.dshReady) return;
    const messages = b.slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(b.cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession(key);
    } catch (error) {
      b.log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await b.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        b.log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        b.log(`黑话提取：${key} 未发现候选`);
        const win = b.slangWindows.get(key) ?? [];
        b.slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(b.cfg.slang?.inferenceThresholds) ? b.cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(b.slangEntries, item.content, { evidence, countIncrement: 1, scope: canonicalV2Key(key) || 'global' });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = b.slangWindows.get(key) ?? [];
      b.slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      b.log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && b.cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      b.log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  // 研究候选黑话的含义
  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (b.cfg.slang?.enabled === false) return;
    if (!b.dshReady) return;
    // 按会话分批，证据和模型历史不跨会话
    const batches = new Map();
    for (const entry of candidates) {
      if (!entry) continue;
      const scope = normalizeSlangScope(entry.scope);
      if (!batches.has(scope)) batches.set(scope, []);
      batches.get(scope).push(entry);
    }
    if (batches.size > 1) {
      for (const batch of batches.values()) await runSlangResearch(batch);
      return;
    }
    // 跳过已在研究队列里的候选
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession(targets[0].scope);
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      b.log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets);
    try {
      const accepted = await b.api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        b.log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const results = parseResearchJson(output);
      for (const r of results) {
        const target = targets.find((e) => e.content === r.content);
        const entry = target && b.slangEntries.find((e) => e.id === target.id
          && normalizeSlangScope(e.scope) === normalizeSlangScope(target.scope));
        if (!entry) continue;
        // 只有 confirmed: true 才写解释，否则保留原状待再研究
        if (r.confirmed !== true) {
          b.log(`黑话研究：${r.content} 未确认，保留候选待后续研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
      }
      saveSlangStore();
      b.log(`黑话研究：已更新 ${results.length} 条候选解释`);
    } catch (error) {
      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      b.log('黑话研究失败:', error?.message ?? error);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  return {
    slangResearchingIds, learnerCollectors, learnerWaiters, saveSlangStore, queueSlangTask, ensureSlangLearnerSession, invalidateSlangLearnerSession, waitLearnerTurn, runSlangExtraction, runSlangResearch };
}
