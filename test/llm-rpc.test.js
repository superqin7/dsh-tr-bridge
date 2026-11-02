import test from 'node:test'
import assert from 'node:assert/strict'
import { EventQueue, LineBuffer, RpcPeer } from '../llm/rpc.js'

test('LineBuffer reassembles split JSONL lines and flushes the tail', () => {
  const lines = []
  const buffer = new LineBuffer(line => lines.push(line))
  buffer.push('{"a":')
  buffer.push('1}\r\n{"b":2}\n')
  buffer.push('{"c":3}')
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  buffer.flush()
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}'])
})

test('RpcPeer resolves responses by id and rejects protocol errors', async () => {
  const sent = []
  const peer = new RpcPeer({ send: message => sent.push(message), timeoutMs: 1000 })
  const promise = peer.request('model/list', { limit: 1 })
  assert.equal(sent[0].method, 'model/list')
  peer.receive({ id: sent[0].id, result: { data: [] } })
  assert.deepEqual(await promise, { data: [] })

  const failed = peer.request('thread/start', {})
  peer.receive({ id: sent[1].id, error: { message: 'no' } })
  await assert.rejects(failed, error => error.code === 'TR_LLM_RPC_ERROR')

  const detailed = peer.request('session/prompt', {})
  peer.receive({
    id: sent[2].id,
    error: {
      message: 'Internal error',
      data: 'Unauthorized (401) from upstream: invalid or expired credentials (Bearer sk-test-secret-12345678)',
    },
  })
  await assert.rejects(detailed, error => (
    error.code === 'TR_LLM_RPC_ERROR'
    && error.message.includes('Unauthorized (401)')
    && error.message.includes('invalid or expired credentials')
    && !error.message.includes('sk-test-secret-12345678')
    && error.message.includes('[REDACTED]')
  ))
})

test('RpcPeer times out and aborts without leaking pending entries', async () => {
  const peer = new RpcPeer({ send: () => {}, timeoutMs: 10 })
  await assert.rejects(peer.request('slow', {}), error => error.code === 'TR_LLM_TIMEOUT')

  const controller = new AbortController()
  const aborted = peer.request('slow', {}, { signal: controller.signal, timeoutMs: 10_000 })
  controller.abort(new Error('stop'))
  await assert.rejects(aborted, /stop/)
  assert.equal(peer.pending.size, 0)
})

test('EventQueue delivers queued values and rejects waiters on failure', async () => {
  const queue = new EventQueue()
  queue.push('first')
  assert.equal(await queue.take(), 'first')

  const waiting = queue.take()
  queue.fail(new Error('closed'))
  await assert.rejects(waiting, /closed/)
  assert.equal(queue.values.length, 0)
})
