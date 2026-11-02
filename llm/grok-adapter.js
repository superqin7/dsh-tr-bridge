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
import { HarnessToolBridge } from './grok-tools.js'
import { contentText, inputFor } from './transcript.js'
import { resolveEffort } from './reasoning-preferences.js'

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
  lastModels = new Map()

  constructor({
    provider = 'tr-grok',
    name = 'TR Grok',
    server,
    catalog,
    cwd,
    idleTimeoutMs = 300_000,
    preferences,
    tools,
    agents,
    approval,
    subprocess,
    grokTools = true,
    testCommand,
    testCwd,
    toolAuditFile,
    toolBridgeFactory,
    logger,
  } = {}) {
    this.provider = provider
    this.name = name
    this.server = server
    this.catalog = catalog
    this.cwd = cwd
    this.idleTimeoutMs = idleTimeoutMs
    this.preferences = preferences
    this.tools = tools
    this.agents = agents
    this.approval = approval
    this.subprocess = subprocess
    this.grokTools = grokTools !== false
    this.testCommand = testCommand
    this.testCwd = testCwd
    this.toolAuditFile = toolAuditFile
    this.toolBridgeFactory = toolBridgeFactory
    this.logger = logger
    this.lastExecution = undefined
  }

  effortFor(options, info, key) {
    const preferred = (options.purpose === undefined || options.purpose === 'conversation')
      && options.sessionId !== undefined
    const previous = preferred ? this.lastModels.get(key) : undefined
    const modelChanged = preferred && (!this.lastModels.has(key) || previous !== options.model)
    const stored = preferred ? this.preferences?.get(this.provider, options.model) : undefined
    return {
      effort: resolveEffort({
        info,
        requested: options.reasoningEffort,
        stored,
        modelChanged,
      }),
      preferred,
    }
  }

  remember(key, model, effort, preferred) {
    if (!preferred) return
    this.lastModels.set(key, model)
    if (effort !== undefined) this.preferences?.record(this.provider, model, effort)
  }

  toolContext(options) {
    if (!this.grokTools) return undefined
    if (options.purpose !== undefined && options.purpose !== 'conversation') return undefined
    if (!Array.isArray(options.tools) || options.tools.length === 0) return undefined
    if (typeof options.sessionId !== 'string' || !options.sessionId) {
      throw new TrLlmError('TR Grok tool calls require a Harness session.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    const agent = this.agents?.get?.(options.sessionId)
    if (!agent) {
      throw new TrLlmError('TR Grok tools require a live Harness Agent for this session.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    if (typeof this.tools?.execute !== 'function') {
      throw new TrLlmError('TR Grok tools require the Harness tool registry.', 'TOOL_CONTEXT_UNAVAILABLE')
    }
    return agent
  }

  makeToolBridge(options, agent) {
    const factory = this.toolBridgeFactory
      ?? (input => new HarnessToolBridge(input))
    return factory({
      sessionId: options.sessionId,
      cwd: this.cwd,
      tools: options.tools,
      agent,
      executeTool: input => this.tools.execute(input),
      requestApproval: this.approval?.request
        ? input => this.approval.request(input)
        : undefined,
      subprocess: this.subprocess,
      testCommand: this.testCommand,
      testCwd: this.testCwd,
      auditFile: this.toolAuditFile,
      logger: this.logger,
      signal: options.signal,
    })
  }

  providerInfo(provider) {
    return { id: provider, name: this.name }
  }

  providerRetryPolicy() {}

  /** Surface the saved per-model choice as the picker default after a restart. */
  preferredDefault(provider, info) {
    const owner = typeof provider === 'string' && provider ? provider : this.provider
    const saved = this.preferences?.get(owner, info.id)
    if (saved === undefined) return info
    const efforts = info.reasoning?.efforts
    if (!Array.isArray(efforts) || !efforts.some(level => level?.id === saved)) return info
    if (info.reasoning.defaultEffort === saved) return info
    return { ...info, reasoning: { ...info.reasoning, defaultEffort: saved } }
  }

  async listModels(provider) {
    const owner = typeof provider === 'string' && provider ? provider : this.provider
    const models = await this.catalog.list()
    return models.map(model => this.preferredDefault(owner, model))
  }

  async resolveModel(provider, model, signal) {
    const info = await this.catalog.resolve(provider, model, signal)
    return this.preferredDefault(provider, info)
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
    const info = await this.resolveModel(options.provider ?? this.provider, options.model, options.signal)
    const { effort, preferred } = this.effortFor(options, info, key)
    if (this.busy.has(key)) {
      throw new TrLlmError('A TR Grok response is already running for this Harness session.', 'TR_LLM_BUSY')
    }
    this.busy.add(key)

    const toolAgent = this.toolContext(options)
    let session
    let bridge
    let finished = false
    let aborted = false
    try {
      if (toolAgent) {
        bridge = this.makeToolBridge(options, toolAgent)
        if (bridge && bridge.toolCount === 0) {
          await bridge.close()
          bridge = undefined
        } else {
          await bridge.start()
        }
      }
      await this.server.start(options.signal)
      session = await this.server.newSession({
        cwd: this.cwd,
        mcpServers: bridge?.mcpServers ?? [],
        trustedToolPrefix: bridge?.serverName,
      }, options.signal)
      const selected = await this.server.setConfigOption(session.sessionId, 'model', options.model, options.signal)
      const effective = optionValue(selected, 'model') ?? optionValue(session, 'model')
      if (effective && effective !== options.model) {
        throw new TrLlmError(
          `TR Grok selected "${effective}" instead of the requested "${options.model}".`,
          'MODEL_UNAVAILABLE',
        )
      }
      if (effort !== undefined) {
        const configured = await this.server.setConfigOption(session.sessionId, 'reasoning_effort', effort, options.signal)
        const applied = optionValue(configured, 'reasoning_effort')
        if (applied !== effort) {
          throw new TrLlmError(
            `TR Grok did not confirm reasoning effort "${effort}" (CLI reported "${applied ?? 'none'}").`,
            'UNSUPPORTED_OPTION',
          )
        }
      }

      const toolNotice = bridge
        ? [
            'You are the model inside DeepSeek Harness.',
            `Harness tools are available through the MCP server "${bridge.serverName}" (${bridge.toolNames.join(', ')}).`,
            'Use only those MCP tools for file reads, searches, edits, and the configured test command. Do not use Grok built-in shell or file tools; they are denied by this client.',
            'Every edit and test run pauses for the Harness user’s one-shot approval. A denied or failed tool is an error result; never claim success when the tool result is an error.',
          ].join(' ')
        : 'You are the model inside DeepSeek Harness. This TR Grok provider supports text chat only. Harness tools are not available in this provider; do not claim to have run one. Answer in text.'
      const system = [
        typeof options.system === 'string' ? options.system : '',
        toolNotice,
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
        // Tool calls are authorized by Grok's permission request, which
        // GrokAppServer grants only for this turn's MCP namespace. Do not
        // reinterpret intermediate tool updates as native DSH tool calls.
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
      if (typeof this.server.deniedPermissionCount === 'function'
        && this.server.deniedPermissionCount(session.sessionId) > 0) {
        throw new TrLlmError(
          'TR Grok requested a tool outside the authorized Harness MCP server; the call was denied.',
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
        reasoningEffort: effort,
        sessionId: session.sessionId,
        stopReason: result.stopReason,
        toolsEnabled: bridge !== undefined,
        ...bridge === undefined ? {} : { toolNames: bridge.toolNames },
      }
      this.remember(key, options.model, effort, preferred)
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
      await bridge?.close()
      this.busy.delete(key)
      void finished
    }
  }

  async clear() {}
}
