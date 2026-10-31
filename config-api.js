/**
 * Host operations shared by the agent tool and the Plugins config page.
 * The page calls these through Connection RPC. It never reads login files.
 */
import {
  agentIds,
  agentProviders,
  authorizeModel,
  classifyQueryError,
  defaultSelectionFile,
  emptySelection,
  readSelection,
  refreshAgent,
  validateMemberId,
  validateModelId,
  writeSelection,
} from './models.js'

export const CONFIG_CHANNEL = '/dsh-tr-bridge'
export const CONFIG_ENDPOINTS = ['status', 'refresh', 'save', 'clear']

const PAYLOAD_KEYS = {
  status: [],
  refresh: ['agent'],
  save: ['agent', 'model'],
  clear: ['agent'],
}

function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

function secretLike(value) {
  const text = JSON.stringify(value)
  return /Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|password|TR_SETUP_KEY)\s*[:=]/i.test(text)
}

export function rejectConfigPayload(endpoint, payload) {
  if (!CONFIG_ENDPOINTS.includes(endpoint)) return fail('bad-request', '不支持的配置操作。')
  if (payload == null) return null
  if (typeof payload !== 'object' || Array.isArray(payload)) return fail('bad-request', '配置请求格式不正确。')
  if (secretLike(payload)) return fail('bad-request', '配置请求被拒绝。')
  const allowed = PAYLOAD_KEYS[endpoint]
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) return fail('bad-request', '配置请求包含不支持的字段。')
  }
  if (JSON.stringify(payload).length > 4000) return fail('bad-request', '配置请求过长。')
  if (payload.agent !== undefined && !agentProviders[payload.agent]) return fail('unsupported-agent', '仅支持已注册的 agent。')
  if (payload.model !== undefined) {
    try { validateModelId(payload.model) } catch { return fail('invalid-model', '模型 ID 无效。') }
  }
  return null
}

function resolvedFile(settings) {
  if (settings?.selectionFile) return settings.selectionFile
  return defaultSelectionFile()
}

function savedOrEmpty(settings) {
  try {
    return { selection: readSelection(resolvedFile(settings)), error: null }
  } catch (error) {
    return { selection: emptySelection(), error }
  }
}

export function describeSelection({ agent, catalog, saved, profile, failed }) {
  const profileModel = profile?.defaults?.[agent] || null
  const savedModel = saved?.defaults?.[agent] || null
  if (failed || !catalog) {
    if (profileModel) return { code: 'unverified', effective: profileModel, source: 'config' }
    if (savedModel) return { code: 'unverified', effective: savedModel, source: 'saved-default' }
    return { code: 'unset', effective: null, source: 'cli-default' }
  }
  const selectable = new Set(catalog.models.filter(item => item.selectable).map(item => item.id))
  if (profileModel) {
    if (!selectable.has(profileModel)) return { code: 'profile-stale', effective: profileModel, source: 'config' }
    return { code: 'profile-override', effective: profileModel, source: 'config' }
  }
  if (savedModel) {
    if (!selectable.has(savedModel)) return { code: 'stale', effective: savedModel, source: 'saved-default' }
    return { code: 'ok', effective: savedModel, source: 'saved-default' }
  }
  return { code: 'unset', effective: null, source: 'cli-default' }
}

export function agentSnapshot({ agent, catalog, connection, saved, profile }) {
  const models = catalog
    ? catalog.models.filter(item => item.selectable).map(item => ({
      id: item.id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 200) : item.id,
      kind: item.kind === 'alias' || item.kind === 'routed' ? item.kind : 'model',
      selectable: true,
    }))
    : []
  const selection = describeSelection({
    agent,
    catalog,
    saved,
    profile,
    failed: !catalog,
  })
  return {
    agent,
    connection,
    models,
    excluded: catalog?.excluded || 0,
    saved: saved?.defaults?.[agent] || null,
    profile: profile?.defaults?.[agent] || null,
    effective: selection.effective,
    effectiveSource: selection.source,
    selection: selection.code,
  }
}

function launcherFacts(resolveLauncher) {
  try {
    const launcher = resolveLauncher()
    return { launcher, source: launcher?.source || 'unknown', error: null }
  } catch (error) {
    return { launcher: null, source: null, error }
  }
}

function selectionFile(settings) {
  return resolvedFile(settings)
}

export async function applySelectionChange({
  action,
  agent,
  model,
  member = '',
  settings,
  launcher,
  subprocess,
  cwd,
  signal,
}) {
  if (!agentProviders[agent]) throw new Error('保存或清除默认模型时必须指定 agent。')
  const file = selectionFile(settings)
  const saved = readSelection(file)
  const memberId = typeof member === 'string' && member.trim() ? validateMemberId(member) : ''
  if (action === 'clear') {
    if (memberId) delete saved.members[memberId]
    else delete saved.defaults[agent]
    writeSelection(file, saved)
    const profile = settings.selection || emptySelection()
    const profileModel = memberId ? profile.members[memberId]?.model : profile.defaults[agent]
    const profileNote = profileModel
      ? `插件配置仍指定 ${profileModel}，它优先于保存文件。要恢复 CLI 默认，请去掉 profile 里的这项。`
      : '未传 model 时将沿用 CLI 默认，不传 --model。'
    const text = memberId
      ? `已清除成员 ${memberId} 的已保存模型。其他成员和默认值不变。${profileNote}`
      : `已清除 ${agent} 的已保存默认模型。${profileNote}`
    return { text, saved }
  }
  if (action !== 'save') throw new Error('仅支持 refresh、set-default 或 clear-default。')
  const id = validateModelId(model)
  const { match } = await authorizeModel({
    agent,
    model: id,
    launcher: launcher.file,
    subprocess,
    cwd,
    signal,
  })
  if (memberId) saved.members[memberId] = { agent, model: id }
  else saved.defaults[agent] = id
  writeSelection(file, saved)
  const text = memberId
    ? `已保存成员 ${memberId} 的 ${agent} 模型 ${match.name}（${match.id}）。切换 agent 不会覆盖这个选择。`
    : `已保存 ${agent} 的默认模型 ${match.name}（${match.id}）。显式 model 参数仍然优先。`
  return { text, saved, match }
}

function namesFor(agent) {
  if (!agent) return agentIds()
  if (!agentProviders[agent]) {
    const error = new Error('仅支持已注册的 agent')
    error.catalogCode = 'unsupported-agent'
    throw error
  }
  return [agent]
}

export async function collectAgentSnapshots({ agent, settings, launcher, subprocess, cwd, signal }) {
  const loaded = savedOrEmpty(settings)
  const saved = loaded.selection
  const profile = settings.selection || emptySelection()
  if (loaded.error) {
    return {
      agents: namesFor(agent).map(name => agentSnapshot({
        agent: name,
        catalog: null,
        connection: 'selection-unreadable',
        saved,
        profile,
      })),
    }
  }
  if (!launcher) {
    return {
      agents: namesFor(agent).map(name => agentSnapshot({
        agent: name,
        catalog: null,
        connection: 'launcher-missing',
        saved,
        profile,
      })),
    }
  }
  const agents = []
  for (const name of namesFor(agent)) {
    try {
      const catalog = await refreshAgent({
        agent: name,
        launcher: launcher.file,
        subprocess,
        cwd,
        signal,
      })
      agents.push(agentSnapshot({
        agent: name,
        catalog,
        connection: 'connected',
        saved,
        profile,
      }))
    } catch (error) {
      agents.push(agentSnapshot({
        agent: name,
        catalog: null,
        connection: error.catalogCode || classifyQueryError(error),
        saved,
        profile,
      }))
    }
  }
  return { agents }
}

export async function handleConfigRpc(endpoint, payload, deps) {
  const rejected = rejectConfigPayload(endpoint, payload ?? {})
  if (rejected) return rejected
  const body = payload ?? {}
  try {
    const loaded = savedOrEmpty(deps.settings)
    const profile = deps.settings.selection || emptySelection()
    if (endpoint === 'status') {
      const facts = launcherFacts(deps.resolveLauncher)
      const connection = loaded.error
        ? 'selection-unreadable'
        : (facts.error ? 'launcher-missing' : 'unknown')
      return {
        ok: true,
        value: {
          launcher: facts.error ? { resolved: false } : { resolved: true, source: facts.source },
          agents: agentIds().map(agent => agentSnapshot({
            agent,
            catalog: null,
            connection,
            saved: loaded.selection,
            profile,
          })),
        },
      }
    }
    const facts = launcherFacts(deps.resolveLauncher)
    if (endpoint === 'refresh') {
      const value = await collectAgentSnapshots({
        agent: body.agent,
        settings: deps.settings,
        launcher: facts.launcher,
        subprocess: deps.subprocess,
        cwd: deps.cwd,
        signal: deps.signal,
      })
      return { ok: true, value: { ...value, launcher: facts.error ? { resolved: false } : { resolved: true, source: facts.source } } }
    }
    if (!facts.launcher) return fail('launcher-missing', '找不到 tr。请确认 TokenRouter 已安装。')
    if (!deps.subprocess?.spawn) return fail('query-failed', '宿主子进程服务不可用。')
    const changed = await applySelectionChange({
      action: endpoint,
      agent: body.agent,
      model: body.model,
      settings: deps.settings,
      launcher: facts.launcher,
      subprocess: deps.subprocess,
      cwd: deps.cwd,
      signal: deps.signal,
    })
    const value = await collectAgentSnapshots({
      agent: body.agent,
      settings: deps.settings,
      launcher: facts.launcher,
      subprocess: deps.subprocess,
      cwd: deps.cwd,
      signal: deps.signal,
    })
    return { ok: true, value: { ...value, notice: changed.text } }
  } catch (error) {
    const message = error instanceof Error ? error.message : '配置操作失败。'
    if (/属于/.test(message)) return fail('cross-agent', message)
    if (/不在本次|不可选|无法安全识别|模型 ID/.test(message)) return fail('not-authorized', message)
    if (/必须指定 agent|仅支持已注册/.test(message)) return fail('unsupported-agent', '仅支持已注册的 agent。')
    return fail(error.catalogCode || classifyQueryError(error), '配置操作失败，不会沿用旧清单。')
  }
}

export function registerConfigChannel(ctx, handler) {
  if (typeof ctx?.inject !== 'function') return false
  try {
    ctx.inject(['connection', 'webServer'], (child) => {
      const connection = child?.connection ?? child?.get?.('connection')
      if (typeof connection?.register !== 'function') return
      try {
        connection.register(child, CONFIG_CHANNEL, handler)
      } catch {
        // The config page stays unavailable. Host tools are already registered.
      }
    })
    return true
  } catch {
    return false
  }
}
