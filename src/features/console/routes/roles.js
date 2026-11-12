// 控制台人格管理与仿真提示词路由；鉴权在分发前完成
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import fs from 'node:fs';
import path from 'node:path';
import { presetPromptWarnings, renderPresetPromptYaml, extractPresetPrefix, presetPromptBlockers } from '../../../preset-prompt.js';
import { roleCharStats, roleSectionReport } from '../../../role-card.js';
import { readConfigObject, atomicWriteJson, atomicWriteText } from '../../../store/fs-atomic.js';

// 创建人格与提示词路由；未命中返回 ROUTE_NEXT
export function createConsoleRoleRoutes(b) {
  return async function consoleRoleRoutes(rq) {
    // ── 人格管理 ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/roles') {
      const rs = b.readRoleState();
      const summaries = b.roleSummaries();
      rq.sendJson({
        // roles 保持名字数组的既有契约，富信息放 summaries
        roles: summaries.map((role) => role.name),
        summaries,
        current: rs.role ?? null,
        limits: { nameMax: b.ROLE_NAME_MAX, contentMaxBytes: b.ROLE_CONTENT_MAX_BYTES, injectMaxChars: b.roleInjectMaxChars },
      });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/roles/content') {
      let name;
      try { name = b.validateRoleName(rq.url.searchParams.get('name')); } catch (error) { rq.sendJson({ ok: false, error: error.message }, 400); return; }
      if (!fs.existsSync(b.roleFilePath(name))) { rq.sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      const content = b.readRoleContent(name);
      rq.sendJson({
        ok: true,
        name,
        content,
        chars: content.length,
        bytes: Buffer.byteLength(content, 'utf8'),
        warnings: b.roleWarnings(content),
        limits: { injectMaxChars: b.roleInjectMaxChars },
        stats: roleCharStats(content),
                // 各小节在各模式下要不要写进提示词，给控制台预览
        sections: { v1: roleSectionReport(content, 'v1'), v2: roleSectionReport(content, 'v2') },
      });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/roles/limit') {
      const body = await rq.readBody();
      const next = b.applyRoleInjectLimit(body.maxInjectChars);
      const configFile = path.join(b.ROOT, 'config.json');
      const file = readConfigObject(configFile);
      file.role = { ...(file.role ?? {}), maxInjectChars: next };
      atomicWriteJson(configFile, file);
      b.cfg.role = { ...(b.cfg.role ?? {}), maxInjectChars: next };
      b.roleInjectMaxChars = next;
      b.log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
      rq.sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/roles/create') {
      const body = await rq.readBody();
      let name; let content;
      try { name = b.validateRoleName(body.name); content = b.validateRoleContent(body.content); }
      catch (error) { rq.sendJson({ ok: false, error: error.message }, 400); return; }
      if (fs.existsSync(b.roleFilePath(name))) { rq.sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
      b.writeRoleContent(name, content);
      b.log(`控制台：创建人格「${name}」（${content.length} 字符）`);
      rq.sendJson({ ok: true, role: name, warnings: b.roleWarnings(content) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/roles/update') {
      const body = await rq.readBody();
      let name; let content;
      try { name = b.validateRoleName(body.name); content = b.validateRoleContent(body.content); }
      catch (error) { rq.sendJson({ ok: false, error: error.message }, 400); return; }
      if (!fs.existsSync(b.roleFilePath(name))) { rq.sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      b.writeRoleContent(name, content);
      b.log(`控制台：更新人格「${name}」（${content.length} 字符）`);
      rq.sendJson({ ok: true, role: name, chars: content.length, warnings: b.roleWarnings(content) });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/roles/rename') {
      const body = await rq.readBody();
      let from; let to;
      try { from = b.validateRoleName(body.from); to = b.validateRoleName(body.to); }
      catch (error) { rq.sendJson({ ok: false, error: error.message }, 400); return; }
      if (from === to) { rq.sendJson({ ok: true, role: to, renamed: false }); return; }
      if (!fs.existsSync(b.roleFilePath(from))) { rq.sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
      if (fs.existsSync(b.roleFilePath(to))) { rq.sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
      fs.renameSync(b.roleFilePath(from), b.roleFilePath(to));
      const rs = b.readRoleState();
      const switched = rs.role === from;
      if (switched) b.writeRoleState(to, rs.mode);
      b.log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
      rq.sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/roles/delete') {
      const body = await rq.readBody();
      let name;
      try { name = b.validateRoleName(body.name); } catch (error) { rq.sendJson({ ok: false, error: error.message }, 400); return; }
      if (!fs.existsSync(b.roleFilePath(name))) { rq.sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
      fs.rmSync(b.roleFilePath(name));
      const rs = b.readRoleState();
      const cleared = rs.role === name;
      if (cleared) b.writeRoleState(null, rs.mode);
      b.log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
      rq.sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
      return;
    }

    // ── 仿真提示词（一代 / 二代预设） ──
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/preset/sim-prompt') {
      const preset = b.knownPresetName(rq.url.searchParams.get('preset'));
      if (!preset) { rq.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(b.PRESET_NAMES).join(' / ')}）` }, 400); return; }
      try {
        const { prefix } = b.readPresetPromptText(preset);
        rq.sendJson({
          ok: true,
          content: prefix,
          chars: prefix.length,
          bytes: Buffer.byteLength(prefix, 'utf8'),
          warnings: presetPromptWarnings(prefix),
          status: b.presetStatus(preset),
          presets: Object.values(b.PRESET_NAMES).map((n) => b.presetStatus(n)),
        });
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: b.presetStatus(preset) }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/preset/sim-prompt') {
      const body = await rq.readBody();
      const preset = b.knownPresetName(body.preset);
      if (!preset) { rq.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(b.PRESET_NAMES).join(' / ')}）` }, 400); return; }
      let nextText;
      try {
        const { text, prefix } = b.readPresetPromptText(preset);
        // 内容未变就不写，避免排版变化造成整块 diff
        const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (normalized === prefix) {
          const sync = b.syncInstalledPreset(preset);
          rq.sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: sync.synced, requiresRestart: sync.changed, status: b.presetStatus(preset) });
          return;
        }
        nextText = renderPresetPromptYaml(text, body.content, preset === b.PRESET_NAMES.v1 ? 'v1' : 'v2');
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
        return;
      }
      const warnings = presetPromptWarnings(body.content);
      let sourceBackup = null;
      try {
        sourceBackup = b.backupPresetFile(preset);
        atomicWriteText(b.presetSourceYaml(preset), nextText);
        // 同步到 DSH 安装目录；安装副本不做仓库内备份
        b.syncInstalledPreset(preset);
      } catch (error) {
        // 尽力回滚源文件，避免半截状态
        if (sourceBackup && fs.existsSync(sourceBackup)) {
          try { fs.copyFileSync(sourceBackup, b.presetSourceYaml(preset)); } catch {}
        }
        rq.sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
        return;
      }
      b.log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
      rq.sendJson({
        ok: true,
        chars: String(body.content ?? '').length,
        warnings,
        synced: fs.existsSync(b.installedPresetYaml(preset)),
        requiresRestart: true,
        status: b.presetStatus(preset),
      });
      return;
    }
    if (rq.req.method === 'GET' && rq.url.pathname === '/api/preset/sim-prompt/backups') {
      const preset = b.knownPresetName(rq.url.searchParams.get('preset'));
      if (!preset) { rq.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(b.PRESET_NAMES).join(' / ')}）` }, 400); return; }
      try {
        rq.sendJson({ ok: true, backups: b.listPresetBackups(preset) });
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
      }
      return;
    }
    if (rq.req.method === 'POST' && rq.url.pathname === '/api/preset/sim-prompt/restore') {
      const body = await rq.readBody();
      const preset = b.knownPresetName(body.preset);
      if (!preset) { rq.sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(b.PRESET_NAMES).join(' / ')}）` }, 400); return; }
      try {
        const requested = String(body.file ?? '').trim();
        const candidates = b.listPresetBackups(preset).map((b) => b.file);
        const target = requested || candidates[0];
        // 只允许还原本预设目录下的备份，拒绝路径穿越
        if (!target || !candidates.includes(target)) { rq.sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
        const backupPath = path.join(b.PRESET_BACKUP_DIR, target);
        const restored = fs.readFileSync(backupPath, 'utf8');
        const restoredPrefix = extractPresetPrefix(restored);
        if (restoredPrefix === null) { rq.sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
                // 还原也要检查这套预设的必备项，防止写回弱化版
        const blockers = presetPromptBlockers(restoredPrefix, preset === b.PRESET_NAMES.v1 ? 'v1' : 'v2');
        if (blockers.length) {
          rq.sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
          return;
        }
        b.backupPresetFile(preset);
        atomicWriteText(b.presetSourceYaml(preset), restored);
        b.syncInstalledPreset(preset);
        b.log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
        rq.sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
      }
      return;
    }
    return ROUTE_NEXT;
  };
}
