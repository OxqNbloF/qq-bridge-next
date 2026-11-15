import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function modeDependencyViolations(file, source) {
  const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)].map((match) => match[1]);
  return [
    ...imports.filter((name) => /(?:^|\/)(?:store|gateway|dsh|features)(?:\/|$)|dsh-client/.test(name)).map((name) => `禁止依赖 ${name}`),
    ...imports.filter((name) => file !== 'registry.js' && (/^\.\//.test(name) || /(?:^|\/)modes\//.test(name))).map((name) => `模式间禁止依赖 ${name}`),
    ...[...source.matchAll(/\b(?:ensureSession|onebotSend|onebotHttpAction|setTimeout|setInterval|memoryPool)\b|\bbot\s*(?:\?\.|\.)\s*send\w*\b|\bapi\s*(?:\?\.|\.)\s*sessions\b/g)].map((match) => `禁止模式持有系统操作 ${match[0]}`),
  ];
}

export function checkModeDependencies(dir = fileURLToPath(new URL('../src/modes', import.meta.url))) {
  return fs.readdirSync(dir, { recursive: true }).filter((file) => file.endsWith('.js')).flatMap((file) => modeDependencyViolations(file, fs.readFileSync(path.join(dir, file), 'utf8')).map((message) => `${file}: ${message}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkModeDependencies();
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log('模式依赖方向检查通过');
}
