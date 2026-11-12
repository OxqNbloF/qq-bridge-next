// 控制台设置路由：白名单、模型、安全通知、控制台令牌
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { unwrap } from '../../../dsh-client.js';
import { hardenStateDirAcl } from '../../../infra/state-acl.js';
import { normalizeOwnerQQ } from '../../../policy/access.js';
import { REASONING_EFFORT_OPTIONS, REASONING_EFFORT_NONE, REASONING_EFFORT_DEFAULT, normalizeReasoningEffort } from '../../../policy/mode.js';
import { manualDirCommand } from '../../../state-acl.mjs';
import { readConfigObject, atomicWriteJson, atomicWriteText } from '../../../store/fs-atomic.js';

// 注册控制台设置类路由
export function createConsoleSettingsRoutes(b) {
  return async function consoleSettingsRoutes(rq) {
    // 白名单读写（写 config.json 并热更新）
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/whitelist') {
      rq.sendJson({ allow: b.cfg.allow ?? { private: [], groups: [] }, deny: b.cfg.deny ?? { private: [], groups: [] }, ownerQQ: b.cfg.ownerQQ ?? null });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/whitelist') {
      const body = await rq.readBody();
      // 把一串号码整理成不重复的数字
      const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
      const configFile = path.join(b.ROOT, 'config.json');
      // 配置损坏直接 500，绝不回写
      const file = readConfigObject(configFile);
      const allow = {
        private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
        groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
      };
      const deny = {
        private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
        groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
      };
      // 管理员 QQ：空值清除（fail-closed），非法值拒绝
      let ownerQQ = b.cfg.ownerQQ ?? null;
      if (body.ownerQQ !== undefined) {
        try {
          ownerQQ = normalizeOwnerQQ(body.ownerQQ);
        } catch (error) {
          rq.sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
          return;
        }
      }
      file.allow = allow;
      file.deny = deny;
      file.ownerQQ = ownerQQ;
      atomicWriteJson(configFile, file);
      b.cfg.allow = { private: allow.private, groups: allow.groups };
      b.cfg.deny = { private: deny.private, groups: deny.groups };
      b.cfg.ownerQQ = ownerQQ;
      b.reconcileSessionPolicies();
      b.log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
      rq.sendJson({ ok: true, allow, deny, ownerQQ });
      return;
    }

    // DSH 模型与思考强度
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/dsh/model') {
      const provider = String(b.cfg.dsh?.provider || 'deepseek-official');
      const model = String(b.cfg.dsh?.model || 'deepseek-flash');
      // 档位优先用 DSH 公布的能力，失败用内置清单
      let options = REASONING_EFFORT_OPTIONS.slice();
      let labels = {};
      let providerDefault = null;
      let catalogSource = 'fallback';
      try {
        if (!b.modelCatalogInFlight) {
          b.modelCatalogInFlight = b.withTimeout(b.fetchModelCatalog(), 3000, 'session/modelCatalog')
            .finally(() => { b.modelCatalogInFlight = null; });
        }
        const catalog = unwrap(await b.modelCatalogInFlight, 'session.modelCatalog');
        const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
        const entry = (group?.models ?? []).find((m) => m?.id === model);
        const efforts = entry?.reasoning?.efforts;
        // 模型省略 reasoning 也算读取成功，不能虚构档位
        if (entry && (entry.reasoning === undefined || Array.isArray(efforts))) {
          const valid = (efforts ?? []).filter((e) => typeof e?.id === 'string' && e.id.length > 0);
          options = valid.map((e) => e.id);
          labels = Object.fromEntries(valid.map((e) => [e.id, { name: e.name ?? '', description: e.description ?? '' }]));
          providerDefault = entry.reasoning?.defaultEffort ?? null;
          catalogSource = 'dsh';
        }
      } catch (error) {
        // 同一失败原因只记一次日志
        const reason = String(error?.message ?? error);
        if (!b.modelCatalogErrorLogged.has(reason)) {
          b.modelCatalogErrorLogged.add(reason);
          b.log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
        }
      }
      options = [...new Set([...options, REASONING_EFFORT_NONE])];
      rq.sendJson({
        provider,
        model,
        reasoningEffort: String(b.cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
        options,
        labels,
        default: REASONING_EFFORT_DEFAULT,
        providerDefault,
        catalogSource,
        // selectModel 也会改 DSH 全局默认，需告知管理员
        globalSideEffect: true,
      });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/dsh/effort') {
      const body = await rq.readBody();
      let effort;
      try { effort = normalizeReasoningEffort(body.reasoningEffort); }
      catch (error) { rq.sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
      const configFile = path.join(b.ROOT, 'config.json');
      // 配置损坏直接 500，绝不回写
      const file = readConfigObject(configFile);
      file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
      atomicWriteJson(configFile, file);
      b.cfg.dsh = { ...(b.cfg.dsh ?? {}), reasoningEffort: effort };
      // 递增代号，运行中会话下条消息重新选模型
      b.modelSelectionEpoch += 1;
      b.log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
      rq.sendJson({ ok: true, reasoningEffort: effort });
      return;
    }

    // 安全拦截通知设置
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/security') {
      rq.sendJson({
        security: b.cfg.security ?? { interceptNotify: true },
        // state/ 权限收紧结果，失败时控制台显示警告和命令
        stateDir: {
          hardened: b.stateDirHardened,
          path: b.STATE_DIR,
          manualCommand: manualDirCommand(b.STATE_DIR)
        }
      });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/security') {
      const body = await rq.readBody();
      // 支持从控制台重试收紧 state/ 权限
      if (body.rehardenStateDir === true) {
        b.stateDirHardened = null;
        b.stateDirHardened = hardenStateDirAcl({ dir: b.STATE_DIR, hardenDir: b.hardenDir, manualDirCommand, log: b.log });
        rq.sendJson({ ok: b.stateDirHardened === true, hardened: b.stateDirHardened, path: b.STATE_DIR });
        return;
      }
      const configFile = path.join(b.ROOT, 'config.json');
      const file = readConfigObject(configFile);
      const next = { ...(file.security ?? {}), ...body };
      if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
      else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
      file.security = next;
      atomicWriteJson(configFile, file);
      b.cfg.security = { ...(b.cfg.security ?? {}), ...next };
      b.log(`控制台：安全拦截通知已更新（interceptNotify=${b.cfg.security.interceptNotify}）`);
      rq.sendJson({ ok: true, security: b.cfg.security });
      return;
    }
    // 控制台访问令牌：手动修改或随机生成
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/token') {
      const body = await rq.readBody();
      let newToken = String(body.token ?? '').trim();
      const generated = !newToken;
      if (generated) {
        newToken = crypto.randomBytes(24).toString('hex');
      }
      if (newToken.length < 16) {
        rq.sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
        return;
      }
      if (newToken.length > 128) {
        rq.sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
        return;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
        rq.sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
        return;
      }
      const configFile = path.join(b.ROOT, 'config.json');
      const file = readConfigObject(configFile);
      // 手动令牌写 config；随机令牌写 state/console-token
      file.consoleToken = generated ? '' : newToken;
      atomicWriteJson(configFile, file);
      b.cfg.consoleToken = generated ? '' : newToken;
      atomicWriteText(path.join(b.STATE_DIR, 'console-token'), newToken);
      b.consoleToken = newToken;
      b.log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
      rq.sendJson({ ok: true, token: newToken, generated });
      return;
    }
    return ROUTE_NEXT;
  };
}
