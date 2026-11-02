import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { GrokAppServer, grokAgentArgv } from '../llm/grok-app-server.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition timed out')
    await sleep(5)
  }
}

function fakeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const child = {
    stdin,
    stdout,
    stderr,
    done,
    messages: [],
    terminated: false,
    terminate() { this.terminated = true; resolveDone({ exitCode: 0 }) },
  }
  let buffer = ''
  stdin.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim()) child.messages.push(JSON.parse(line))
    }
  })
  return child
}

function launch() {
  const spawns = []
  const server = new GrokAppServer({
    spawn: spec => {
      const child = fakeChild()
      spawns.push({ spec, child })
      return child
    },
    command: 'C:\\TokenRouter\\tr.exe',
    cwd: 'C:\\work',
    requestTimeoutMs: 1000,
  })
  return { server, spawns }
}

test('Grok argv uses tr.exe and the no-leader ACP stdio transport', () => {
  assert.deepEqual(grokAgentArgv('C:\\TokenRouter\\tr.exe'), [
    'C:\\TokenRouter\\tr.exe', 'grok', 'agent', '--no-leader', 'stdio',
  ])
})

test('Grok forwards the MCP server config and permits only its namespaced tools', async () => {
  const { server, spawns } = launch()
  const starting = server.start()
  await waitFor(() => spawns[0]?.child.messages.length > 0)
  const init = spawns[0].child.messages[0]
  spawns[0].child.stdout.write(JSON.stringify({ id: init.id, result: { protocolVersion: 1 } }) + '\n')
  await starting

  const session = server.newSession({
    cwd: 'C:\\work',
    mcpServers: [{ name: 'dsh_harness_test', command: 'node', args: ['bridge.js'], env: [] }],
    trustedToolPrefix: 'dsh_harness_test',
  })
  await waitFor(() => spawns[0].child.messages.some(message => message.method === 'session/new'))
  const request = spawns[0].child.messages.find(message => message.method === 'session/new')
  assert.deepEqual(request.params.mcpServers, [{ name: 'dsh_harness_test', command: 'node', args: ['bridge.js'], env: [] }])
  spawns[0].child.stdout.write(JSON.stringify({ id: request.id, result: { sessionId: 's1' } }) + '\n')
  await session

  server.receive({
    id: 101,
    method: 'session/request_permission',
    params: {
      sessionId: 's1',
      toolCall: { rawInput: { tool_name: 'dsh_harness_test__read' } },
      options: [
        { optionId: 'always-allow', kind: 'allow_always' },
        { optionId: 'allow-once', kind: 'allow_once' },
      ],
    },
  })
  const allowed = spawns[0].child.messages.find(message => message.id === 101)
  assert.deepEqual(allowed.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } })

  server.receive({
    id: 102,
    method: 'session/request_permission',
    params: {
      sessionId: 's1',
      toolCall: { title: 'shell' },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    },
  })
  const denied = spawns[0].child.messages.find(message => message.id === 102)
  assert.deepEqual(denied.result, { outcome: { outcome: 'cancelled' } })
  assert.equal(server.deniedPermissionCount('s1'), 1)
  server.close()
})

test('Grok initialize, session/new and session/update stay on JSONL stdio', async () => {
  const { server, spawns } = launch()
  const starting = server.start()
  await waitFor(() => spawns[0]?.child.messages.length > 0)
  const init = spawns[0].child.messages[0]
  assert.equal(init.method, 'initialize')
  assert.equal(init.params.protocolVersion, 1)
  assert.equal(init.params.clientInfo.name, 'dsh_tr_bridge')
  spawns[0].child.stdout.write(JSON.stringify({ id: init.id, result: { protocolVersion: 1 } }) + '\n')
  await starting

  const session = server.newSession({ cwd: 'C:\\work' })
  await waitFor(() => spawns[0].child.messages.some(message => message.method === 'session/new'))
  const request = spawns[0].child.messages.find(message => message.method === 'session/new')
  assert.deepEqual(request.params, { cwd: 'C:\\work', mcpServers: [] })
  spawns[0].child.stdout.write(JSON.stringify({ id: request.id, result: { sessionId: 's1' } }) + '\n')
  assert.equal((await session).sessionId, 's1')

  server.receive({
    id: 99,
    method: 'session/request_permission',
    params: { sessionId: 's1', options: [] },
  })
  const denied = spawns[0].child.messages.find(message => message.id === 99)
  assert.deepEqual(denied.result, { outcome: { outcome: 'cancelled' } })

  server.receive({
    method: 'session/update',
    params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } },
  })
  const event = await server.nextEvent('s1')
  assert.equal(event.params.update.sessionUpdate, 'agent_message_chunk')
  server.close()
  assert.equal(spawns[0].child.terminated, true)
})
