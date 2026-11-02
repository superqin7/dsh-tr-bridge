/**
 * TR Grok ACP transport.
 *
 * Starts `tr grok agent --no-leader stdio` with a literal argv. The process
 * owns no Harness credentials: TokenRouter/Grok login remains in the CLI.
 * ACP has no client-side dynamic-tool channel, so server tool permission
 * requests are denied and reported; this provider never fabricates a tool call.
 */
import { EventQueue, LineBuffer, RpcPeer } from './rpc.js'
import { TrLlmError } from './errors.js'

const MAX_STDERR_BYTES = 64 * 1024

export function grokAgentArgv(command) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new TrLlmError('TR Grok launcher path is empty.', 'LAUNCHER_MISSING')
  }
  return [command, 'grok', 'agent', '--no-leader', 'stdio']
}

export class GrokAppServer {
  generation = 0
  child
  starting
  peer
  queues = new Map()
  stderrBytes = 0
  actualModels = []

  constructor({
    spawn,
    command,
    cwd,
    requestTimeoutMs = 30_000,
    promptTimeoutMs = 10 * 60_000,
    clientVersion = '0.1.0',
  } = {}) {
    if (typeof spawn !== 'function') throw new TrLlmError('DSH subprocess service is unavailable.', 'SUBPROCESS_UNAVAILABLE')
    this.spawn = spawn
    this.command = command
    this.cwd = cwd
    this.requestTimeoutMs = requestTimeoutMs
    this.promptTimeoutMs = promptTimeoutMs
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
    const argv = grokAgentArgv(this.command)
    const child = this.spawn({
      argv,
      cwd: this.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 3_000,
    })
    if (!child?.stdout || typeof child.stdin?.write !== 'function') {
      throw new TrLlmError('TR Grok did not expose stdio pipes.', 'PROTOCOL_ERROR')
    }
    this.child = child
    this.generation += 1
    this.queues.clear()
    this.stderrBytes = 0

    const lines = new LineBuffer(line => {
      if (this.child !== child) return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.fail(child, new TrLlmError('TR Grok sent malformed protocol data.', 'PROTOCOL_ERROR'))
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
      try { lines.flush() } catch (error) { this.fail(child, error) }
    })
    child.stderr?.on?.('data', chunk => {
      this.stderrBytes = Math.min(MAX_STDERR_BYTES, this.stderrBytes + chunk.length)
    })
    child.stdin?.on?.('error', error => this.fail(
      child,
      new TrLlmError('TR Grok input pipe is closed.', 'TR_LLM_DISCONNECTED', { cause: error }),
    ))

    this.peer = new RpcPeer({
      send: message => this.send(message),
      timeoutMs: this.requestTimeoutMs,
      label: 'TR Grok',
    })

    const done = child.done && typeof child.done.then === 'function' ? child.done : Promise.resolve({})
    done.then(
      status => this.fail(child, new TrLlmError(
        `TR Grok disconnected (${status?.signal ?? status?.exitCode ?? 'unknown'}).`,
        'TR_LLM_DISCONNECTED',
      )),
      () => this.fail(child, new TrLlmError('TR Grok disconnected.', 'TR_LLM_DISCONNECTED')),
    )

    try {
      await this.peer.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: 'dsh_tr_bridge',
          title: 'DSH TokenRouter Bridge',
          version: this.clientVersion,
        },
      })
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
      throw new TrLlmError('TR Grok is disconnected.', 'TR_LLM_DISCONNECTED')
    }
    try {
      child.stdin.write(JSON.stringify(message) + '\n')
    } catch (error) {
      throw new TrLlmError('TR Grok input pipe is closed.', 'TR_LLM_DISCONNECTED', { cause: error })
    }
  }

  rpc(method, params = {}, { signal, timeoutMs } = {}) {
    if (!this.peer) throw new TrLlmError('TR Grok is not initialized.', 'TR_LLM_DISCONNECTED')
    return this.peer.request(method, params, { signal, timeoutMs })
  }

  async request(method, params = {}, signal, timeoutMs) {
    await this.start(signal)
    return this.rpc(method, params, { signal, timeoutMs })
  }

  receive(message) {
    if (this.peer?.receive(message)) return
    if (typeof message?.method !== 'string') return
    if (message.method === 'session/update') {
      const sessionId = message.params?.sessionId
      if (typeof sessionId === 'string') this.queue(sessionId).push({ method: message.method, params: message.params })
      return
    }
    if (message.id !== undefined) {
      this.answerServerRequest(message)
      return
    }
    // Notifications without a session are deliberately ignored. They can be
    // diagnostics, queue state, or command updates; none are assistant text.
  }

  answerServerRequest(message) {
    if (message.method === 'session/request_permission') {
      // This provider has no client-side tool executor. Answering "cancelled"
      // is honest: the tool is not run and no permission is granted.
      this.send({
        id: message.id,
        result: { outcome: { outcome: 'cancelled' } },
      })
      return
    }
    this.send({
      id: message.id,
      error: { code: -32601, message: 'This client supports text chat only.' },
    })
  }

  queue(sessionId) {
    if (!this.queues.has(sessionId)) this.queues.set(sessionId, new EventQueue())
    return this.queues.get(sessionId)
  }

  nextEvent(sessionId, signal) {
    return this.queue(sessionId).take(signal)
  }

  pushEvent(sessionId, event) {
    this.queue(sessionId).push(event)
  }

  drainEvents(sessionId) {
    const queue = this.queues.get(sessionId)
    if (!queue) return []
    const values = queue.values.splice(0)
    return values
  }

  async newSession({ cwd = this.cwd } = {}, signal) {
    const result = await this.request('session/new', { cwd, mcpServers: [] }, signal)
    if (!result || typeof result.sessionId !== 'string') {
      throw new TrLlmError('TR Grok returned no session ID.', 'PROTOCOL_ERROR')
    }
    this.queue(result.sessionId)
    return result
  }

  async setConfigOption(sessionId, configId, value, signal) {
    const result = await this.request('session/set_config_option', { sessionId, configId, value }, signal)
    if (!result) throw new TrLlmError('TR Grok returned no config result.', 'PROTOCOL_ERROR')
    return result
  }

  prompt(sessionId, text, signal) {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }, signal, this.promptTimeoutMs)
  }

  cancel(sessionId) {
    try {
      this.send({ method: 'session/cancel', params: { sessionId } })
    } catch {
      // The process may already be gone; close() reports that separately.
    }
  }

  async closeSession(sessionId) {
    try {
      if (!this.child) return
      await this.request('session/close', { sessionId }, undefined, 5_000)
    } catch {
      // A discovery/failed session must not mask the primary error.
    } finally {
      this.queues.delete(sessionId)
    }
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
    this.fail(child, new TrLlmError('TR Grok provider stopped.', 'TR_LLM_STOPPED'))
  }
}
