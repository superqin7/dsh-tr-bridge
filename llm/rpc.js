/**
 * JSONL JSON-RPC primitives for the Codex app-server.
 *
 * This module has no subprocess dependency so framing, timeouts, cancellation
 * and response routing can be unit-tested without starting a CLI.
 */
import { TrLlmError } from './errors.js'

export class EventQueue {
  values = []
  waiters = []
  error

  push(value) {
    if (this.error) return
    if (this.waiters.length) this.waiters.shift().resolve(value)
    else if (this.values.length >= 4096) this.fail(new TrLlmError('TR Codex event queue overflowed; retry the turn.', 'PROTOCOL_ERROR'))
    else this.values.push(value)
  }

  fail(error) {
    this.error = error
    this.values = []
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  take(signal) {
    signal?.throwIfAborted()
    if (this.error) return Promise.reject(this.error)
    if (this.values.length) return Promise.resolve(this.values.shift())
    return new Promise((resolve, reject) => {
      const abort = () => waiter.reject(signal.reason ?? new TrLlmError('Request aborted.', 'ABORTED'))
      const waiter = {
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
      }
      const finish = (fn, value) => {
        signal?.removeEventListener('abort', abort)
        this.waiters = this.waiters.filter(entry => entry !== waiter)
        fn(value)
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}

/** Incremental newline splitter. Feed chunks, receive complete non-empty lines. */
export class LineBuffer {
  constructor(onLine) {
    this.onLine = onLine
    this.buffer = ''
  }

  push(chunk) {
    this.buffer += String(chunk)
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim()) this.onLine(line)
    }
    if (this.buffer.length > 8 * 1024 * 1024) {
      throw new TrLlmError('TR Codex sent an oversized protocol line.', 'PROTOCOL_ERROR')
    }
  }

  flush() {
    const rest = this.buffer
    this.buffer = ''
    if (rest.trim()) this.onLine(rest)
  }
}

export class RpcPeer {
  constructor({ send, timeoutMs = 30_000 }) {
    this.send = send
    this.timeoutMs = timeoutMs
    this.nextId = 1
    this.pending = new Map()
  }

  request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const finish = (fn, value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.pending.delete(id)
        fn(value)
      }
      const abort = () => finish(reject, signal.reason ?? new TrLlmError('Request aborted.', 'ABORTED'))
      const timer = setTimeout(
        () => finish(reject, new TrLlmError(`TR Codex ${method} timed out.`, 'TR_LLM_TIMEOUT')),
        timeoutMs,
      )
      this.pending.set(id, {
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error),
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.send({ id, method, params })
      } catch (error) {
        finish(reject, error)
      }
    })
  }

  notify(method, params = {}) {
    this.send({ method, params })
  }

  /** Resolve one server response. Returns false for notifications/requests. */
  receive(message) {
    if (!message || typeof message !== 'object') return false
    if (message.method !== undefined) return false
    if (message.id === undefined) return false
    const pending = this.pending.get(message.id)
    if (!pending) return true
    if (message.error) {
      pending.reject(new TrLlmError(message.error.message ?? 'TR Codex rejected the request.', 'TR_LLM_RPC_ERROR'))
    } else {
      pending.resolve(message.result)
    }
    return true
  }

  failAll(error) {
    for (const pending of [...this.pending.values()]) pending.reject(error)
    this.pending.clear()
  }
}
