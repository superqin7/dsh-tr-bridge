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
  async newSession() {
    const id = `s${this.sessions.length + 1}`
    this.sessions.push({ sessionId: id })
    return { sessionId: id, models: { currentModelId: 'tokenrouter', availableModels: [] } }
  }
  async setConfigOption(sessionId, configId, value) {
    this.sets.push({ sessionId, configId, value })
    return this.setResult ?? { configOptions: [{ id: 'model', currentValue: value }] }
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
    catalog: { async list() { return [] } },
    cwd: 'C:\\work',
    idleTimeoutMs: 5_000,
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
    sessionId: 's1',
    stopReason: 'end_turn',
  })
  assert.deepEqual(server.closed, ['s1'])
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

test('Grok reports a native tool call instead of pretending Harness ran it', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  server.events.push({ params: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'shell' } } })
  await assert.rejects(
    collect(adapter.stream(options())),
    error => error.code === 'UNSUPPORTED_TOOL_CALL',
  )
  assert.deepEqual(server.closed, ['s1'])
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
