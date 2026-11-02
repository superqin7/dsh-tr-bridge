/**
 * Harness LlmAdapter backed by `tr codex app-server`.
 *
 * The selected model id is always sent to thread/start and turn/start. Native
 * Codex tools are disabled by the transport; tool calls can only arrive as
 * Harness dynamic tools on an ephemeral thread.
 */
import { randomUUID } from 'node:crypto'
import { TrLlmError } from './errors.js'
import {
  contentHash,
  contentText,
  hashJson,
  historyHash,
  inputFor,
  toolSpecs,
} from './transcript.js'

function usageDelta(total, previous = {}) {
  const diff = name => Math.max(0, (total?.[name] ?? 0) - (previous?.[name] ?? 0))
  return {
    inputTokens: Math.max(0, diff('inputTokens') - diff('cachedInputTokens') - diff('cacheWriteInputTokens')),
    outputTokens: diff('outputTokens'),
    cacheReadTokens: diff('cachedInputTokens'),
    cacheWriteTokens: diff('cacheWriteInputTokens'),
    reasoningTokens: diff('reasoningOutputTokens'),
  }
}

function keyOf(options) {
  return options.sessionId ? `${options.sessionId}:${options.purpose ?? 'conversation'}` : randomUUID()
}

/**
 * Index tool results in the two shapes a Harness history can contain:
 * the live transport's role=tool message (toolCallId on the message), and
 * the older block form used by transcript fixtures.
 */
function toolResultsFrom(messages) {
  const results = new Map()
  for (const message of messages) {
    if (message?.role === 'tool' && typeof message.toolCallId === 'string') {
      results.set(message.toolCallId, {
        text: contentText(message.content),
        isError: message.isError === true,
      })
    }
    for (const block of message?.content ?? []) {
      if (block?.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue
      results.set(block.toolCallId, {
        text: contentText(block.content),
        isError: block.isError === true,
      })
    }
  }
  return results
}

export class CodexAdapter {
  sessions = new Map()
  busy = new Set()

  constructor({
    provider = 'tr-codex',
    name = 'TR Codex',
    server,
    catalog,
    cwd,
    idleTimeoutMs = 300_000,
    maxSessions = 128,
  } = {}) {
    this.provider = provider
    this.name = name
    this.server = server
    this.catalog = catalog
    this.cwd = cwd
    this.idleTimeoutMs = idleTimeoutMs
    this.maxSessions = maxSessions
  }

  providerInfo(provider) {
    return { id: provider, name: this.name }
  }

  // Defaults (normal retry policy) are correct for a local CLI process.
  providerRetryPolicy() {}

  listModels(_provider) {
    // The host may call this with or without the route argument; this adapter
    // only owns one provider, so both forms return the same live catalog.
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

  reusable(session, options, signature) {
    if (!session || session.generation !== this.server.generation || session.signature !== signature) return false
    const index = options.messages.findLastIndex(message => message.role === 'assistant')
    if (index < 0) return false
    const previous = options.messages[index]
    const replay = previous?.source?.replayState?.response
    return index === session.inputCount
      && replay?.kind === 'tr-codex'
      && replay.marker === session.marker
      && historyHash(options.messages.slice(0, index)) === session.inputHash
      && contentHash(previous.content) === session.outputHash
  }

  async fresh(options, specs, signature, key) {
    const old = this.sessions.get(key)
    if (old) await this.server.release(old.threadId, old.turnId)
    this.sessions.delete(key)
    for (const [id, session] of this.sessions) {
      if (!this.busy.has(id) && (Date.now() - session.touched > 30 * 60_000 || this.sessions.size >= this.maxSessions)) {
        this.sessions.delete(id)
        await this.server.release(session.threadId, session.turnId)
      }
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new TrLlmError('All TR Codex sessions are busy; retry after a running turn finishes.', 'TR_LLM_BUSY')
    }
    const threadId = await this.server.startThread({
      model: options.model,
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      baseInstructions: [
        options.system ?? '',
        'You are the model inside DeepSeek Harness. Harness owns the conversation and executes every tool. Use only the supplied dynamic tools, one at a time. Never use native Codex tools or shell commands.',
      ].filter(Boolean).join('\n\n'),
      dynamicTools: specs,
    }, options.signal)
    const session = {
      threadId,
      generation: this.server.generation,
      signature,
      touched: Date.now(),
      pending: [],
      billed: {},
      turnId: undefined,
      closedItems: new Set(),
      marker: undefined,
      inputCount: 0,
      inputHash: '',
      outputHash: '',
    }
    this.sessions.set(key, session)
    return session
  }

  async *stream(options) {
    options.signal?.throwIfAborted()
    if (options.stop !== undefined || options.temperature !== undefined || options.maxTokens !== undefined) {
      throw new TrLlmError('TR Codex does not support stop, temperature or maxTokens overrides.', 'UNSUPPORTED_OPTION')
    }
    if (!options.messages?.length) {
      throw new TrLlmError('At least one conversation message is required.', 'INVALID_REQUEST')
    }
    for (const message of options.messages) contentText(message.content)

    const specs = toolSpecs(options.tools)
    const signature = hashJson({
      system: options.system,
      specs,
      model: options.model,
      effort: options.reasoningEffort,
      cwd: this.cwd,
    })
    const key = keyOf(options)
    if (this.busy.has(key)) {
      throw new TrLlmError('A TR Codex response is already running for this Harness session.', 'TR_LLM_BUSY')
    }
    this.busy.add(key)

    let session
    let finished = false
    try {
      await this.server.start(options.signal)
      session = this.sessions.get(key)
      const sameProcess = session?.generation === this.server.generation
      const hasPending = sameProcess && session.pending.length > 0
      const reuse = hasPending || this.reusable(session, options, signature)
      if (!reuse) session = await this.fresh(options, specs, signature, key)

      if (session.pending.length) {
        const results = toolResultsFrom(options.messages)
        for (const call of session.pending) {
          const result = results.get(call.callId)
          if (!result) {
            throw new TrLlmError('Harness has not supplied the pending tool result.', 'INVALID_REQUEST')
          }
          this.server.respond(call.requestId, {
            contentItems: [{ type: 'inputText', text: result.text || '(no output)' }],
            success: !result.isError,
          })
        }
        session.pending = []
      } else {
        const incoming = reuse ? options.messages.slice(session.inputCount + 1) : options.messages
        if (!incoming.length) {
          throw new TrLlmError('No new Harness messages were supplied.', 'INVALID_REQUEST')
        }
        session.turnId = await this.server.startTurn(session.threadId, {
          model: options.model,
          ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
          input: [{ type: 'text', text: inputFor(incoming, !reuse) }],
        }, options.signal)
        session.closedItems = new Set()
      }
      session.inputCount = options.messages.length
      session.inputHash = historyHash(options.messages)

      const open = new Map()
      const emitted = []
      let nextIndex = 0
      const end = block => {
        open.delete(block.key)
        session.closedItems.add(block.itemId)
        const content = { type: block.type, text: block.text }
        emitted[block.index] = content
        return { type: 'block-end', index: block.index, block: content }
      }
      const finish = kind => {
        session.marker = randomUUID()
        session.outputHash = contentHash(emitted.filter(Boolean))
        session.touched = Date.now()
        finished = true
        return {
          type: 'finish',
          reason: { kind },
          replayState: { response: { kind: 'tr-codex', version: 1, marker: session.marker } },
        }
      }

      while (true) {
        const timeout = AbortSignal.timeout(this.idleTimeoutMs)
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
        let event
        try {
          event = await this.server.nextEvent(session.threadId, signal)
        } catch (error) {
          if (!options.signal?.aborted && timeout.aborted) {
            throw new TrLlmError('TR Codex stopped sending events. Retry to reconnect.', 'TR_LLM_TIMEOUT')
          }
          throw error
        }
        const { method, params } = event
        const eventTurn = params.turnId ?? params.turn?.id
        if (eventTurn && session.turnId && eventTurn !== session.turnId) continue

        if (method === 'thread/tokenUsage/updated') {
          session.usage = params.tokenUsage?.total ?? params.tokenUsage
          continue
        }
        if (method === 'error' && !params.willRetry) {
          throw new TrLlmError(params.error?.message ?? 'TR Codex turn failed.', 'TR_LLM_TURN_FAILED')
        }

        const type = method === 'item/agentMessage/delta'
          ? 'text'
          : method === 'item/reasoning/summaryTextDelta'
            ? 'reasoning'
            : undefined
        if (type) {
          const itemId = params.itemId ?? type
          const blockKey = `${itemId}:${type}`
          let block = open.get(blockKey)
          if (!block) {
            block = { key: blockKey, itemId, index: nextIndex++, type, text: '' }
            open.set(blockKey, block)
            yield { type: 'block-start', index: block.index, blockType: type }
          }
          const text = params.delta ?? ''
          block.text += text
          yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text }
        }

        if (method === 'item/completed') {
          const item = params.item
          const blocks = [...open.values()].filter(block => block.itemId === item?.id)
          if (!blocks.length && item?.type === 'agentMessage' && item.text && !session.closedItems.has(item.id)) {
            const block = { key: `${item.id}:text`, itemId: item.id, index: nextIndex++, type: 'text', text: item.text }
            yield { type: 'block-start', index: block.index, blockType: 'text' }
            yield { type: 'text-delta', index: block.index, text: item.text }
            yield end(block)
          }
          for (const block of blocks) yield end(block)
        }

        if (method === 'item/tool/call') {
          const { callId, tool, arguments: args } = params
          const known = specs.some(spec => spec.name === tool)
          if (event.requestId === undefined || typeof callId !== 'string' || !known) {
            if (event.requestId !== undefined) {
              this.server.respond(event.requestId, {
                success: false,
                contentItems: [{ type: 'inputText', text: 'Unknown or malformed Harness tool call.' }],
              })
            }
            throw new TrLlmError('TR Codex requested an unknown or malformed dynamic tool.', 'PROTOCOL_ERROR')
          }
          for (const block of [...open.values()]) yield end(block)
          const index = nextIndex++
          const content = {
            type: 'tool-call',
            id: callId,
            name: tool,
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          }
          session.pending = [{ requestId: event.requestId, callId }]
          emitted[index] = content
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: callId, name: tool, argumentsDelta: content.arguments }
          yield { type: 'block-end', index, block: content }
          if (session.usage) {
            yield { type: 'usage', usage: usageDelta(session.usage, session.billed) }
            session.billed = session.usage
          }
          yield finish('tool-calls')
          return
        }

        if (method === 'turn/completed') {
          if (params.turn?.status === 'failed') {
            throw new TrLlmError(params.turn.error?.message ?? 'TR Codex turn failed.', 'TR_LLM_TURN_FAILED')
          }
          if (params.turn?.status === 'interrupted') {
            throw new TrLlmError('TR Codex turn was interrupted.', 'ABORTED')
          }
          for (const block of [...open.values()]) yield end(block)
          if (session.usage) {
            yield { type: 'usage', usage: usageDelta(session.usage, session.billed) }
            session.billed = session.usage
          }
          session.turnId = undefined
          yield finish('stop')
          return
        }
      }
    } finally {
      if (session && (!finished || !options.sessionId || options.purpose)) {
        this.sessions.delete(key)
        await this.server.release(session.threadId, session.turnId)
      }
      this.busy.delete(key)
    }
  }

  async clear() {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map(session => this.server.release(session.threadId, session.turnId)))
  }
}
