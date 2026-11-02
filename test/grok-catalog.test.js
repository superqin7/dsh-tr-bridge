import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { GrokCatalog, grokModelInfo } from '../llm/grok-catalog.js'
import { discoverGrokRouteIds } from '../llm/grok-routes.js'

class FakeServer {
  sessions = []
  closed = []
  fail = false
  constructor(models = []) {
    this.models = models
  }
  async newSession(params) {
    this.sessions.push(params)
    if (this.fail) throw new Error('offline')
    return {
      sessionId: `session-${this.sessions.length}`,
      models: { currentModelId: 'tokenrouter', availableModels: this.models },
    }
  }
  async closeSession(id) {
    this.closed.push(id)
  }
}

const models = [
  { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { reasoningEffort: 'high', reasoningEfforts: [{ id: 'high', label: 'High', default: true }] } },
  { modelId: 'tokenrouter', name: 'TOKEN ROUTER', _meta: { reasoningEffort: 'low', reasoningEfforts: [{ value: 'low', description: 'Fast' }] } },
  { modelId: 'tokenrouter-grok-9.9', name: 'TR · Grok 9.9', description: 'Future alias' },
]

const routeIds = ['tokenrouter', 'tokenrouter-grok-9.9']

function catalogFor(server, overrides = {}) {
  return new GrokCatalog(server, {
    cwd: 'C:\\work',
    ttlMs: 60_000,
    routeCatalog: async () => routeIds,
    ...overrides,
  })
}

test('Grok catalog keeps only models confirmed by the live TokenRouter route notice', async () => {
  const server = new FakeServer(models)
  const catalog = catalogFor(server)
  const entries = await catalog.list()
  assert.deepEqual(entries.map(entry => entry.id), ['tokenrouter', 'tokenrouter-grok-9.9'])
  assert.equal(entries.some(entry => entry.id === 'grok-4.6'), false)
  assert.deepEqual(entries[0].reasoning, { efforts: [{ id: 'low', name: 'low', description: 'Fast' }], defaultEffort: 'low' })
  assert.equal(entries[0].isDefault, true)
  assert.equal(entries[1].routingAlias, true)
  assert.equal(server.sessions[0].cwd, 'C:\\work')
  assert.deepEqual(server.closed, ['session-1'])
})

test('Grok catalog fails closed when route authorization cannot be confirmed', async () => {
  const server = new FakeServer(models)
  await assert.rejects(
    new GrokCatalog(server, { cwd: 'C:\\work' }).list(),
    error => error.code === 'MODEL_DISCOVERY_FAILED' && /route authorization is unavailable/.test(error.message),
  )
  assert.equal(server.sessions.length, 0)
})

test('Grok catalog fails closed when the route notice is empty or disjoint', async () => {
  const server = new FakeServer(models)
  await assert.rejects(
    catalogFor(server, { routeCatalog: async () => [] }).list(),
    error => error.code === 'MODEL_DISCOVERY_FAILED',
  )
  await assert.rejects(
    catalogFor(new FakeServer(models), { routeCatalog: async () => ['not-in-acp'] }).list(),
    error => error.code === 'MODEL_DISCOVERY_FAILED',
  )
})

test('Grok catalog menu reports a discovery failure instead of a stale list', async () => {
  const server = new FakeServer(models)
  const catalog = catalogFor(server)
  assert.equal((await catalog.list()).length, 2)
  server.fail = true
  await assert.rejects(catalog.list(), /offline/)
})

test('Grok catalog falls back to the ACP model config select', async () => {
  const server = {
    async newSession() {
      return {
        sessionId: 's1',
        configOptions: [{
          id: 'model',
          currentValue: 'tokenrouter-x',
          options: [{ value: 'tokenrouter-x', name: 'X' }],
        }],
      }
    },
    async closeSession() {},
  }
  const catalog = new GrokCatalog(server, {
    cwd: 'C:\\work',
    routeCatalog: async () => ['tokenrouter-x'],
  })
  const entries = await catalog.list()
  assert.deepEqual(entries.map(entry => entry.id), ['tokenrouter-x'])
  assert.equal(entries[0].id, 'tokenrouter-x')
})

test('Grok catalog refuses a partial page because ACP exposes no pagination call', async () => {
  const server = {
    async newSession() {
      return {
        sessionId: 's1',
        models: { currentModelId: 'a', availableModels: [{ modelId: 'a' }], nextCursor: 'page-2' },
      }
    },
    async closeSession() {},
  }
  const catalog = new GrokCatalog(server, { cwd: 'C:\\work', routeCatalog: async () => ['a'] })
  await assert.rejects(catalog.list(), error => error.code === 'MODEL_DISCOVERY_FAILED')
})

test('Grok catalog does not keep a removed model authorized', async () => {
  const server = new FakeServer(models)
  const catalog = catalogFor(server, { ttlMs: 0 })
  assert.equal((await catalog.resolve('tr-grok', 'tokenrouter-grok-9.9')).id, 'tokenrouter-grok-9.9')
  server.models = models.filter(model => model.modelId !== 'tokenrouter-grok-9.9')
  await assert.rejects(catalog.resolve('tr-grok', 'tokenrouter-grok-9.9'), error => error.code === 'MODEL_UNAVAILABLE')
})

test('Grok model metadata keeps route aliases distinct from model identity', () => {
  const info = grokModelInfo('tr-grok', { modelId: 'tokenrouter-grok-4.7', name: 'TR · Grok 4.7' }, 'tokenrouter', { isRouted: true })
  assert.equal(info.id, 'tokenrouter-grok-4.7')
  assert.equal(info.routingAlias, true)
  assert.deepEqual(info.inputModalities, ['text'])
  const native = grokModelInfo('tr-grok', { modelId: 'grok-4.6', name: 'Grok 4.6' }, 'tokenrouter')
  assert.equal(native.routingAlias, undefined)
})

function fakeSubprocess(stdout, exitCode = 0) {
  return {
    spawn() {
      const child = {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { end() {} },
        terminate() {},
      }
      child.done = Promise.resolve().then(() => {
        child.stdout.emit('data', stdout)
        return { exitCode }
      })
      return child
    },
  }
}

test('TokenRouter Grok routes come from the CLI notice, not a fixed prefix or model count', async () => {
  const output = [
    "Model 'router-x' is using its own API key.",
    '',
    'Available models:',
    '  * grok-4.6 (default)',
    '  - grok-4.5',
    '  - router-x',
    '  - router-x-future-model',
    '',
  ].join('\n')
  const ids = await discoverGrokRouteIds({
    launcher: 'tr.exe',
    subprocess: fakeSubprocess(output),
    cwd: 'C:\\work',
  })
  assert.deepEqual(ids, ['router-x', 'router-x-future-model'])
})

test('TokenRouter route discovery fails closed when the notice is absent', async () => {
  const output = 'Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n'
  await assert.rejects(
    discoverGrokRouteIds({ launcher: 'tr.exe', subprocess: fakeSubprocess(output), cwd: 'C:\\work' }),
    error => error.code === 'MODEL_DISCOVERY_FAILED' && /no TokenRouter route alias/.test(error.message),
  )
})
