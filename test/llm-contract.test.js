import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { registerTrCodexProvider, registerTrGrokProvider } from '../llm/providers.js'

function fakeContext({ llm = true, inject } = {}) {
  const tools = []
  const adapters = new Map()
  const effects = []
  const service = llm ? {
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (adapters.has(provider)) {
          const error = new Error(`duplicate ${provider}`)
          error.code = 'DUPLICATE_ADAPTER'
          throw error
        }
        const info = adapter.providerInfo(provider)
        assert.equal(info.id, provider)
        assert.equal(typeof info.name, 'string')
        assert.ok(info.name.length > 0)
        adapters.set(provider, adapter)
      }
      return () => {}
    },
  } : undefined
  const ctx = {
    tools: { register(definition) { tools.push(definition) } },
    subprocess: { spawn() { throw new Error('must not spawn during registration') } },
    effect(callback, label) { effects.push({ callback, label }) },
    get(name) {
      if (name === 'llm') return service
      if (name === 'subprocess') return ctx.subprocess
      return undefined
    },
    llm: service,
  }
  if (inject) ctx.inject = inject
  return { ctx, tools, adapters, effects }
}

test('apply registers tr_bridge, tr_bridge_models and both native providers together', () => {
  const { ctx, tools, adapters } = fakeContext()
  const api = { providerInfo: () => ({ id: 'deepseek-api', name: 'DeepSeek API' }) }
  adapters.set('deepseek-api', api)
  apply(ctx, { trCommand: process.execPath })
  assert.deepEqual(tools.map(tool => tool.name), ['tr_bridge_models', 'tr_bridge'])
  assert.equal(adapters.has('tr-codex'), true)
  assert.equal(adapters.has('tr-grok'), true)
  assert.equal(adapters.get('deepseek-api'), api)
  const adapter = adapters.get('tr-codex')
  assert.deepEqual(adapter.providerInfo('tr-codex'), { id: 'tr-codex', name: 'TR Codex' })
  assert.equal(adapter.providerRetryPolicy('tr-codex'), undefined)
  assert.deepEqual(adapters.get('tr-grok').providerInfo('tr-grok'), { id: 'tr-grok', name: 'TR Grok' })
})

test('both providers resolve one cwd and Codex one catalog for discovery and execution', () => {
  const adapters = new Map()
  const ctx = {
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
        return () => {}
      },
    },
    subprocess: { spawn() { throw new Error('must not spawn during registration') } },
  }
  const codex = registerTrCodexProvider(ctx, {
    launcher: { file: 'C:\\TokenRouter\\tr.exe' },
    cwd: 'D:\\work',
    catalogJson: 'C:\\catalog.json',
  })
  assert.equal(codex.cwd, 'D:\\work')
  assert.equal(codex.server.cwd, 'D:\\work')
  assert.equal(codex.adapter.cwd, 'D:\\work')
  assert.equal(codex.catalogJson, 'C:\\catalog.json')
  assert.equal(codex.server.catalogJson, 'C:\\catalog.json')

  const grok = registerTrGrokProvider(ctx, {
    launcher: { file: 'C:\\TokenRouter\\tr.exe' },
    cwd: 'D:\\work',
  })
  assert.equal(grok.cwd, 'D:\\work')
  assert.equal(grok.server.cwd, 'D:\\work')
  assert.equal(grok.adapter.cwd, 'D:\\work')
  assert.equal(adapters.has('tr-codex'), true)
  assert.equal(adapters.has('tr-grok'), true)
  codex.dispose()
  grok.dispose()
})

test('a missing llm service leaves both existing tools registered', () => {
  const { ctx, tools, adapters } = fakeContext({ llm: false })
  assert.doesNotThrow(() => apply(ctx, { trCommand: process.execPath }))
  assert.deepEqual(tools.map(tool => tool.name), ['tr_bridge_models', 'tr_bridge'])
  assert.equal(adapters.size, 0)
})

test('native registration does not write or change the model selection file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-llm-'))
  const selectionFile = join(dir, 'selection.json')
  const { ctx } = fakeContext()
  const config = { trCommand: process.execPath, selectionFile }
  apply(ctx, config)
  assert.equal(existsSync(selectionFile), false)
  assert.deepEqual(config, { trCommand: process.execPath, selectionFile })
})

test('a duplicate provider does not break the existing tools', () => {
  const { ctx, tools, adapters } = fakeContext()
  adapters.set('tr-codex', { providerInfo: () => ({ id: 'tr-codex', name: 'existing' }) })
  assert.doesNotThrow(() => apply(ctx, { trCommand: process.execPath }))
  assert.deepEqual(tools.map(tool => tool.name), ['tr_bridge_models', 'tr_bridge'])
  assert.equal(adapters.get('tr-codex').providerInfo('tr-codex').name, 'existing')
})
