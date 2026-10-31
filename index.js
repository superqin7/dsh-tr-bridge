/**
 * DeepSeek Harness -> TokenRouter CLI bridge (host-only).
 *
 * Checked against the installed DeepSeek Harness 0.2.1-rc.5 contracts:
 * ctx.tools.register stores model-facing JSON Schema and requires
 * output.schema to be the supported subset; ctx.subprocess.spawn takes an
 * explicit argv and on Windows resolves only .exe/.com through CreateProcessW.
 * The session directory comes from workingDirectory.ensure(), which includes
 * later cd changes, not only session.header.cwd.
 * Login stays in the existing TokenRouter config. This plugin does not read
 * or forward an API key.
 */
import { resolveTrLauncher } from './resolve-tr.js'

export const name = 'dsh-tr-bridge'
export const inject = ['tools', 'subprocess', 'workingDirectory']

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TASK_CHARS = 20_000
const MAX_RESULT_CHARS = 24_000
const MAX_STDERR_CHARS = 4_000
const GROK_READ_TOOLS = 'read_file,grep,list_dir'

const AGENTS = new Set(['codex', 'grok'])

export const toolParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent: { type: 'string', enum: ['codex', 'grok'], description: '目标代理 codex 或 grok' },
    task: { type: 'string', description: '完整自包含任务。目标 CLI 不会自动获得 Harness 聊天历史。' },
    dryRun: { type: 'boolean', description: 'true 仅预览，不消耗 Token；默认 false。' },
  },
  required: ['agent', 'task'],
}

export function commandFor(agent, task, launcher = 'tr', options = {}) {
  if (!AGENTS.has(agent)) throw new Error('仅支持 codex 或 grok')
  if (typeof task !== 'string' || !task.trim()) throw new Error('任务内容不能为空')
  if (task.includes('\0')) throw new Error('任务内容含有非法控制字符')
  if (task.length > MAX_TASK_CHARS) throw new Error(`任务不得超过 ${MAX_TASK_CHARS} 个字符`)
  if (typeof launcher !== 'string' || !launcher.trim()) throw new Error('tr 启动器路径不能为空')

  // Direct argv. The task is one argument and is never interpolated into a shell string.
  if (agent === 'codex') {
    return [launcher, 'codex', 'exec', '--sandbox', 'read-only', '--color', 'never', '--ephemeral', '--', task]
  }
  const prompt = `请只阅读、分析或讨论。不得修改文件、执行有副作用的命令或发起部署。\n\n${task}`
  const argv = [
    launcher,
    'grok',
    '--permission-mode', 'dontAsk',
    '--tools', GROK_READ_TOOLS,
    '--no-subagents',
    '--deny', 'Bash',
    '--deny', 'Edit',
    '--deny', 'Write',
    '--deny', 'MCPTool',
    '--deny', 'WebFetch',
  ]
  if (options.grokWebSearch !== true) argv.push('--disable-web-search')
  argv.push('-p', prompt)
  return argv
}

export async function resolveWorkspace(exec, workingDirectory) {
  // 0.2.1-rc.5 stores the original project on session.header.cwd and later
  // cd changes on the workingDirectory projection. ensure() returns the
  // directory the session is actually using.
  if (typeof workingDirectory?.ensure === 'function' && exec?.agent) {
    const cwd = await workingDirectory.ensure(exec.agent, exec.signal)
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('请先在 DeepSeek Harness 选择一个可信任的项目工作区，再使用 TR Bridge。')
    }
    return cwd
  }
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('请先在 DeepSeek Harness 选择一个可信任的项目工作区，再使用 TR Bridge。')
  }
  return cwd
}

export function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|password|TR_SETUP_KEY)\s*[:=]\s*["']?[^\s"']+/gi, '[REDACTED]')
    .replace(/API密钥\s*[:：]\s*\S+/g, 'API密钥：[REDACTED]')
}

export function clip(text, max = MAX_RESULT_CHARS) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = Math.floor(max * 0.25)
  return `${text.slice(0, head)}\n\n[内容过长，已截断]\n\n${text.slice(-tail)}`
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function appendBounded(previous, chunk, limit) {
  const room = limit - previous.length
  return room > 0 ? previous + String(chunk).slice(0, room) : previous
}

function readConfig(config = {}) {
  const trCommand = typeof config.trCommand === 'string' && config.trCommand.trim()
    ? config.trCommand.trim()
    : 'tr'
  const timeoutMs = Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.min(config.timeoutMs, 30 * 60 * 1000))
    : DEFAULT_TIMEOUT_MS
  return {
    trCommand,
    timeoutMs,
    grokWebSearch: config.grokWebSearch === true,
  }
}

export function previewLaunch(launcher, agent, task, options = {}) {
  const argv = commandFor(agent, task, launcher.file, options)
  const hidden = [...argv]
  hidden[hidden.length - 1] = `[任务内容 ${task.length} 字符，已隐藏]`
  const skipped = launcher.skippedScripts?.length
    ? `\n已跳过脚本启动器：${launcher.skippedScripts.join('；')}`
    : ''
  const limit = agent === 'grok'
    ? 'Grok 使用 dontAsk、只读工具允许列表和拒绝规则。这不是 Windows 内核沙箱；操作系统级隔离未验证。'
    : 'Codex 请求 --sandbox read-only。真实限制由 Codex CLI 和操作系统决定。'
  return `TR Bridge 预览（未执行）\n工作目录：${options.cwd}\n启动器：${launcher.file}（${launcher.source}）\n参数：${JSON.stringify(hidden)}\n目标：${agent}\n${limit}${skipped}`
}

export async function invoke({ subprocess, argv, cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (signal?.aborted) throw new Error('任务已取消')
  const child = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3000,
    signal,
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk, MAX_RESULT_CHARS * 2) })
  child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk, MAX_STDERR_CHARS) })
  child.stdin?.end()

  let timer
  let onAbort
  const canceled = new Promise((_, reject) => {
    onAbort = () => reject(new Error('任务已取消'))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('执行超时')), timeoutMs)
  })

  try {
    const status = await Promise.race([child.done, canceled, timedOut])
    if (!status || status.exitCode !== 0) {
      throw new Error(`TR 子进程退出码 ${status?.exitCode ?? 'unknown'}：${clip(redact((stderr || stdout).trim()), 1000)}`)
    }
    const answer = stripAnsi(stdout).trim()
    if (!answer) throw new Error('TR 子进程正常退出，但未返回任何文本')
    return clip(redact(answer))
  } catch (error) {
    try { child.terminate?.() } catch { /* best effort */ }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function launchError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (error?.code === 'TR_LAUNCHER_UNUSABLE') return new Error(redact(message))
  if (/ENOENT|EINVAL|not found|was not found on PATH|找不到指定的文件|系统找不到|SubprocessExecutableNotFoundError/i.test(message)) {
    return new Error(`无法启动 tr。桌面版 PATH 可能看不到 PowerShell 里的 tr；.cmd 也不能直接交给 CreateProcessW。请把插件配置 trCommand 设为 tr.exe 的完整路径。原始错误：${redact(message)}`)
  }
  if (/trusted|Trust|not a git|git repo|不受信任/i.test(message)) {
    return new Error(`Codex 拒绝了当前目录。请在 Harness 中选择已信任的 Git 项目，不要为了绕过检查关闭信任。原始错误：${redact(message)}`)
  }
  return new Error(`tr 调用失败：${redact(message)}`)
}

export function apply(ctx, config = {}) {
  if (typeof ctx?.tools?.register !== 'function') {
    throw new Error('DSH tools 服务不可用。请在 Desktop 基础 profile 中启用本插件。')
  }
  const settings = readConfig(config)
  if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) {
    throw new Error('timeoutMs 必须是正数')
  }

  ctx.tools.register({
    name: 'tr_bridge',
    description: '使用已经登录的 TokenRouter tr codex / tr grok 派发独立任务。不读取、不要求 API Key。先用 dryRun 查看实际启动器路径和参数；用户明确要求后再执行。Codex 请求 read-only sandbox。Grok 使用 dontAsk 和只读工具允许列表，这不是 Windows 内核沙箱。可并发调用不同 agent。',
    parameters: toolParameters,
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    timeoutMs: settings.timeoutMs + 30_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: `TokenRouter → ${args?.agent ?? '?'}`,
      kind: args?.dryRun ? 'read' : 'execute',
      rawInput: args,
    }),
    async execute(args, exec) {
      const agent = args?.agent
      const task = args?.task
      const launcher = resolveTrLauncher(settings.trCommand)
      const argv = commandFor(agent, task, launcher.file, settings)
      const directory = ctx.workingDirectory ?? ctx.get?.('workingDirectory')
      const cwd = await resolveWorkspace(exec, directory)
      if (args?.dryRun === true) return previewLaunch(launcher, agent, task, { ...settings, cwd })
      const subprocess = ctx.get?.('subprocess') ?? ctx.subprocess
      if (!subprocess?.spawn) throw new Error('DSH subprocess 服务不可用，请检查插件是否已启用。')
      try {
        const answer = await invoke({
          subprocess,
          argv,
          cwd,
          signal: exec?.signal,
          timeoutMs: settings.timeoutMs,
        })
        return `[由 tr ${agent} 执行]\n${answer}`
      } catch (error) {
        throw launchError(error)
      }
    },
  })
}
