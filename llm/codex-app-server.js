/**
 * TR Codex app-server transport.
 *
 * The process is started through the Harness subprocess service (CreateProcessW
 * on Windows) with a literal argv. No shell, no API key, and no TokenRouter
 * login file is read. Native Codex tools are disabled before the app-server
 * starts; only Harness dynamic tools may be requested.
 */
import { EventQueue, LineBuffer, RpcPeer } from './rpc.js'
import { TrLlmError } from './errors.js'

const MAX_STDERR_BYTES = 64 * 1024

/**
 * Config flags applied before `app-server`. These switch off native Codex
 * capabilities that would otherwise run outside Harness approval. Unknown
 * flags are ignored by Codex with a warning; they are not a permission bypass.
 */
export const CODEX_SAFETY_ARGS = [
  '-c', 'features.shell_tool=false',
  '-c', 'features.unified_exec=false',
  '-c', 'features.browser_use=false',
  '-c', 'features.computer_use=false',
  '-c', 'features.apps=false',
  '-c', 'features.image_generation=false',
  '-c', 'features.in_app_browser=false',
  '-c', 'features.multi_agent=false',
  '-c', 'features.plugins=false',
  '-c', 'features.skill_search=false',
  '-c', 'features.tool_suggest=false',
  '-c', 'features.hooks=false',
  '-c', 'features.workspace_dependencies=false',
  '-c', 'web_search="disabled"',
  '-c', 'agents.enabled=false',
  '-c', 'project_doc_max_bytes=0',
]

export function codexAppServerArgv(command, { catalogJson } = {}) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new TrLlmError('TR Codex launcher path is empty.', 'LAUNCHER_MISSING')
  }
  const argv = [command, 'codex', ...CODEX_SAFETY_ARGS]
  if (catalogJson !== undefined && catalogJson !== null) {
    if (typeof catalogJson !== 'string' || !catalogJson.trim()) {
      throw new TrLlmError('TR Codex catalog path is empty.', 'LAUNCHER_MISSING')
    }
    // Codex reads this override before app-server starts. The literal is quoted
    // as a TOML basic string so Windows backslashes survive argv unchanged.
    argv.push('-c', `model_catalog_json=${JSON.stringify(catalogJson)}`)
  }
  argv.push('app-server', '--stdio')
  return argv
}

export class CodexAppServer {
  generation = 0
  child
  starting
  peer
  queues = new Map()
  retired = new Set()
  stderrBytes = 0

  constructor({
    spawn,
    command,
    cwd,
    env,
    catalogJson,
    requestTimeoutMs = 30_000,
    clientVersion = '0.3.1',
  } = {}) {
    if (typeof spawn !== 'function') throw new TrLlmError('DSH subprocess service is unavailable.', 'SUBPROCESS_UNAVAILABLE')
    this.spawn = spawn
    this.command = command
    this.cwd = cwd
    this.env = env
    this.catalogJson = catalogJson
    this.requestTimeoutMs = requestTimeoutMs
    this.clientVersion = clientVersion
  }

  async start(signal) {
    signal?.throwIfAborted()
    if (this.child) return
    if (!this.starting) {
      const starting = this.boot()
      this.starting = starting
      starting.catch(() => {
        if (this.starting === starting) this.starting = undefined
      })
    }
    await this.awaitAbortable(this.starting, signal)
  }

  async boot() {
    const argv = codexAppServerArgv(this.command, { catalogJson: this.catalogJson })
    const child = this.spawn({
      argv,
      cwd: this.cwd,
      ...(this.env ? { env: this.env } : {}),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
    })
    if (!child?.stdout || typeof child.stdin?.write !== 'function') {
      throw new TrLlmError('TR Codex did not expose stdio pipes.', 'PROTOCOL_ERROR')
    }
    this.child = child
    this.generation += 1
    this.retired.clear()
    this.queues.clear()
    this.stderrBytes = 0

    const lines = new LineBuffer(line => {
      if (this.child !== child) return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.fail(child, new TrLlmError('TR Codex sent malformed protocol data.', 'PROTOCOL_ERROR'))
        return
      }
      try {
        this.receive(message)
      } catch (error) {
        this.fail(child, error)
      }
    })
    child.stdout.on('data', chunk => {
      try {
        lines.push(chunk)
      } catch (error) {
        this.fail(child, error)
      }
    })
    child.stdout.on('end', () => {
      try { lines.flush() } catch { /* the exit path reports the disconnect */ }
    })
    // Native stderr may contain request data. Count bytes only; never relay it.
    child.stderr?.on('data', chunk => {
      this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + chunk.length)
    })

    this.peer = new RpcPeer({ send: message => this.send(message), timeoutMs: this.requestTimeoutMs, label: 'TR Codex' })
    const done = child.done && typeof child.done.then === 'function' ? child.done : Promise.resolve({})
    done.then(
      status => this.fail(child, new TrLlmError(
        `TR Codex disconnected (${status?.signal ?? status?.exitCode ?? 'unknown'}).`,
        'TR_LLM_DISCONNECTED',
      )),
      () => this.fail(child, new TrLlmError('TR Codex disconnected.', 'TR_LLM_DISCONNECTED')),
    )

    try {
      await this.peer.request('initialize', {
        clientInfo: {
          name: 'dsh_tr_bridge',
          title: 'DSH TokenRouter Bridge',
          version: this.clientVersion,
        },
        capabilities: { experimentalApi: true },
      })
      this.send({ method: 'initialized', params: {} })
    } catch (error) {
      this.fail(child, error)
      throw error
    }
  }

  async awaitAbortable(promise, signal) {
    if (!signal) return promise
    signal.throwIfAborted()
    let abort
    const aborted = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new TrLlmError('Request aborted.', 'ABORTED'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  send(message) {
    const child = this.child
    if (!child || typeof child.stdin?.write !== 'function') {
      throw new TrLlmError('TR Codex is disconnected.', 'TR_LLM_DISCONNECTED')
    }
    try {
      child.stdin.write(JSON.stringify(message) + '\n')
    } catch (error) {
      throw new TrLlmError('TR Codex input pipe is closed.', 'TR_LLM_DISCONNECTED', { cause: error })
    }
  }

  rpc(method, params = {}, { signal, timeoutMs } = {}) {
    if (!this.peer) throw new TrLlmError('TR Codex is not initialized.', 'TR_LLM_DISCONNECTED')
    return this.peer.request(method, params, { signal, timeoutMs })
  }

  async request(method, params = {}, signal, timeoutMs) {
    await this.start(signal)
    return this.rpc(method, params, { signal, timeoutMs })
  }

  receive(message) {
    if (this.peer?.receive(message)) return
    if (typeof message?.method !== 'string') return
    const params = message.params ?? {}
    const requestId = message.id
    if (requestId !== undefined && message.method !== 'item/tool/call') {
      this.send({ id: requestId, error: { code: -32601, message: 'This provider supports Harness dynamic tools only.' } })
      return
    }
    const threadId = params.threadId ?? params.turn?.threadId
    if (typeof threadId !== 'string') return
    if (this.retired.has(threadId)) {
      if (requestId !== undefined) {
        this.respond(requestId, {
          success: false,
          contentItems: [{ type: 'inputText', text: 'Turn was cancelled.' }],
        })
      }
      return
    }
    this.queue(threadId).push({ method: message.method, params, requestId })
  }

  queue(threadId) {
    if (!this.queues.has(threadId)) this.queues.set(threadId, new EventQueue())
    return this.queues.get(threadId)
  }

  nextEvent(threadId, signal) {
    return this.queue(threadId).take(signal)
  }

  respond(id, result) {
    this.send({ id, result })
  }

  async models(signal) {
    const models = []
    const seenCursors = new Set()
    let cursor
    let pages = 0
    do {
      const result = await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, signal)
      if (!result || !Array.isArray(result.data)) {
        throw new TrLlmError('TR Codex model/list returned no model array.', 'PROTOCOL_ERROR')
      }
      pages += 1
      if (pages > 100) {
        throw new TrLlmError('TR Codex model/list exceeded 100 pages.', 'PROTOCOL_ERROR')
      }
      models.push(...result.data)
      const next = result.nextCursor
      if (next !== undefined && next !== null && next !== '' && typeof next !== 'string') {
        throw new TrLlmError('TR Codex model/list returned an invalid cursor.', 'PROTOCOL_ERROR')
      }
      cursor = next || undefined
      if (cursor && seenCursors.has(cursor)) {
        throw new TrLlmError('TR Codex model pagination repeated a cursor.', 'PROTOCOL_ERROR')
      }
      if (cursor) seenCursors.add(cursor)
    } while (cursor)
    this.lastPagination = { pages, complete: true }
    return models
  }

  async startThread(params, signal) {
    const result = await this.request('thread/start', params, signal)
    if (typeof result?.thread?.id !== 'string') {
      throw new TrLlmError('TR Codex returned no thread ID.', 'PROTOCOL_ERROR')
    }
    this.queue(result.thread.id)
    return result.thread.id
  }

  async startTurn(threadId, params, signal) {
    const result = await this.request('turn/start', { threadId, ...params }, signal)
    if (typeof result?.turn?.id !== 'string') {
      throw new TrLlmError('TR Codex returned no turn ID.', 'PROTOCOL_ERROR')
    }
    return result.turn.id
  }

  interrupt(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId }, undefined, 5_000)
  }

  async release(threadId, turnId) {
    this.retired.add(threadId)
    if (this.retired.size > 1024) this.retired.delete(this.retired.values().next().value)
    this.queues.get(threadId)?.fail(new TrLlmError('TR Codex thread was released.', 'ABORTED'))
    this.queues.delete(threadId)
    if (!this.child) return
    if (turnId) await this.rpc('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 }).catch(() => {})
    await this.rpc('thread/unsubscribe', { threadId }, { timeoutMs: 5_000 }).catch(() => {})
  }

  fail(child, error) {
    if (this.child !== child) return
    this.child = undefined
    this.starting = undefined
    this.peer?.failAll(error)
    for (const queue of this.queues.values()) queue.fail(error)
    this.queues.clear()
    try { child.terminate?.() } catch { /* already gone */ }
  }

  close() {
    const child = this.child
    if (!child) return
    this.fail(child, new TrLlmError('TR Codex provider stopped.', 'TR_LLM_STOPPED'))
  }
}
