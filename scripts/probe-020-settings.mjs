// 列出 DSH 的所有设置分组，重点看 qq-mode 这一组
// 再把读到的值原样写回一次，看能不能写进去
//
// 网页上改设置不生效或被还原时，用这个脚本查原因
// 登录凭证交给 probe-auth.mjs 处理
//
// 只把读到的值写回去，不会改动你的配置
import { PROBE_BASE as BASE, probeCookie, probeRpc } from './probe-auth.mjs';

const rpc = probeRpc(probeCookie({ base: BASE }));

const st = await rpc('settings/describe', {});
console.log('settings/describe ok =', st?.ok === true);
const namespaces = st?.value?.namespaces ?? [];
console.log('命名空间总数:', namespaces.length);
console.log('全部命名空间:', namespaces.map((n) => n.ns).join(', '));

const qq = namespaces.find((n) => n.ns === 'qq-mode');
console.log('\n=== qq-mode 命名空间 ===');
if (!qq) console.log('❌ 未出现在 describe 里');
else {
  console.log('ns       =', qq.ns);
  console.log('keys     =', Object.keys(qq).join(','));
  console.log('value    =', JSON.stringify(qq.value));
  console.log('revision =', qq.revision);
}

// 把当前 mode 原样写回一次，看看能不能写成功
// 注意：参数直接写 ns、patch、expectedRevision，不要包一层 request
// 否则网关会报参数不对
if (qq) {
  const current = qq.value?.mode;
  const up = await rpc('settings/update', { ns: 'qq-mode', patch: { mode: current }, expectedRevision: qq.revision });
  console.log('\n=== settings/update（写回原值） ===');
  console.log(up?.ok === true ? `✅ 写入成功 accepted=${JSON.stringify(up.value)}` : `❌ ${up?.error?.code}: ${up?.error?.message}`);
  const again = await rpc('settings/describe', {});
  const qq2 = (again?.value?.namespaces ?? []).find((n) => n.ns === qq.ns);
  console.log('写回后 value =', JSON.stringify(qq2?.value), 'revision =', qq2?.revision);
}

// 桥接还关心的其他设置分组
console.log('\n=== 桥接关心的命名空间 ===');
for (const want of ['agent-preset-registry', 'agent-default-model', 'llm-deepseek', 'permission-presets']) {
  const hit = namespaces.find((n) => n.ns === want);
  console.log(`  ${hit ? '✅' : '❌'} ${want}${hit ? ` = ${JSON.stringify(hit.value)?.slice(0, 120)}` : ''}`);
}
process.exit(0);
