// 控制台黑话库路由（操作者通道）；鉴权在分发前完成
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import path from 'node:path';
import { createSlangEntry, SLANG_STATUS, normalizeSlangScope } from '../../../slang-learner.js';
import { readConfigObject, atomicWriteJson } from '../../../store/fs-atomic.js';

// 创建黑话库路由；未命中返回 ROUTE_NEXT
export function createConsoleSlangRoutes(b) {
  return async function consoleSlangRoutes(rq) {
    // ── 黑话库管理 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/slang') {
      const status = rq.url.searchParams.get('status') || '';
      const list = status ? b.slangEntries.filter((e) => e.status === status) : b.slangEntries;
      rq.sendJson({ entries: list, config: b.cfg.slang, writable: b.slangStoreWritable });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang') {
      const body = await rq.readBody();
      const content = String(body.content ?? '').trim();
      if (!content) { rq.sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
      if (b.slangEntries.some((e) => e.content === content && normalizeSlangScope(e.scope) === 'global')) { rq.sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
      const entry = createSlangEntry({
        content,
        meaning: String(body.meaning ?? '').trim(),
        usage: String(body.usage ?? '').trim(),
        example: String(body.example ?? '').trim(),
        risk: String(body.risk ?? '').trim(),
        sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
        status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
        source: 'manual',
        evidence: Array.isArray(body.evidence) ? body.evidence : []
      });
      b.slangEntries.push(entry);
      b.saveSlangStore();
      b.log(`控制台：新增黑话「${content}」`);
      rq.sendJson({ ok: true, entry });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang/clear') {
      const body = await rq.readBody();
      const status = String(body.status ?? '').trim();
      if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
        rq.sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
        return;
      }
      let removedCount = 0;
      if (status) {
        removedCount = b.slangEntries.filter((e) => e.status === status).length;
        b.slangEntries = b.slangEntries.filter((e) => e.status !== status);
      } else {
        removedCount = b.slangEntries.length;
        b.slangEntries = [];
        // 清空时同步清掉待提取窗口和冷却，防止删了又回来
        b.slangWindows.clear();
        b.slangExtractionCooldowns.clear();
        b.slangSubmitTimes.clear();
        b.slangResearchingIds.clear();
      }
      b.saveSlangStore();
      b.log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
      rq.sendJson({ ok: true, removedCount });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang/batch-delete') {
      const body = await rq.readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const status = String(body.status ?? '').trim();
      if (ids.length) {
        const idSet = new Set(ids);
        const before = b.slangEntries.length;
        b.slangEntries = b.slangEntries.filter((e) => !idSet.has(e.id));
        const removedCount = before - b.slangEntries.length;
        if (!removedCount) { rq.sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
        b.saveSlangStore();
        b.log(`控制台：批量删除黑话 ${removedCount} 条`);
        rq.sendJson({ ok: true, removedCount });
        return;
      }
      if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
        rq.sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
        return;
      }
      if (!status) { rq.sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
      const removedCount = b.slangEntries.filter((e) => e.status === status).length;
      b.slangEntries = b.slangEntries.filter((e) => e.status !== status);
      b.saveSlangStore();
      b.log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
      rq.sendJson({ ok: true, removedCount });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang/batch-confirm') {
      const body = await rq.readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { rq.sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
      let confirmedCount = 0;
      let skippedCount = 0;
      const skipped = [];
      for (const id of ids) {
        const idx = b.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
        const entry = b.slangEntries[idx];
        if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
        if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
        entry.status = SLANG_STATUS.CONFIRMED;
        entry.updatedAt = new Date().toISOString();
        confirmedCount++;
      }
      if (confirmedCount) b.saveSlangStore();
      b.log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
      rq.sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang/batch-reject') {
      const body = await rq.readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { rq.sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
      let rejectedCount = 0;
      for (const id of ids) {
        const idx = b.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) continue;
        const entry = b.slangEntries[idx];
        if (entry.status === SLANG_STATUS.REJECTED) continue;
        entry.status = SLANG_STATUS.REJECTED;
        entry.updatedAt = new Date().toISOString();
        rejectedCount++;
      }
      if (rejectedCount) b.saveSlangStore();
      b.log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
      rq.sendJson({ ok: true, rejectedCount });
      return;
    }
    const slangMatch = rq.url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
    if (rq.req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
      const id = slangMatch[1];
      const idx = b.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { rq.sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
      const body = await rq.readBody();
      const entry = { ...b.slangEntries[idx] };
      if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
      if (body.content !== undefined && b.slangEntries.some((e) => e.id !== id && e.content === entry.content
          && normalizeSlangScope(e.scope) === normalizeSlangScope(entry.scope))) {
        rq.sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
        return;
      }
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
      if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
      if (!entry.content) { rq.sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
      entry.updatedAt = new Date().toISOString();
      b.slangEntries[idx] = entry;
      b.saveSlangStore();
      b.log(`控制台：更新黑话「${entry.content}」`);
      rq.sendJson({ ok: true, entry });
      return;
    }
    if (rq.req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
      const id = slangMatch[1];
      const idx = b.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { rq.sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
      const body = await rq.readBody();
      const entry = b.slangEntries[idx];
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
      if (!entry.meaning) {
        rq.sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
        return;
      }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      b.saveSlangStore();
      b.log(`控制台：确认黑话「${entry.content}」`);
      rq.sendJson({ ok: true, entry });
      return;
    }
    if (rq.req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
      const id = slangMatch[1];
      const idx = b.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { rq.sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
      const entry = b.slangEntries[idx];
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      b.saveSlangStore();
      b.log(`控制台：拒绝黑话「${entry.content}」`);
      rq.sendJson({ ok: true, entry });
      return;
    }
    if (rq.req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
      const id = slangMatch[1];
      const idx = b.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { rq.sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
      const [removed] = b.slangEntries.splice(idx, 1);
      b.saveSlangStore();
      b.log(`控制台：删除黑话「${removed.content}」`);
      rq.sendJson({ ok: true, removed });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang/extract') {
      if (b.cfg.slang?.enabled === false) { rq.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
      const body = await rq.readBody();
      const key = String(body.key ?? '').trim();
      if (key && b.slangWindows.has(key)) {
        b.queueSlangTask(() => b.runSlangExtraction(key));
        rq.sendJson({ ok: true, key });
      } else {
        const firstKey = b.slangWindows.keys().next().value;
        if (!firstKey) { rq.sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
        b.queueSlangTask(() => b.runSlangExtraction(firstKey));
        rq.sendJson({ ok: true, key: firstKey });
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang/research') {
      if (b.cfg.slang?.enabled === false) { rq.sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
      const body = await rq.readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const candidates = ids.length
        ? b.slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
        : b.slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
      if (!candidates.length) { rq.sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
      b.queueSlangTask(() => b.runSlangResearch(candidates));
      rq.sendJson({ ok: true, count: candidates.length });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/slang/config') {
      const body = await rq.readBody();
      const oldPreset = b.cfg.slang?.learnerPreset;
      const oldWorkspaceTitle = b.cfg.slang?.workspaceTitle;
      const configFile = path.join(b.ROOT, 'config.json');
      const file = readConfigObject(configFile);
      const merged = { ...(file.slang ?? {}), ...body };
      if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
      else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
      if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
      if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
      if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
      if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
      if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
      if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
      if (body.inferenceThresholds !== undefined) {
        const raw = Array.isArray(body.inferenceThresholds)
          ? body.inferenceThresholds
          : String(body.inferenceThresholds).split(/[,，\s]+/);
        merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
        if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
      }
      file.slang = merged;
      atomicWriteJson(configFile, file);
      b.cfg.slang = { ...b.cfg.slang, ...merged };
      if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
        b.invalidateSlangLearnerSession();
        b.log('黑话学习 preset 已变更，已重置学习会话');
      } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
        b.invalidateSlangLearnerSession();
        b.log('黑话学习工作区名已变更，已重置学习会话');
      }
      b.log('控制台：黑话系统配置已更新');
      rq.sendJson({ ok: true, config: b.cfg.slang });
      return;
    }
    return ROUTE_NEXT;
  };
}
