import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexAdapter } from '../llm/codex-adapter.js'
import { CodexCatalog } from '../llm/catalog.js'
import { EventQueue } from '../llm/rpc.js'

class FakeServer {
  generation = 1
  events = new EventQueue()
  threads = []
  turns = []
  responses = []
  releases = []
  constructor(models = [{ slug: 'gpt-5.6-terra', displayName: 'Terra' }]) {
    this.modelsForList = models
  }
  async start() {}
  async models() { return this.modelsForList }
  async startThread(params) { this.threads.push(params); return 'thread-1' }
  async startTurn(threadId, params) { this.turns.push({ threadId, params }); return 'turn-1' }
  nextEvent(_threadId, signal) { return this.events.take(signal) }
  respond(id, result) { this.responses.push({ id, result }) }
  async release(threadId, turnId) { this.releases.push({ threadId, turnId }) }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function adapterFor(server, overrides = {}) {
  const catalog = new CodexCatalog(server, { provider: 'tr-codex', ttlMs: 60_000 })
  return new CodexAdapter({
    provider: 'tr-codex',
    name: 'TR Codex',
    server,
    catalog,
    cwd: 'C:\\work',
    ...overrides,
  })
}

function completeTurn(server) {
  server.events.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  })
}

const effortModels = [{
  slug: 'gpt-effort',
  displayName: 'Effort',
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
  defaultReasoningEffort: 'high',
}]

function baseOptions(overrides = {}) {
  return {
    provider: 'tr-codex',
    model: 'gpt-5.6-terra',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    sessionId: 'session-1',
    ...overrides,
  }
}

function delta(text) {
  return { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i1', delta: text } }
}

test('selected model id reaches thread/start and turn/start; text streams and finishes', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  server.events.push(delta('Hello '))
  server.events.push(delta('world'))
  server.events.push({
    method: 'item/completed',
    params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'i1', type: 'agentMessage', text: 'Hello world' } },
  })
  server.events.push({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })

  const chunks = await collect(adapter.stream(baseOptions()))

  assert.equal(server.threads[0].model, 'gpt-5.6-terra')
  assert.equal(server.threads[0].sandbox, 'read-only')
  assert.equal(server.threads[0].approvalPolicy, 'never')
  assert.equal(server.turns[0].params.model, 'gpt-5.6-terra')
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'text-delta', 'text-delta', 'block-end', 'finish',
  ])
  assert.equal(chunks[1].text, 'Hello ')
  assert.equal(chunks[3].block.type, 'text')
  assert.deepEqual(chunks[4].reason, { kind: 'stop' })
  assert.equal(chunks[4].replayState.response.kind, 'tr-codex')
})

test('a dynamic tool call ends with tool-calls, then the result continues the same thread', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  const toolBlock = {
    type: 'tool-call',
    id: 'call-1',
    name: 'read_file',
    arguments: '{"path":"a.txt"}',
  }
  server.events.push(delta('Reading.'))
  server.events.push({
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      tool: 'read_file',
      arguments: { path: 'a.txt' },
    },
    requestId: 77,
  })

  const first = await collect(adapter.stream(baseOptions({
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })))
  const finish = first.at(-1)
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  const end = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(end.block, toolBlock)

  const assistant = {
    role: 'assistant',
    content: [end.block],
    source: { kind: 'model', replayState: finish.replayState },
  }
  const tool = {
    role: 'tool',
    source: { kind: 'tool', callId: 'call-1' },
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'file body' }],
    isError: false,
  }
  server.events.push({
    method: 'item/completed',
    params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'i2', type: 'agentMessage', text: 'Done' } },
  })
  server.events.push({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })

  const second = await collect(adapter.stream(baseOptions({
    messages: [baseOptions().messages[0], assistant, tool],
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })))

  assert.equal(server.responses.length, 1)
  assert.deepEqual(server.responses[0], {
    id: 77,
    result: { contentItems: [{ type: 'inputText', text: 'file body' }], success: true },
  })
  assert.equal(server.threads.length, 1)
  assert.equal(server.turns.length, 1)
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.equal(second.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Done'), true)
})

test('a tool-call finish still remembers the effort that reached turn/start', async () => {
  const server = new FakeServer(effortModels)
  const records = []
  const adapter = adapterFor(server, {
    preferences: {
      get() {},
      record(provider, model, effort) { records.push({ provider, model, effort }) },
    },
  })
  server.events.push({
    method: 'item/tool/call',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      tool: 'read_file',
      arguments: { path: 'a.txt' },
    },
    requestId: 78,
  })
  const chunks = await collect(adapter.stream(baseOptions({
    model: 'gpt-effort',
    reasoningEffort: 'low',
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
  assert.deepEqual(records, [{ provider: 'tr-codex', model: 'gpt-effort', effort: 'low' }])
})

test('cancelling a running turn aborts and releases the thread', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  server.events.push(delta('partial'))
  const controller = new AbortController()
  const iterator = adapter.stream(baseOptions({ signal: controller.signal }))[Symbol.asyncIterator]()

  const first = await iterator.next()
  assert.equal(first.value.type, 'block-start')
  const second = await iterator.next()
  assert.equal(second.value.type, 'text-delta')
  controller.abort(new Error('user cancelled'))
  await assert.rejects(iterator.next(), /user cancelled/)
  assert.equal(server.releases.length, 1)
  assert.equal(server.releases[0].threadId, 'thread-1')
})

test('a non-default reasoning effort reaches turn/start; unsupported levels fail before a thread', async () => {
  const server = new FakeServer(effortModels)
  const adapter = adapterFor(server)
  completeTurn(server)
  await collect(adapter.stream(baseOptions({ model: 'gpt-effort', reasoningEffort: 'low' })))
  assert.equal(server.turns[0].params.effort, 'low')

  const rejected = new FakeServer(effortModels)
  const rejectedAdapter = adapterFor(rejected)
  await assert.rejects(
    collect(rejectedAdapter.stream(baseOptions({ model: 'gpt-effort', reasoningEffort: 'ultra' }))),
    error => error.code === 'UNSUPPORTED_OPTION' && /available: low, high/.test(error.message),
  )
  assert.equal(rejected.threads.length, 0)
})

test('a saved preference becomes the resolved default so a restart restores it', async () => {
  const server = new FakeServer(effortModels)
  const adapter = adapterFor(server, {
    preferences: {
      get() { return 'low' },
      record() {},
    },
  })
  const info = await adapter.resolveModel('tr-codex', 'gpt-effort')
  assert.equal(info.reasoning.defaultEffort, 'low')
  const models = await adapter.listModels('tr-codex')
  assert.equal(models[0].reasoning.defaultEffort, 'low')
})

test('a saved per-model effort replaces the picker default on a model switch', async () => {
  const server = new FakeServer(effortModels)
  const recorded = []
  const adapter = adapterFor(server, {
    preferences: {
      get() { return 'low' },
      record(provider, model, effort) { recorded.push({ provider, model, effort }) },
    },
  })
  completeTurn(server)
  const chunks = await collect(adapter.stream(baseOptions({ model: 'gpt-effort', reasoningEffort: 'low' })))
  assert.equal(server.turns[0].params.effort, 'low')
  assert.deepEqual(recorded, [{ provider: 'tr-codex', model: 'gpt-effort', effort: 'low' }])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('unsupported request overrides fail before starting a thread', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  await assert.rejects(
    collect(adapter.stream(baseOptions({ temperature: 0.2 }))),
    error => error.code === 'UNSUPPORTED_OPTION',
  )
  assert.equal(server.threads.length, 0)
})

test('providerInfo keeps the exact provider id', () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  assert.deepEqual(adapter.providerInfo('tr-codex'), { id: 'tr-codex', name: 'TR Codex' })
})

test('listModels serves the live catalog with or without the route argument', async () => {
  const server = new FakeServer()
  const adapter = adapterFor(server)
  const withRoute = await adapter.listModels('tr-codex')
  const withoutRoute = await adapter.listModels()
  assert.deepEqual(withRoute.map(model => model.id), ['gpt-5.6-terra'])
  assert.deepEqual(withoutRoute.map(model => model.id), ['gpt-5.6-terra'])
})
