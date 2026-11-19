/**
 * Live TR Codex model catalog.
 *
 * The menu is built only from `model/list`; there is no hard-coded fallback.
 * A short TTL keeps the picker responsive, while resolve() forces a refresh
 * when a selected id disappeared so a revoked model fails loudly instead of
 * silently running another model.
 */
import { TrLlmError } from './errors.js'

function reasoningOf(model) {
  const levels = model.supportedReasoningEfforts
    ?? model.supported_reasoning_levels
    ?? model.supportedReasoningLevels
    ?? []
  const efforts = []
  const seen = new Set()
  for (const level of levels) {
    if (typeof level === 'string') {
      if (seen.has(level)) continue
      seen.add(level)
      efforts.push({ id: level, name: level })
      continue
    }
    const id = level?.reasoningEffort ?? level?.effort ?? level?.id
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)
    efforts.push({
      id,
      name: typeof level?.name === 'string' && level.name.trim() ? level.name.trim() : id,
      ...(typeof level?.description === 'string' && level.description.trim() ? { description: level.description.trim() } : {}),
    })
  }
  const advertisedDefault = model.defaultReasoningEffort ?? model.default_reasoning_level ?? model.defaultReasoningLevel
  const defaultEffort = typeof advertisedDefault === 'string' && seen.has(advertisedDefault)
    ? advertisedDefault
    : undefined
  // DSH reads the nested `reasoning` field on LlmModelInfo; top-level effort
  // fields alone do not populate its reasoning chooser.
  return efforts.length
    ? {
        efforts,
        ...(defaultEffort !== undefined ? { defaultEffort } : {}),
      }
    : undefined
}

export function modelInfo(provider, model) {
  const id = model?.model ?? model?.slug ?? model?.id
  if (typeof id !== 'string' || !id) return undefined
  const hidden = model.hidden === true || model.visibility === 'hide' || model.visibility === 'hidden'
  if (hidden) return undefined
  const name = model.displayName ?? model.display_name ?? id
  const reportedId = model?.id ?? model?.slug
  const reasoning = reasoningOf(model)
  return {
    provider,
    id,
    name: typeof name === 'string' && name.trim() ? name.trim() : id,
    ...(typeof model.description === 'string' && model.description ? { description: model.description } : {}),
    // Codex currently returns the same value for id and model. Keep the raw
    // routing id when a future CLI reports an alias separately from identity.
    ...(typeof reportedId === 'string' && reportedId && reportedId !== id ? { routingAlias: reportedId } : {}),
    ...(model.isDefault === true ? { isDefault: true } : {}),
    inputModalities: ['text'],
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

export class CodexCatalog {
  entries = []
  loaded = false
  loadedAt = 0
  issue
  refreshing

  constructor(server, { provider = 'tr-codex', ttlMs = 60_000, now = () => Date.now() } = {}) {
    this.server = server
    this.provider = provider
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
      try {
        const models = await this.server.models(signal)
        if (!Array.isArray(models)) {
          throw new TrLlmError('TR Codex model/list returned no model array.', 'PROTOCOL_ERROR')
        }
        const seen = new Set()
        const entries = []
        for (const model of models) {
          const info = modelInfo(this.provider, model)
          if (!info || seen.has(info.id)) continue
          seen.add(info.id)
          entries.push(info)
        }
        this.entries = entries
        this.loaded = true
        this.loadedAt = this.now()
        this.pages = this.server.lastPagination?.pages
        this.issue = undefined
        return entries
      } catch (error) {
        this.issue = error
        throw error
      } finally {
        this.refreshing = undefined
      }
    })()
    this.refreshing = running
    return running
  }

  async list(signal) {
    // A menu fetch is an explicit request for the current CLI catalog. Do not
    // serve a previous snapshot when discovery fails; the caller must see the
    // failure instead of a menu that may no longer be authorized.
    return this.refresh(signal, { force: true })
  }

  async resolve(provider, id, signal) {
    if (provider !== this.provider) {
      throw new TrLlmError(`Unknown provider "${provider}".`, 'MODEL_UNAVAILABLE')
    }
    if (typeof id !== 'string' || !id) {
      throw new TrLlmError('A model id is required.', 'MODEL_UNAVAILABLE')
    }
    try {
      await this.refresh(signal)
    } catch (error) {
      throw new TrLlmError('TR Codex model discovery failed; retry after the CLI is reachable.', 'MODEL_DISCOVERY_FAILED', { cause: error })
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
    if (!found) {
      throw new TrLlmError(`Model "${id}" is no longer offered by this TokenRouter device.`, 'MODEL_UNAVAILABLE')
    }
    return { ...found }
  }
}
