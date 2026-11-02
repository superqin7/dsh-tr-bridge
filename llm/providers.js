/**
 * Register the native `tr-codex` provider without making the existing tools
 * depend on the llm service. A host without `ctx.llm` keeps `tr_bridge` and
 * `tr_bridge_models` exactly as before.
 */
import { homedir } from 'node:os'
import { CodexAppServer } from './codex-app-server.js'
import { CodexCatalog } from './catalog.js'
import { CodexAdapter } from './codex-adapter.js'
import { resolveTrLauncher } from '../resolve-tr.js'

export const TR_CODEX_PROVIDER = 'tr-codex'

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

export function registerTrCodexProvider(ctx, {
  settings = {},
  launcher,
  cwd,
  providerId = TR_CODEX_PROVIDER,
  name = 'TR Codex',
  requestTimeoutMs = 30_000,
  idleTimeoutMs = 300_000,
  version = '0.2.0',
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

  const server = new CodexAppServer({
    spawn: spec => proc.spawn(spec),
    command,
    cwd: cwd || defaultLlmCwd(),
    requestTimeoutMs,
    clientVersion: version,
  })
  const catalog = new CodexCatalog(server, { provider: providerId })
  const adapter = new CodexAdapter({
    provider: providerId,
    name,
    server,
    catalog,
    cwd: cwd || defaultLlmCwd(),
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

  return { ok: true, server, catalog, adapter, registration, dispose }
}
