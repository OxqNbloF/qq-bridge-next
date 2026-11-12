// QQ 桥接模式设置插件，只暴露 settings 命名空间
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

// 诊断日志写临时目录，勿按相对路径上爬；QQ_MODE_DIAG 可覆盖
const DIAG = process.env.QQ_MODE_DIAG ?? path.join(os.tmpdir(), 'qq-mode-plugin.log');

// 追加一行诊断日志，失败忽略
function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-mode-console';
// 等 settings 就绪后再激活
export const inject = ['settings'];

export const QQMODE_NAMESPACE = 'qq-mode';

/** 旧版 schema，仅供静态测试校验非法 mode */
export const QqModeSchema = z.object({
  // 新名字和旧写法都要能保存，否则检查不过整组设置会失效
  mode: z.union([
    z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2'), z.const('simulation')
  ]).default('reserved2'),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json'),
});

/** DSH 定位命名空间用的 Config，字段须带 volatile */
export const Config = z.object({
  mode: z.union([
    z.const('chat'), z.const('closed-agent'), z.const('reserved'), z.const('reserved2'), z.const('simulation')
  ]).default('reserved2').extra('volatile', true),
  ownerQQ: z.string().description('管理员 QQ（ownerQQ）；留空表示不通过 DSH 设置覆盖 config.json').extra('volatile', true),
});

/** 0.2.0 下无需注册，只记一行诊断；勿调用 register/configure */
export function apply(ctx) {
  diag(`apply called; settings service=${typeof ctx.settings}; namespace=${QQMODE_NAMESPACE} (0.2.0: no registration needed)`);
}

