// 控制台首页和几组基础接口：状态、预设、模式、角色
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import fs from 'node:fs';
import path from 'node:path';
import { unwrap } from '../../../dsh-client.js';
import { normalizeModeInput, VALID_MODES } from '../../../policy/mode.js';
import { readJsonSafe, atomicWriteJson } from '../../../store/fs-atomic.js';

// 创建控制台的这些基础接口
export function createConsoleCoreRoutes(b) {
  return async function consoleCoreRoutes(rq) {
    if (rq.req.method === 'GET' && rq.url.pathname === '/') {
      rq.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...rq.SECURITY_HEADERS });
      try {
        rq.res.end(fs.readFileSync(path.join(b.ROOT, 'src', 'features', 'console', 'web', 'console.html'), 'utf8'));
      } catch {
        rq.res.end('控制台页面缺失：qq-bridge/src/features/console/web/console.html');
      }
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/status') {
      const rs = b.readRoleState();
      // 群里的 AI 只能看到运行状态，不能看管理员才知道的信息
      if (rq.req.headers['x-agent-token'] || rq.req.headers['x-agent-call'] !== undefined) {
        rq.sendJson({
          mode: b.currentMode,
          role: rs.role ?? null,
          roleMode: rs.mode ?? 'active',
          dshReady: b.dshReady,
          socialV2Paused: b.socialV2.paused,
        });
        return;
      }
      rq.sendJson({
        mode: b.currentMode,
        closedAgentPreset: b.closedAgentPreset,
        role: rs.role ?? null,
        roleMode: rs.mode ?? 'active',
        dshReady: b.dshReady,
        ownerQQ: b.cfg.ownerQQ ?? null,
        allowGroups: b.cfg.allow?.groups ?? [],
        allowPrivate: b.cfg.allow?.private ?? [],
        socialV2Paused: b.socialV2.paused,
        // 上游健康只给操作者看，别给 QQ 里的 AI 看
        snowluma: b.snowlumaHealthSnapshot(),
        activity: b.readActivityTail(100)
      });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/presets') {
      let presets = [];
      try {
        const { presets: list } = unwrap(await b.api.agentPresets.list({}), 'agentPreset.list');
        presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
      } catch {}
      rq.sendJson({ presets });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/mode') {
      const body = await rq.readBody();
      // 新旧叫法都认，存到硬盘时统一写内部名字
      const requestedMode = normalizeModeInput(body.mode);
      if (!requestedMode) {
        rq.sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
        return;
      }
      const existing = readJsonSafe(path.join(b.STATE_DIR, 'mode.json'), {});
      const next = {
        mode: requestedMode,
        // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
        ...(body.closedAgentPreset !== undefined
          ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
          : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
      };
      atomicWriteJson(path.join(b.STATE_DIR, 'mode.json'), next);
      // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
      b.closedAgentPreset = next.closedAgentPreset;
      // 只写本地文件会被 DSH 轮询覆盖，所以要同步写进 DSH
      // 这里要写内部名 reserved2，下游判断都认这个名字
      let dshSynced = false;
      try {
        // 能走到下一行就说明已经写成功了
        unwrap(await b.api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
        dshSynced = true;
      } catch (error) {
        b.log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
      }
      // 用整理后的名字比，模式其实没变就别清定时器
      if (b.currentMode === 'reserved' && requestedMode !== 'reserved') {
        b.cleanupSocialForModeChange();
        b.log('控制台：模式离开一代仿真模式，清理社交状态');
      }
      if (b.currentMode === 'reserved2' && requestedMode !== 'reserved2') {
        b.clearAllSocialV2Timers();
        b.drainAllPromptQueues('模式切换，已取消排队中的投递');
        b.log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
      }
      b.currentMode = requestedMode;
      b.lastMode = requestedMode;
      b.reconcileSessionPolicies();
      if (requestedMode === 'reserved2') {
        for (const key of b.socialV2.conversations.keys()) {
          b.setupSleepTimerV2(key);
          b.scheduleProactiveCheckV2(key);
        }
        b.log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
      }
      b.log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
      rq.sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/role') {
      const body = await rq.readBody();
      const rs = b.readRoleState();
      if (body.role && typeof body.role === 'string') {
        const name = b.sanitizeRoleName(body.role);
        if (!fs.existsSync(path.join(b.ROOT, 'roles', name + '.md'))) {
          rq.sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
          return;
        }
        b.writeRoleState(name, rs.mode);
        b.log(`控制台：角色已设置为 ${name}`);
        rq.sendJson({ ok: true, role: name });
      } else {
        b.writeRoleState(null, rs.mode);
        b.log('控制台：角色已清除');
        rq.sendJson({ ok: true, role: null });
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/role-mode') {
      const body = await rq.readBody();
      const rs = b.readRoleState();
      const mode = body.mode === 'silent' ? 'silent' : 'active';
      b.writeRoleState(rs.role, mode);
      b.log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
      rq.sendJson({ ok: true, roleMode: mode });
      return;
    }
    return ROUTE_NEXT;
  };
}
