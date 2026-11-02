/**
 * Confirm which Grok models are TokenRouter routes.
 *
 * `tr grok models` lists models from two different authentication surfaces:
 * the Grok vendor defaults and the routes TokenRouter adds to the Grok config.
 * The CLI prints a notice for each route root that uses its own API key, e.g.
 * "Model 'tokenrouter' is using its own API key." The catalog parser already
 * classifies that root and every `<root>-...` route as `alias` / `routed`.
 *
 * This module deliberately does not guess from a hardcoded name or prefix.
 * If the CLI gives no route notice, the safe result is an error: exposing the
 * remaining vendor-native models would silently send them outside
 * TokenRouter.
 */
import { collectCommand, parseGrokModels } from '../models.js'
import { TrLlmError } from './errors.js'

export async function discoverGrokRouteIds({
  launcher,
  subprocess,
  cwd,
  signal,
  timeoutMs = 60_000,
} = {}) {
  if (typeof launcher !== 'string' || !launcher.trim()) {
    throw new TrLlmError('Cannot confirm TokenRouter Grok routes without the tr launcher.', 'MODEL_DISCOVERY_FAILED')
  }
  if (typeof subprocess?.spawn !== 'function') {
    throw new TrLlmError('Cannot confirm TokenRouter Grok routes without the DSH subprocess service.', 'MODEL_DISCOVERY_FAILED')
  }
  const result = await collectCommand({
    subprocess,
    argv: [launcher, 'grok', 'models'],
    cwd,
    signal,
    timeoutMs,
  })
  if (result.exitCode !== 0) {
    throw new TrLlmError(
      `tr grok models exited with code ${result.exitCode ?? 'unknown'}; TokenRouter route authorization cannot be confirmed.`,
      'MODEL_DISCOVERY_FAILED',
    )
  }
  let parsed
  try {
    parsed = parseGrokModels(result.stdout)
  } catch (error) {
    throw new TrLlmError(
      `tr grok models did not provide a complete route proof: ${error instanceof Error ? error.message : String(error)}`,
      'MODEL_DISCOVERY_FAILED',
      { cause: error },
    )
  }
  const ids = parsed.models
    .filter(model => model.selectable !== false && (model.kind === 'alias' || model.kind === 'routed'))
    .map(model => model.id)
  if (ids.length === 0) {
    throw new TrLlmError(
      'tr grok models reported no TokenRouter route alias notice; refusing to expose vendor-native Grok models as TR Grok.',
      'MODEL_DISCOVERY_FAILED',
    )
  }
  return ids
}
