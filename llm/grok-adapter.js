/**
 * Harness LlmAdapter backed by `tr grok agent --no-leader stdio` (ACP v1).
 *
 * Grok ACP has no client-side dynamic-tool channel. This adapter therefore
 * advertises text chat only: it never invents tool blocks and never turns a
 * JSON convention in a prompt into a tool call. If the CLI requests a native
 * tool, the transport denies permission; if a tool call still reaches the
 * stream, the turn fails with UNSUPPORTED_TOOL_CALL instead of pretending it
 * ran.
 */
import { randomUUID } from 'node:crypto'
import { TrLlmError } from './errors.js'
import { contentText, inputFor } from './transcript.js'

function usageOf(result) {
  const usage = result?._meta?.usage ?? result?.usage
  if (!usage || typeof usage !== 'object') return undefined
  return {
    inputTokens: Number(usage.inputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    cacheReadTokens: Number(usage.cachedReadTokens ?? usage.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(usage.cacheCreationTokens ?? usage.cacheWriteTokens ?? 0),
    reasoningTokens: Number(usage.reasoningTokens ?? 0),
  }
}

function stopKind(reason) {
  if (reason === 'max_tokens' || reason === 'max-tokens') return 'max-tokens'
  if (reason === 'cancelled' || reason === 'interrupted') return 'interrupted'
  return 'stop'
}

function contentOf(update) {
  const content = update?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(item => {
      if (typeof item === 'string') return item
      if (typeof item?.text === 'string') return item.text
      return ''
    }).join('')
  }
  if (typeof content?.text === 'string') return content.text
  if (typeof update?.text === 'string') return update.text
  if (typeof update?.delta === 'string') return update.delta
  return ''
}

function optionValue(result, id) {
  const options = result?.configOptions
  if (!Array.isArray(options)) return undefined
  return options.find(option => option?.id === id)?.currentValue
}

export class GrokAdapter {
  busy = new Set()

  constructor({
    provider = 'tr-grok',
    name = 'TR Grok',
    server,
    catalog,
    cwd,
    idleTimeoutMs = 300_000,
  } = {}) {
    this.provider = provider
    this.name = name
    this.server = server
    this.catalog = catalog
    this.cwd = cwd
    this.idleTimeoutMs = idleTimeoutMs
    this.lastExecution = undefined
  }

  providerInfo(provider) {
    return { id: provider, name: this.name }
  }

  providerRetryPolicy() {}

  listModels(_provider) {
    return this.catalog.list()
  }

  resolveModel(provider, model, signal) {
    return this.catalog.resolve(provider, model, signal)
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  async *stream(options) {
    options.signal?.throwIfAborted()
    if (options.stop !== undefined || options.temperature !== undefined || options.maxTokens !== undefined) {
      throw new TrLlmError('TR Grok does not support stop, temperature or maxTokens overrides.', 'UNSUPPORTED_OPTION')
    }
    if (!options.messages?.length) {
      throw new TrLlmError('At least one conversation message is required.', 'INVALID_REQUEST')
    }
    for (const message of options.messages) contentText(message.content)

    const key = options.sessionId ? `${options.sessionId}:${options.purpose ?? 'conversation'}` : randomUUID()
    if (this.busy.has(key)) {
      throw new TrLlmError('A TR Grok response is already running for this Harness session.', 'TR_LLM_BUSY')
    }
    this.busy.add(key)

    let session
    let finished = false
    let aborted = false
    try {
      await this.server.start(options.signal)
      session = await this.server.newSession({ cwd: this.cwd }, options.signal)
      const selected = await this.server.setConfigOption(session.sessionId, 'model', options.model, options.signal)
      const effective = optionValue(selected, 'model') ?? optionValue(session, 'model')
      if (effective && effective !== options.model) {
        throw new TrLlmError(
          `TR Grok selected "${effective}" instead of the requested "${options.model}".`,
          'MODEL_UNAVAILABLE',
        )
      }
      if (options.reasoningEffort) {
        await this.server.setConfigOption(session.sessionId, 'reasoning_effort', options.reasoningEffort, options.signal)
      }

      const system = [
        typeof options.system === 'string' ? options.system : '',
        'You are the model inside DeepSeek Harness. This TR Grok provider supports text chat only. Harness tools are not available in this provider; do not claim to have run one. Answer in text.',
      ].filter(Boolean).join('\n\n')
      const text = [
        system,
        inputFor(options.messages, true),
      ].filter(Boolean).join('\n\n')

      const prompt = this.server.prompt(session.sessionId, text, options.signal)
      let result
      let promptError
      const completion = prompt.then(
        value => {
          result = value
          try { this.server.pushEvent(session.sessionId, { done: true }) } catch { /* disconnected */ }
        },
        error => {
          promptError = error
          try { this.server.pushEvent(session.sessionId, { done: true, error }) } catch { /* disconnected */ }
        },
      )
      void completion

      const blocks = new Map()
      let nextIndex = 0
      let sawToolCall = false
      const end = block => {
        blocks.delete(block.id)
        return {
          type: 'block-end',
          index: block.index,
          block: { type: block.type, text: block.text },
        }
      }
      const handle = function* (event) {
        const update = event?.params?.update ?? {}
        const kind = update.sessionUpdate
        if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
          const type = kind === 'agent_message_chunk' ? 'text' : 'reasoning'
          const id = update.messageId ?? update.itemId ?? type
          let block = blocks.get(id)
          if (!block) {
            block = { id, index: nextIndex++, type, text: '' }
            blocks.set(id, block)
            yield { type: 'block-start', index: block.index, blockType: type }
          }
          const delta = contentOf(update)
          block.text += delta
          yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: delta }
          return
        }
        if (kind === 'tool_call' || kind === 'tool_call_update') {
          sawToolCall = true
        }
      }

      while (true) {
        const timeout = AbortSignal.timeout(this.idleTimeoutMs)
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
        let event
        try {
          event = await this.server.nextEvent(session.sessionId, signal)
        } catch (error) {
          if (options.signal?.aborted) {
            aborted = true
            throw error
          }
          if (timeout.aborted) {
            throw new TrLlmError('TR Grok stopped sending updates. Retry to reconnect.', 'TR_LLM_TIMEOUT')
          }
          throw error
        }
        if (event?.done) {
          if (event.error) throw event.error
          break
        }
        for (const chunk of handle(event)) yield chunk
      }

      if (promptError) throw promptError
      for (const event of this.server.drainEvents(session.sessionId)) {
        if (event?.done) continue
        for (const chunk of handle(event)) yield chunk
      }
      if (sawToolCall) {
        throw new TrLlmError(
          'TR Grok attempted a native tool, but this provider exposes no Harness tool channel.',
          'UNSUPPORTED_TOOL_CALL',
        )
      }
      if (!result) throw new TrLlmError('TR Grok returned no prompt result.', 'PROTOCOL_ERROR')
      if (result.stopReason === 'cancelled') {
        aborted = true
        throw new TrLlmError('TR Grok turn was cancelled.', 'ABORTED')
      }
      for (const block of [...blocks.values()]) yield end(block)
      const usage = usageOf(result)
      if (usage) yield { type: 'usage', usage }
      const actual = result?._meta?.modelId
      this.lastExecution = {
        requested: options.model,
        actual: typeof actual === 'string' ? actual : undefined,
        sessionId: session.sessionId,
        stopReason: result.stopReason,
      }
      finished = true
      yield {
        type: 'finish',
        reason: { kind: stopKind(result.stopReason) },
        replayState: { response: { kind: 'tr-grok', version: 1 } },
      }
    } catch (error) {
      if (options.signal?.aborted) {
        aborted = true
        throw options.signal.reason ?? new TrLlmError('Request aborted.', 'ABORTED')
      }
      throw error
    } finally {
      if (session?.sessionId) {
        if (aborted) this.server.cancel(session.sessionId)
        await this.server.closeSession(session.sessionId)
      }
      this.busy.delete(key)
      void finished
    }
  }

  async clear() {}
}
