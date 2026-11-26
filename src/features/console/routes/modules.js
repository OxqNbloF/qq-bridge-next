// 工作台全模块参数读写与配置备份恢复路由（仅控制台可用）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import { loadConfig, withConfigWriteLock } from '../../../infra/config.js';
import { syncConfigAliases } from '../../../infra/legacy-config.js';
import { readConfigObject, atomicWriteJson } from '../../../store/fs-atomic.js';
import { clearSearchCache } from '../../../web-search.js';
import { MODULE_MAP, buildModuleCatalog, validateModulePatch, applyHotModuleChanges } from '../module-registry.js';

const MODULE_PATH_RE = /^\/api\/console\/modules\/([a-z0-9-]+)$/;
const BACKUP_NAME_RE = /^[A-Za-z0-9._-]+\.json$/;

export function createConsoleModuleRoutes(b) {
  const hashRevision = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

  return async function consoleModuleRoutes(rq) {
    const configFile = path.join(b.ROOT, 'config.json');
    const backupDir = path.join(b.STATE_DIR, 'config-backups');

    if (rq.req.method === 'GET' && rq.url.pathname === '/api/console/modules') {
      const file = readConfigObject(configFile);
      const revision = hashRevision(file);
      const catalog = buildModuleCatalog({ cfg: b.cfg, fileConfig: file, configFile });
      rq.sendJson({ ok: true, revision, ...catalog });
      return;
    }

    const modMatch = MODULE_PATH_RE.exec(rq.url.pathname);
    if (modMatch) {
      const moduleId = modMatch[1];
      if (!MODULE_MAP.has(moduleId)) {
        rq.sendJson({ ok: false, error: `未知模块：${moduleId}` }, 404);
        return;
      }
      if (rq.req.method === 'GET') {
        const file = readConfigObject(configFile);
        const revision = hashRevision(file);
        const catalog = buildModuleCatalog({ cfg: b.cfg, fileConfig: file, configFile });
        const mod = catalog.modules.find((m) => m.id === moduleId);
        rq.sendJson({ ok: true, revision, module: mod, pendingRestartCount: catalog.pendingRestartCount });
        return;
      }
      if (rq.req.method === 'POST') {
        const body = await rq.readBody();
        await withConfigWriteLock(async () => {
          const file = readConfigObject(configFile);
          const revision = hashRevision(file);
          if (body.revision !== undefined && body.revision !== revision) {
            rq.sendJson({ ok: false, error: '配置已被其他操作修改，请刷新后重试', revision }, 409);
            return;
          }
          let checked;
          try {
            checked = validateModulePatch({
              moduleId,
              values: body.values ?? {},
              resetDefaults: body.resetDefaults === true,
              currentFile: file,
              configFile,
            });
          } catch (error) {
            rq.sendJson({ ok: false, error: error?.message ?? String(error) }, error?.statusCode ?? 400);
            return;
          }
          if (body.dryRun === true) {
            rq.sendJson({
              ok: true,
              dryRun: true,
              revision,
              moduleId,
              changedPaths: checked.changedPaths,
              hotPaths: checked.hotPaths,
              requiresRestart: checked.requiresRestart,
            });
            return;
          }
          const backupPath = path.join(backupDir, `${revision.slice(0, 16)}-${Date.now()}.json`);
          atomicWriteJson(backupPath, file);
          const written = syncConfigAliases(checked.nextFile);
          atomicWriteJson(configFile, written);
          applyHotModuleChanges(
            Object.assign(Object.create(b), { clearSearchCache }),
            { moduleId, validatedCfg: checked.validatedCfg, hotPaths: checked.hotPaths }
          );
          const nextRevision = hashRevision(written);
          const catalog = buildModuleCatalog({ cfg: b.cfg, fileConfig: written, configFile });
          const updatedMod = catalog.modules.find((m) => m.id === moduleId);
          b.log(`工作台：已更新模块「${checked.mod.title}」参数（${checked.changedPaths.length} 项${checked.requiresRestart ? '，含重启生效项' : '，已热更新'}）`);
          b.appendActivity?.(`工作台更新模块 ${moduleId}（${checked.changedPaths.length} 项）`);
          rq.sendJson({
            ok: true,
            revision: nextRevision,
            module: updatedMod,
            changedPaths: checked.changedPaths,
            hotPaths: checked.hotPaths,
            requiresRestart: checked.requiresRestart,
            pendingRestartCount: catalog.pendingRestartCount,
            backup: path.relative(b.ROOT, backupPath),
          });
        });
        return;
      }
    }

    if (rq.req.method === 'GET' && rq.url.pathname === '/api/console/config/backups') {
      let items = [];
      try {
        if (fs.existsSync(backupDir)) {
          items = fs.readdirSync(backupDir)
            .filter((name) => BACKUP_NAME_RE.test(name))
            .map((name) => {
              const st = fs.statSync(path.join(backupDir, name));
              return { name, size: st.size, mtimeMs: st.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, 30);
        }
      } catch {}
      rq.sendJson({ ok: true, backups: items });
      return;
    }

    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/config/restore') {
      const body = await rq.readBody();
      const name = String(body.name ?? '').trim();
      if (!BACKUP_NAME_RE.test(name)) {
        rq.sendJson({ ok: false, error: '备份文件名非法' }, 400);
        return;
      }
      const target = path.join(backupDir, name);
      if (!fs.existsSync(target)) {
        rq.sendJson({ ok: false, error: '备份文件不存在' }, 404);
        return;
      }
      await withConfigWriteLock(async () => {
        const current = readConfigObject(configFile);
        const restored = readConfigObject(target);
        try {
          loadConfig({ configFile, readJsonSafe: () => restored, discoverDshLaunchToken: () => '' });
        } catch (error) {
          rq.sendJson({ ok: false, error: `备份配置校验失败：${error?.message ?? error}` }, 400);
          return;
        }
        const preRestoreBackup = path.join(backupDir, `pre-restore-${Date.now()}.json`);
        atomicWriteJson(preRestoreBackup, current);
        atomicWriteJson(configFile, restored);
        b.log(`工作台：已从备份 ${name} 恢复 config.json（重启生效）`);
        rq.sendJson({ ok: true, restored: name, backup: path.relative(b.ROOT, preRestoreBackup), restartRequired: true });
      });
      return;
    }

    return ROUTE_NEXT;
  };
}
