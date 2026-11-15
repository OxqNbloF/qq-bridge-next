import path from 'node:path';
import crypto from 'node:crypto';
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import { loadConfig } from '../../../infra/config.js';
import { migrateLegacyConfig } from '../../../infra/legacy-config.js';
import { readConfigObject, atomicWriteJson } from '../../../store/fs-atomic.js';
import { canonicalV2Key } from '../../../policy/access.js';

export function createConsoleSystemRoutes(b) {
  return async function consoleSystemRoutes(rq) {
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/console/system') {
      const toolResults = b.readToolLog(200).filter((entry) => entry.type === 'result');
      const failedTools = toolResults.filter((entry) => entry.ok === false).length;
      const keys = [...new Set([...Object.keys(b.state.sessions), ...b.socialV2.conversations.keys(), ...Object.keys(b.listConversationOverrides().conversations)])];
      rq.sendJson({ ok: true, tools: { sample: toolResults.length, failed: failedTools, failureRate: toolResults.length ? failedTools / toolResults.length : null }, health: { dsh: b.dshReady, snowluma: b.snowlumaHealthSnapshot() }, scheduler: b.schedulerDiagnostics(),
        queues: [...b.queued].map(([key, items]) => ({ key, depth: items.length })),
        memory: { enabled: b.cfg.memory.enabled, archive: b.cfg.archive.enabled, cursors: keys.map((key) => ({ key, cursor: b.compressCursor.get(key), lastSeq: b.messageArchive?.lastSeq(key) ?? 0 })) },
        conversations: keys.map((key) => ({ key, ...b.resolveConversationMode(key), sessionId: b.state.sessions[key] ?? null,
          busy: b.collectors.has(b.state.sessions[key]), phase: b.social.states.get(key)?.phase ?? null,
          legacyTimers: ['sleepTimer','pendingWakeTimer','replyCheckTimer','proactiveTimer','rateLimitRetryTimer'].filter((slot) => b.socialV2.conversations.get(key)?.[slot]),
          wakeConfig: b.socialV2.conversations.get(key)?.wakeConfig ?? null })),
      }); return;
    }
    if (rq.url.pathname === '/api/console/identity') {
      if (rq.req.method === 'GET') { rq.sendJson({ ok: true, writable: b.identityWritable(), ...b.identitySnapshot() }); return; }
      if (rq.req.method === 'POST') {
        const body = await rq.readBody();
        if (body.remove !== undefined && typeof body.remove !== 'boolean') { rq.sendJson({ ok: false, error: 'remove 必须是布尔值' }, 400); return; }
        if (body.remove === true && body.confirm !== true) { rq.sendJson({ ok: false, error: '删除称呼需要确认' }, 400); return; }
        try { rq.sendJson({ ok: true, ...b.editIdentity(body) }); }
        catch (error) { rq.sendJson({ ok: false, error: error.message }, error.statusCode ?? 400); }
        return;
      }
    }
    if (rq.url.pathname === '/api/console/memory/long' && rq.req.method === 'GET') {
      const key = canonicalV2Key(rq.url.searchParams.get('key'));
      if (!key) { rq.sendJson({ ok: false, error: '会话 key 非法' }, 400); return; }
      rq.sendJson({ ok: true, key, items: b.memoryPool.query().filter((item) => item.conv_id === key), cursor: b.compressCursor.get(key) }); return;
    }
    if (rq.url.pathname === '/api/console/memory/long/delete' && rq.req.method === 'POST') {
      const body = await rq.readBody();
      const key = canonicalV2Key(body.key);
      if (!key || typeof body.id !== 'string' || body.confirm !== true) { rq.sendJson({ ok: false, error: '需要会话 key、条目 id 和删除确认' }, 400); return; }
      if (!b.memoryPool.query().some((item) => item.id === body.id && item.conv_id === key)) { rq.sendJson({ ok: false, error: '记忆条目不存在' }, 404); return; }
      b.memoryPool.update((items) => items.filter((item) => item.id !== body.id || item.conv_id !== key));
      b.memoryIndex.drop(key);
      b.removeMemoryView({ convId: key });
      b.appendActivity(`控制台删除记忆 ${key} ${body.id}`);
      rq.sendJson({ ok: true }); return;
    }
    if (['/api/console/settings', '/api/console/migration'].includes(rq.url.pathname)) {
      const configFile = path.join(b.ROOT, 'config.json');
      const file = readConfigObject(configFile);
      const revision = crypto.createHash('sha256').update(JSON.stringify(file)).digest('hex');
      const migration = migrateLegacyConfig(file);
      if (rq.req.method === 'GET') {
        rq.sendJson({ ok: true, revision, migration: migration.changes, running: { memory: b.cfg.memory, architecture: b.cfg.architecture, modes: { engine: b.cfg.modes.engine, defaults: b.cfg.modes.defaults } },
          configured: { memory: migration.config.memory ?? {}, architecture: migration.config.architecture ?? {}, modes: { engine: file.modes?.engine ?? {}, defaults: file.modes?.defaults ?? {} } }, restartRequired: true }); return;
      }
      if (rq.req.method === 'POST') {
        const body = await rq.readBody();
        if (body.revision !== revision) { rq.sendJson({ ok: false, error: '配置已变化，请刷新后重试' }, 409); return; }
        const objects = [body.architecture, body.modes, body.architecture?.schedulerV2, body.modes?.engine, body.modes?.defaults, body.memory, body.memory?.terms];
        if (objects.some((value) => value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))) { rq.sendJson({ ok: false, error: '配置分组必须是对象' }, 400); return; }
        const next = rq.url.pathname === '/api/console/migration' ? migration.config : { ...migration.config, ...(body.memory ? { memory: { ...migration.config.memory, ...body.memory, terms: { ...migration.config.memory?.terms, ...body.memory.terms } } } : {}), architecture: { ...migration.config.architecture, ...body.architecture, schedulerV2: { ...migration.config.architecture?.schedulerV2, ...body.architecture?.schedulerV2 } }, modes: { ...migration.config.modes, ...body.modes, engine: { ...file.modes?.engine, ...body.modes?.engine } } };
        // 只在配置校验通过后写盘；预览仅返回键路径，完整配置只用于校验与本地备份。
        const booleanValues = [next.memory?.enabled, next.memory?.terms?.enabled, next.architecture?.gateV2, ...Object.entries(next.architecture?.schedulerV2 ?? {}).filter(([key]) => key !== 'maxConcurrent').map(([, value]) => value), ...Object.values(next.modes?.engine ?? {})];
        if (booleanValues.some((value) => value !== undefined && typeof value !== 'boolean')) { rq.sendJson({ ok: false, error: '架构开关必须是布尔值' }, 400); return; }
        if ((next.memory?.terms?.injectMax !== undefined && (!Number.isInteger(next.memory.terms.injectMax) || next.memory.terms.injectMax < 1 || next.memory.terms.injectMax > 30))
          || (next.memory?.learnerPreset !== undefined && (typeof next.memory.learnerPreset !== 'string' || !next.memory.learnerPreset.trim()))) { rq.sendJson({ ok: false, error: '记忆参数非法' }, 400); return; }
        const maxConcurrent = next.architecture?.schedulerV2?.maxConcurrent;
        if (maxConcurrent !== undefined && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64)) { rq.sendJson({ ok: false, error: '调度并发数必须为 1–64 的整数' }, 400); return; }
        const validate = () => {
          try { return loadConfig({ configFile, readJsonSafe: () => next, discoverDshLaunchToken: () => '' }); }
          catch (error) { error.statusCode = 400; throw error; }
        };
        const validated = validate();
        if (rq.url.pathname === '/api/console/settings') {
          next.architecture = { ...next.architecture, ...validated.architecture, schedulerV2: { ...next.architecture.schedulerV2, ...validated.architecture.schedulerV2 } };
          next.modes = { ...next.modes, engine: { ...next.modes?.engine, ...validated.modes.engine }, defaults: validated.modes.defaults };
        }
        if (body.apply !== true) { rq.sendJson({ ok: true, revision, changes: migration.changes, dryRun: true }); return; }
        const backup = path.join(b.STATE_DIR, 'config-backups', `${revision}.json`);
        atomicWriteJson(backup, file);
        atomicWriteJson(configFile, next);
        b.appendActivity(`配置${rq.url.pathname.endsWith('migration') ? '迁移' : '更新'}完成；重启生效`);
        rq.sendJson({ ok: true, backup: path.relative(b.ROOT, backup), restartRequired: true }); return;
      }
    }
    return ROUTE_NEXT;
  };
}
