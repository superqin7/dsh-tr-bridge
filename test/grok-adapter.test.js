import test from 'node:test'
import assert from 'node:assert/strict'
import { EventQueue } from '../llm/rpc.js'
import { GrokAdapter } from '../llm/grok-adapter.js'

class FakeServer {
  generation = 1
  events = new EventQueue()
  sessions = []
  sets = []
  closed = []
  cancelled = []
  promptResult = { stopReason: 'end_turn', _meta: { modelId: 'grok-9.9', usage: { inputTokens: 4, outputTokens: 2 } } }
  setResult = undefined
  async start() {}
  async newSession(options = {}) {
    const id = `s${this.sessions.length + 1}`
    this.sessions.push({ sessionId: id, options })
    return { sessionId: id, models: { currentModelId: 'tokenrouter', availableModels: [] } }
  }
  async setConfigOption(sessionId, configId, value) {
    this.sets.push({ sessionId, configId, value })
    return this.setResult ?? {
      configOptions: [
        { id: 'model', currentValue: configId === 'model' ? value : 'tokenrouter-grok-9.9' },
        { id: 'reasoning_effort', currentValue: value },
      ],
    }
  }
  prompt() { return Promise.resolve(this.promptResult) }
  nextEvent(_id, signal) { return this.events.take(signal) }
  pushEvent(_id, event) { this.events.push(event) }
  drainEvents() {
    const values = this.events.values.splice(0)
    return values
  }
  cancel(id) { this.cancelled.push(id) }
  async closeSession(id) { this.closed.push(id) }
}

function adapterFor(server, overrides = {}) {
  return new GrokAdapter({
    provider: 'tr-grok',
    name: 'TR Grok',
    server,
    catalog: {
      async resolve(provider, id) {
        return {
          provider,
          id,
          name: id,
          inputModalities: ['text'],
          reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: 'high' },
        }
      },
      async list(...args) {
        assert.deepEqual(args, [], 'listModels must not pass the provider as an AbortSignal')
        return [await this.resolve('tr-grok', 'tokenrouter-grok-9.9')]
      },
    },
    cwd: 'C:\\work',
    idleTimeoutMs: 5_000,
    grokTools: false,
    ...overrides,
  })
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function options(overrides = {}) {
  return {
    provider: 'tr-grok',
    model: 'tokenrouter-grok-9.9',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }],
    sessionId: 'session-1',
    system: 'Be concise.',
    ...overrides,
  }
}

test('Grok selected model reaches set_config_option and text streams with actual model evidence', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  server.events.push({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } } })
  const chunks = await collect(adapter.stream(options()))
  assert.deepEqual(server.sets[0], { sessionId: 's1', configId: 'model', value: 'tokenrouter-grok-9.9' })
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].text, 'Hello')
  assert.equal(chunks[2].block.text, 'Hello')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.deepEqual(adapter.lastExecution, {
    requested: 'tokenrouter-grok-9.9',
    actual: 'grok-9.9',
    reasoningEffort: undefined,
    sessionId: 's1',
    stopReason: 'end_turn',
    toolsEnabled: false,
  })
  assert.deepEqual(server.closed, ['s1'])
})

test('Grok surfaces a saved effort as the model resolver default after restart', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server, {
    preferences: {
      get() { return 'low' },
      record() {},
    },
  })
  const info = await adapter.resolveModel('tr-grok', 'tokenrouter-grok-9.9')
  assert.equal(info.reasoning.defaultEffort, 'low')
  assert.equal((await adapter.listModels('tr-grok'))[0].reasoning.defaultEffort, 'low')
})

test('Grok sends a selected effort through set_config_option and records the confirmed value', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  const chunks = await collect(adapter.stream(options({ reasoningEffort: 'high' })))
  assert.deepEqual(server.sets[1], { sessionId: 's1', configId: 'reasoning_effort', value: 'high' })
  assert.equal(adapter.lastExecution.reasoningEffort, 'high')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('Grok fails loudly for an unadvertised effort and for an unconfirmed CLI value', async () => {
  const unsupportedServer = new FakeServer()
  const unsupported = adapterFor(unsupportedServer)
  await assert.rejects(
    collect(unsupported.stream(options({ reasoningEffort: 'ultra' }))),
    error => error.code === 'UNSUPPORTED_OPTION' && /available: high, low/.test(error.message),
  )
  assert.deepEqual(unsupportedServer.sessions, [])

  const unconfirmedServer = new FakeServer()
  unconfirmedServer.setResult = { configOptions: [{ id: 'model', currentValue: 'tokenrouter-grok-9.9' }] }
  const unconfirmed = adapterFor(unconfirmedServer)
  await assert.rejects(
    collect(unconfirmed.stream(options({ reasoningEffort: 'high' }))),
    error => error.code === 'UNSUPPORTED_OPTION' && /did not confirm/.test(error.message),
  )
})

test('Grok refuses a silent model substitution', async () => {
  const server = new FakeServer()
  server.setResult = { configOptions: [{ id: 'model', currentValue: 'grok-fallback' }] }
  const adapter = adapterFor(server)
  await assert.rejects(
    collect(adapter.stream(options())),
    error => error.code === 'MODEL_UNAVAILABLE',
  )
  assert.deepEqual(server.closed, ['s1'])
})

test('Grok reports a denied non-MCP tool instead of pretending Harness ran it', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  server.deniedPermissionCount = () => 1
  await assert.rejects(
    collect(adapter.stream(options())),
    error => error.code === 'UNSUPPORTED_TOOL_CALL',
  )
  assert.deepEqual(server.closed, ['s1'])
})

test('Grok registers the Harness MCP bridge and allows its namespaced tool calls', async () => {
  const server = new FakeServer()
  const bridge = {
    serverName: 'dsh_harness_test',
    trustedPrefix: 'dsh_harness_test__',
    toolNames: ['read', 'edit', 'run_tests'],
    toolCount: 3,
    mcpServers: [{ name: 'dsh_harness_test', command: 'node', args: ['bridge.js'], env: [] }],
    started: false,
    closed: false,
    async start() { this.started = true },
    async close() { this.closed = true },
  }
  const adapter = adapterFor(server, {
    grokTools: true,
    tools: { execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }) },
    agents: { get: id => id === 'session-1' ? { id } : undefined },
    approval: { request: async () => 'allowed-once' },
    subprocess: {},
    toolBridgeFactory: input => {
      assert.equal(input.sessionId, 'session-1')
      assert.equal(input.agent.id, 'session-1')
      return bridge
    },
  })
  let promptText
  server.prompt = (_session, text) => {
    promptText = text
    return Promise.resolve(server.promptResult)
  }
  server.events.push({
    params: {
      update: {
        sessionUpdate: 'tool_call',
        title: 'use_tool',
        rawInput: { tool_name: 'dsh_harness_test__read', tool_input: { file_path: 'a' } },
      },
    },
  })
  server.events.push({
    params: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        title: 'read',
        status: 'completed',
      },
    },
  })
  const chunks = await collect(adapter.stream(options()))
  assert.equal(bridge.started, true)
  assert.equal(bridge.closed, true)
  assert.equal(server.sessions[0].options.mcpServers.length, 1)
  assert.equal(server.sessions[0].options.trustedToolPrefix, 'dsh_harness_test')
  assert.match(promptText, /dsh_harness_test/)
  assert.deepEqual(adapter.lastExecution.toolNames, ['read', 'edit', 'run_tests'])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('Grok still rejects a tool outside the authorized MCP namespace', async () => {
  const server = new FakeServer()
  const bridge = {
    serverName: 'dsh_harness_test',
    trustedPrefix: 'dsh_harness_test__',
    toolNames: ['read'],
    toolCount: 1,
    mcpServers: [],
    async start() {},
    async close() { this.closed = true },
  }
  const adapter = adapterFor(server, {
    grokTools: true,
    tools: { execute: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }) },
    agents: { get: () => ({ id: 'session-1' }) },
    approval: { request: async () => 'allowed-once' },
    subprocess: {},
    toolBridgeFactory: () => bridge,
  })
  server.deniedPermissionCount = () => 1
  await assert.rejects(
    collect(adapter.stream(options())),
    error => error.code === 'UNSUPPORTED_TOOL_CALL',
  )
  assert.equal(bridge.closed, true)
})

test('Grok omits Harness tools from ACP and returns usage', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  let promptText
  server.prompt = (_session, text) => {
    promptText = text
    return Promise.resolve(server.promptResult)
  }
  const chunks = await collect(adapter.stream(options()))
  assert.match(promptText, /Harness tools are not available/)
  assert.equal(promptText.includes('read_file'), false)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 4,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  })
})
