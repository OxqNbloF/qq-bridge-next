// 读出 DSH 有哪些设置分类和可用模型，只看不改
//
// 结果写到系统临时文件夹，不写仓库里的 state/
// state/ 的权限被收紧过，在沙箱里写不进去
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROBE_BASE as BASE, probeCookie, probeRpc } from './probe-auth.mjs';

// 登录和连接都复用 probe-auth.mjs 里的做法
// 老办法在新版 DSH 上会一直连不上
const rpc = probeRpc(probeCookie());
const outDir = path.join(os.tmpdir(), 'qq-bridge-probe-models');
fs.mkdirSync(outDir, { recursive: true });

const out = await rpc('settings/describe', {});
if (!out?.ok) {
  console.error(`settings/describe 失败：${out?.error?.code}: ${out?.error?.message}`);
  process.exit(1);
}
const namespaces = out.value.namespaces;
console.log('=== settings namespaces ===');
for (const ns of namespaces) console.log(' -', ns.ns, '| value:', JSON.stringify(ns.value)?.slice(0, 200));

const modelNs = namespaces.find((n) => n.ns === 'agent-default-model');
if (modelNs) {
  console.log('\n=== agent-default-model schema (JSON) ===');
  console.log(JSON.stringify(modelNs.schema, null, 2).slice(0, 4000));
}

const describeFile = path.join(outDir, 'dsh-settings-describe.json');
fs.writeFileSync(describeFile, JSON.stringify(out, null, 2));
console.log(`\n[saved] ${describeFile}`);

const presets = await rpc('agentPresets/list', {});
const presetsFile = path.join(outDir, 'dsh-agent-presets.json');
fs.writeFileSync(presetsFile, JSON.stringify(presets, null, 2));
console.log(`[saved] ${presetsFile}`);
console.log('presets:', presets.value?.presets?.map((p) => p.id).join(', '));
