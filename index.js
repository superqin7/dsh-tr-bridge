/**
 * DeepSeek Harness -> TokenRouter CLI bridge (host-only).
 * Uses the verified commands `tr codex exec` and `tr grok -p`.
 * No API keys, shell interpolation, or direct Codex/Grok login paths.
 */
export const name = 'dsh-tr-bridge'
export const inject = ['tools', 'subprocess']

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TASK_CHARS = 20_000
const MAX_RESULT_CHARS = 24_000
const MAX_STDERR_CHARS = 4_000

const AGENTS = new Set(['codex', 'grok'])

export function commandFor(agent, task, trCommand = 'tr') {
  if (!AGENTS.has(agent)) throw new Error('仅支持 codex 或 grok')
  if (typeof task !== 'string' || !task.trim()) throw new Error('任务内容不能为空')
  if (task.length > MAX_TASK_CHARS) throw new Error(`任务不得超过 ${MAX_TASK_CHARS} 个字符`)
  if (typeof trCommand !== 'string' || !trCommand.trim()) throw new Error('trCommand 配置不能为空')

  // Direct argv transport: a prompt can never become a second shell command.
  if (agent === 'codex') {
    return [trCommand, 'codex', 'exec', '--sandbox', 'read-only', task]
  }
  return [trCommand, 'grok', '-p', `请只阅读、分析或讨论；不得修改文件、执行有副作用的操作或发起部署。\n\n${task}`]
}

export function resolveWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw new Error('请先在 DeepSeek Harness 选择一个可信任的项目工作区，再使用 TR Bridge。')
  }
  return cwd
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|gho|github_pat)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|token|password)\s*[:=]\s*["']?[^\s"']+/gi, '[REDACTED]')
}

function clip(text, max = MAX_RESULT_CHARS) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = Math.floor(max * 0.25)
  return `${text.slice(0, head)}\n\n[内容过长，已截断]\n\n${text.slice(-tail)}`
}

function appendBounded(previous, chunk, limit) {
  const room = limit - previous.length
  return room > 0 ? previous + String(chunk).slice(0, room) : previous
}

export async function invoke({ subprocess, argv, cwd, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // Executable is resolved by Harness's subprocess service, never through a shell.
  const child = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3000,
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
    if (!stdout.trim()) throw new Error('TR 子进程正常退出，但未返回任何文本')
    return clip(redact(stdout.trim()))
  } catch (error) {
    try { child.terminate?.() } catch { /* best effort */ }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

export function apply(ctx, config = {}) {
  const trCommand = typeof config.trCommand === 'string' && config.trCommand.trim()
    ? config.trCommand
    : 'tr'
  const timeoutMs = Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.min(config.timeoutMs, 30 * 60 * 1000))
    : DEFAULT_TIMEOUT_MS

  ctx.tools.register({
    name: 'tr_bridge',
    description: '使用 TokenRouter 的 tr codex / tr grok 已登录链路派发独立的只读任务。先用 dryRun 查看实际参数；用户明确要求后再执行。可并发调用不同 agent，结果返回当前会话。Grok 的只读限制属于提示词约束，不能代替操作系统权限隔离。',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['codex', 'grok'], description: '目标代理 codex 或 grok' },
        task: { type: 'string', description: '完整自包含的只读任务。目标 CLI 不会自动获得 Harness 聊天历史。' },
        dryRun: { type: 'boolean', description: 'true 仅预览，不消耗 Token；默认 false。' },
      },
      required: ['agent', 'task'],
    },
    output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }] } },
    timeoutMs: timeoutMs + 30_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: `TokenRouter → ${args?.agent ?? '?'}`,
      kind: args?.dryRun ? 'read' : 'execute',
      rawInput: args,
    }),
    async execute(args, exec) {
      const argv = commandFor(args?.agent, args?.task, trCommand)
      const cwd = resolveWorkspace(exec)
      if (args?.dryRun === true) {
        const preview = [...argv]
        preview[preview.length - 1] = `[任务内容 ${args.task.length} 字符，已隐藏]`
        return `TR Bridge 预览（未执行）\n工作目录：${cwd}\n参数：${JSON.stringify(preview)}\n目标：${args.agent}\n默认只读；Grok 仅为提示词约束。`
      }
      const subprocess = ctx.get('subprocess')
      if (!subprocess?.spawn) throw new Error('DSH subprocess 服务不可用，请检查插件是否已启用。')
      try {
        const answer = await invoke({ subprocess, argv, cwd, signal: exec?.signal, timeoutMs })
        return `[由 tr ${args.agent} 执行]\n${answer}`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/ENOENT|not found|找不到指定的文件|系统找不到/i.test(message)) {
          throw new Error(`无法启动 tr。请确认桌面版能找到 TR CLI；必要时在插件配置 trCommand 中指定 tr.exe 的完整路径。原始错误：${redact(message)}`)
        }
        throw new Error(`tr ${args.agent} 调用失败：${redact(message)}`)
      }
    },
  })
}
