/**
 * Register the native `tr-codex` provider without making the existing tools
 * depend on the llm service. A host without `ctx.llm` keeps `tr_bridge` and
 * `tr_bridge_models` exactly as before.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServer } from './codex-app-server.js'
import { CodexCatalog } from './catalog.js'
import { CodexAdapter } from './codex-adapter.js'
import { GrokAppServer } from './grok-app-server.js'
import { GrokCatalog } from './grok-catalog.js'
import { GrokAdapter } from './grok-adapter.js'
import { resolveTrLauncher } from '../resolve-tr.js'

export const TR_CODEX_PROVIDER = 'tr-codex'
export const TR_GROK_PROVIDER = 'tr-grok'

function serviceOf(ctx, name) {
  try {
    const direct = ctx?.[name]
    if (direct !== undefined) return direct
  } catch {
    // Service access can throw when the fiber did not inject it.
  }
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

export function defaultLlmCwd() {
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

/**
 * TokenRouter writes its full Codex catalog beside the user's Codex config.
 * Codex only loads that catalog automatically when the process cwd is the
 * user's home. Passing it explicitly keeps discovery and inference identical
 * in any workspace without reading the config or any credential.
 */
export function defaultCodexCatalogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir()
  const path = join(home, '.codex', 'tokenrouter-model-catalog.json')
  return existsSync(path) ? path : undefined
}

export function resolveCodexCatalogPath(explicit, env = process.env) {
  if (explicit === null) return undefined
  if (typeof explicit === 'string' && explicit.trim()) return explicit
  return defaultCodexCatalogPath(env)
}

export function registerTrCodexProvider(ctx, {
  settings = {},
  launcher,
  cwd,
  catalogJson,
  providerId = TR_CODEX_PROVIDER,
  name = 'TR Codex',
  requestTimeoutMs = 30_000,
  idleTimeoutMs = 300_000,
  version = '0.3.0',
  llm,
  subprocess,
} = {}) {
  const service = llm ?? serviceOf(ctx, 'llm')
  if (typeof service?.registerAdapter !== 'function') {
    return { ok: false, reason: 'llm-unavailable' }
  }
  const proc = subprocess ?? serviceOf(ctx, 'subprocess')
  if (typeof proc?.spawn !== 'function') {
    return { ok: false, reason: 'subprocess-unavailable' }
  }

  let command
  try {
    command = launcher?.file ?? resolveTrLauncher(settings?.trCommand).file
  } catch (error) {
    return { ok: false, reason: 'launcher-unavailable', error }
  }

  const resolvedCwd = cwd || defaultLlmCwd()
  const resolvedCatalog = resolveCodexCatalogPath(catalogJson)
  const server = new CodexAppServer({
    spawn: spec => proc.spawn(spec),
    command,
    cwd: resolvedCwd,
    catalogJson: resolvedCatalog,
    requestTimeoutMs,
    clientVersion: version,
  })
  const catalog = new CodexCatalog(server, { provider: providerId, ttlMs: 0 })
  const adapter = new CodexAdapter({
    provider: providerId,
    name,
    server,
    catalog,
    cwd: resolvedCwd,
    idleTimeoutMs,
  })

  let registration
  try {
    registration = service.registerAdapter([providerId], adapter)
  } catch (error) {
    server.close()
    return { ok: false, reason: 'register-failed', error }
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try { server.close() } catch { /* best effort */ }
  }
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'dsh-tr-bridge.tr-codex')
    } catch {
      // The registration handle is still disposed with the host fiber.
    }
  }

  return {
    ok: true,
    server,
    catalog,
    adapter,
    registration,
    dispose,
    cwd: resolvedCwd,
    catalogJson: resolvedCatalog,
  }
}

export function registerTrGrokProvider(ctx, {
  settings = {},
  launcher,
  cwd,
  providerId = TR_GROK_PROVIDER,
  name = 'TR Grok',
  requestTimeoutMs = 30_000,
  promptTimeoutMs = 10 * 60_000,
  idleTimeoutMs = 300_000,
  version = '0.3.0',
  llm,
  subprocess,
} = {}) {
  const service = llm ?? serviceOf(ctx, 'llm')
  if (typeof service?.registerAdapter !== 'function') {
    return { ok: false, reason: 'llm-unavailable' }
  }
  const proc = subprocess ?? serviceOf(ctx, 'subprocess')
  if (typeof proc?.spawn !== 'function') {
    return { ok: false, reason: 'subprocess-unavailable' }
  }

  let command
  try {
    command = launcher?.file ?? resolveTrLauncher(settings?.trCommand).file
  } catch (error) {
    return { ok: false, reason: 'launcher-unavailable', error }
  }

  const resolvedCwd = cwd || defaultLlmCwd()
  const server = new GrokAppServer({
    spawn: spec => proc.spawn(spec),
    command,
    cwd: resolvedCwd,
    requestTimeoutMs,
    promptTimeoutMs,
    clientVersion: version,
  })
  const catalog = new GrokCatalog(server, {
    provider: providerId,
    cwd: resolvedCwd,
    ttlMs: 15_000,
  })
  const adapter = new GrokAdapter({
    provider: providerId,
    name,
    server,
    catalog,
    cwd: resolvedCwd,
    idleTimeoutMs,
  })

  let registration
  try {
    registration = service.registerAdapter([providerId], adapter)
  } catch (error) {
    server.close()
    return { ok: false, reason: 'register-failed', error }
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    try { server.close() } catch { /* best effort */ }
  }
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'dsh-tr-bridge.tr-grok')
    } catch {
      // The registration handle is still disposed with the host fiber.
    }
  }

  return { ok: true, server, catalog, adapter, registration, dispose, cwd: resolvedCwd }
}
