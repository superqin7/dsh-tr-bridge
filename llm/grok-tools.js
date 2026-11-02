/**
 * Harness-owned tool bridge for the TR Grok ACP session.
 *
 * Grok 1.0.30 has no ACP tool-result channel, but its `session/new` accepts
 * MCP servers and its permission flow marks MCP calls with the server/tool
 * namespace. This module starts a loopback-only MCP bridge, exposes a small
 * curated subset of the tools Harness already gave this turn, and executes
 * those tools through `ctx.tools.execute` with the calling Agent. Mutations
 * and test runs additionally pass through Harness's one-shot approval service.
 *
 * The bridge never parses assistant text as a tool call. The child MCP server
 * only forwards real MCP `tools/call` requests; a denied or failed native tool
 * becomes an MCP error result, never a fabricated success.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TrLlmError } from './errors.js'

export const GROK_TOOL_NAMES = Object.freeze(['read', 'glob', 'grep', 'edit'])
export const GROK_TEST_TOOL = 'run_tests'
const GROK_TESTS_NAME = GROK_TEST_TOOL
const MAX_HTTP_BODY = 1_000_000
const MAX_TOOL_CHARS = 100_000
const MAX_TEST_CHARS = 24_000
const DEFAULT_TEST_TIMEOUT_MS = 120_000

const ARGUMENT_KEYS = Object.freeze({
  read: Object.freeze(['file_path', 'offset', 'limit']),
  glob: Object.freeze(['pattern', 'path']),
  grep: Object.freeze(['pattern', 'path', 'include']),
  edit: Object.freeze(['file_path', 'old_string', 'new_string', 'replace_all']),
})

export function defaultGrokAuditFile(env = process.env) {
  const base = env.APPDATA || env.LOCALAPPDATA || env.USERPROFILE || env.HOME || homedir()
  return join(base, 'dsh-tr-bridge', 'grok-tool-audit.jsonl')
}

/** Normalize the configured test argv without ever introducing a shell. */
export function normalizeTestCommand(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new TrLlmError('grokTestCommand must be a non-empty array of argv strings.', 'INVALID_CONFIG')
  }
  if (!value.every(item => typeof item === 'string' && item.length > 0)) {
    throw new TrLlmError('grokTestCommand must contain only non-empty strings.', 'INVALID_CONFIG')
  }
  return value.slice()
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content)
  return content.map(block => {
    if (typeof block === 'string') return block
    if (typeof block?.text === 'string') return block.text
    if (block?.type === 'image') return `[image ${block.mediaType ?? 'image'} omitted from bridge text]`
    return `[${block?.type ?? 'content'} block]`
  }).join('\n')
}

function trimResult(text) {
  if (text.length <= MAX_TOOL_CHARS) return text
  return `${text.slice(0, MAX_TOOL_CHARS - 200)}\n\n[result truncated by dsh-tr-bridge]`
}

function sanitizeSchema(toolName, parameters) {
  if (toolName !== 'edit' || parameters === undefined) return parameters
  const copy = structuredClone(parameters)
  if (copy?.properties && typeof copy.properties === 'object') {
    delete copy.properties.sandbox_permissions
    delete copy.properties.justification
  }
  if (Array.isArray(copy?.required)) {
    copy.required = copy.required.filter(name => name !== 'sandbox_permissions' && name !== 'justification')
  }
  return copy
}

function normalizeArguments(toolName, args) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new TrLlmError(`MCP arguments for "${toolName}" must be a JSON object.`, 'TOOL_ARGUMENT_REJECTED')
  }
  if (toolName === GROK_TEST_TOOL) {
    if (Object.keys(args).length > 0) {
      throw new TrLlmError('run_tests accepts no arguments; the test argv is configured by the user.', 'TOOL_ARGUMENT_REJECTED')
    }
    return {}
  }
  const allowed = ARGUMENT_KEYS[toolName]
  if (allowed === undefined) return args
  const filtered = {}
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.includes(key)) {
      throw new TrLlmError(`MCP argument "${key}" is not allowed for "${toolName}".`, 'TOOL_ARGUMENT_REJECTED')
    }
    filtered[key] = value
  }
  return filtered
}

function argumentSummary(toolName, args) {
  if (toolName === GROK_TEST_TOOL) return { command: 'configured' }
  const summary = {}
  if (typeof args?.file_path === 'string') summary.file_path = args.file_path
  if (typeof args?.pattern === 'string') summary.pattern = args.pattern
  if (typeof args?.path === 'string') summary.path = args.path
  if (typeof args?.include === 'string') summary.include = args.include
  return summary
}

export class HarnessToolBridge {
  constructor({
    sessionId,
    cwd,
    tools = [],
    agent,
    executeTool,
    requestApproval,
    subprocess,
    testCommand,
    testCwd,
    testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS,
    auditFile = defaultGrokAuditFile(),
    mcpCommand = process.execPath,
    bridgeScript = fileURLToPath(new URL('./grok-mcp-server.js', import.meta.url)),
    logger,
    signal,
  } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TrLlmError('TR Grok tool bridge requires a Harness session ID.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    if (!agent || typeof agent !== 'object') {
      throw new TrLlmError('TR Grok tool bridge requires the live Harness Agent for this session.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    if (typeof executeTool !== 'function') {
      throw new TrLlmError('TR Grok tool bridge requires the Harness tool registry.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    if (typeof mcpCommand !== 'string' || !mcpCommand) {
      throw new TrLlmError('TR Grok tool bridge could not resolve a Node-compatible executable.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    if (!existsSync(bridgeScript)) {
      throw new TrLlmError(`TR Grok MCP bridge script is missing: ${bridgeScript}`, 'TOOL_CONTEXT_UNAVAILABLE')
    }
    this.sessionId = sessionId
    this.cwd = cwd || process.cwd()
    this.agent = agent
    this.executeTool = executeTool
    this.requestApproval = requestApproval
    this.subprocess = subprocess
    this.testCommand = normalizeTestCommand(testCommand)
    this.testCwd = typeof testCwd === 'string' && testCwd ? testCwd : this.cwd
    this.testTimeoutMs = Number.isFinite(testTimeoutMs) && testTimeoutMs > 0
      ? Math.min(testTimeoutMs, 30 * 60_000)
      : DEFAULT_TEST_TIMEOUT_MS
    this.auditFile = auditFile === null ? null : (auditFile || defaultGrokAuditFile())
    this.logger = logger
    this.serverName = `dsh_harness_${randomBytes(4).toString('hex')}`
    this.trustedPrefix = `${this.serverName}__`
    this.token = randomBytes(24).toString('hex')
    this.mcpCommand = mcpCommand
    this.bridgeScript = bridgeScript
    this.http = undefined
    this.url = undefined
    this.closed = false
    this.externalSignal = signal
    this.abort = new AbortController()
    this.onExternalAbort = () => {
      try { this.abort.abort(signal.reason) } catch { /* already aborted */ }
    }
    if (signal?.aborted) this.onExternalAbort()
    else signal?.addEventListener?.('abort', this.onExternalAbort, { once: true })
    this.auditReady = false
    this.exposed = this.#buildExposedTools(tools)
  }

  #buildExposedTools(tools) {
    const available = new Map()
    for (const definition of Array.isArray(tools) ? tools : []) {
      if (!definition || !GROK_TOOL_NAMES.includes(definition.name)) continue
      if (typeof definition.parameters !== 'object' || definition.parameters === null) continue
      available.set(definition.name, {
        name: definition.name,
        description: typeof definition.description === 'string' ? definition.description : undefined,
        parameters: sanitizeSchema(definition.name, definition.parameters),
        mutating: definition.name === 'edit',
      })
    }
    if (this.testCommand !== undefined) {
      available.set(GROK_TEST_TOOL, {
        name: GROK_TEST_TOOL,
        description: 'Run the project test command configured by the Harness user. The argv is fixed by configuration; this tool never accepts a shell command.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        mutating: true,
      })
    }
    return available
  }

  get toolNames() {
    return [...this.exposed.keys()]
  }

  get toolCount() {
    return this.exposed.size
  }

  get mcpServers() {
    if (!this.url) return []
    return [{
      name: this.serverName,
      command: this.mcpCommand,
      args: [this.bridgeScript],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'DSH_TR_GROK_BRIDGE_URL', value: this.url },
        { name: 'DSH_TR_GROK_BRIDGE_TOKEN', value: this.token },
      ],
    }]
  }

  async start() {
    if (this.http) return this
    if (this.exposed.size === 0) {
      throw new TrLlmError('TR Grok tool bridge has no approved Harness tools to expose.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    this.http = createServer((req, res) => {
      Promise.resolve(this.#handle(req, res)).catch(error => {
        this.#respond(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    })
    this.http.on('clientError', (_error, socket) => {
      try { socket.destroy() } catch { /* already gone */ }
    })
    await new Promise((resolve, reject) => {
      const onError = error => {
        this.http?.off('listening', onListening)
        reject(new TrLlmError('TR Grok tool bridge could not bind loopback.', 'TOOL_CONTEXT_UNAVAILABLE', { cause: error }))
      }
      const onListening = () => {
        this.http?.off('error', onError)
        resolve()
      }
      this.http.once('error', onError)
      this.http.once('listening', onListening)
      this.http.listen(0, '127.0.0.1')
    })
    this.http.unref?.()
    const address = this.http.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new TrLlmError('TR Grok tool bridge did not receive a loopback port.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    this.url = `http://127.0.0.1:${address.port}`
    return this
  }

  async close() {
    if (this.closed) return
    this.closed = true
    try { this.externalSignal?.removeEventListener?.('abort', this.onExternalAbort) } catch { /* no listener */ }
    try { this.abort.abort() } catch { /* already aborted */ }
    const http = this.http
    this.http = undefined
    if (http) {
      try { http.closeAllConnections?.() } catch { /* best effort */ }
      await new Promise(resolve => {
        try { http.close(() => resolve()) } catch { resolve() }
      })
    }
  }

  #authorized(req) {
    const header = req.headers?.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const actual = Buffer.from(header.slice('Bearer '.length))
    const expected = Buffer.from(this.token)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  #respond(res, status, body) {
    if (res.headersSent || res.destroyed) return
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
  }

  async #handle(req, res) {
    if (!this.#authorized(req)) {
      this.#respond(res, 401, { error: 'unauthorized' })
      return
    }
    if (req.method === 'GET' && req.url === '/tools') {
      this.#respond(res, 200, this.toolsPayload())
      return
    }
    if (req.method === 'POST' && req.url === '/call') {
      const body = await this.#readBody(req)
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        this.#respond(res, 400, { error: 'invalid JSON bridge request' })
        return
      }
      const result = await this.#call({
        name: payload?.name,
        arguments: payload?.arguments,
        callId: payload?.callId,
      })
      this.#respond(res, 200, result)
      return
    }
    this.#respond(res, 404, { error: 'not found' })
  }

  async #readBody(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_HTTP_BODY) throw new Error('bridge request is too large')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  toolsPayload() {
    return {
      tools: [...this.exposed.values()].map(tool => ({
        name: tool.name,
        ...tool.description === undefined ? {} : { description: tool.description },
        inputSchema: tool.parameters,
      })),
    }
  }

  async #call({ name, arguments: args, callId }) {
    const tool = this.exposed.get(name)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: tool "${String(name)}" is not exposed by this Harness bridge.` }],
      }
    }
    const id = typeof callId === 'string' && callId ? callId : randomUUID()
    const started = Date.now()
    let approval = 'not-required'
    let normalized
    try {
      normalized = normalizeArguments(name, args)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.#audit({ phase: 'result', tool: name, callId: id, isError: true, durationMs: Date.now() - started, error: text })
      return { isError: true, content: [{ type: 'text', text: `Error: ${text}` }] }
    }
    this.#audit({ phase: 'request', tool: name, callId: id, arguments: argumentSummary(name, normalized) })
    if (tool.mutating) {
      approval = await this.#approve(name, id, normalized)
      if (approval !== 'allowed-once') {
        const text = `Error: tool "${name}" was not approved (${approval}). The tool did not run.`
        this.#audit({ phase: 'result', tool: name, callId: id, approval, isError: true, durationMs: Date.now() - started, error: text })
        return { isError: true, content: [{ type: 'text', text }] }
      }
    }
    try {
      const result = name === GROK_TEST_TOOL
        ? await this.#runTests()
        : await this.#runNative(name, normalized, id)
      const resultText = result.content?.[0]?.text
      this.#audit({
        phase: 'result',
        tool: name,
        callId: id,
        approval,
        isError: result.isError === true,
        durationMs: Date.now() - started,
        resultChars: resultText?.length ?? 0,
        ...result.isError && typeof resultText === 'string'
          ? { error: resultText.slice(0, 500) }
          : {},
      })
      return result
    } catch (error) {
      if (this.abort.signal.aborted) {
        const text = 'Error: TR Grok tool call was cancelled.'
        this.#audit({ phase: 'result', tool: name, callId: id, approval, isError: true, durationMs: Date.now() - started, error: 'cancelled' })
        return { isError: true, content: [{ type: 'text', text }] }
      }
      const text = error instanceof Error ? error.message : String(error)
      this.#audit({ phase: 'result', tool: name, callId: id, approval, isError: true, durationMs: Date.now() - started, error: text })
      return { isError: true, content: [{ type: 'text', text: `Error: ${text}` }] }
    }
  }

  async #approve(toolName, callId, args) {
    if (typeof this.requestApproval !== 'function') return 'unavailable'
    const target = typeof args?.file_path === 'string' ? ` for ${args.file_path}` : ''
    const reason = toolName === GROK_TESTS_NAME
      ? 'TR Grok wants to run the configured project test command through Harness.'
      : `TR Grok wants to modify a project file${target} through Harness.`
    try {
      const outcome = await this.requestApproval({
        agent: this.agent,
        toolName,
        callId,
        reason,
        signal: this.abort.signal,
      })
      return typeof outcome === 'string' ? outcome : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async #runNative(name, args, callId) {
    const result = await this.executeTool({
      name,
      arguments: args,
      agent: this.agent,
      callId,
      signal: this.abort.signal,
    })
    if (!result || typeof result !== 'object') {
      throw new TrLlmError(`Harness tool "${name}" returned no result.`, 'TOOL_FAILED')
    }
    const text = trimResult(textOf(result.content))
    return {
      isError: result.isError === true,
      content: [{ type: 'text', text: text || (result.isError ? `Error: Harness tool "${name}" failed without text.` : `(${name} returned no text)`) }],
    }
  }

  async #runTests() {
    if (this.testCommand === undefined) {
      throw new TrLlmError('No project test command is configured; set grokTestCommand first.', 'TEST_UNAVAILABLE')
    }
    if (typeof this.subprocess?.spawn !== 'function') {
      throw new TrLlmError('Harness subprocess service is unavailable for test execution.', 'TEST_UNAVAILABLE')
    }
    const timeoutMs = this.testTimeoutMs
    const controller = new AbortController()
    const onAbort = () => controller.abort(this.abort.signal.reason)
    if (this.abort.signal.aborted) {
      return { isError: true, content: [{ type: 'text', text: 'Error: TR Grok test call was cancelled.' }] }
    }
    this.abort.signal.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('test command timed out'))
    }, timeoutMs)
    let child
    let stdout = ''
    let stderr = ''
    try {
      child = this.subprocess.spawn({
        argv: this.testCommand,
        cwd: this.testCwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3_000,
        signal: controller.signal,
      })
      child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk, MAX_TEST_CHARS) })
      child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk, MAX_TEST_CHARS) })
      try { child.stdin?.end() } catch { /* already closed */ }
      const status = await child.done
      if (this.abort.signal.aborted) {
        return { isError: true, content: [{ type: 'text', text: 'Error: TR Grok test call was cancelled and the test process was terminated.' }] }
      }
      if (timedOut) {
        return { isError: true, content: [{ type: 'text', text: `Error: test command exceeded ${timeoutMs}ms and was terminated.` }] }
      }
      const exitCode = status?.exitCode ?? (status?.signal ? `signal ${status.signal}` : 'unknown')
      const ok = status?.exitCode === 0
      const text = [
        `[test command: ${JSON.stringify(this.testCommand)} in ${this.testCwd}]`,
        `exit code: ${exitCode}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
        stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
      ].filter(Boolean).join('\n\n')
      return { isError: !ok, content: [{ type: 'text', text: trimResult(text) }] }
    } catch (error) {
      if (controller.signal.aborted && !this.abort.signal.aborted) {
        const text = `Error: test command exceeded ${timeoutMs}ms and was terminated.`
        return { isError: true, content: [{ type: 'text', text }] }
      }
      throw error
    } finally {
      clearTimeout(timer)
      this.abort.signal.removeEventListener('abort', onAbort)
      if (controller.signal.aborted) {
        try { child?.terminate?.() } catch { /* already gone */ }
      }
    }
  }

  #audit(entry) {
    if (!this.auditFile) return
    try {
      if (!this.auditReady) {
        mkdirSync(dirname(this.auditFile), { recursive: true })
        this.auditReady = true
      }
      appendFileSync(this.auditFile, JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        ...entry,
      }) + '\n')
    } catch (error) {
      this.logger?.warn?.(`TR Grok tool audit failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function appendBounded(previous, chunk, limit) {
  const room = limit - previous.length
  return room > 0 ? previous + String(chunk).slice(0, room) : previous
}
