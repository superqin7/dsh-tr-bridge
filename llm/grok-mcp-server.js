/**
 * Minimal stdio MCP server spawned by Grok for one TR Grok ACP session.
 *
 * It is deliberately stateless: tool discovery and execution are delegated to
 * the loopback Harness bridge named by the environment. No model text is
 * interpreted here, and no tool result is invented when the bridge fails.
 */
const url = process.env.DSH_TR_GROK_BRIDGE_URL
const token = process.env.DSH_TR_GROK_BRIDGE_TOKEN

if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || typeof token !== 'string' || !token) {
  process.stderr.write('dsh-tr-bridge MCP: missing bridge URL/token\n')
  process.exit(2)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index < 0) break
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    void handle(message)
  }
})

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}

function result(id, value) {
  write({ id, result: value })
}

function error(id, code, message) {
  write({ id, error: { code: Number.isInteger(code) ? code : -32603, message: String(message) } })
}

async function callBridge(path, init = {}) {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(15 * 60_000),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Harness bridge returned non-JSON (${response.status}).`)
  }
  if (!response.ok) throw new Error(body?.error ?? `Harness bridge returned HTTP ${response.status}.`)
  return body
}

async function handle(message) {
  if (!message || typeof message !== 'object' || message.id === undefined || typeof message.method !== 'string') {
    // Notifications (including cancellation) need no response.
    return
  }
  const id = message.id
  try {
    if (message.method === 'initialize') {
      result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-harness-tools', version: '0.4.0' },
      })
      return
    }
    if (message.method === 'tools/list') {
      result(id, await callBridge('/tools', { method: 'GET' }))
      return
    }
    if (message.method === 'tools/call') {
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      if (typeof name !== 'string' || !name) {
        error(id, -32602, 'tools/call requires a tool name')
        return
      }
      result(id, await callBridge('/call', {
        method: 'POST',
        body: JSON.stringify({
          name,
          arguments: args,
          callId: message.params?._meta?.toolCallId,
        }),
      }))
      return
    }
    error(id, -32601, `unsupported MCP method: ${message.method}`)
  } catch (failure) {
    error(id, -32603, failure instanceof Error ? failure.message : String(failure))
  }
}
