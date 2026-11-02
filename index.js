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
 *
 * 0.3.0 also registers optional native `tr-codex` and `tr-grok` LlmAdapters.
 * They are additive: if the llm service or launcher is unavailable, the two
 * tools above still register and behave exactly as before.
 */
import {
  applySelectionChange,
  handleConfigRpc,
  registerConfigChannel,
} from './config-api.js'
import {
  agentIds,
  agentProviders,
  authorizeModel,
  defaultSelectionFile,
  emptySelection,
  formatCatalog,
  modelArgs,
  readSelection,
  refreshAgent,
  resolveModelChoice,
  selectionFromConfig,
  workspaceOrTemp,
} from './models.js'
import { resolveTrLauncher } from './resolve-tr.js'
import { defaultLlmCwd, registerTrCodexProvider, registerTrGrokProvider } from './llm/providers.js'

export const name = 'dsh-tr-bridge'
export const inject = ['tools', 'subprocess', 'workingDirectory']

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TASK_CHARS = 20_000
const MAX_RESULT_CHARS = 24_000
const MAX_STDERR_CHARS = 4_000
const GROK_READ_TOOLS = 'read_file,grep,list_dir'

const AGENTS = new Set(agentIds())

export const toolParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent: { type: 'string', enum: agentIds(), description: '目标代理。当前为 codex 或 grok；新增 agent 时由注册表扩展，不写死模型 ID。' },
    task: { type: 'string', description: '完整自包含任务。目标 CLI 不会自动获得 Harness 聊天历史。' },
    model: { type: 'string', description: '可选。本次任务的模型 ID，必须来自 tr_bridge_models 刷新到的该 agent 清单。显式值优先于插件默认值。省略则使用已保存默认值；都没有则不传 --model，沿用 CLI 默认。' },
    member: { type: 'string', description: '可选。AgentTeams 成员 ID。未传 model 时使用该成员已保存的模型，且成员绑定的 agent 必须一致。' },
    dryRun: { type: 'boolean', description: 'true 仅预览，不消耗 Token；默认 false。' },
  },
  required: ['agent', 'task'],
}

export const modelToolParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['refresh', 'set-default', 'clear-default'], description: 'refresh 重新查询授权清单；set-default 保存默认模型；clear-default 清除已保存默认值。' },
    agent: { type: 'string', enum: agentIds(), description: 'set-default 和 clear-default 必填。refresh 省略时查询全部已注册 agent。' },
    model: { type: 'string', description: 'set-default 使用的模型 ID。必须出现在本次刷新的该 agent 可选项中。' },
    member: { type: 'string', description: '可选。只保存或清除这个成员的模型，不影响其他成员和全局默认值。' },
  },
  required: ['action'],
}

export function commandFor(agent, task, launcher = 'tr', options = {}) {
  if (!AGENTS.has(agent)) throw new Error('仅支持 codex 或 grok')
  if (typeof task !== 'string' || !task.trim()) throw new Error('任务内容不能为空')
  if (task.includes('\0')) throw new Error('任务内容含有非法控制字符')
  if (task.length > MAX_TASK_CHARS) throw new Error(`任务不得超过 ${MAX_TASK_CHARS} 个字符`)
  if (typeof launcher !== 'string' || !launcher.trim()) throw new Error('tr 启动器路径不能为空')

  // Direct argv. The task is one argument and is never interpolated into a shell string.
  if (agent === 'codex') {
    return [launcher, 'codex', 'exec', '--sandbox', 'read-only', '--color', 'never', '--ephemeral', ...modelArgs(agent, options.model), '--', task]
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
  argv.push(...modelArgs(agent, options.model), '-p', prompt)
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
    llmCwd: typeof config.llmCwd === 'string' && config.llmCwd.trim()
      ? config.llmCwd.trim()
      : defaultLlmCwd(),
    llmCatalogPath: config.llmCatalogPath === null
      ? null
      : (typeof config.llmCatalogPath === 'string' && config.llmCatalogPath.trim()
          ? config.llmCatalogPath.trim()
          : undefined),
    selection: selectionFromConfig(config),
    selectionFile: typeof config.selectionFile === 'string' && config.selectionFile.trim()
      ? config.selectionFile.trim()
      : null,
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
  const modelLine = options.model
    ? `模型：${options.model}（${options.modelSource || 'explicit'}）`
    : '模型：未指定，不传 --model，沿用 CLI 当前默认。'
  const checked = options.modelChecked ? `\n授权：已在本次 ${agent} 清单中确认。` : ''
  return `TR Bridge 预览（未执行）\n工作目录：${options.cwd}\n启动器：${launcher.file}（${launcher.source}）\n${modelLine}${checked}\n参数：${JSON.stringify(hidden)}\n目标：${agent}\n${limit}${skipped}`
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

function selectionFile(settings) {
  return settings.selectionFile || defaultSelectionFile()
}

function loadSaved(settings) {
  return readSelection(selectionFile(settings))
}

async function authorize(agent, model, launcher, subprocess, cwd, signal) {
  const { match } = await authorizeModel({
    agent,
    model,
    launcher: launcher.file,
    subprocess,
    cwd,
    signal,
  })
  return match
}

export function apply(ctx, config = {}) {
  if (typeof ctx?.tools?.register !== 'function') {
    throw new Error('DSH tools 服务不可用。请在 Desktop 基础 profile 中启用本插件。')
  }
  const settings = readConfig(config)
  if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) {
    throw new Error('timeoutMs 必须是正数')
  }

  const output = {
    schema: { type: 'string' },
    render(_args, value) { return [{ type: 'text', text: String(value) }] },
  }

  ctx.tools.register({
    name: 'tr_bridge_models',
    description: '刷新 TokenRouter 当前设备上 Codex / Grok CLI 实际列出的模型，或保存某个 agent 的默认模型。不读取、不要求 API Key。插件页的配置界面调用同一套保存逻辑。清单代表查询当时的 CLI 授权，不保证下一次请求成功，也不缓存已撤销模型。',
    parameters: modelToolParameters,
    output,
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    presentCall: args => ({
      card: 'generic',
      title: `TokenRouter 模型 ${args?.action ?? ''}`,
      kind: 'read',
      rawInput: args,
    }),
    async execute(args, exec) {
      const action = args?.action
      const subprocess = ctx.get?.('subprocess') ?? ctx.subprocess
      if (!subprocess?.spawn) throw new Error('DSH subprocess 服务不可用，请检查插件是否已启用。')
      const launcher = resolveTrLauncher(settings.trCommand)
      const directory = ctx.workingDirectory ?? ctx.get?.('workingDirectory')
      const cwd = workspaceOrTemp(await resolveWorkspace(exec, directory).catch(() => ''))
      try {
        if (action === 'refresh') {
          const names = args?.agent ? [args.agent] : agentIds()
          const blocks = []
          for (const agent of names) {
            if (!agentProviders[agent]) throw new Error('仅支持已注册的 agent')
            const catalog = await refreshAgent({ agent, launcher: launcher.file, subprocess, cwd, signal: exec?.signal })
            blocks.push(formatCatalog(agent, catalog))
          }
          return `模型清单已按本次查询替换。查询失败时不会保留旧列表。\n\n${blocks.join('\n\n')}`
        }
        if (action !== 'set-default' && action !== 'clear-default') throw new Error('仅支持 refresh、set-default 或 clear-default。')
        const changed = await applySelectionChange({
          action: action === 'set-default' ? 'save' : 'clear',
          agent: args?.agent,
          model: args?.model,
          member: args?.member,
          settings,
          launcher,
          subprocess,
          cwd,
          signal: exec?.signal,
        })
        return changed.text
      } catch (error) {
        throw launchError(error)
      }
    },
  })

  ctx.tools.register({
    name: 'tr_bridge',
    description: '使用已经登录的 TokenRouter tr codex / tr grok 派发独立任务。不读取、不要求 API Key。可选 model 必须来自 tr_bridge_models 的本次清单；省略时用插件默认值，没有默认值则不传 --model。先用 dryRun 查看实际模型、启动参数和工作目录。Codex 请求 read-only sandbox。Grok 使用 dontAsk 和只读工具允许列表，这不是 Windows 内核沙箱。',
    parameters: toolParameters,
    output,
    timeoutMs: settings.timeoutMs + 30_000,
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'generic',
      title: `TokenRouter → ${args?.agent ?? '?'}${args?.model ? ` / ${args.model}` : ''}`,
      kind: args?.dryRun ? 'read' : 'execute',
      rawInput: args,
    }),
    async execute(args, exec) {
      const agent = args?.agent
      const task = args?.task
      const launcher = resolveTrLauncher(settings.trCommand)
      const directory = ctx.workingDirectory ?? ctx.get?.('workingDirectory')
      const cwd = await resolveWorkspace(exec, directory)
      let saved = emptySelection()
      if (!args?.model) {
        try { saved = loadSaved(settings) } catch (error) { throw launchError(error) }
      }
      const choice = resolveModelChoice({
        agent,
        explicit: args?.model,
        member: args?.member,
        config: settings.selection,
        saved,
      })
      let modelChecked = false
      if (choice.model) {
        const subprocess = ctx.get?.('subprocess') ?? ctx.subprocess
        if (!subprocess?.spawn) throw new Error('DSH subprocess 服务不可用，不能复核模型授权。')
        try {
          await authorize(agent, choice.model, launcher, subprocess, cwd, exec?.signal)
          modelChecked = true
        } catch (error) {
          throw launchError(error)
        }
      }
      const argv = commandFor(agent, task, launcher.file, { ...settings, model: choice.model })
      if (args?.dryRun === true) {
        return previewLaunch(launcher, agent, task, { ...settings, cwd, model: choice.model, modelSource: choice.source, modelChecked })
      }
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
        const used = choice.model ? `，模型 ${choice.model}` : '，未指定模型，沿用 CLI 默认'
        return `[由 tr ${agent} 执行${used}]\n${answer}`
      } catch (error) {
        throw launchError(error)
      }
    },
  })

  // Native provider is additive: tools above are already registered, and a
  // missing llm service or launcher must not disable the existing bridge.
  const native = registerTrCodexProvider(ctx, {
    settings,
    cwd: settings.llmCwd,
    catalogJson: settings.llmCatalogPath,
    version: '0.3.0',
  })
  if (native.ok === false && native.reason === 'llm-unavailable' && typeof ctx.inject === 'function') {
    ctx.inject(['llm'], child => {
      registerTrCodexProvider(child, {
        settings,
        cwd: settings.llmCwd,
        catalogJson: settings.llmCatalogPath,
        version: '0.3.0',
      })
      registerTrGrokProvider(child, {
        settings,
        cwd: settings.llmCwd,
        version: '0.3.0',
      })
    })
  } else {
    registerTrGrokProvider(ctx, {
      settings,
      cwd: settings.llmCwd,
      version: '0.3.0',
    })
  }

  // Optional. A missing Connection or webServer must not prevent the tools above from registering.
  registerConfigChannel(ctx, (endpoint, payload, signal) => handleConfigRpc(endpoint, payload, {
    settings,
    subprocess: ctx.get?.('subprocess') ?? ctx.subprocess,
    cwd: workspaceOrTemp(''),
    signal,
    resolveLauncher: () => resolveTrLauncher(settings.trCommand),
  }))
}
