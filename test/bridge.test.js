import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { apply, commandFor, invoke, resolveWorkspace } from '../index.js'

test('Codex runs through TR and enforces a read-only sandbox', () => {
  assert.deepEqual(commandFor('codex', 'CODEX_OK'), [
    'tr', 'codex', 'exec', '--sandbox', 'read-only', 'CODEX_OK',
  ])
})

test('Grok runs through TR and receives an explicit no-write instruction', () => {
  const args = commandFor('grok', 'GROK_OK')
  assert.deepEqual(args.slice(0, 3), ['tr', 'grok', '-p'])
  assert.match(args[3], /不得修改文件/)
  assert.match(args[3], /GROK_OK/)
})

test('Rejects empty and unsupported requests', () => {
  assert.throws(() => commandFor('foo', 'test'), /仅支持/)
  assert.throws(() => commandFor('codex', ''), /不能为空/)
  assert.throws(() => commandFor('grok', 'x'.repeat(20_001)), /不得超过/)
})

test('Requires a real session workspace', () => {
  assert.throws(() => resolveWorkspace({}), /工作区/)
  assert.equal(resolveWorkspace({ agent: { session: { header: { cwd: 'C:\\work\\example-repo' } } } }), 'C:\\work\\example-repo')
})

function fakeChild(stdoutText, stderrText, exitCode = 0) {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = { end() {} }
  let terminated = false
  const done = new Promise(resolve => {
    setImmediate(() => {
      if (stdoutText) stdout.emit('data', Buffer.from(stdoutText))
      if (stderrText) stderr.emit('data', Buffer.from(stderrText))
      resolve({ exitCode })
    })
  })
  return { stdout, stderr, stdin, done, terminate() { terminated = true }, get terminated() { return terminated } }
}

test('Runs mocked CLI, preserves stdout, scrubs obvious credential strings', async () => {
  const child = fakeChild('GROK_OK token=secretpassword\n', '', 0)
  const result = await invoke({
    subprocess: { spawn: spec => { assert.equal(spec.argv[0], 'tr'); return child } },
    argv: ['tr', 'grok', '-p', 'GROK_OK'],
    cwd: 'C:\\project',
    timeoutMs: 2000,
  })
  assert.match(result, /GROK_OK/)
  assert.doesNotMatch(result, /secretpassword/)
})

test('Nonzero CLI exit reports a safe diagnostic', async () => {
  const child = fakeChild('', 'Access denied', 1)
  await assert.rejects(invoke({
    subprocess: { spawn: () => child },
    argv: ['tr', 'codex', 'exec', 'ping'],
    cwd: 'C:\\project',
    timeoutMs: 2000,
  }), /退出码 1.*Access denied/)
})

test('Cancellation terminates the child', async () => {
  const child = fakeChild('', '', 0)
  // Replace the done promise with an unending task.
  child.done = new Promise(() => {})
  const controller = new AbortController()
  const pending = invoke({
    subprocess: { spawn: () => child },
    argv: ['tr', 'grok', '-p', 'wait'],
    cwd: 'C:\\project',
    signal: controller.signal,
    timeoutMs: 2000,
  })
  controller.abort()
  await assert.rejects(pending, /已取消/)
  assert.equal(child.terminated, true)
})

test('Registers the DSH tool; dry-run does not launch a child', async () => {
  let tool
  const ctx = {
    tools: { register(value) { tool = value } },
    get() { throw new Error('should not touch subprocess') },
  }
  apply(ctx)
  assert.equal(tool.name, 'tr_bridge')
  const preview = await tool.execute({ agent: 'codex', task: 'inspect', dryRun: true }, {
    agent: { session: { header: { cwd: 'C:\\work\\example-repo' } } },
  })
  assert.match(preview, /预览（未执行）/)
  assert.match(preview, /read-only/)
})
