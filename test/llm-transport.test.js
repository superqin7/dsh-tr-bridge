import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { CodexAppServer, codexAppServerArgv } from '../llm/codex-app-server.js'

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
    terminate() {
      this.terminated = true
      resolveDone({ exitCode: 0 })
    },
    exit(code = 0) { resolveDone({ exitCode: code }) },
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
  const server = new CodexAppServer({
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

test('argv uses a literal tr.exe and disables native Codex tools before app-server', () => {
  const argv = codexAppServerArgv('C:\\TokenRouter\\tr.exe')
  assert.equal(argv[0], 'C:\\TokenRouter\\tr.exe')
  assert.equal(argv[1], 'codex')
  assert.ok(argv.includes('features.shell_tool=false'))
  assert.ok(argv.includes('features.unified_exec=false'))
  assert.deepEqual(argv.slice(-2), ['app-server', '--stdio'])
  assert.equal(argv.filter(part => part === '--stdio').length, 1)
})

test('an explicit catalog is passed as one Codex config argument', () => {
  const argv = codexAppServerArgv('C:\\TokenRouter\\tr.exe', {
    catalogJson: 'C:\\Users\\me\\.codex\\tokenrouter-model-catalog.json',
  })
  const index = argv.findIndex((part, i) => part === '-c' && argv[i + 1]?.startsWith('model_catalog_json='))
  assert.ok(index > 0)
  assert.equal(
    argv[index + 1],
    'model_catalog_json="C:\\\\Users\\\\me\\\\.codex\\\\tokenrouter-model-catalog.json"',
  )
  assert.deepEqual(argv.slice(-2), ['app-server', '--stdio'])
})

test('a null catalog means no override, not an empty path', () => {
  const argv = codexAppServerArgv('C:\\TokenRouter\\tr.exe', { catalogJson: null })
  assert.equal(argv.some(part => part.startsWith('model_catalog_json=')), false)
  assert.deepEqual(argv.slice(-2), ['app-server', '--stdio'])
})

test('model/list follows every cursor and reports the complete page count', async () => {
  const { server, spawns } = launch()
  const starting = server.start()
  await waitFor(() => spawns[0]?.child.messages.length > 0)
  spawns[0].child.stdout.write(JSON.stringify({ id: spawns[0].child.messages[0].id, result: {} }) + '\n')
  await starting

  const listing = server.models()
  await waitFor(() => spawns[0].child.messages.some(message => message.method === 'model/list'))
  const first = spawns[0].child.messages.find(message => message.method === 'model/list')
  spawns[0].child.stdout.write(JSON.stringify({
    id: first.id,
    result: { data: [{ model: 'a' }], nextCursor: 'page-2' },
  }) + '\n')
  await waitFor(() => spawns[0].child.messages.filter(message => message.method === 'model/list').length === 2)
  const second = spawns[0].child.messages.filter(message => message.method === 'model/list').at(-1)
  assert.deepEqual(second.params, { limit: 100, cursor: 'page-2' })
  spawns[0].child.stdout.write(JSON.stringify({
    id: second.id,
    result: { data: [{ model: 'b' }], nextCursor: null },
  }) + '\n')
  assert.deepEqual(await listing, [{ model: 'a' }, { model: 'b' }])
  assert.deepEqual(server.lastPagination, { pages: 2, complete: true })
  server.close()
})

test('initialize, model/list and close use JSONL stdio without relaying stderr', async () => {
  const { server, spawns } = launch()
  const starting = server.start()
  await waitFor(() => spawns[0]?.child.messages.length > 0)
  const init = spawns[0].child.messages[0]
  assert.equal(init.method, 'initialize')
  assert.equal(init.params.clientInfo.name, 'dsh_tr_bridge')
  spawns[0].child.stdout.write(JSON.stringify({ id: init.id, result: { userAgent: 'test' } }) + '\n')
  await starting
  assert.equal(spawns[0].child.messages[1].method, 'initialized')
  assert.deepEqual(spawns[0].spec.stdio, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })

  const listing = server.models()
  await waitFor(() => spawns[0].child.messages.some(message => message.method === 'model/list'))
  const request = spawns[0].child.messages.find(message => message.method === 'model/list')
  spawns[0].child.stdout.write(JSON.stringify({
    id: request.id,
    result: { data: [{ slug: 'gpt-5.6-terra' }], nextCursor: null },
  }) + '\n')
  assert.deepEqual(await listing, [{ slug: 'gpt-5.6-terra' }])

  // Native stderr is counted, never parsed or forwarded.
  spawns[0].child.stderr.write('private request body\n')
  server.close()
  assert.equal(spawns[0].child.terminated, true)
})

test('an exited child rejects an in-flight request instead of hanging', async () => {
  const { server, spawns } = launch()
  const starting = server.start()
  await waitFor(() => spawns[0]?.child.messages.length > 0)
  spawns[0].child.stdout.write(JSON.stringify({ id: spawns[0].child.messages[0].id, result: {} }) + '\n')
  await starting

  const pending = server.models()
  await waitFor(() => spawns[0].child.messages.some(message => message.method === 'model/list'))
  spawns[0].child.exit(1)
  await assert.rejects(pending, error => error.code === 'TR_LLM_DISCONNECTED')
  server.close()
})
