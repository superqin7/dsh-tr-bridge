/**
 * Dynamic model discovery for already-signed-in TokenRouter CLIs.
 *
 * Codex: `tr codex debug models` returns one JSON document.
 * Grok: `tr grok models` returns the CLI's available-model text.
 * Neither command is given an API key. Credential files are not read.
 * A new agent is added by registering a provider, not by rewriting selection.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'

export const CATALOG_STDOUT_LIMIT = 8 * 1024 * 1024
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const PAGE_KEYS = ['next', 'next_cursor', 'nextCursor', 'cursor', 'has_more']

export function validateModelId(model) {
  if (typeof model !== 'string' || !MODEL_ID.test(model)) {
    throw new Error('模型 ID 只能包含字母、数字、点、下划线、冒号和连字符，且不能包含空格或 shell 元字符。')
  }
  return model
}

export function validateMemberId(member) {
  if (typeof member !== 'string' || !MEMBER_ID.test(member)) {
    throw new Error('成员 ID 只能包含字母、数字、点、下划线、冒号和连字符。')
  }
  return member
}

function incomplete(message) {
  const error = new Error(message)
  error.code = 'MODEL_CATALOG_INCOMPLETE'
  return error
}

export function parseCodexCatalog(stdout) {
  let data
  try {
    data = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim())
  } catch {
    throw new Error('tr codex debug models 没有返回 JSON，不能确认模型清单是否完整。')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw incomplete('Codex 模型清单不是单个对象。拒绝把它当成全部模型。')
  }
  for (const key of PAGE_KEYS) {
    if (data[key]) {
      throw incomplete('Codex 模型清单带有分页标记，但 tr codex debug models 没有翻页参数。拒绝把这一页当成全部模型。')
    }
  }
  if (!Array.isArray(data.models)) throw new Error('Codex 模型清单缺少 models 数组。')
  const models = []
  let hidden = 0
  for (const entry of data.models) {
    if (typeof entry?.slug !== 'string' || !MODEL_ID.test(entry.slug)) {
      hidden += 1
      continue
    }
    const unsupported = entry.supported_in_api === false
    const hiddenByCli = entry.visibility === 'hide'
    if (hiddenByCli || unsupported) hidden += 1
    models.push({
      id: entry.slug,
      name: typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : entry.slug,
      selectable: !hiddenByCli && !unsupported,
      agent: 'codex',
    })
  }
  if (models.length === 0) throw new Error('Codex 模型清单没有可识别的模型 ID。')
  return { models, excluded: hidden }
}

export function parseGrokModels(stdout) {
  const text = String(stdout).replace(/^\uFEFF/, '')
  if (/next[_ -]?cursor|has_more|page \d+ of \d+/i.test(text)) {
    throw incomplete('Grok 模型输出声明还有更多页，但 tr grok models 没有翻页参数。拒绝把当前输出当成全部模型。')
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => line.trim() === 'Available models:')
  if (start < 0) throw new Error('tr grok models 没有返回 Available models 清单。')
  const models = []
  let interrupted = false
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue
    const match = /^\s*[*+-]\s+(\S+?)(?:\s+\(default\))?(?:\s+.*)?$/.exec(line)
    if (!match) {
      interrupted = true
      continue
    }
    if (interrupted) {
      throw incomplete('Grok 模型输出在清单中断后仍有模型行。不能确认已经读完，拒绝使用不完整清单。')
    }
    if (!MODEL_ID.test(match[1])) {
      throw incomplete('Grok 清单含有无法安全识别的模型 ID，拒绝把其余输出当成全部模型。')
    }
    models.push({ id: match[1], name: match[1], selectable: true, agent: 'grok' })
  }
  if (models.length === 0) throw new Error('Grok 模型清单没有可识别的模型 ID。')
  return { models, excluded: 0 }
}

export const agentProviders = {
  codex: {
    listArgv: ['codex', 'debug', 'models'],
    parse: parseCodexCatalog,
    scope: '来自 tr codex debug models 的单份 JSON。没有分页字段时只表示该命令的完整输出；出现分页字段则拒绝。CLI 标记为 hide 或 supported_in_api=false 的条目不进入可选项。',
  },
  grok: {
    listArgv: ['grok', 'models'],
    parse: parseGrokModels,
    scope: '来自 tr grok models 的全部标准输出。该命令没有翻页参数；输出若声明还有更多页则拒绝。ID 以 CLI 原文为准，不按名称前缀增删。',
  },
}

export function agentIds() {
  return Object.keys(agentProviders)
}

export function modelArgs(agent, model) {
  const provider = agentProviders[agent]
  if (!provider) throw new Error('仅支持已注册的 agent')
  if (!model) return []
  return ['--model', validateModelId(model)]
}

export function emptySelection() {
  return { defaults: {}, members: {} }
}

export function normalizeSelection(value) {
  const selection = emptySelection()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return selection
  for (const agent of agentIds()) {
    const model = value.defaults?.[agent]
    if (typeof model === 'string' && model.trim()) selection.defaults[agent] = validateModelId(model)
  }
  const members = value.members
  if (members && typeof members === 'object' && !Array.isArray(members)) {
    for (const [member, binding] of Object.entries(members)) {
      if (!binding || typeof binding !== 'object') continue
      const id = validateMemberId(member)
      if (!agentIds().includes(binding.agent)) throw new Error(`成员 ${id} 的 agent 不受支持`)
      selection.members[id] = {
        agent: binding.agent,
        model: validateModelId(binding.model),
      }
    }
  }
  return selection
}

export function selectionFromConfig(config = {}) {
  return normalizeSelection({
    defaults: config.defaults,
    members: config.members,
  })
}

export function defaultSelectionFile(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const root = env.APPDATA || env.LOCALAPPDATA
    if (!root) throw new Error('缺少 APPDATA，无法保存模型选择。')
    return win32.join(root, 'dsh-tr-bridge', 'model-selection.json')
  }
  const root = env.XDG_CONFIG_HOME || (env.HOME ? posix.join(env.HOME, '.config') : '')
  if (!root) throw new Error('缺少 HOME，无法保存模型选择。')
  return posix.join(root, 'dsh-tr-bridge', 'model-selection.json')
}

export function readSelection(file, io = {}) {
  const read = io.readFile ?? readFileSync
  try {
    return normalizeSelection(JSON.parse(read(file, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') return emptySelection()
    if (error instanceof Error && /模型 ID|成员 ID|agent 不受支持/.test(error.message)) throw error
    throw new Error('已保存的模型选择无法读取。为避免使用过期授权，本次不会沿用其中的默认模型。')
  }
}

export function writeSelection(file, selection, io = {}) {
  const normalized = normalizeSelection(selection)
  const mkdir = io.mkdir ?? mkdirSync
  const write = io.writeFile ?? writeFileSync
  const rename = io.rename ?? renameSync
  const dir = dirname(file)
  mkdir(dir, { recursive: true })
  const temporary = join(dir, `.model-selection-${process.pid}.json`)
  write(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  rename(temporary, file)
  return normalized
}

export function resolveModelChoice({ agent, explicit, member, config = emptySelection(), saved = emptySelection() }) {
  if (!agentProviders[agent]) throw new Error('仅支持已注册的 agent')
  if (typeof explicit === 'string' && explicit.trim()) {
    return { model: validateModelId(explicit), source: 'explicit' }
  }
  if (typeof member === 'string' && member.trim()) {
    const id = validateMemberId(member)
    const binding = config.members[id] ?? saved.members[id]
    if (!binding) throw new Error(`没有成员 ${id} 的模型配置。`)
    if (binding.agent !== agent) throw new Error(`成员 ${id} 绑定的是 ${binding.agent}，不能用于 ${agent}。`)
    return { model: binding.model, source: 'member', member: id }
  }
  if (config.defaults[agent]) return { model: config.defaults[agent], source: 'config' }
  if (saved.defaults[agent]) return { model: saved.defaults[agent], source: 'saved-default' }
  return { model: null, source: 'cli-default' }
}

export function assertModelAllowed(agent, model, catalogs) {
  const id = validateModelId(model)
  const own = catalogs?.[agent]
  if (!own) throw new Error(`没有 ${agent} 的本次模型清单，不能确认授权。`)
  const match = own.models.find(item => item.id === id)
  if (match?.selectable) return match
  const other = Object.entries(catalogs).find(([name, catalog]) => name !== agent && catalog.models.some(item => item.id === id && item.selectable))
  if (other) throw new Error(`模型 ${id} 属于 ${other[0]}，不能用于 ${agent}。`)
  if (match && !match.selectable) throw new Error(`模型 ${id} 在本次 ${agent} 清单中被 CLI 标记为不可选。`)
  throw new Error(`模型 ${id} 不在本次 ${agent} 授权清单中。请先刷新；已撤销的模型不能继续使用。`)
}

export function formatCatalog(agent, parsed) {
  const selectable = parsed.models.filter(item => item.selectable)
  const lines = selectable.map(item => item.name === item.id ? `- ${item.id}` : `- ${item.name}（${item.id}）`)
  const excluded = parsed.excluded > 0
    ? `\n另有 ${parsed.excluded} 个未放入可选项（CLI 标记不可选，或 ID 无法安全识别）。`
    : ''
  return `${agent}\n${agentProviders[agent].scope}\n${lines.join('\n') || '（没有可选项）'}${excluded}`
}

export async function collectCommand({ subprocess, argv, cwd, signal, timeoutMs = 60_000, limit = CATALOG_STDOUT_LIMIT }) {
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
  let overflow = false
  child.stdout?.on('data', chunk => {
    if (stdout.length < limit) stdout += String(chunk).slice(0, limit - stdout.length)
    if (stdout.length >= limit) overflow = true
  })
  child.stderr?.on('data', chunk => {
    if (stderr.length < 4_000) stderr += String(chunk).slice(0, 4_000 - stderr.length)
  })
  child.stdin?.end()
  let timer
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('模型清单查询超时')), timeoutMs)
  })
  try {
    const status = await Promise.race([child.done, timedOut])
    // Host `done` can resolve on process exit while the last stdout chunk is
    // still queued. Drain one turn before deciding the catalog is complete.
    await new Promise(resolve => setImmediate(resolve))
    if (overflow) throw incomplete('模型清单输出达到上限，不能确认已经读完，拒绝使用不完整清单。')
    return { exitCode: status?.exitCode, stdout, stderr }
  } catch (error) {
    try { child.terminate?.() } catch { /* best effort */ }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function refreshAgent({ agent, launcher, subprocess, cwd, signal }) {
  const provider = agentProviders[agent]
  if (!provider) throw new Error('仅支持已注册的 agent')
  const result = await collectCommand({
    subprocess,
    argv: [launcher, ...provider.listArgv],
    cwd,
    signal,
  })
  if (result.exitCode !== 0) {
    throw new Error(`查询 ${agent} 模型失败，退出码 ${result.exitCode ?? 'unknown'}。不会沿用旧清单。`)
  }
  const parsed = provider.parse(result.stdout)
  return {
    agent,
    fetchedAt: new Date().toISOString(),
    models: parsed.models,
    excluded: parsed.excluded,
    scope: provider.scope,
  }
}

export function workspaceOrTemp(cwd) {
  return typeof cwd === 'string' && cwd.trim() ? cwd : (process.env.TEMP || tmpdir() || homedir())
}
