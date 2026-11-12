// 找出 DSH 里所有工具名，只在这一处实现，供两个脚本共用。
//
// 以前两处各写一份，测试那份扫得不全，把真工具名误判成假的。
// 误判会逼人把真名字从守卫名单里删掉，很危险。
//
// 只认这几种写法：注册工具时的 name、toolName 字段、
// 以及配置文件里的 toolName 行，别把别的 name 当成工具名。
import fs from 'node:fs';
import path from 'node:path';
import { dshModulesDir } from './dsh-modules.mjs';

/** 工具名的样子：小写字母开头，可以带下划线和连字符 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/** 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器等）。 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  return [home ? path.join(home, 'plugins') : null].filter((p) => p && fs.existsSync(p));
}

// 把一个文件夹里的文件一层层全找出来
function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/** 从一个 JS/TS 源文件里抽取工具名。 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 有的工具文件不挂在注册调用里，也要扫到
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/**
 * 扫出已安装的 DSH 和插件里出现的所有工具名。
 *
 * @param options.packagesDir - DSH 自带包的目录
 * @param options.pluginDirs - 第三方插件的目录列表
 * @returns 工具名和来源，以及实际扫过的包名
 */
export function collectDshToolNames({ packagesDir, pluginDirs } = {}) {
  const names = new Map();
  const packages = [];
  // 记下一个工具名和它的来源
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  const roots = [];
  const pkgRoot = packagesDir ?? dshPackagesDir();
  if (fs.existsSync(pkgRoot)) roots.push({ dir: pkgRoot, filter: /^dsh-/ });
  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 插件目录里的备份也扫，旧名字也说明它存在过
    roots.push({ dir, filter: null });
  }

  for (const { dir, filter } of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (filter && !filter.test(e.name)) continue;
      const pkgDir = path.join(dir, e.name);
      packages.push(e.name);
      for (const f of walkFiles(pkgDir)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) extractFromSource(text, e.name, add);
        else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, e.name, add);
      }
    }
  }
  return { names, packages };
}

/** 只要名字集合，不要来源信息 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 判断工具名有没有危险含义，真正拦截靠守卫名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 确定无害、可以放行的纯聊天工具 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);
