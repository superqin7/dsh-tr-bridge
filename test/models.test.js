import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertModelAllowed,
  defaultSelectionFile,
  parseCodexCatalog,
  parseGrokModels,
  readSelection,
  resolveModelChoice,
  writeSelection,
} from '../models.js'

const codexJson = JSON.stringify({
  models: [
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', supported_in_api: true },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', visibility: 'list', supported_in_api: true },
    { slug: 'internal-review', display_name: 'Internal', visibility: 'hide', supported_in_api: true },
    { slug: 'future-model', display_name: 'Future Model', visibility: 'list', supported_in_api: true },
  ],
})

const grokText = [
  "Model 'tokenrouter' is using its own API key.",
  '',
  'Default model: grok-4.6',
  '',
  'Available models:',
  '  * grok-4.6 (default)',
  '  - tokenrouter-grok-4.7',
  '  - brand-new-model',
  '',
].join('\n')

test('Codex parser reads the whole document and does not hardcode an allowlist', () => {
  const parsed = parseCodexCatalog(codexJson)
  assert.deepEqual(parsed.models.filter(item => item.selectable).map(item => item.id), [
    'gpt-5.6-terra', 'gpt-5.6-sol', 'future-model',
  ])
  assert.equal(parsed.excluded, 1)
  assert.equal(parsed.models.find(item => item.id === 'gpt-5.6-terra').name, 'GPT-5.6 Terra')
})

test('Codex parser refuses a paginated document instead of using the first page', () => {
  assert.throws(() => parseCodexCatalog(JSON.stringify({ models: [{ slug: 'gpt-5.6-terra' }], next_cursor: 'page-2' })), /分页/)
})

test('Grok parser keeps every CLI id, including ones that do not match a prefix', () => {
  const parsed = parseGrokModels(grokText)
  assert.deepEqual(parsed.models.map(item => item.id), ['grok-4.6', 'tokenrouter-grok-4.7', 'brand-new-model'])
})

test('Grok parser refuses an output that says more pages exist', () => {
  assert.throws(() => parseGrokModels('Available models:\n  - grok-4.6\nnext_cursor: abc\n'), /更多页/)
})

test('Grok parser keeps an id that has a trailing note and refuses a list that resumes after prose', () => {
  const parsed = parseGrokModels('Available models:\n  - brand-new-model extra note\n')
  assert.deepEqual(parsed.models.map(item => item.id), ['brand-new-model'])
  assert.throws(() => parseGrokModels('Available models:\n  - grok-4.6\nfooter\n  - later-model\n'), /中断后仍有模型行/)
})

test('Unsafe model ids are not silently treated as part of a complete catalog', () => {
  const parsed = parseCodexCatalog(JSON.stringify({
    models: [
      { slug: 'gpt-5.6-terra', visibility: 'list' },
      { slug: 'bad id', visibility: 'list' },
    ],
  }))
  assert.equal(parsed.models.some(item => item.id === 'bad id'), false)
  assert.equal(parsed.excluded, 1)
  assert.throws(() => parseGrokModels('Available models:\n  - bad&id\n'), /无法安全识别/)
})

test('A model removed by the next refresh is no longer allowed', () => {
  const first = parseCodexCatalog(codexJson)
  assert.equal(assertModelAllowed('codex', 'future-model', { codex: first }).id, 'future-model')
  const second = parseCodexCatalog(JSON.stringify({
    models: [{ slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list' }],
  }))
  assert.throws(() => assertModelAllowed('codex', 'future-model', { codex: second }), /不在本次 codex/)
})

test('Cross-agent models are rejected without using name prefixes', () => {
  const catalogs = {
    codex: parseCodexCatalog(codexJson),
    grok: parseGrokModels(grokText),
  }
  assert.throws(() => assertModelAllowed('grok', 'gpt-5.6-terra', catalogs), /属于 codex/)
  assert.throws(() => assertModelAllowed('codex', 'tokenrouter-grok-4.7', catalogs), /属于 grok/)
})

test('Hidden and unknown models are not selectable', () => {
  const catalogs = { codex: parseCodexCatalog(codexJson), grok: parseGrokModels(grokText) }
  assert.throws(() => assertModelAllowed('codex', 'internal-review', catalogs), /不可选/)
  assert.throws(() => assertModelAllowed('codex', 'revoked-model', catalogs), /不在本次/)
})

test('Explicit model wins, then member, then saved default, then CLI default', () => {
  const config = { defaults: { codex: 'gpt-5.6-sol' }, members: { reviewer: { agent: 'codex', model: 'gpt-5.6-terra' } } }
  const saved = { defaults: { codex: 'future-model', grok: 'grok-4.6' }, members: {} }
  assert.equal(resolveModelChoice({ agent: 'codex', explicit: 'future-model', member: 'reviewer', config, saved }).source, 'explicit')
  assert.equal(resolveModelChoice({ agent: 'codex', member: 'reviewer', config, saved }).model, 'gpt-5.6-terra')
  assert.equal(resolveModelChoice({ agent: 'codex', config, saved }).source, 'config')
  assert.equal(resolveModelChoice({ agent: 'grok', config, saved }).source, 'saved-default')
  assert.equal(resolveModelChoice({ agent: 'grok', config: { defaults: {}, members: {} }, saved: { defaults: {}, members: {} } }).model, null)
})

test('A member bound to another agent cannot be reused', () => {
  const config = { defaults: {}, members: { writer: { agent: 'grok', model: 'grok-4.6' } } }
  assert.throws(() => resolveModelChoice({
    agent: 'codex',
    member: 'writer',
    config,
    saved: { defaults: {}, members: {} },
  }), /不能用于 codex/)
})

test('Saved defaults survive independently and a corrupt file is not reused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tr-models-'))
  const file = join(dir, 'model-selection.json')
  writeSelection(file, {
    defaults: { codex: 'gpt-5.6-terra', grok: 'grok-4.6' },
    members: { reviewer: { agent: 'codex', model: 'gpt-5.6-sol' } },
  })
  const loaded = readSelection(file)
  assert.equal(loaded.defaults.codex, 'gpt-5.6-terra')
  assert.equal(loaded.defaults.grok, 'grok-4.6')
  assert.equal(loaded.members.reviewer.model, 'gpt-5.6-sol')
  assert.deepEqual(readSelection(join(dir, 'missing.json')), { defaults: {}, members: {} })
  writeFileSync(file, '{', 'utf8')
  assert.throws(() => readSelection(file), /不会沿用/)
  writeSelection(file, { defaults: { grok: 'brand-new-model' }, members: {} })
  const replaced = readSelection(file)
  assert.equal(replaced.defaults.codex, undefined)
  assert.equal(replaced.defaults.grok, 'brand-new-model')
})

test('Windows selection file is outside TokenRouter and CLI credential directories', () => {
  const file = defaultSelectionFile({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32')
  assert.equal(file, 'C:\\Users\\me\\AppData\\Roaming\\dsh-tr-bridge\\model-selection.json')
  assert.equal(/tokenrouter|\.codex|\.grok/i.test(file), false)
})

test('Query failure does not keep a previous catalog as authorized', () => {
  let current = parseCodexCatalog(codexJson)
  const refresh = succeeded => {
    if (!succeeded) {
      current = null
      throw new Error('查询失败')
    }
    current = parseCodexCatalog(JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', visibility: 'list' }] }))
    return current
  }
  assert.throws(() => refresh(false), /查询失败/)
  assert.equal(current, null)
  assert.throws(() => assertModelAllowed('codex', 'gpt-5.6-sol', { codex: current }), /没有 codex 的本次模型清单/)
})
