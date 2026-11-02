import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { HarnessToolBridge } from '../llm/grok-tools.js'

const tools = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
  { name: 'glob', description: 'Find files', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'grep', description: 'Search files', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  {
    name: 'edit',
    description: 'Edit a file',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        sandbox_permissions: { type: 'string' },
        justification: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
]

function makeBridge(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grok-tools-'))
  const bridge = new HarnessToolBridge({
    sessionId: 'session-test',
    cwd: 'C:\\work',
    tools,
    agent: { id: 'agent-1' },
    executeTool: async input => ({
      content: [{ type: 'text', text: `EXECUTED ${input.name} ${input.arguments.file_path ?? ''}` }],
      isError: false,
    }),
    requestApproval: async () => 'allowed-once',
    testCommand: ['node', '--version'],
    subprocess: {
      spawn: () => {
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const child = {
          stdout,
          stderr,
          stdin: { end() {} },
          done: Promise.resolve({ exitCode: 0 }),
        }
        queueMicrotask(() => {
          stdout.write('v-test\n')
          stderr.end()
        })
        return child
      },
    },
    auditFile: join(dir, 'audit.jsonl'),
    ...overrides,
  })
  return { bridge, dir }
}

async function request(bridge, path, init = {}) {
  const response = await fetch(`${bridge.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${bridge.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  })
  return { status: response.status, body: await response.json() }
}

test('Grok bridge exposes only curated tools and strips edit escalation fields', async () => {
  const { bridge, dir } = makeBridge()
  try {
    await bridge.start()
    const { status, body } = await request(bridge, '/tools')
    assert.equal(status, 200)
    assert.deepEqual(body.tools.map(tool => tool.name), ['read', 'glob', 'grep', 'edit', 'run_tests'])
    const edit = body.tools.find(tool => tool.name === 'edit')
    assert.equal('sandbox_permissions' in edit.inputSchema.properties, false)
    assert.equal('justification' in edit.inputSchema.properties, false)
    assert.deepEqual(bridge.toolNames, ['read', 'glob', 'grep', 'edit', 'run_tests'])
  } finally {
    await bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Grok bridge requires its bearer token and rejects unknown arguments', async () => {
  const { bridge, dir } = makeBridge()
  try {
    await bridge.start()
    const unauthorized = await fetch(`${bridge.url}/tools`)
    assert.equal(unauthorized.status, 401)
    const unknown = await request(bridge, '/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'read', arguments: { file_path: 'a', sandbox_permissions: 'danger-full-access' } }),
    })
    assert.equal(unknown.body.isError, true)
    assert.match(unknown.body.content[0].text, /not allowed/)
  } finally {
    await bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Grok read is executed through the native tool result, not synthesized', async () => {
  const { bridge, dir } = makeBridge()
  try {
    await bridge.start()
    const { body } = await request(bridge, '/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'read', arguments: { file_path: 'src/a.js' }, callId: 'call-1' }),
    })
    assert.equal(body.isError, false)
    assert.equal(body.content[0].text, 'EXECUTED read src/a.js')
    const audit = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(audit.map(entry => entry.phase), ['request', 'result'])
    assert.equal(audit[0].arguments.file_path, 'src/a.js')
  } finally {
    await bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Grok edit and test runs require one-shot approval and fail closed when denied', async () => {
  const approvals = []
  const { bridge, dir } = makeBridge({
    requestApproval: async request => {
      approvals.push(request.toolName)
      return request.toolName === 'edit' ? 'denied' : 'allowed-once'
    },
  })
  try {
    await bridge.start()
    const edit = await request(bridge, '/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'edit', arguments: { file_path: 'src/a.js', old_string: 'a', new_string: 'b' } }),
    })
    assert.equal(edit.body.isError, true)
    assert.match(edit.body.content[0].text, /not approved/)
    const tests = await request(bridge, '/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'run_tests', arguments: {} }),
    })
    assert.equal(tests.body.isError, false)
    assert.match(tests.body.content[0].text, /exit code: 0/)
    assert.deepEqual(approvals, ['edit', 'run_tests'])
  } finally {
    await bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the stdio MCP child forwards real tools/list and tools/call requests', async () => {
  const { bridge, dir } = makeBridge()
  const pending = new Map()
  let bridgeChild
  try {
    await bridge.start()
    bridgeChild = spawn(process.execPath, [bridge.bridgeScript], {
      env: {
        ...process.env,
        DSH_TR_GROK_BRIDGE_URL: bridge.url,
        DSH_TR_GROK_BRIDGE_TOKEN: bridge.token,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const bridgeLines = createInterface({ input: bridgeChild.stdout })
    bridgeLines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    })
    const bridgeRpc = (id, method, params) => new Promise(resolve => {
      pending.set(id, resolve)
      bridgeChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    try {
      const init = await bridgeRpc(1, 'initialize', { protocolVersion: '2025-11-25' })
      assert.equal(init.result.serverInfo.name, 'dsh-harness-tools')
      const list = await bridgeRpc(2, 'tools/list', {})
      assert.deepEqual(list.result.tools.map(tool => tool.name), ['read', 'glob', 'grep', 'edit', 'run_tests'])
      const call = await bridgeRpc(3, 'tools/call', {
        name: 'read',
        arguments: { file_path: 'src/a.js' },
        _meta: { toolCallId: 'mcp-call-1' },
      })
      assert.equal(call.result.isError, false)
      assert.equal(call.result.content[0].text, 'EXECUTED read src/a.js')
    } finally {
      bridgeChild.kill()
    }
  } finally {
    await bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Grok bridge reports a native tool failure as an MCP error result', async () => {
  const { bridge, dir } = makeBridge({
    executeTool: async () => ({
      content: [{ type: 'text', text: 'file not found' }],
      isError: true,
    }),
  })
  try {
    await bridge.start()
    const { body } = await request(bridge, '/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'read', arguments: { file_path: 'missing.js' } }),
    })
    assert.equal(body.isError, true)
    assert.equal(body.content[0].text, 'file not found')
  } finally {
    await bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Grok bridge abort signal terminates a running test and reports cancellation', async () => {
  const controller = new AbortController()
  let terminated = false
  const { bridge, dir } = makeBridge({
    signal: controller.signal,
    subprocess: {
      spawn: () => {
        const child = {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          stdin: { end() {} },
          done: new Promise(resolve => setTimeout(() => resolve({ exitCode: 0 }), 500)),
          terminate: () => { terminated = true },
        }
        return child
      },
    },
  })
  try {
    await bridge.start()
    const pending = request(bridge, '/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'run_tests', arguments: {} }),
    })
    setTimeout(() => controller.abort(), 30)
    const { body } = await pending
    assert.equal(body.isError, true)
    assert.match(body.content[0].text, /cancelled/)
    assert.equal(terminated, true)
  } finally {
    await bridge.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
