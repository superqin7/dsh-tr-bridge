/**
 * Convert Harness messages into the compact text projection Codex accepts.
 *
 * Codex app-server has no Harness block vocabulary. We deliberately keep only
 * text and text tool results: images/files are refused instead of being
 * silently dropped, and reasoning is not replayed as input.
 */
import { createHash } from 'node:crypto'
import { TrLlmError } from './errors.js'

export function contentText(blocks) {
  if (!Array.isArray(blocks)) {
    throw new TrLlmError('Message content must be an array of blocks.', 'UNSUPPORTED_CONTENT')
  }
  return blocks.map(block => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'reasoning') return ''
    if (block?.type === 'tool-call') {
      return `[Tool call ${block.id}: ${block.name}] ${block.arguments}`
    }
    if (block?.type === 'tool-result') {
      return `[${block.isError ? 'Failed tool result' : 'Tool result'} ${block.toolCallId}]\n${contentText(block.content)}`
    }
    throw new TrLlmError(`This provider accepts text and text tool results only; unsupported content: ${block?.type}.`, 'UNSUPPORTED_CONTENT')
  }).filter(Boolean).join('\n')
}

export function transcriptShape(messages) {
  return messages.map(message => ({ role: message.role, content: message.content }))
}

export function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function historyHash(messages) {
  return hashJson(transcriptShape(messages))
}

export function contentHash(blocks) {
  return hashJson(blocks.filter(block => !(block?.type === 'text' || block?.type === 'reasoning') || block.text))
}

export function inputFor(messages, rebuild = false) {
  const onlyUserText = messages.length === 1
    && messages[0].role === 'user'
    && !messages[0].content.some(block => block?.type === 'tool-result')
  if (onlyUserText) return contentText(messages[0].content)
  const transcript = messages.map(message => ({
    role: message.role,
    source: message.source?.kind ?? message.role,
    content: contentText(message.content),
  }))
  const prefix = rebuild
    ? 'Harness conversation history follows as JSON. Continue from its last message. Tool results in this history have already been executed; do not repeat a tool merely to reconstruct history.\n'
    : 'New Harness messages follow as JSON, in order:\n'
  return prefix + JSON.stringify(transcript)
}

export function toolSpecs(tools = []) {
  const names = new Set()
  return tools.map(tool => {
    if (typeof tool?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) {
      throw new TrLlmError('Dynamic tool names must be unique and contain 1-64 letters, digits, underscores or hyphens.', 'INVALID_REQUEST')
    }
    names.add(tool.name)
    if (!tool.parameters || tool.parameters.type !== 'object' || Array.isArray(tool.parameters)) {
      throw new TrLlmError(`Tool ${tool.name} requires an object JSON Schema.`, 'INVALID_REQUEST')
    }
    return {
      type: 'function',
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.parameters,
    }
  })
}
