// 门禁成员策略管理；校验与持久化由 member-policy store 负责
import { ROUTE_NEXT } from '../../../infra/http/route-next.js';
import { FLAG_KEYS, MEMBER_MODES } from '../../../gate/decide.js';
import { validateMemberPolicyDoc } from '../../../store/member-policy.js';

const GROUP_RE = /^(?:group:)?([1-9]\d{0,15})$/;
const QQ_RE = /^[1-9]\d{0,15}$/;
const MAX_ENTRIES = 5000;

// 按参数化路由模板匹配 pathname 并提取非空路径参数
function matchParamRoute(pattern, pathname) {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].startsWith(':')) {
      if (!actual[i]) return null;
      params[expected[i].slice(1)] = actual[i];
    } else if (expected[i] !== actual[i]) {
      return null;
    }
  }
  return params;
}

export function createConsoleGateRoutes(b) {
  return async function consoleGateRoutes(rq) {
    const groupFrom = (value) => {
      const match = GROUP_RE.exec(String(value ?? ''));
      return match ? `group:${match[1]}` : null;
    };
    const entriesFrom = (value) => {
      if (Array.isArray(value)) {
        const keys = value.map((item) => String(item?.qq ?? ''));
        if (new Set(keys).size !== keys.length) throw new Error('entries 中有重复 QQ');
        return Object.fromEntries(value.map((item, index) => [keys[index], item]));
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      throw new Error('entries 必须是数组或对象');
    };
    const checkFlags = (flags, previous = {}) => {
      if (!flags || typeof flags !== 'object' || Array.isArray(flags) || Object.keys(flags).some((key) => !FLAG_KEYS.includes(key) || typeof flags[key] !== 'boolean')) {
        throw new Error('flags 只接受 respond/converse/context/memory 布尔值');
      }
      const next = { respond: true, converse: true, context: true, memory: true, ...previous, ...flags };
      if (next.respond && !next.converse) throw new Error('respond=true 时 converse 不能为 false');
      if (!next.converse && next.context && !next.memory) throw new Error('converse=false 且 memory=false 时 context 不能为 true');
    };
    const checkRules = (rules, previous = {}) => {
      for (const [qq, rule] of Object.entries(rules)) {
        if (rule?.flags !== undefined) checkFlags(rule.flags, previous[qq]?.flags);
      }
    };
    const ensureLoaded = (rq) => {
      if (typeof b.ensureMemberPolicyLoaded === 'function') {
        if (b.ensureMemberPolicyLoaded()) return true;
      } else if (b.cfg?.architecture?.gateV2 === true) {
        return true;
      }
      rq.sendJson({ ok: false, error: '成员策略尚未加载，无法读写' }, 503);
      return false;
    };
    const response = (group, policy) => ({
      group,
      mode: policy?.mode ?? 'all',
      updatedAt: policy?.updatedAt ?? null,
      updatedBy: policy?.updatedBy ?? null,
      gateV2: b.cfg.architecture?.gateV2 === true,
      policyBroken: b.memberPolicySnapshot().policyBroken,
      policyEpoch: b.memberPolicySnapshot().policyEpoch,
      entries: Object.entries(policy?.rules ?? {}).map(([qq, rule]) => ({
        ...rule,
        effective: b.gateDecide({ kind: 'group', id: Number(group.slice(6)), qq }),
      })),
    });

    if (rq.req.method === 'GET' && rq.url.pathname === '/api/console/gate/member-policy') {
      const group = groupFrom(rq.url.searchParams.get('group'));
      if (!group) { rq.sendJson({ ok: false, error: 'group 必须是有效群号' }, 400); return; }
      if (!ensureLoaded(rq)) return;
      const policy = b.memberPolicySnapshot().policy.groups[group];
      rq.sendJson({ ok: true, ...response(group, policy) });
      return;
    }

    if (rq.req.method === 'GET' && rq.url.pathname === '/api/console/gate/member-policy/effective') {
      const group = groupFrom(rq.url.searchParams.get('group'));
      const qq = String(rq.url.searchParams.get('qq') ?? '');
      if (!group || !QQ_RE.test(qq)) { rq.sendJson({ ok: false, error: 'group 或 qq 无效' }, 400); return; }
      if (!ensureLoaded(rq)) return;
      const decision = b.gateDecide({ kind: 'group', id: Number(group.slice(6)), qq });
      rq.sendJson({ ok: true, group, qq, ...decision });
      return;
    }

    if (rq.req.method === 'GET' && rq.url.pathname === '/api/console/gate/member-policy/export') {
      const group = groupFrom(rq.url.searchParams.get('group'));
      if (!group) { rq.sendJson({ ok: false, error: 'group 必须是有效群号' }, 400); return; }
      if (!ensureLoaded(rq)) return;
      const data = response(group, b.memberPolicySnapshot().policy.groups[group]);
      if (rq.url.searchParams.get('format') !== 'csv') { rq.sendJson({ ok: true, ...data }); return; }
      const cell = (value) => {
        const text = String(value ?? '');
        const safe = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
        return `"${safe.replaceAll('"', '""')}"`;
      };
      const csv = [
        ['qq', ...FLAG_KEYS, 'aliases', 'note'].join(','),
        ...data.entries.map((entry) => [entry.qq, ...FLAG_KEYS.map((key) => entry.flags?.[key] === true), (entry.aliases ?? []).join('|'), entry.note ?? ''].map(cell).join(',')),
      ].join('\r\n');
      const safeFilename = `${group.replace(':', '-')}.csv`;
      rq.res.writeHead(200, { ...(rq.SECURITY_HEADERS ?? {}), 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${safeFilename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      rq.res.end(csv);
      return;
    }

    const groupMatch = rq.req.method === 'PUT' ? matchParamRoute('/api/console/gate/member-policy/:groupId', rq.url.pathname) : null;
    if (groupMatch) {
      const group = groupFrom(groupMatch.groupId);
      if (!group) { rq.sendJson({ ok: false, error: 'group 无效' }, 400); return; }
      const body = await rq.readBody();
      if (!ensureLoaded(rq)) return;
      const current = b.memberPolicySnapshot().policy.groups[group];
      if (!Object.hasOwn(body, 'expectedUpdatedAt') || (body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== 'string')) {
        rq.sendJson({ ok: false, error: 'expectedUpdatedAt 必须明确提供（字符串或 null）' }, 400);
        return;
      }
      if ((body.expectedUpdatedAt ?? null) !== (current?.updatedAt ?? null)) {
        rq.sendJson({ ok: false, error: '策略已被其他操作修改，请重新加载', updatedAt: current?.updatedAt ?? null }, 409);
        return;
      }
      let checked;
      try {
        const rules = entriesFrom(body.entries ?? body.rules);
        if (Object.keys(rules).length > MAX_ENTRIES) throw new Error(`每组最多 ${MAX_ENTRIES} 条成员规则`);
        if (!MEMBER_MODES.includes(body.mode)) throw new Error('mode 必须是 all / blacklist / whitelist');
        checkRules(rules);
        checked = validateMemberPolicyDoc({ groups: { [group]: { mode: body.mode, rules } } }).groups[group];
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        return;
      }
      if (b.memberPolicySnapshot().policyBroken) { rq.sendJson({ ok: false, error: '策略文件损坏，当前为只读状态' }, 503); return; }
      b.setGroupPolicy(group, checked, 'console');
      rq.sendJson({ ok: true, ...response(group, b.memberPolicySnapshot().policy.groups[group]) });
      return;
    }

    const memberMatch = (rq.req.method === 'PATCH' || rq.req.method === 'DELETE') ? matchParamRoute('/api/console/gate/member-policy/:groupId/members/:qq', rq.url.pathname) : null;
    if (memberMatch) {
      const group = groupFrom(memberMatch.groupId);
      const qq = memberMatch.qq;
      if (!group || !QQ_RE.test(qq)) { rq.sendJson({ ok: false, error: 'group 或 qq 无效' }, 400); return; }
      if (rq.req.method === 'DELETE') {
        if (!ensureLoaded(rq)) return;
        const snap = b.memberPolicySnapshot();
        if (snap.policyBroken) { rq.sendJson({ ok: false, error: '策略文件损坏，当前为只读状态' }, 503); return; }
        const current = snap.policy.groups[group];
        if (rq.url.searchParams.get('confirm') !== 'true') { rq.sendJson({ ok: false, error: '删除需明确提供 confirm=true' }, 400); return; }
        if (!rq.url.searchParams.has('expectedUpdatedAt')) { rq.sendJson({ ok: false, error: '缺少 expectedUpdatedAt，请重新加载成员策略后再删除' }, 400); return; }
        const rawExpected = rq.url.searchParams.get('expectedUpdatedAt');
        const expected = rawExpected === '' || rawExpected === 'null' ? null : rawExpected;
        if (expected !== (current?.updatedAt ?? null)) {
          rq.sendJson({ ok: false, error: '策略已被其他操作修改，请重新加载', updatedAt: current?.updatedAt ?? null }, 409);
          return;
        }
        b.deleteMemberRule(group, qq, 'console');
        rq.sendJson({ ok: true, ...response(group, b.memberPolicySnapshot().policy.groups[group]) });
        return;
      }
      const body = await rq.readBody();
      if (!ensureLoaded(rq)) return;
      const snap = b.memberPolicySnapshot();
      if (snap.policyBroken) { rq.sendJson({ ok: false, error: '策略文件损坏，当前为只读状态' }, 503); return; }
      const current = snap.policy.groups[group];
      if (!Object.hasOwn(body, 'expectedUpdatedAt') || (body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== 'string')) {
        rq.sendJson({ ok: false, error: 'expectedUpdatedAt 必须是字符串或 null' }, 400);
        return;
      }
      if ((body.expectedUpdatedAt ?? null) !== (current?.updatedAt ?? null)) {
        rq.sendJson({ ok: false, error: '策略已被其他操作修改，请重新加载', updatedAt: current?.updatedAt ?? null }, 409);
        return;
      }
      const { expectedUpdatedAt: _omitExpected, ...patchFields } = body;
      if (!Object.keys(patchFields).some((key) => ['flags', 'aliases', 'note'].includes(key)) || Object.keys(patchFields).some((key) => !['flags', 'aliases', 'note'].includes(key))) {
        rq.sendJson({ ok: false, error: '仅可修改 flags、aliases、note，且至少提供一项' }, 400);
        return;
      }
      try {
        if (patchFields.flags !== undefined) checkFlags(patchFields.flags, current?.rules?.[qq]?.flags);
        validateMemberPolicyDoc({ groups: { [group]: { mode: current?.mode ?? 'all', rules: { ...current?.rules, [qq]: { ...current?.rules?.[qq], ...patchFields } } } } });
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        return;
      }
      b.setMemberRule(group, qq, patchFields, 'console');
      rq.sendJson({ ok: true, ...response(group, b.memberPolicySnapshot().policy.groups[group]) });
      return;
    }

    if (rq.req.method === 'POST' && rq.url.pathname === '/api/console/gate/member-policy/import') {
      const body = await rq.readBody();
      const group = groupFrom(body.group);
      if (!group) { rq.sendJson({ ok: false, error: 'group 必须是有效群号' }, 400); return; }
      if (!ensureLoaded(rq)) return;
      const current = b.memberPolicySnapshot().policy.groups[group];
      if (!Object.hasOwn(body, 'expectedUpdatedAt') || (body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== 'string')) {
        rq.sendJson({ ok: false, error: 'expectedUpdatedAt 必须明确提供（字符串或 null）' }, 400);
        return;
      }
      if ((body.expectedUpdatedAt ?? null) !== (current?.updatedAt ?? null)) {
        rq.sendJson({ ok: false, error: '策略已被其他操作修改，请重新加载', updatedAt: current?.updatedAt ?? null }, 409);
        return;
      }
      let checked;
      try {
        const rules = entriesFrom(body.entries ?? body.rules);
        if (Object.keys(rules).length > MAX_ENTRIES) throw new Error(`每组最多 ${MAX_ENTRIES} 条成员规则`);
        checkRules(rules);
        checked = validateMemberPolicyDoc({ groups: { [group]: { mode: body.mode, rules } } }).groups[group];
      } catch (error) {
        rq.sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
        return;
      }
      if (body.dryRun === true) { rq.sendJson({ ok: true, dryRun: true, group, mode: checked.mode, count: Object.keys(checked.rules).length }); return; }
      if (body.dryRun !== false) { rq.sendJson({ ok: false, error: 'dryRun 必须明确为 true（预检）或 false（确认导入）' }, 400); return; }
      if (b.memberPolicySnapshot().policyBroken) { rq.sendJson({ ok: false, error: '策略文件损坏，当前为只读状态' }, 503); return; }
      b.setGroupPolicy(group, checked, 'console');
      rq.sendJson({ ok: true, ...response(group, b.memberPolicySnapshot().policy.groups[group]) });
      return;
    }
    return ROUTE_NEXT;
  };
}
