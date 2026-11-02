import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexCatalog, modelInfo } from '../llm/catalog.js'
import { contentText, inputFor, toolSpecs } from '../llm/transcript.js'

function fakeServer(models) {
  return {
    calls: 0,
    fail: null,
    async models() {
      this.calls += 1
      if (this.fail) throw this.fail
      return models
    },
  }
}

test('catalog comes only from live model/list and hides hidden entries', async () => {
  const server = fakeServer([
    { slug: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' },
    { slug: 'gpt-5.6-terra', displayName: 'Terra' },
    { slug: 'secret', displayName: 'Secret', hidden: true },
  ])
  const catalog = new CodexCatalog(server, { provider: 'tr-codex', ttlMs: 60_000 })
  const models = await catalog.list()
  assert.deepEqual(models.map(model => model.id), ['gpt-5.6-sol', 'gpt-5.6-terra'])
  assert.equal(models[0].provider, 'tr-codex')
  assert.deepEqual(models[0].inputModalities, ['text'])
  assert.equal(models[0].defaultEffort, 'high')
  assert.equal(server.calls, 1)
})

test('catalog caches within TTL and rediscovers a revoked model', async () => {
  const server = fakeServer([{ slug: 'gpt-5.6-sol' }])
  let now = 1000
  const catalog = new CodexCatalog(server, { provider: 'tr-codex', ttlMs: 100, now: () => now })
  assert.equal((await catalog.resolve('tr-codex', 'gpt-5.6-sol')).id, 'gpt-5.6-sol')
  assert.equal(server.calls, 1)

  server.models = async function () {
    this.calls += 1
    return []
  }
  now += 101
  await assert.rejects(catalog.resolve('tr-codex', 'gpt-5.6-sol'), error => error.code === 'MODEL_UNAVAILABLE')
  assert.ok(server.calls >= 2)
})

test('a discovery failure keeps the last good list but never invents a model', async () => {
  const server = fakeServer([{ slug: 'gpt-5.6-sol' }])
  const catalog = new CodexCatalog(server, { provider: 'tr-codex', ttlMs: 0 })
  assert.equal((await catalog.list()).length, 1)
  server.fail = new Error('offline')
  assert.equal((await catalog.list()).length, 1)
  await assert.rejects(catalog.resolve('tr-codex', 'unknown'), error => error.code === 'MODEL_UNAVAILABLE')
})

test('modelInfo never claims image input and transcript rejects it', () => {
  const info = modelInfo('tr-codex', { slug: 'x', displayName: 'X' })
  assert.deepEqual(info.inputModalities, ['text'])
  assert.throws(() => contentText([{ type: 'image' }]), error => error.code === 'UNSUPPORTED_CONTENT')
})

test('transcript keeps tool results and tool specs validate names', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
    },
  ]
  const input = inputFor(messages, true)
  assert.match(input, /Harness conversation history/)
  assert.match(input, /ok/)
  assert.throws(() => toolSpecs([{ name: 'bad name', parameters: { type: 'object' } }]), /Dynamic tool names/)
  assert.deepEqual(toolSpecs([{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }]), [{
    type: 'function',
    name: 'read',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
  }])
})
