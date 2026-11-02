/**
 * Live TR Grok model catalog.
 *
 * The ACP `session/new` response is the source of truth. `models` is an object
 * with `availableModels` in current Grok builds, while some ACP versions expose
 * the same select as `configOptions`. Both are read; nothing is hardcoded.
 */
import { TrLlmError } from './errors.js'

function textOf(model) {
  return typeof model?.name === 'string' && model.name.trim()
    ? model.name.trim()
    : (typeof model?.displayName === 'string' && model.displayName.trim() ? model.displayName.trim() : model.id)
}

function reasoningOf(model, meta) {
  const levels = meta?.reasoningEfforts ?? model?.reasoningEfforts ?? []
  const efforts = []
  for (const level of levels) {
    const id = typeof level === 'string' ? level : (level?.id ?? level?.value)
    if (typeof id !== 'string' || !id) continue
    efforts.push({
      id,
      name: typeof level?.label === 'string' && level.label.trim()
        ? level.label.trim()
        : (typeof level?.name === 'string' && level.name.trim() ? level.name.trim() : id),
      ...(typeof level?.description === 'string' && level.description.trim() ? { description: level.description.trim() } : {}),
    })
  }
  const defaultEffort = meta?.reasoningEffort
    ?? efforts.find(effort => levels.find?.(level => level?.default === true && (level.id ?? level.value) === effort.id))?.id
  return {
    ...(efforts.length ? { efforts } : {}),
    ...(typeof defaultEffort === 'string' && defaultEffort ? { defaultEffort } : {}),
  }
}

export function grokModelInfo(provider, model, currentId) {
  const id = model?.modelId ?? model?.value ?? model?.id
  if (typeof id !== 'string' || !id) return undefined
  const meta = model?._meta ?? {}
  const name = model?.name ?? model?.displayName
  return {
    provider,
    id,
    name: typeof name === 'string' && name.trim() ? textOf({ ...model, name }) : id,
    ...(typeof model?.description === 'string' && model.description.trim() ? { description: model.description.trim() } : {}),
    ...(id === currentId ? { isDefault: true } : {}),
    // TokenRouter route aliases are not the underlying model identity. Expose
    // the distinction without filtering either kind out of the CLI's list.
    ...(id === 'tokenrouter' || id.startsWith('tokenrouter-') ? { routingAlias: true } : {}),
    inputModalities: ['text'],
    ...reasoningOf(model, meta),
  }
}

function optionsFromSession(session) {
  const models = session?.models
  if (Array.isArray(models)) {
    return { models, currentId: session?.currentModelId, nextCursor: session?.nextCursor }
  }
  if (Array.isArray(models?.availableModels)) {
    return { models: models.availableModels, currentId: models.currentModelId, nextCursor: models.nextCursor }
  }
  const select = (session?.configOptions ?? []).find(option => option?.id === 'model')
  if (Array.isArray(select?.options)) {
    return {
      models: select.options.map(option => ({
        modelId: option.value,
        name: option.name ?? option.label,
        description: option.description,
      })),
      currentId: select.currentValue,
      nextCursor: select.nextCursor,
    }
  }
  return { models: [], currentId: undefined, nextCursor: undefined }
}

export class GrokCatalog {
  entries = []
  loaded = false
  loadedAt = 0
  issue
  refreshing

  constructor(server, { provider = 'tr-grok', cwd, ttlMs = 15_000, now = () => Date.now() } = {}) {
    this.server = server
    this.provider = provider
    this.cwd = cwd
    this.ttlMs = ttlMs
    this.now = now
  }

  invalidate() {
    this.loaded = false
    this.loadedAt = 0
  }

  stale() {
    return !this.loaded || this.now() - this.loadedAt >= this.ttlMs
  }

  async refresh(signal, { force = false } = {}) {
    if (!force && !this.stale()) return this.entries
    if (this.refreshing) return this.refreshing
    const running = (async () => {
      let session
      try {
        session = await this.server.newSession({ cwd: this.cwd }, signal)
        const { models, currentId, nextCursor } = optionsFromSession(session)
        if (!Array.isArray(models)) {
          throw new TrLlmError('TR Grok session/new returned no model array.', 'MODEL_DISCOVERY_FAILED')
        }
        if (nextCursor) {
          throw new TrLlmError(
            'TR Grok reported another model page, but ACP session/new exposes no pagination call; refusing a partial list.',
            'MODEL_DISCOVERY_FAILED',
          )
        }
        const seen = new Set()
        const entries = []
        for (const model of models) {
          const info = grokModelInfo(this.provider, model, currentId)
          if (!info || seen.has(info.id)) continue
          seen.add(info.id)
          entries.push(info)
        }
        this.entries = entries
        this.loaded = true
        this.loadedAt = this.now()
        this.issue = undefined
        return entries
      } catch (error) {
        this.issue = error
        throw error
      } finally {
        if (session?.sessionId) await this.server.closeSession(session.sessionId)
        this.refreshing = undefined
      }
    })()
    this.refreshing = running
    return running
  }

  async list(signal) {
    // A menu fetch is an explicit opportunity to see the current CLI list.
    // resolve() keeps the short cache to avoid a discovery session per turn.
    // Never fall back to a previous snapshot here: a failed discovery is a
    // failed menu, not evidence that the old models are still available.
    return this.refresh(signal, { force: true })
  }

  async resolve(provider, id, signal) {
    if (provider !== this.provider) {
      throw new TrLlmError(`Unknown provider "${provider}".`, 'MODEL_UNAVAILABLE')
    }
    if (typeof id !== 'string' || !id) throw new TrLlmError('A model id is required.', 'MODEL_UNAVAILABLE')
    try {
      await this.refresh(signal)
    } catch (error) {
      throw new TrLlmError('TR Grok model discovery failed; retry after the CLI is reachable.', 'MODEL_DISCOVERY_FAILED', { cause: error })
    }
    let found = this.entries.find(entry => entry.id === id)
    if (!found) {
      try {
        await this.refresh(signal, { force: true })
      } catch {
        // Report the original miss below.
      }
      found = this.entries.find(entry => entry.id === id)
    }
    if (!found) throw new TrLlmError(`Model "${id}" is no longer offered by this TR Grok CLI.`, 'MODEL_UNAVAILABLE')
    return { ...found }
  }
}
