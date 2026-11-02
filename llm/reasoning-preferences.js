/**
 * Per-provider/model reasoning-effort preference shared by the two native
 * adapters.
 *
 * DeepSeek Harness 0.2.1 keeps a reasoning effort on the Session's model
 * selection; its picker does not remember a separate effort for every model.
 * The adapter therefore keeps this small plugin-owned store and uses it only
 * when the picker has just switched to another model (or on a fresh process)
 * and the incoming effort is that model's advertised default. A value the
 * user explicitly chooses for the current model always wins and is recorded.
 *
 * The store is best-effort: an unreadable or corrupt preference file must not
 * break inference, and a failure to write it must not turn a successful model
 * call into a failed one.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { TrLlmError } from './errors.js'

const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function defaultReasoningFile(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const root = env.APPDATA || env.LOCALAPPDATA || env.USERPROFILE
    if (!root) return undefined
    return win32.join(root, 'dsh-tr-bridge', 'reasoning-preferences.json')
  }
  const root = env.XDG_CONFIG_HOME || (env.HOME ? posix.join(env.HOME, '.config') : '')
  if (!root) return undefined
  return posix.join(root, 'dsh-tr-bridge', 'reasoning-preferences.json')
}

function keyOf(provider, model) {
  if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !MODEL_ID.test(model)) return undefined
  // A JSON array key avoids delimiter collisions while remaining a plain
  // object key in the preference file.
  return JSON.stringify([provider, model])
}

function normalize(value) {
  const result = new Map()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  const models = value.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) return result
  for (const [key, effort] of Object.entries(models)) {
    if (typeof key !== 'string' || typeof effort !== 'string' || !EFFORT_ID.test(effort)) continue
    result.set(key, effort)
  }
  return result
}

export class ReasoningPreferences {
  constructor({ file, io = {} } = {}) {
    this.file = file
    this.readFile = io.readFile ?? readFileSync
    this.writeFile = io.writeFile ?? writeFileSync
    this.mkdir = io.mkdir ?? mkdirSync
    this.rename = io.rename ?? renameSync
    this.loaded = false
    this.values = new Map()
  }

  load() {
    if (this.loaded) return this
    this.loaded = true
    if (!this.file) return this
    try {
      this.values = normalize(JSON.parse(this.readFile(this.file, 'utf8')))
    } catch {
      // ENOENT and malformed files both mean "no saved preference".
      this.values = new Map()
    }
    return this
  }

  get(provider, model) {
    const key = keyOf(provider, model)
    return key === undefined ? undefined : this.load().values.get(key)
  }

  record(provider, model, effort) {
    const key = keyOf(provider, model)
    if (key === undefined || typeof effort !== 'string' || !EFFORT_ID.test(effort)) return false
    this.load()
    if (this.values.get(key) === effort) return false
    this.values.set(key, effort)
    this.save()
    return true
  }

  save() {
    if (!this.file) return false
    try {
      const directory = dirname(this.file)
      this.mkdir(directory, { recursive: true })
      const temporary = join(directory, `.reasoning-preferences-${process.pid}.json`)
      const models = Object.fromEntries([...this.values].sort(([a], [b]) => a.localeCompare(b)))
      this.writeFile(temporary, `${JSON.stringify({ version: 1, models }, null, 2)}\n`, 'utf8')
      this.rename(temporary, this.file)
      return true
    } catch {
      // Preferences are an enhancement; never fail a model turn for this.
      return false
    }
  }
}

export function effortsOf(info) {
  const efforts = info?.reasoning?.efforts
  return Array.isArray(efforts) ? efforts : []
}

export function defaultEffortOf(info) {
  return info?.reasoning?.defaultEffort
}

export function supportsEffort(info, effort) {
  return effort === undefined || effortsOf(info).some(level => level?.id === effort)
}

export function assertEffort(info, effort) {
  if (effort === undefined) return
  if (!supportsEffort(info, effort)) {
    const offered = effortsOf(info).map(level => level?.id).filter(Boolean)
    throw new TrLlmError(
      `Reasoning effort "${effort}" is not offered by model "${info?.id ?? 'unknown'}"${offered.length ? `; available: ${offered.join(', ')}` : ''}.`,
      'UNSUPPORTED_OPTION',
    )
  }
}

/**
 * Choose the effort for one call.
 *
 * `modelChanged` is true when this Session is about to use a different model
 * than its previous native call (or has no previous call in this process).
 * Only in that case does a saved preference replace an incoming default. An
 * explicitly selected non-default value is always preserved.
 */
export function resolveEffort({ info, requested, stored, modelChanged = false }) {
  assertEffort(info, requested)
  const defaultEffort = defaultEffortOf(info)
  if (modelChanged && stored !== undefined && supportsEffort(info, stored)) {
    if (requested === undefined || requested === defaultEffort) return stored
  }
  if (requested !== undefined) return requested
  if (stored !== undefined && supportsEffort(info, stored)) return stored
  return undefined
}
