import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ReasoningPreferences,
  defaultReasoningFile,
  resolveEffort,
} from '../llm/reasoning-preferences.js'

const info = {
  id: 'gpt-test',
  reasoning: {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
    defaultEffort: 'high',
  },
}

test('a requested effort is preserved and an unsupported one fails loudly', () => {
  assert.equal(resolveEffort({ info, requested: 'low' }), 'low')
  assert.throws(
    () => resolveEffort({ info, requested: 'ultra' }),
    error => error.code === 'UNSUPPORTED_OPTION' && /available: low, high/.test(error.message),
  )
})

test('a saved effort replaces the picker default only on a model change or fresh process', () => {
  assert.equal(resolveEffort({ info, requested: 'high', stored: 'low', modelChanged: true }), 'low')
  assert.equal(resolveEffort({ info, requested: 'high', stored: 'low', modelChanged: false }), 'high')
  assert.equal(resolveEffort({ info, requested: 'low', stored: 'high', modelChanged: true }), 'low')
  assert.equal(resolveEffort({ info, requested: undefined, stored: 'low' }), 'low')
})

test('preferences persist per provider/model and a corrupt file is treated as empty', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tr-bridge-reasoning-'))
  const file = join(directory, 'preferences.json')
  try {
    const first = new ReasoningPreferences({ file })
    assert.equal(first.get('tr-codex', 'gpt-test'), undefined)
    assert.equal(first.record('tr-codex', 'gpt-test', 'low'), true)
    assert.equal(first.record('tr-codex', 'gpt-test', 'low'), false)
    assert.equal(first.get('tr-codex', 'gpt-test'), 'low')
    assert.equal(first.get('tr-grok', 'gpt-test'), undefined)

    const second = new ReasoningPreferences({ file })
    assert.equal(second.get('tr-codex', 'gpt-test'), 'low')
    assert.match(readFileSync(file, 'utf8'), /"low"/)

    writeFileSync(file, '{not json', 'utf8')
    assert.equal(new ReasoningPreferences({ file }).get('tr-codex', 'gpt-test'), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the default preference file stays outside TokenRouter and CLI secrets', () => {
  const path = defaultReasoningFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32')
  assert.match(path, /dsh-tr-bridge[\\/]reasoning-preferences\.json$/)
  assert.equal(path.includes('.codex'), false)
  assert.equal(path.includes('.grok'), false)
})
