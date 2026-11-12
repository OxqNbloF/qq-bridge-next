// 发布前扫描隐私和敏感信息，只读、不联网。
//
// 这个项目在真实机器上跑过，代码里可能混着真实的 QQ 号、
// 群号、本机路径、令牌和人格卡内容。
// 一旦推上公开仓库，这些东西就永远留在历史里删不掉了。
//
// 做法：扫描将要提交的文件，命中就报错退出，
// 并且只打印打码后的片段，不会把凭据原样打出来。
//
// 用法：
//   node scripts/privacy-scan.mjs
//   扫描当前工作树（提交前、发布前都应该跑）
//   node scripts/privacy-scan.mjs --tracked-only
//   只扫 git 已跟踪的文件
//   node scripts/privacy-scan.mjs --history
//   连全部 git 历史一起扫（发布前必跑）
//   node scripts/privacy-scan.mjs --json
//   输出给程序读的格式
//
// 规则可写在 scripts/privacy-rules.json 里，
// 那个文件含你机器上的真实信息，不要提交。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RULES_FILE = path.join(__dirname, 'privacy-rules.json');
const args = process.argv.slice(2);
const trackedOnly = args.includes('--tracked-only');
const withHistory = args.includes('--history');
const asJson = args.includes('--json');

// 默认规则：即使没有 privacy-rules.json 也能挡住最常见的一类泄漏。
const DEFAULT_RULES = {
  comment: '默认规则。请把 privacy-rules.json 加进 .gitignore（它含你的真实 QQ 号/路径），本文件是脱敏模板。',
  deny: [
    // 路径中间允许有空格，真实目录常常带空格
    { name: '本机绝对路径（Windows 用户目录）', pattern: '[A-Za-z]:\\\\Users\\\\[^\\\\"\'`<>]{2,}', flags: 'i', reject: rejectUserDirPath },
    { name: '本机绝对路径（非系统盘的顶层目录）', pattern: '(?<![A-Za-z0-9])(?!C:)[A-Za-z]:\\\\[^\\\\"\'`|<>]{2,}\\\\', flags: 'i', reject: rejectWindowsPathShape },
    { name: 'QQ 号/群号（9-10 位连续数字）', pattern: '(?<![0-9])[1-9][0-9]{8,9}(?![0-9])', flags: '' },
    // 一串全十六进制的多是提交编号，不是密钥，不报
    { name: '疑似令牌/密钥（高熵串）', pattern: '(?<![0-9a-zA-Z])[0-9a-zA-Z_-]{32,}(?![0-9a-zA-Z])', flags: '', requireNonHex: true },
    // 空值不算；右边是从别处读来的也不算，只有写死的才算
    { name: '疑似凭据赋值（有实际值）', pattern: '(?:access[_-]?token|api[_-]?key|password|passwd|secret)["\']?\\s*[:=]\\s*["\']?[A-Za-z0-9_\\-./+=]{12,}', flags: 'i',
      reject: (v) => !/[:=]\s*["']/.test(v)
        && (/[:=]\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v) || /[:=]\s*[a-z]+(?:[A-Z][a-z]+)+$/.test(v)) },
    { name: '私钥头', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----', flags: '' },
    { name: '带凭据的 URL', pattern: 'https?://[^/\\s:@]+:[^/\\s:@]+@', flags: 'i' },
  ],
  // 这些文件本来就不该进公开仓库；出现即失败（无论内容）。
  denyFiles: ['config.json', 'state/', 'audio/', '*.log', '*.bak', '*.bak-*', 'roles/*.md.bak*'],
  // 这些文件里都是占位数据，跳过不报。
  // 加进来之前要确认：里面确实只有假数据。
  allowPaths: [
    'scripts/privacy-', 'config.example.json', 'package-lock.json', 'src/sensitive.js',
    // 测试夹具/回归脚本：里面是刻意构造的假 ID 与假凭据
    'scripts/test-', 'scripts/console-ui-', 'scripts/fixtures/', 'scripts/audit-bridge-harness.mjs',
    'scripts/check-onebot-status.mjs', 'scripts/send-test-group.mjs', 'scripts/send-voice.mjs',
    'scripts/setup-dsh.mjs', 'scripts/patch-', 'scripts/verify-', 'scripts/probe-',
    // 下面几项是说明文档里的占位符示例，不是真数据。
    // 不排除它们，外部验证的人每次都会看到一片红。
  ],
};

/**
 * 判断一个 Windows 路径像不像假数据（占位符、源码片段）。
 * 只挡明显假的，别误伤真路径。
 */
function rejectWindowsPathShape(value) {
  return (/[<>…]|\.\.\./.test(value)
    || /[\\/](?:path|xxx|example)[\\/]/i.test(value)
    || /[*?|]/.test(value)
    || /\\[sSdDwWnNtT][([*+?\\]/.test(value)
    || /\\[nrt]\s/.test(value));
}

/** 用户目录规则额外排除「用户名本身就是占位符」的写法。 */
function rejectUserDirPath(value) {
  return (rejectWindowsPathShape(value)
    || /[\\/](?:someone|x|user|username|example|名字|用户名)(?:[\\/]|$)/i.test(value));
}

// 读出扫描规则，没有自定义文件就用默认的
function loadRules() {
  if (!fs.existsSync(RULES_FILE)) return { ...DEFAULT_RULES, fromFile: false };
  try {
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return {
      ...DEFAULT_RULES,
      ...raw,
      deny: [...(raw.deny ?? []), ...DEFAULT_RULES.deny],
      denyFiles: [...(raw.denyFiles ?? []), ...DEFAULT_RULES.denyFiles],
      allowPaths: [...(raw.allowPaths ?? []), ...DEFAULT_RULES.allowPaths],
      fromFile: true,
    };
  } catch (error) {
    console.error(`[privacy-scan] 无法解析 ${RULES_FILE}：${error?.message ?? error}`);
    process.exit(2);
  }
}

/** 收集要检查的文件；git 用不了就自己遍历目录 */
function listFiles() {
  // 跑一条 git 命令，失败就返回空
  const git = (a) => {
    const res = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    if (res.error || res.status !== 0) return null;
    return (res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  };
  const tracked = git(['ls-files']);
  if (tracked) {
    if (trackedOnly) return { files: tracked, via: 'git ls-files' };
    const others = git(['ls-files', '--others', '--exclude-standard']) ?? [];
    return { files: [...new Set([...tracked, ...others])], via: 'git ls-files' };
  }
  // git 用不了时改为自己遍历目录，这样也能给出有用的结果
  const ignores = readGitignorePatterns();
  const out = [];
  const seen = new Set();
  const MAX_DEPTH = 24;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  // 一层层遍历目录，把文件记下来
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH) return;
    // 有的目录会指回仓库自己，不跳过就会一直转圈。
    // 所以这里跳过所有链接，并记下走过的真实路径。
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(childRel)) continue;
      if (ignores.some((re) => re.test(childRel) || re.test(`${childRel}/`))) continue;
      const abs = path.join(dir, e.name);
      let st = null;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || (st.attributes !== undefined && (st.attributes & 0x400) !== 0)) {
        // 0x400 表示这是一个链接目录
        continue;
      }
      if (st.isDirectory()) walk(abs, childRel, depth + 1);
      else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) continue;
        out.push(childRel);
      }
    }
  };
  walk(ROOT, '', 0);
  return { files: out, via: `目录遍历（git 不可用，已尽力套用 .gitignore；跳过 ${seen.size} 个真实目录）` };
}

// 这些目录永远不看：装的包、缓存、git 数据、用户数据。
// 少跳一个，扫描就要多读几十万行代码。
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.npm-cache', '.cache', 'dist', 'build', 'coverage',
  'state', 'audio', 'assets/vendor',
]);

/** 把 .gitignore 里的简单规则转成能匹配的写法 */
function readGitignorePatterns() {
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'); } catch { return []; }
  const out = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const p = line.replace(/^\//, '').replace(/\/$/, '');
    if (!p) continue;
    // *.log 这种要匹配任意目录下的同名文件，不能只看根目录
    const hasSlash = p.includes('/');
    const base = hasSlash ? p : path.basename(p);
    const baseRe = globToRe(hasSlash ? p : base).source;
    try {
      out.push(hasSlash
        ? new RegExp(`(?:^|/)${baseRe}(?:/|$)`)
        : new RegExp(`(?:^|/)${baseRe}$`));
    } catch { /* 看不懂的规则就不管它 */ }
  }
  return out;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.wav', '.mp3', '.ico', '.zip', '.tgz', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.zstd']);

// 看文件开头有没有 0，判断是不是二进制
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// 只留头尾，中间打码，别把敏感内容打出来
function mask(snippet) {
  // 只保留头尾，中间打码——报告本身不能成为泄漏源。
  const s = String(snippet).replace(/[\r\n]+/g, ' ').trim();
  if (s.length <= 12) return s.replace(/./g, '*');
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

// 把简单通配写法转成正则
function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}

const rules = loadRules();
if (process.env.QQ_BRIDGE_PRIVACY_DEBUG) console.error('[privacy-scan:debug] rules loaded');
const listed = listFiles();
if (process.env.QQ_BRIDGE_PRIVACY_DEBUG) console.error(`[privacy-scan:debug] listed ${listed.files.length} files via ${listed.via}`);
const files = listed.files;
if (!files.length) {
  console.error('[privacy-scan] 没有拿到任何文件（目录遍历失败或仓库为空）');
  process.exit(2);
}

const allowRe = rules.allowPaths.map((p) => (p.includes('*') ? globToRe(p) : new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&')}`)));
const denyFileRes = rules.denyFiles.map((p) => ({ glob: p, re: globToRe(p) }));

const findings = [];
for (const rel of files) {
  const normalized = rel.split(path.sep).join('/');
  // ① 文件级：本来就不该出现的文件
  for (const { glob, re } of denyFileRes) {
    if (re.test(normalized)) findings.push({ kind: 'file', rule: `不应入库的文件（${glob}）`, file: normalized, masked: '' });
  }
  if (allowRe.some((re) => re.test(normalized))) continue;
  if (BINARY_EXT.has(path.extname(normalized).toLowerCase())) continue;
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; }
  if (looksBinary(buf)) continue;
  const text = buf.toString('utf8');
  // ② 内容级：一个文件里同一规则最多报 3 处（带行号），方便直接定位；不要把整文件刷屏。
  for (const rule of rules.deny) {
    let re;
      // 正则必须带 g，否则会卡在同一个位置反复命中。
      // 那会造成同一条报好几次，还会被误判成匹配太多。
    const flags = new Set((rule.flags ?? '').split(''));
    flags.add('g');
    try { re = new RegExp(rule.pattern, [...flags].join('')); }
    catch (error) { console.error(`[privacy-scan] 规则「${rule.name}」正则非法：${error.message}`); continue; }
    re.lastIndex = 0;
    let m;
    let hits = 0;       // 已经报了几条（最多 3 条）
    let attempts = 0;   // 正则一共试了多少次（包括被挡掉的）
    const started = Date.now();
  // 迭代次数要单独限，因为被过滤掉的匹配不算命中，但也会耗时间。
  // 一份全是十六进制串的文档能让扫描卡死。
    while ((m = re.exec(text)) !== null && hits < 3 && attempts < 5000 && Date.now() - started < 3000) {
      attempts += 1;
      const value = m[0];
      if (m.index === re.lastIndex) re.lastIndex += 1; // 防止空匹配卡住
      if (rule.reject && rule.reject(value)) continue;
      if (isNoise(value, rule)) continue;
      hits += 1;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ kind: 'content', rule: rule.name, file: normalized, line, masked: mask(value) });
    }
    if (attempts >= 5000 || Date.now() - started >= 3000) {
      // 没扫完要算失败，不能只说一声，否则会让人以为没问题
      console.error(`[privacy-scan] ❌ ${normalized} 的「${rule.name}」匹配过多/过慢，已提前结束该规则（结果不完整）`);
      findings.push({ kind: 'scan', rule: `扫描未完成（${rule.name}）`, file: normalized, masked: '' });
    }
  }
}

/**
 * 把明显不是秘密的命中挡掉，免得报告里全是噪音。
 * 真凭据一般是大写、小写、数字混在一起。
 */
function isNoise(value, rule) {
  if (rule.requireNonHex && /^[0-9a-f]+$/i.test(value)) return true;
  // 全大写的多是常量名，不可能是凭据
  if (/^[A-Z0-9_-]+$/.test(value)) return true;
  if (/^[a-z0-9._-]+$/.test(value)) return true;                     // 文件名、包名、路径片段
  if (/^[A-Za-z0-9]+$/.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value))) return true;
  return false;
}

/**
 * 扫 git 历史里已经提交过、后来又删掉的内容。
 * 删文件删不掉历史，这类内容最危险。
 */
const HISTORY_RULES = [
  {
    name: '本机绝对路径（Windows 用户目录）',
    check: /[A-Za-z]:\\Users\\[^\\"'`<>]{2,}/,
    // 这些是示例里的占位写法，不算真路径
    reject: rejectUserDirPath,
  },
  {
    name: '本机绝对路径（非系统盘）',
    // 路径中间允许有空格，真实目录常常带空格
    check: /[A-Za-z]:\\[^\\"<>]+\\[^\\"<>]+\\/,
    reject: (v) => (/^[Cc]:/.test(v) || rejectWindowsPathShape(v)),
  },
  { name: '私钥头', check: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: '带凭据的 URL',
    check: /https?:\/\/[^/\s:@]+:[^/\s:@]+@/,
    // 只有密码或主机明显是占位符时才放过
    reject: (v) => (/[<>…]/.test(v) || /:(?:pass|password|placeholder|test|demo)@/i.test(v)
      || /@(?:host|localhost|example)(?:[:/]|$)/i.test(v)),
  },
  {
    name: '已知密钥前缀',
    check: /(?:sk-|ghp_|gho_|ghs_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{16,}/,
    // 测试用的假 key 是小写加连字符，不算真凭据
    reject: (v) => (/(?:test|fake|dummy|example|fixture|sample)/i.test(v) || /^[a-z0-9_-]+$/.test(v)),
  },
  {
    name: 'QQ 号/群号（9-10 位连续数字）',
    check: /(?<![0-9])[1-9][0-9]{8,9}(?![0-9])/,
    noise: true,
  },
];

const HISTORY_MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** 查这个文件内容第一次出现在哪个提交里 */
function commitsForBlob(oid) {
  try {
    const res = spawnSync('git', ['log', '--all', '--find-object', oid, '--format=%h', '--max-count=3'],
      { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    if (res.error || res.status !== 0) return '';
    return (res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3).join(',');
  } catch {
    return '';
  }
}

/**
 * 把历史里每一份文件内容都读出来，用同一套规则扫。
 * 这样不受 git 自带搜索的方言差异影响。
 */
function scanHistory() {
  const revs = spawnSync('git', ['-c', 'core.quotepath=false', 'rev-list', '--all', '--objects'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
  if (revs.error || revs.status !== 0 || !(revs.stdout ?? '').trim()) {
    console.error('[privacy-scan] ❌ 历史扫描失败：拿不到 git 对象列表');
    findings.push({ kind: 'history', rule: '历史扫描没有执行', file: '(git rev-list)', masked: '' });
    return;
  }

  // 只要文件内容，同一份内容只扫一次，并按 oid 去重（同一内容出现在多个提交里只扫一次）。
  const typed = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(rest)'],
    { cwd: ROOT, encoding: 'utf8', input: revs.stdout, timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
  if (typed.error || typed.status !== 0) {
    console.error('[privacy-scan] ❌ 历史扫描失败：无法识别 git 对象类型');
    findings.push({ kind: 'history', rule: '历史扫描没有执行', file: '(git cat-file)', masked: '' });
    return;
  }
  const blobs = new Map(); // 每份内容第一次出现时的路径
  for (const line of (typed.stdout ?? '').split('\n')) {
    const i = line.indexOf(' ');
    if (i < 0) continue;
    const oid = line.slice(0, i);
    const rest = line.slice(i + 1);
    const j = rest.indexOf(' ');
    if (j < 0) continue;
    if (rest.slice(0, j) !== 'blob') continue;
    const p = rest.slice(j + 1);
    if (!p || BINARY_EXT.has(path.extname(p).toLowerCase())) continue;
    if (!blobs.has(oid)) blobs.set(oid, p);
  }
  if (!blobs.size) return;

  const batch = spawnSync('git', ['cat-file', '--batch'],
    { cwd: ROOT, input: `${[...blobs.keys()].join('\n')}\n`, timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
  if (batch.error || batch.status !== 0 || !batch.stdout) {
    console.error('[privacy-scan] ❌ 历史扫描失败：无法读取历史文件内容');
    findings.push({ kind: 'history', rule: '历史扫描没有执行', file: '(git cat-file --batch)', masked: '' });
    return;
  }

  const seen = new Set();
  // 每条规则只编译一次，不然几十万行会很慢
  const compiled = new Map();
  // 在历史内容里逐行用规则找
  const scanLine = (rule, fileKey, fileLabel, lineNo, text) => {
    if (!text) return;
    let re = compiled.get(rule);
    if (!re) {
      const flags = new Set(rule.check.flags.split(''));
      flags.add('g');
      re = new RegExp(rule.check.source, [...flags].join(''));
      compiled.set(rule, re);
    }
    let m;
    let hits = 0;
    while ((m = re.exec(text)) !== null && hits < 3) {
      if (m.index === re.lastIndex) re.lastIndex += 1;
      const value = m[0];
      if (rule.reject && rule.reject(value)) continue;
      if (rule.noise && isNoise(value, {})) continue;
      hits += 1;
      const masked = mask(value);
      // 同一处泄漏会在多个提交里重复出现，去重后再报
      const key = `${rule.name}|${fileKey}|${masked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = typeof fileLabel === 'function' ? fileLabel() : fileLabel;
      findings.push({ kind: 'history', rule: rule.name, file, line: lineNo, masked });
    }
  };

  let pos = 0;
  while (pos < batch.stdout.length) {
    const nl = batch.stdout.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = batch.stdout.toString('utf8', pos, nl);
    pos = nl + 1;
    const [oid, type, sizeText] = header.split(' ');
    if (type === 'missing') break;
    const size = Number(sizeText);
    if (!Number.isFinite(size)) break;
    const content = batch.stdout.subarray(pos, pos + size);
    pos += size + 1; // 跳过 git 自己加的那个换行
    if (type !== 'blob') continue;
    if (size > HISTORY_MAX_BLOB_BYTES || looksBinary(content)) continue;
    const file = blobs.get(oid) ?? '(unknown)';
    // 真命中了才去查提交号，查一次很慢（`git log --find-object` 不便宜）。
    const label = () => {
      const commits = commitsForBlob(oid);
      return commits ? `${file} @ ${commits}` : file;
    };
    const lines = content.toString('utf8').split('\n');
    for (const rule of HISTORY_RULES) {
      for (let ln = 0; ln < lines.length; ln += 1) scanLine(rule, file, label, ln + 1, lines[ln]);
    }
  }

  // 提交说明也是公开的，一起扫（`git log` 直接可见），一并扫描。
  const log = spawnSync('git', ['--no-pager', 'log', '--all', '--format=%h%x09%B%x00'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (!log.error && log.status === 0) {
    for (const record of (log.stdout ?? '').split('\u0000')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const hash = record.slice(0, tab).trim();
      const body = record.slice(tab + 1).split('\n');
      for (const rule of HISTORY_RULES) {
        const label = `(commit message) @ ${hash}`;
        body.forEach((line, i) => scanLine(rule, label, label, i + 1, line));
      }
    }
  }
}

if (withHistory) scanHistory();

if (asJson) {
  console.log(JSON.stringify({ rulesFromFile: rules.fromFile, source: listed.via, scanned: files.length, historyScanned: withHistory, findings }, null, 2));
} else {
  console.log(`[privacy-scan] 规则来源：${rules.fromFile ? 'scripts/privacy-rules.json + 内置默认' : '仅内置默认（建议补 privacy-rules.json）'}`);
  console.log(`[privacy-scan] 扫描文件数：${files.length}（来源：${listed.via}${withHistory ? '；含 git 历史' : ''}）`);
  if (!findings.length) {
    console.log('[privacy-scan] ✅ 未发现敏感信息。');
  } else {
    console.log(`[privacy-scan] ❌ 发现 ${findings.length} 处问题：`);
    for (const f of findings) {
      console.log(`   - [${f.kind}] ${f.rule} → ${f.file}${f.masked ? `  （命中片段：${f.masked}）` : ''}`);
    }
    console.log('[privacy-scan] 处理方式：① 真实数据删掉/换占位符；② 该文件本就该忽略 → 加进 .gitignore；');
    console.log('[privacy-scan] ③ 是脱敏模板/测试夹具的误报 → 加进 privacy-rules.json 的 allowPaths。');
    console.log('[privacy-scan] ⚠️ 已经提交过的内容光删文件没用：还要清历史（git filter-repo）或干脆新建仓库。');
  }
}
process.exitCode = findings.length ? 1 : 0;
