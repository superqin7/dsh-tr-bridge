import test from 'node:test'
import assert from 'node:assert/strict'
import { GrokCatalog, grokModelInfo } from '../llm/grok-catalog.js'

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
  { modelId: 'tokenrouter', name: 'TOKEN ROUTER', _meta: { reasoningEfforts: [{ value: 'low', description: 'Fast' }] } },
  { modelId: 'tokenrouter-grok-9.9', name: 'TR · Grok 9.9', description: 'Future alias' },
]

test('Grok catalog reads the live session model state without a hardcoded allowlist', async () => {
  const server = new FakeServer(models)
  const catalog = new GrokCatalog(server, { cwd: 'C:\\work', ttlMs: 60_000 })
  const entries = await catalog.list()
  assert.deepEqual(entries.map(entry => entry.id), ['grok-4.6', 'tokenrouter', 'tokenrouter-grok-9.9'])
  assert.equal(entries[0].defaultEffort, 'high')
  assert.deepEqual(entries[0].efforts, [{ id: 'high', name: 'High' }])
  assert.equal(entries[1].isDefault, true)
  assert.equal(entries[2].routingAlias, true)
  assert.equal(server.sessions[0].cwd, 'C:\\work')
  assert.deepEqual(server.closed, ['session-1'])
})

test('Grok catalog menu reports a discovery failure instead of a stale list', async () => {
  const server = new FakeServer(models)
  const catalog = new GrokCatalog(server, { cwd: 'C:\\work', ttlMs: 60_000 })
  assert.equal((await catalog.list()).length, 3)
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
  const catalog = new GrokCatalog(server, { cwd: 'C:\\work' })
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
  const catalog = new GrokCatalog(server, { cwd: 'C:\\work' })
  await assert.rejects(catalog.list(), error => error.code === 'MODEL_DISCOVERY_FAILED')
})

test('Grok catalog does not keep a removed model authorized', async () => {
  const server = new FakeServer(models)
  const catalog = new GrokCatalog(server, { cwd: 'C:\\work', ttlMs: 0 })
  assert.equal((await catalog.resolve('tr-grok', 'tokenrouter-grok-9.9')).id, 'tokenrouter-grok-9.9')
  server.models = models.filter(model => model.modelId !== 'tokenrouter-grok-9.9')
  await assert.rejects(catalog.resolve('tr-grok', 'tokenrouter-grok-9.9'), error => error.code === 'MODEL_UNAVAILABLE')
})

test('Grok model metadata keeps route aliases distinct from model identity', () => {
  const info = grokModelInfo('tr-grok', { modelId: 'tokenrouter-grok-4.7', name: 'TR · Grok 4.7' }, 'tokenrouter')
  assert.equal(info.id, 'tokenrouter-grok-4.7')
  assert.equal(info.routingAlias, true)
  assert.deepEqual(info.inputModalities, ['text'])
})
