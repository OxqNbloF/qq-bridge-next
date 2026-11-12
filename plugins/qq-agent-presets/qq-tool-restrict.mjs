// QQ 桥接的安全边界：只放行 QQ 工具和少量无害工具
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 唯一实现：注册时隐藏危险工具，调用时按白名单拦截。
// 危险工具必须列进隐藏名单，否则拦不住。
import { sessionBindingDenial } from './qq-self-key.mjs'

export const name = 'qq-tool-restrict'

export const inject = ['tools']

/** 仿真会话绝对不能拥有的本地执行、文件、进程类工具 */
const LOCAL_EXECUTION_TOOLS = [
  // 命令行和进程
  'pwsh', 'bash',
  // 读写文件
  'read', 'read_image', 'write', 'edit', 'apply_patch', 'str_replace_editor',
  // 查找文件
  'glob', 'grep',
  // 能拿到运行环境，等于能执行代码
  'load_workspace_dependencies',
  // 能叫出别的 AI，还能间接用到命令行
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 能读运行它的那个程序的内部状态
  'cordis_inspect_list', 'cordis_inspect_query',
  // 能改配置并启动外部程序
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话和任务类工具（待办、提问除外）
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 全局默认开启，会进到仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // 能叫出别的 AI，或执行外部程序
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  // 能装插件，等于能执行任意代码
  'plugin_manager',
  // 能自己安排定时任务
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  // DSH 默认开启，会继承到仿真会话
  'working_directory',
  // 终端，等于命令行
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // 能翻别的会话的历史
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  // 能装东西、写硬盘、起进程
  'plugin_market', 'create_worktree',
  // 团队协作类工具
  'wait_agent',
  // 已安装但还没打包的插件
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/** 可选能力包的工具名，装上就要挡 */
export const OPTIONAL_BUNDLE_TOOL_NAMES = Object.freeze([
  'subagent_codex',
  'subagent_claude_code',
])

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行类
  ...LOCAL_EXECUTION_TOOLS,
  // 按需安装的可选能力包
  ...OPTIONAL_BUNDLE_TOOL_NAMES,
  // 开发工具的运行时接口，只能尽量拦
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 导出给测试用，也和 DSH 真实工具名核对
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 调用时的白名单：不在名单里的工具一律拒绝
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

// 无害的模型侧工具：问管理员、维护待办
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

// 记录拦截失败原因，并在 3 秒后重试一次
const DIAG_FILE = (() => {
  // 测试时可以改到临时文件
  if (process.env.QQ_TOOL_RESTRICT_LOG) return path.resolve(process.env.QQ_TOOL_RESTRICT_LOG)
  try {
    // 往上两层是仓库根目录
    return fileURLToPath(new URL('../../state/tool-restrict.log', import.meta.url))
  } catch { return '' }
})()

// 往日志里追加诊断，只保留最近 20 条
function writeDiagnostics(lines) {
  if (!DIAG_FILE || !lines.length) return
  // 每行截断，DSH 报错会带整份工具清单
  const trim = (line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line)
  try {
    // 先读出旧日志的内容
    const previous = (() => {
      try { return fs.readFileSync(DIAG_FILE, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    })()
    // 只保留最近 20 条
    const next = [...previous, ...lines.map(trim)].slice(-20)
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true })
    fs.writeFileSync(DIAG_FILE, next.join('\n') + '\n', 'utf8')
  } catch {}
}

// 每会话只记一次拒绝，只记会话编号和工具名
const loggedBindingDenials = new Set()

// 记录一次会话绑定拒绝
function noteBindingDenial(exec, name) {
  try {
    const id = String(exec?.agent?.id ?? '') || '(无 agent)'
    if (loggedBindingDenials.has(id)) return
    if (loggedBindingDenials.size > 200) loggedBindingDenials.clear()
    loggedBindingDenials.add(id)
    console.error(`[qq-tool-restrict] 拒绝 ${name}：会话绑定校验未通过（agent.id=${id}；` +
      '这通常意味着该会话不是桥接创建的，或 exec 上没有 agent 字段）')
  } catch {}
}

// 插件入口：注册隐藏名单和调用时的检查
export function apply(ctx) {
  // 逐个隐藏危险工具，一个失败不影响整批
  const stamp = new Date().toISOString()
  const failed = []
  // 隐藏一批工具名，返回成功个数
  const attempt = (names) => {
    let ok = 0
    for (const name of names) {
      try {
        ctx.tools.restrict({ deny: [name] })
        ok += 1
      } catch (error) {
        failed.push({ name, message: String(error?.message ?? error) })
      }
    }
    return ok
  }

  const firstOk = attempt(KNOWN_DANGEROUS_GLOBAL_TOOLS)
  const firstFailed = failed.slice()
  failed.length = 0

  if (firstFailed.length > 0) {
    // 同类报错合并成一行
    const reasons = [...new Set(firstFailed.map((f) => f.message))]
    console.error(
      `[qq-tool-restrict] restrict 失败 ${firstFailed.length}/${KNOWN_DANGEROUS_GLOBAL_TOOLS.length}：${reasons.join(' | ')}`
    )
    writeDiagnostics([
      `${stamp} restrict ok=${firstOk} failed=${firstFailed.length} 原因: ${reasons.join(' | ')}`,
      `${stamp} 失败样例: ${firstFailed.slice(0, 3).map((f) => f.name).join(', ')}`,
    ])
    // 3 秒后重试失败的工具，兼容工具注册得晚
    const timer = setTimeout(() => {
      let ok = 0
      const still = []
      for (const { name } of firstFailed) {
        try { ctx.tools.restrict({ deny: [name] }); ok += 1 } catch (error) { still.push(`${name}: ${error?.message ?? error}`) }
      }
      if (ok > 0) console.error(`[qq-tool-restrict] 延迟重试补藏成功 ${ok} 个`)
      writeDiagnostics([
        `${new Date().toISOString()} 延迟重试 ok=${ok} 仍失败=${still.length}${still.length ? ` 原因: ${still[0]}` : ''}`,
      ])
    }, 3000)
    timer?.unref?.()
  }

  // 调用时检查白名单和会话绑定；身份取自执行记录，模型改不了
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (SAFE_EXACT.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      // 带 key 的 QQ 工具必须指向当前会话；没绑定也拒绝
      const denial = sessionBindingDenial(exec, exec?.arguments)
      if (denial) {
        noteBindingDenial(exec, name)
        return denial
      }
      return
    }
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
