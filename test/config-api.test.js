import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { apply } from '../index.js'
import { handleConfigRpc, rejectConfigPayload } from '../config-api.js'

function catalogChild(stdout, exitCode = 0) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end() {} }
  child.done = Promise.resolve({ exitCode })
  child.terminate = () => {}
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', stdout)
  })
  return child
}

function spawnFor(state) {
  return {
    spawn(spec) {
      state.calls.push(spec.argv.slice())
      const argv = spec.argv.join(' ')
      if (state.fail) return catalogChild('not logged in', 1)
      if (argv.includes('codex') && argv.includes('models')) {
        return catalogChild(JSON.stringify({ models: state.codex }))
      }
      if (argv.includes('grok') && argv.includes('models')) return catalogChild(state.grokText)
      throw new Error(`unexpected ${argv}`)
    },
  }
}

function deps(dir, state, settings = {}) {
  const launcher = join(dir, 'tr.exe')
  writeFileSync(launcher, 'not-a-real-binary')
  return {
    launcher,
    settings: {
      trCommand: launcher,
      timeoutMs: 600000,
      grokWebSearch: false,
      selection: { defaults: {}, members: {}, ...settings.selection },
      selectionFile: join(dir, 'model-selection.json'),
      ...settings,
    },
    subprocess: spawnFor(state),
    cwd: dir,
    signal: undefined,
    resolveLauncher: () => ({ file: launcher, source: 'configured' }),
  }
}

const state = () => ({
  calls: [],
  fail: false,
  codex: [
    { slug: 'future-model', display_name: 'Future Model', visibility: 'list', supported_in_api: true },
    { slug: 'hidden-model', visibility: 'hide', supported_in_api: true },
  ],
  grokText: [
    "Model 'routehub' is using its own API key.",
    'Available models:',
    '  - plain-model',
    '  - routehub',
    '  - routehub-fast',
  ].join('\n'),
})

test('config payloads reject extra fields, cross-agent ids, and secrets without echoing them', () => {
  const extra = rejectConfigPayload('save', { agent: 'codex', model: 'future-model', task: 'secret task', apiKey: 'sk-secretvalue' })
  assert.equal(extra.ok, false)
  assert.equal(JSON.stringify(extra).includes('secret task'), false)
  assert.equal(JSON.stringify(extra).includes('sk-secretvalue'), false)
  const injected = rejectConfigPayload('refresh', { agent: 'codex; whoami' })
  assert.equal(injected.ok, false)
  assert.equal(JSON.stringify(injected).includes('whoami'), false)
})

test('refresh builds dropdown data from the CLI and keeps aliases selectable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-config-'))
  const current = state()
  const result = await handleConfigRpc('refresh', {}, deps(dir, current))
  assert.equal(result.ok, true)
  const codex = result.value.agents.find(item => item.agent === 'codex')
  const grok = result.value.agents.find(item => item.agent === 'grok')
  assert.deepEqual(codex.models.map(item => item.id), ['future-model'])
  assert.equal(codex.models.some(item => item.id === 'hidden-model'), false)
  assert.equal(grok.models.find(item => item.id === 'routehub').kind, 'alias')
  assert.equal(grok.models.find(item => item.id === 'routehub-fast').kind, 'routed')
  assert.equal(grok.models.find(item => item.id === 'plain-model').kind, 'model')
  assert.equal(JSON.stringify(result).includes('sk-'), false)
  assert.equal(result.value.launcher.file, undefined)
})

test('save writes the same selection file and rejects a model from the other agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-config-'))
  const current = state()
  const host = deps(dir, current)
  const saved = await handleConfigRpc('save', { agent: 'codex', model: 'future-model' }, host)
  assert.equal(saved.ok, true)
  assert.equal(JSON.parse(readFileSync(host.settings.selectionFile, 'utf8')).defaults.codex, 'future-model')
  const crossed = await handleConfigRpc('save', { agent: 'codex', model: 'plain-model' }, host)
  assert.equal(crossed.ok, false)
  assert.equal(crossed.error.code, 'cross-agent')
  assert.equal(JSON.stringify(crossed).includes('API'), false)
  const stale = await handleConfigRpc('refresh', {}, deps(dir, {
    ...state(),
    codex: [{ slug: 'other-model', visibility: 'list' }],
  }, { selectionFile: host.settings.selectionFile, selection: { defaults: {}, members: {} } }))
  const codex = stale.value.agents.find(item => item.agent === 'codex')
  assert.equal(codex.selection, 'stale')
  assert.equal(codex.models.some(item => item.id === 'future-model'), false)
})

test('a failed query does not reuse the previous catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-config-'))
  writeFileSync(join(dir, 'model-selection.json'), JSON.stringify({ defaults: { grok: 'plain-model' }, members: {} }))
  const failed = await handleConfigRpc('refresh', { agent: 'grok' }, deps(dir, { ...state(), fail: true }))
  const grok = failed.value.agents.find(item => item.agent === 'grok')
  assert.equal(failed.ok, true)
  assert.deepEqual(grok.models, [])
  assert.equal(grok.connection, 'authorization-revoked')
  assert.equal(grok.selection, 'unverified')
})

test('connection registration failure does not stop tool registration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-config-'))
  const launcher = join(dir, 'tr.exe')
  writeFileSync(launcher, 'not-a-real-binary')
  const tools = {}
  assert.doesNotThrow(() => apply({
    tools: { register(value) { tools[value.name] = value } },
    subprocess: { spawn() { throw new Error('not used') } },
    inject(_names, callback) {
      callback({ connection: { register() { throw new Error('webServer missing') } }, webServer: {} })
    },
  }, { trCommand: launcher, selectionFile: join(dir, 'model-selection.json') }))
  assert.equal(typeof tools.tr_bridge.execute, 'function')
  assert.equal(typeof tools.tr_bridge_models.execute, 'function')
})
